/**
 * MixMind Engine — Core Mixing Logic (Hardware Interactive)
 * Handles: audio graph setup, beat-sync, EQ, trim, pitch(rate), cue points
 */

class MixMindEngine {
  constructor() {
    this.ctx = null;
    this.decks = { A: this._blankDeck(), B: this._blankDeck() };
    this.master = null;
    this.compressor = null;
    this._initialized = false;
    this.onTransitionProgress = null;
    this.onTransitionDone = null;
  }

  init() {
    if (this._initialized) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this._buildGraph();
    this._initialized = true;
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  _blankDeck() {
    return {
      buffer: null, source: null,
      trimNode: null, gainNode: null,
      lowEQ: null, midEQ: null, highEQ: null, analyser: null,
      bpm: null, camelot: null,
      startedAt: null, startOffset: 0,
      isPlaying: false, rate: 1.0,
      transitions: null,
      cuePoint: 0
    };
  }

  _buildGraph() {
    const ctx = this.ctx;
    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -12;
    this.compressor.knee.value = 6;
    this.compressor.ratio.value = 3;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.25;

    this.master = ctx.createGain();
    this.master.gain.value = 1.0;
    this.master.connect(this.compressor);
    this.compressor.connect(ctx.destination);

    ['A', 'B'].forEach(id => {
      const d = this.decks[id];
      // Trim acts as pre-fader gain
      d.trimNode = ctx.createGain();
      d.trimNode.gain.value = 1.0;

      d.gainNode = ctx.createGain();
      d.gainNode.gain.value = 1.0; // Handled by channel fader/crossfader logic separately

      d.lowEQ = ctx.createBiquadFilter(); d.lowEQ.type = 'lowshelf'; d.lowEQ.frequency.value = 200;
      d.midEQ = ctx.createBiquadFilter(); d.midEQ.type = 'peaking'; d.midEQ.frequency.value = 1000; d.midEQ.Q.value = 0.7;
      d.highEQ = ctx.createBiquadFilter(); d.highEQ.type = 'highshelf'; d.highEQ.frequency.value = 8000;

      d.analyser = ctx.createAnalyser(); d.analyser.fftSize = 256;

      d.trimNode.connect(d.lowEQ);
      d.lowEQ.connect(d.midEQ);
      d.midEQ.connect(d.highEQ);
      d.highEQ.connect(d.gainNode);
      d.gainNode.connect(d.analyser);
      d.analyser.connect(this.master);
    });
  }

  loadBuffer(deckId, audioBuffer, bpm, camelot, transitions) {
    const d = this.decks[deckId];
    this._stopDeck(deckId);
    d.buffer = audioBuffer;
    d.bpm = bpm;
    d.camelot = camelot;
    d.transitions = transitions;
    d.startOffset = 0;
    d.cuePoint = 0;
  }

  play(deckId, offsetSeconds = null) {
    this.resume();
    const d = this.decks[deckId];
    if (!d.buffer) return;
    this._stopDeck(deckId);
    if (offsetSeconds !== null) d.startOffset = offsetSeconds;

    const src = this.ctx.createBufferSource();
    src.buffer = d.buffer;
    src.playbackRate.value = d.rate;
    src.connect(d.trimNode);
    src.start(0, d.startOffset);

    d.source = src;
    d.startedAt = this.ctx.currentTime;
    d.isPlaying = true;
    src.onended = () => { d.isPlaying = false; };
  }

  _stopDeck(deckId) {
    const d = this.decks[deckId];
    if (d.source) {
      try { d.source.stop(); } catch (_) {}
      d.source.disconnect();
      d.source = null;
    }
    d.isPlaying = false;
  }

  pause(deckId) {
    const d = this.decks[deckId];
    if (!d.isPlaying) return;
    d.startOffset = this.getCurrentTime(deckId);
    this._stopDeck(deckId);
  }

  jumpTo(deckId, timeSeconds) {
    const d = this.decks[deckId];
    const wasPlaying = d.isPlaying;
    if (wasPlaying) {
      this.play(deckId, timeSeconds);
    } else {
      d.startOffset = timeSeconds;
    }
  }

  getCurrentTime(deckId) {
    const d = this.decks[deckId];
    if (!d.isPlaying || d.startedAt === null) return d.startOffset;
    return d.startOffset + (this.ctx.currentTime - d.startedAt) * d.rate;
  }

  // ── Manual Hardware Controls ──

  setRate(deckId, rate) {
    const d = this.decks[deckId];
    d.rate = rate;
    if (d.isPlaying && d.source) {
      // Linear ramp to avoid audio pop, though direct set is usually fine for rate
      d.source.playbackRate.setTargetAtTime(rate, this.ctx.currentTime, 0.05);
    }
  }

  setTrim(deckId, db) {
    // Convert dB to linear gain: 10^(dB/20)
    const gain = Math.pow(10, db / 20);
    this.decks[deckId].trimNode.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.01);
  }

  setEQ(deckId, band, dbVal) {
    const d = this.decks[deckId];
    const node = band === 'low' ? d.lowEQ : band === 'mid' ? d.midEQ : d.highEQ;
    node.gain.setTargetAtTime(dbVal, this.ctx.currentTime, 0.01);
  }

  // Set the linear volume (0.0 to 1.0) coming from the channel fader.
  setVolume(deckId, val) {
    this.decks[deckId].gainNode.gain.setTargetAtTime(val, this.ctx.currentTime, 0.01);
  }

  // Set crossfader via separate system, usually combining with channel fader
  // val: 0 = full A, 1 = full B
  setCrossfader(val) {
    const gainA = Math.cos(val * (Math.PI / 2));
    const gainB = Math.sin(val * (Math.PI / 2));
    // Store global crossfader state to multiply with faders if needed. For now, directly applying to gainNode alongside channel vol is complex. 
    // In Pro DJs, crossfader is purely an assignable cut. Let's just use it to scale the final output.
    // Actually, it's simpler to manage a Crossfader node inside the mixer.
    // Hack: we will apply the crossfader multiplier inside the app.js logic so the user can use BOTH the volume fader AND the crossfader.
  }

  getLevel(deckId) {
    const d = this.decks[deckId];
    if (!d.analyser) return 0;
    const data = new Uint8Array(d.analyser.frequencyBinCount);
    d.analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i] - 128) / 128;
      if (v > peak) peak = v;
    }
    return peak;
  }

  // ── Auto Mix ──
  autoMix(fromId, toId, fadeDuration = 16) {
    this.resume();
    const dFrom = this.decks[fromId], dTo = this.decks[toId];
    if (!dFrom.isPlaying || !dTo.buffer) return { error: `Active deck must be playing & next deck loaded.` };

    const bpmFrom = (dFrom.bpm * dFrom.rate) || 120;
    const bpmTo = dTo.bpm || 120;
    const beatPeriod = 60 / bpmFrom;
    const barPeriod = beatPeriod * 4;

    // AI Phrase Matching: find next proper 4-bar drop
    const posFrom = this.getCurrentTime(fromId);
    const barsElapsed = posFrom / barPeriod;
    const nextBar = (Math.floor(barsElapsed) + 2) * barPeriod;
    const delayUntilNextBar = nextBar - posFrom;
    const startTimeTo = this.ctx.currentTime + Math.max(0, delayUntilNextBar);

    // Sync tempo precisely 
    const targetToRate = bpmFrom / bpmTo;
    this.setRate(toId, targetToRate);
    
    // Jump to ML extracted in-point
    const inOffset = dTo.transitions ? dTo.transitions.inPoint : 0;
    
    if (dTo.source) { try { dTo.source.stop(); } catch (_) {} }
    const srcTo = this.ctx.createBufferSource();
    srcTo.buffer = dTo.buffer;
    srcTo.playbackRate.value = targetToRate;
    srcTo.connect(dTo.trimNode);
    srcTo.start(startTimeTo, inOffset);
    dTo.source = srcTo;
    dTo.startedAt = startTimeTo;
    dTo.startOffset = inOffset;
    dTo.isPlaying = true;

    // Isolate EQs dynamically
    dTo.lowEQ.gain.cancelScheduledValues(this.ctx.currentTime);
    dTo.gainNode.gain.cancelScheduledValues(this.ctx.currentTime);
    dTo.lowEQ.gain.setValueAtTime(-26, startTimeTo);

    const phase1End = startTimeTo + fadeDuration * 0.5;
    const endTime = startTimeTo + fadeDuration;

    // Isolator Swap
    dFrom.lowEQ.gain.linearRampToValueAtTime(-26, phase1End);
    dTo.lowEQ.gain.linearRampToValueAtTime(0, phase1End);

    dFrom.midEQ.gain.linearRampToValueAtTime(-10, phase1End);
    dFrom.midEQ.gain.linearRampToValueAtTime(0, endTime);

    if (this.onTransitionProgress) {
      const startMs = (startTimeTo - this.ctx.currentTime) * 1000;
      const durationMs = fadeDuration * 1000;
      let startReal = Date.now() + startMs;
      const tick = () => {
        const elapsed = Date.now() - startReal;
        // Sigmoid easing for professional smoother curve than linear
        let rawPct = Math.min(1, Math.max(0, elapsed / durationMs));
        let progress = rawPct < 0.5 ? 2 * rawPct * rawPct : -1 + (4 - 2 * rawPct) * rawPct;
        
        this.onTransitionProgress(progress, fromId, toId);
        
        if (rawPct < 1) requestAnimationFrame(tick);
        else {
            this._stopDeck(fromId);
            dFrom.lowEQ.gain.value = 0;
            if (this.onTransitionDone) this.onTransitionDone(fromId, toId);
        }
      };
      setTimeout(tick, startMs);
    }
    return { success: true };
  }
}

window.MixMindEngine = MixMindEngine;
