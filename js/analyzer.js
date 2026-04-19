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
  return new Promise(async (resolve) => {
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

    const hopDur = 0.01; // 10ms per hop
    const lagFor = bpm => Math.round((60 / bpm) / hopDur);
    const minLag = lagFor(200);
    const maxLag = lagFor(55);

    // Move heavy autocorrelation to a Web Worker
    const workerCode = `
      self.onmessage = ({ data: { onset, minLag, maxLag, hopDur } }) => {
        const acf = new Float64Array(maxLag + 1);
        for (let lag = minLag; lag <= maxLag; lag++) {
          let s = 0;
          for (let i = 0; i < onset.length - lag; i++) s += onset[i] * onset[i + lag];
          acf[lag] = s;
        }
        self.postMessage({ acf: Array.from(acf) });
      };
    `;
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    const worker = new Worker(URL.createObjectURL(blob));
    
    worker.onmessage = ({ data: { acf } }) => {
      worker.terminate();

      // Find best lag
      let best = minLag;
      for (let lag = minLag; lag <= maxLag; lag++) {
        if (acf[lag] > acf[best]) best = lag;
      }

      // Resolve harmonic ambiguity
      const halfLag = Math.round(best / 2);
      if (halfLag >= minLag && acf[halfLag] > acf[best] * 0.85) {
        best = halfLag; // double-time was the true tempo
      }

      // Also check 2x lag (half-time)
      const doubleLag = best * 2;
      if (doubleLag <= maxLag && acf[doubleLag] > acf[best] * 0.9) {
        // Both are valid — pick whichever is closer to 120
        const bpmA = 60 / (best * hopDur);
        const bpmB = 60 / (doubleLag * hopDur);
        if (Math.abs(bpmB - 120) < Math.abs(bpmA - 120)) best = doubleLag;
      }

      let rawBpm = 60 / (best * hopDur);

      // Normalize to 70–175 BPM fallback
      while (rawBpm < 70) rawBpm *= 2;
      while (rawBpm > 175) rawBpm /= 2;

      const bpm = Math.round(rawBpm * 10) / 10;
      const beatPeriod = 60 / bpm;

      resolve({ bpm, beatPeriod });
    };
    
    worker.postMessage({ onset: Array.from(onset), minLag, maxLag, hopDur });
  });
}


// ─── Key Detection ───────────────────────────────────────────────────────────
async function detectKey(audioBuffer) {
  const dur = audioBuffer.duration;
  let segs = [];
  
  if (dur < 40) {
    segs.push([0, dur]);
  } else {
    // Analyze 3 segments: intro skip, middle, outro skip
    segs.push([Math.min(15, dur * 0.1), 30]);
    segs.push([dur * 0.5 - 15, 30]);
    segs.push([dur * 0.85 - 15, 30]);
  }

  let chromas = [];
  for (let [start, len] of segs) {
    if (start < 0) start = 0;
    if (start + len > dur) len = dur - start;
    chromas.push(await _computeChromaForSegment(audioBuffer, start, len));
  }

  // Median Chroma Vector
  const chroma = new Float64Array(12);
  if (chromas.length === 1) {
    for (let i=0; i<12; i++) chroma[i] = chromas[0][i];
  } else {
    for (let i=0; i<12; i++) {
      let vals = chromas.map(c => c[i]).sort((a,b) => a - b);
      chroma[i] = vals[Math.floor(vals.length / 2)];
    }
  }

  // Normalize median chroma
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

async function _computeChromaForSegment(audioBuffer, startTime, duration) {
  const sampleRate = audioBuffer.sampleRate;
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

  const FFT_SIZE = 8192;
  const chroma = new Float64Array(12);
  const frameHop = Math.floor(FFT_SIZE / 2);

  for (let i = 0; i + FFT_SIZE < data.length; i += frameHop) {
    const frame = data.slice(i, i + FFT_SIZE);
    const mag = computeFFTMagnitude(frame, FFT_SIZE);
    accumulateChroma(mag, sampleRate, FFT_SIZE, chroma);
  }
  return chroma;
}

// Simple DFT-based magnitude spectrum
function computeFFTMagnitude(frame, fftSize) {
  const windowed = new Float64Array(fftSize);
  for (let i = 0; i < fftSize; i++) {
    windowed[i] = frame[i] * (0.5 * (1 - Math.cos((2 * Math.PI * i) / (fftSize - 1))));
  }
  
  const N = fftSize;
  const mag = new Float64Array(N / 2);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = windowed[i];

  let j = 0;
  for (let i = 1; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }

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
  for (let bin = 1; bin < mag.length; bin++) {
    const freq = bin * freqPerBin;
    if (freq < 60 || freq > 5000) continue;
    
    const midi = 12 * Math.log2(freq / 440) + 69;
    const pitchClass = ((midi % 12) + 12) % 12;
    const nearest = Math.round(pitchClass);
    const dist = Math.abs(pitchClass - nearest);
    
    const weight = Math.exp(-(dist * dist) / (2 * 0.25 * 0.25));
    // Octave weight: lower octaves matter more
    const octave = Math.floor(midi / 12);
    const octaveWeight = 1 / (1 + Math.abs(octave - 4) * 0.5);
    
    chroma[((nearest % 12) + 12) % 12] += mag[bin] * weight * octaveWeight;
  }
}

// ─── Camelot Compatibility ───────────────────────────────────────────────────
function camelotCompat(cam1, cam2, energy1 = 0.5, energy2 = 0.5) {
  let keyScore = 0;
  let label = '❌ Key Clash';

  if (cam1 === '??' || cam2 === '??') {
      keyScore = 0.3; label = '❓ Unknown';
  } else if (cam1 === cam2) {
      keyScore = 1.0; label = '✅ Perfect';
  } else {
      const n1 = parseInt(cam1), l1 = cam1.slice(-1);
      const n2 = parseInt(cam2), l2 = cam2.slice(-1);
      if (!isNaN(n1) && !isNaN(n2)) {
          if (n1 === n2 && l1 !== l2) {
              keyScore = 0.75; label = '⚠️ Safe (relative)';
          } else {
              const d = Math.min(Math.abs(n1 - n2), 12 - Math.abs(n1 - n2));
              if (d === 1 && l1 === l2) {
                  keyScore = 0.7; label = '⚠️ Safe (adjacent)';
              } else {
                  keyScore = 0.0; label = '❌ Key Clash';
              }
          }
      }
  }

  // Energy compatibility penalty (Asymmetric directionality)
  const energyDelta = energy2 - energy1; // signed
  const energyScore = energyDelta >= 0
    ? Math.min(1, 0.7 + energyDelta * 0.5)   // building energy
    : Math.max(0, 0.7 + energyDelta * 1.5);  // dropping energy

  const combined = keyScore * 0.7 + energyScore * 0.3;
  return { score: combined, label: label };
}

// ─── AI Transition Point Detection ──────────────────────────────────────────
function findTransitionPoints(audioBuffer, bpm) {
  const sr = audioBuffer.sampleRate;
  const ch = audioBuffer.getChannelData(0);
  const WIN = Math.floor(sr * 0.05); // 50ms windows 

  const energy = [];
  let peakE = 0, sumE = 0;
  
  for (let i = 0; i < ch.length - WIN; i += WIN) {
    let s = 0;
    for (let j = 0; j < WIN; j++) s += ch[i + j] ** 2;
    let currE = Math.sqrt(s / WIN);
    energy.push(currE);
    
    if (currE > peakE) peakE = currE;
    sumE += currE;
  }

  const avgE = sumE / energy.length;
  const duration = audioBuffer.duration;
  const beatPeriod = 60 / bpm;
  const barPeriod = beatPeriod * 4;

  const trackEnergy = Math.min(1, avgE / (peakE || 1));

  // OUT point: find last bar where energy stays above 70% of peak for 4 consecutive windows
  const threshold = peakE * 0.70;
  let outIdx = energy.length - 1;
  for (let i = energy.length - 1; i >= Math.floor(energy.length * 0.6); i--) {
    if (i + 4 < energy.length &&
        energy[i] > threshold && energy[i+1] > threshold &&
        energy[i+2] > threshold && energy[i+3] > threshold) {
      outIdx = i;
      break;
    }
  }
  let outPoint = Math.round((outIdx * 0.05) / barPeriod) * barPeriod;

  // IN point: find where energy first sustains above 60% of peak for 8+ consecutive windows
  let inIdx = 0;
  for (let i = 0; i < Math.floor(energy.length * 0.5); i++) {
    let sustained = true;
    for (let k = 0; k < 8; k++) {
      if (!energy[i + k] || energy[i + k] < peakE * 0.60) { sustained = false; break; }
    }
    if (sustained) { inIdx = i; break; }
  }
  let inPoint = Math.round((inIdx * 0.05) / barPeriod) * barPeriod;

  return { outPoint, inPoint, trackEnergy };
}

// ─── BPM score ───────────────────────────────────────────────────────────────
function bpmScore(a, b, maxJump = 8) {
  const direct = Math.abs(a - b);
  const dbl = Math.abs(a - b * 2);
  const half = Math.abs(a * 2 - b);
  const diff = Math.min(direct, dbl, half);
  
  // Softer falloff curve — penalize less for small overages
  const normalized = diff / Math.max(maxJump, 1);
  return Math.max(0, 1 - normalized * normalized); // quadratic falloff
}

// ─── Exports ─────────────────────────────────────────────────────────────────
window.MixMindAnalyzer = {
  detectBPM, detectKey, findTransitionPoints, camelotCompat, bpmScore, CAMELOT, NOTE_NAMES
};
