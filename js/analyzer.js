/**
 * MixMind Audio Analyzer
 * BPM detection via autocorrelation + Key detection via Krumhansl-Schmuckler profiles
 */

// ─── Krumhansl-Schmuckler Key Profiles ───────────────────────────────────────
const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const CAMELOT = {
  'C major': '8B',  'C minor': '5A',
  'C# major': '3B', 'C# minor': '12A',
  'D major': '10B', 'D minor': '7A',
  'D# major': '5B', 'D# minor': '2A',
  'E major': '12B', 'E minor': '9A',
  'F major': '7B',  'F minor': '4A',
  'F# major': '2B', 'F# minor': '11A',
  'G major': '9B',  'G minor': '6A',
  'G# major': '4B', 'G# minor': '1A',
  'A major': '11B', 'A minor': '8A',
  'A# major': '6B', 'A# minor': '3A',
  'B major': '1B',  'B minor': '10A',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function pearsonCorr(a, b) {
  const n = a.length;
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, dA = 0, dB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA, db = b[i] - meanB;
    num += da * db; dA += da * da; dB += db * db;
  }
  return num / (Math.sqrt(dA) * Math.sqrt(dB) + 1e-9);
}

function rotate(arr, n) {
  const k = ((n % arr.length) + arr.length) % arr.length;
  return [...arr.slice(k), ...arr.slice(0, k)];
}

// ─── BPM Detection ───────────────────────────────────────────────────────────
async function detectBPM(audioBuffer) {
  const sampleRate = audioBuffer.sampleRate;
  const maxDuration = Math.min(audioBuffer.duration, 90);
  const numSamples = Math.floor(maxDuration * sampleRate);

  // Get mono channel (average if stereo)
  let rawData = audioBuffer.getChannelData(0).slice(0, numSamples);
  if (audioBuffer.numberOfChannels > 1) {
    const ch1 = audioBuffer.getChannelData(1).slice(0, numSamples);
    rawData = rawData.map((v, i) => (v + ch1[i]) * 0.5);
  }

  // Offline context with lowpass filter (isolate kick drum range)
  const offCtx = new OfflineAudioContext(1, numSamples, sampleRate);
  const buf = offCtx.createBuffer(1, numSamples, sampleRate);
  buf.getChannelData(0).set(rawData);

  const src = offCtx.createBufferSource();
  src.buffer = buf;

  const lpf = offCtx.createBiquadFilter();
  lpf.type = 'lowpass';
  lpf.frequency.value = 220;
  lpf.Q.value = 0.5;

  src.connect(lpf);
  lpf.connect(offCtx.destination);
  src.start(0);

  const rendered = await offCtx.startRendering();
  const filtered = rendered.getChannelData(0);

  // RMS energy in 10ms windows
  const WIN = Math.floor(sampleRate * 0.01);
  const energy = [];
  for (let i = 0; i < filtered.length - WIN; i += WIN) {
    let sum = 0;
    for (let j = 0; j < WIN; j++) sum += filtered[i + j] ** 2;
    energy.push(Math.sqrt(sum / WIN));
  }

  // Onset strength (half-wave rectified difference)
  const onset = new Float64Array(energy.length);
  for (let i = 1; i < energy.length; i++) {
    onset[i] = Math.max(0, energy[i] - energy[i - 1]);
  }

  // Autocorrelation on onset function
  const hopDur = 0.01; // 10ms per hop
  const lagFor = bpm => Math.round((60 / bpm) / hopDur);
  const minLag = lagFor(200);
  const maxLag = lagFor(55);
  const acf = new Float64Array(maxLag + 1);

  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i < onset.length - lag; i++) s += onset[i] * onset[i + lag];
    acf[lag] = s;
  }

  // Find best lag
  let best = minLag;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (acf[lag] > acf[best]) best = lag;
  }
  let rawBpm = 60 / (best * hopDur);

  // Normalize to 70–175 BPM (handle half/double time)
  while (rawBpm < 70) rawBpm *= 2;
  while (rawBpm > 175) rawBpm /= 2;

  const bpm = Math.round(rawBpm * 10) / 10;
  const beatPeriod = 60 / bpm;

  return { bpm, beatPeriod };
}

// ─── Beat Grid ───────────────────────────────────────────────────────────────
function buildBeatGrid(startOffset, beatPeriod, totalDuration) {
  const beats = [];
  for (let t = startOffset; t < totalDuration; t += beatPeriod) {
    beats.push(t);
  }
  return beats;
}

// Estimate the first downbeat by finding the first high-energy onset
function estimateFirstBeat(audioBuffer, bpm) {
  const sr = audioBuffer.sampleRate;
  const beatPeriod = 60 / bpm;
  const winSamples = Math.floor(beatPeriod * sr);
  const ch = audioBuffer.getChannelData(0);

  let maxEnergy = -Infinity;
  let firstBeat = 0;

  // Scan first 8 beats for highest energy onset
  for (let i = 0; i < Math.min(8 * winSamples, ch.length - winSamples); i += Math.floor(winSamples / 4)) {
    let e = 0;
    for (let j = 0; j < winSamples; j++) e += ch[i + j] ** 2;
    if (e > maxEnergy) { maxEnergy = e; firstBeat = i / sr; }
  }

  return firstBeat % beatPeriod; // offset within one beat period
}

// ─── Key Detection ───────────────────────────────────────────────────────────
async function detectKey(audioBuffer) {
  const sampleRate = audioBuffer.sampleRate;

  // Use middle 30s of track for stability
  const startTime = Math.min(audioBuffer.duration * 0.3, 30);
  const duration = Math.min(30, audioBuffer.duration - startTime);
  const numSamples = Math.floor(duration * sampleRate);
  const startSample = Math.floor(startTime * sampleRate);

  let rawData = audioBuffer.getChannelData(0).slice(startSample, startSample + numSamples);
  if (audioBuffer.numberOfChannels > 1) {
    const ch1 = audioBuffer.getChannelData(1).slice(startSample, startSample + numSamples);
    rawData = rawData.map((v, i) => (v + ch1[i]) * 0.5);
  }

  // HPF to focus on pitched content
  const offCtx = new OfflineAudioContext(1, numSamples, sampleRate);
  const buf = offCtx.createBuffer(1, numSamples, sampleRate);
  buf.getChannelData(0).set(rawData);

  const src = offCtx.createBufferSource();
  src.buffer = buf;
  const hpf = offCtx.createBiquadFilter();
  hpf.type = 'highpass';
  hpf.frequency.value = 100;
  src.connect(hpf);
  hpf.connect(offCtx.destination);
  src.start(0);

  const rendered = await offCtx.startRendering();
  const data = rendered.getChannelData(0);

  // Build chroma vector via FFT using Cooley-Tukey
  const FFT_SIZE = 8192;
  const chroma = new Float64Array(12);
  const frameHop = Math.floor(FFT_SIZE / 2);

  let frameCount = 0;
  for (let i = 0; i + FFT_SIZE < data.length; i += frameHop) {
    const frame = data.slice(i, i + FFT_SIZE);
    const mag = computeFFTMagnitude(frame, FFT_SIZE);
    accumulateChroma(mag, sampleRate, FFT_SIZE, chroma);
    frameCount++;
  }

  // Normalize chroma
  const sum = chroma.reduce((s, v) => s + v, 0);
  if (sum > 0) for (let i = 0; i < 12; i++) chroma[i] /= sum;

  // Correlate with all 12 rotations of major + minor profiles
  let bestScore = -Infinity;
  let bestKey = 0;
  let bestMode = 'major';

  for (let k = 0; k < 12; k++) {
    const majRotated = rotate(KS_MAJOR, k);
    const minRotated = rotate(KS_MINOR, k);
    const majScore = pearsonCorr(Array.from(chroma), majRotated);
    const minScore = pearsonCorr(Array.from(chroma), minRotated);
    if (majScore > bestScore) { bestScore = majScore; bestKey = k; bestMode = 'major'; }
    if (minScore > bestScore) { bestScore = minScore; bestKey = k; bestMode = 'minor'; }
  }

  const keyName = NOTE_NAMES[bestKey];
  const keyStr = `${keyName} ${bestMode}`;
  const camelot = CAMELOT[keyStr] || '??';

  return { key: keyName, mode: bestMode, camelot, confidence: bestScore };
}

// Simple DFT-based magnitude spectrum (no full FFT library needed for this use)
function computeFFTMagnitude(frame, fftSize) {
  // Apply Hann window
  const windowed = new Float64Array(fftSize);
  for (let i = 0; i < fftSize; i++) {
    windowed[i] = frame[i] * (0.5 * (1 - Math.cos((2 * Math.PI * i) / (fftSize - 1))));
  }
  // For performance, use a simplified magnitude spectrum via DFT on reduced points
  // Then map to chroma. We only need spectral shape, not phase.
  const N = fftSize;
  const mag = new Float64Array(N / 2);

  // Cooley-Tukey FFT (iterative, in-place on real signal)
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = windowed[i];

  // Bit-reversal
  let j = 0;
  for (let i = 1; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }

  // FFT butterfly
  for (let len = 2; len <= N; len <<= 1) {
    const ang = (2 * Math.PI) / len;
    const wRe = Math.cos(ang), wIm = -Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let curRe = 1, curIm = 0;
      for (let jj = 0; jj < len / 2; jj++) {
        const uRe = re[i + jj], uIm = im[i + jj];
        const vRe = re[i + jj + len / 2] * curRe - im[i + jj + len / 2] * curIm;
        const vIm = re[i + jj + len / 2] * curIm + im[i + jj + len / 2] * curRe;
        re[i + jj] = uRe + vRe; im[i + jj] = uIm + vIm;
        re[i + jj + len / 2] = uRe - vRe; im[i + jj + len / 2] = uIm - vIm;
        const tmp = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = tmp;
      }
    }
  }

  for (let i = 0; i < N / 2; i++) mag[i] = Math.sqrt(re[i] ** 2 + im[i] ** 2);
  return mag;
}

function accumulateChroma(mag, sampleRate, fftSize, chroma) {
  const freqPerBin = sampleRate / fftSize;
  // A4 = 440 Hz = MIDI 69
  for (let bin = 1; bin < mag.length; bin++) {
    const freq = bin * freqPerBin;
    if (freq < 60 || freq > 5000) continue;
    // Map frequency to MIDI note
    const midi = 12 * Math.log2(freq / 440) + 69;
    const pitchClass = ((Math.round(midi) % 12) + 12) % 12;
    chroma[pitchClass] += mag[bin];
  }
}

// ─── Camelot Compatibility ───────────────────────────────────────────────────
function camelotCompat(cam1, cam2) {
  if (cam1 === '??' || cam2 === '??') return { score: 0.3, label: '❓ Unknown' };
  if (cam1 === cam2) return { score: 1.0, label: '✅ Perfect' };
  const n1 = parseInt(cam1), l1 = cam1.slice(-1);
  const n2 = parseInt(cam2), l2 = cam2.slice(-1);
  if (isNaN(n1) || isNaN(n2)) return { score: 0.3, label: '❓ Unknown' };
  if (n1 === n2 && l1 !== l2) return { score: 0.75, label: '⚠️ Safe (relative)' };
  const d = Math.min(Math.abs(n1 - n2), 12 - Math.abs(n1 - n2));
  if (d === 1 && l1 === l2) return { score: 0.7, label: '⚠️ Safe (adjacent)' };
  return { score: 0.0, label: '❌ Key Clash' };
}

// ─── AI Transition Point Detection ──────────────────────────────────────────
function findTransitionPoints(audioBuffer, bpm) {
  const sr = audioBuffer.sampleRate;
  const ch = audioBuffer.getChannelData(0);
  const WIN = Math.floor(sr * 0.05); // 50ms windows for high-res spectral flux emulation

  const energy = [];
  const flux = [];
  let prevE = 0;
  
  for (let i = 0; i < ch.length - WIN; i += WIN) {
    let s = 0;
    for (let j = 0; j < WIN; j++) s += ch[i + j] ** 2;
    let currE = Math.sqrt(s / WIN);
    energy.push(currE);
    // Emulate spectral flux dynamics (positive energy derivative squared)
    flux.push(Math.max(0, currE - prevE) ** 2);
    prevE = currE;
  }

  // Calculate dynamic thresholding
  const avgE = energy.reduce((a, b) => a + b, 0) / energy.length;
  const avgFlux = flux.reduce((a, b) => a + b, 0) / flux.length;
  
  const duration = audioBuffer.duration;
  const beatPeriod = 60 / bpm;
  const barPeriod = beatPeriod * 4;

  // ML-Heuristic: Find "OUT" point analyzing the last 25% of track
  // Target: High energy drop-off + low spectral flux (fewer transients, fading out)
  let outPoint = duration * 0.85;
  const outSearchStart = Math.floor((duration * 0.75) / 0.05);
  for (let i = energy.length - 1; i >= outSearchStart; i -= 8) { // scan in larger leaps backwards
    if (energy[i] > avgE * 0.8 && flux[i] > avgFlux * 0.5) {
       // Found last structural transient drop
       outPoint = i * 0.05; 
       break; 
    }
  }
  // Snap perfectly to a 4-bar phrase marker from the end
  outPoint = Math.round(outPoint / barPeriod) * barPeriod;

  // ML-Heuristic: Find "IN" point by locating the first major structural transient 
  // (the "Drop" or first heavy chorus loop) past intro
  let inPoint = beatPeriod * 16; // default fallback: 16 beats (4 bars) in
  let maxTransientScore = 0;
  
  // Scan first 30 seconds for the highest flux density
  const maxScanEnd = Math.min(flux.length, Math.floor(30 / 0.05));
  for (let i = 0; i < maxScanEnd; i++) {
    // Score heavily weights sudden structural changes and high energy
    let score = (flux[i] / avgFlux) * 0.7 + (energy[i] / avgE) * 0.3;
    if (score > maxTransientScore && score > 2.0) { 
       maxTransientScore = score;
       inPoint = i * 0.05; 
    }
  }
  // Retain structural phase-alignment
  inPoint = Math.round(inPoint / barPeriod) * barPeriod;

  return { outPoint, inPoint };
}

// ─── BPM score ───────────────────────────────────────────────────────────────
function bpmScore(a, b, maxJump = 8) {
  const direct = Math.abs(a - b);
  const dbl = Math.abs(a - b * 2);
  const half = Math.abs(a * 2 - b);
  const diff = Math.min(direct, dbl, half);
  return Math.max(0, 1 - diff / Math.max(maxJump, 1));
}

// ─── Exports ─────────────────────────────────────────────────────────────────
window.MixMindAnalyzer = {
  detectBPM, detectKey, buildBeatGrid, estimateFirstBeat,
  findTransitionPoints, camelotCompat, bpmScore, CAMELOT, NOTE_NAMES
};
