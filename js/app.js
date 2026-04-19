/**
 * MixMind Web - DJ Hardware Controller
 */

document.addEventListener('DOMContentLoaded', () => {
  const engine = new MixMindEngine();
  const waveA = new WaveformRenderer(document.getElementById('waveA'), '#f5b041');
  const waveB = new WaveformRenderer(document.getElementById('waveB'), '#f5b041');
  
  const ui = {
    A: {
      file: document.getElementById('file-A'),
      jog: document.getElementById('jog-A'),
      loadBtn: document.getElementById('load-A-btn'),
      bpm: document.getElementById('bpm-A'),
      key: document.getElementById('key-A'),
      play: document.getElementById('play-A'),
      cue: document.getElementById('cue-A'),
      vu: document.getElementById('vu-A'),
      vol: document.getElementById('vol-A'),
      pitch: document.querySelector('#deck-A .pitch-fader'),
      pads: document.querySelectorAll('#deck-A .pad'),
    },
    B: {
      file: document.getElementById('file-B'),
      jog: document.getElementById('jog-B'),
      loadBtn: document.getElementById('load-B-btn'),
      bpm: document.getElementById('bpm-B'),
      key: document.getElementById('key-B'),
      play: document.getElementById('play-B'),
      cue: document.getElementById('cue-B'),
      vu: document.getElementById('vu-B'),
      vol: document.getElementById('vol-B'),
      pitch: document.querySelector('#deck-B .pitch-fader'),
      pads: document.querySelectorAll('#deck-B .pad'),
    },
    Mixer: {
      compatScore: document.getElementById('compat-score'),
      compatBpm: document.getElementById('compat-bpm'),
      compatKey: document.getElementById('compat-key'),
      crossfader: document.getElementById('crossfader'),
      autoMix: document.getElementById('auto-mix-btn'),
    },
    status: document.getElementById('app-status')
  };

  const state = {
    A: { buffer: null, analysis: null, isPlaying: false, baseBpm: 0, hotCues: [] },
    B: { buffer: null, analysis: null, isPlaying: false, baseBpm: 0, hotCues: [] },
    crossfader: 0.5,
    activeDeck: 'A'
  };

  // The pad names to reset after changing track
  const PAD_DEFAULTS = [
    "HOT CUE", "PAD FX1", "BEAT JUMP", "SAMPLER",
    "KEYBOARD", "PAD FX2", "BEAT LOOP", "KEY SHIFT"
  ];

  const ensureInit = () => {
    engine.init();
    engine.resume();
  };

  engine.onDeckEnded = (id) => {
    state[id].isPlaying = false;
    ui[id].jog.classList.remove('spinning');
    ui[id].play.classList.remove('active');
    ui[id].play.style.boxShadow = '';
    const wave = id === 'A' ? waveA : waveB;
    wave.stopAnimation();
  };

  // ─── KNOB DRAG LOGIC ──────────────────────────────────────────
  function initKnobs() {
    const channelStrips = document.querySelectorAll('.channel-strip');
    ['A', 'B'].forEach((id, index) => {
      const strip = channelStrips[index];
      const knobs = strip.querySelectorAll('.knob');
      
      const bindings = [
        { type: 'trim', band: null },
        { type: 'eq', band: 'high' },
        { type: 'eq', band: 'mid' },
        { type: 'eq', band: 'low' }
      ];

      knobs.forEach((knob, kIndex) => {
        let isDragging = false;
        let startY, startVal;
        
        if (!knob.dataset.val) knob.dataset.val = 0.5;
        
        const updateEngine = (val) => {
          ensureInit();
          const { type, band } = bindings[kIndex];
          if (type === 'eq') {
            // Trim to -26dB bottom, 0dB middle, +6dB top
            let db = val < 0.5 ? (val * 2 * 26) - 26 : (val - 0.5) * 2 * 6;
            engine.setEQ(id, band, db);
          } else if (type === 'trim') {
            let db = val < 0.5 ? (val * 2 * 24) - 24 : (val - 0.5) * 2 * 6;
            engine.setTrim(id, db);
          }
        };

        const renderVisual = (val) => {
          const deg = (val - 0.5) * 300; 
          knob.style.transform = `rotate(${deg}deg)`;
        };

        renderVisual(0.5);
        if(bindings[kIndex].type === 'eq') {
          // Explicitly save the DOM node for automated AutoMix referencing
          ui[id][`eq${bindings[kIndex].band.charAt(0).toUpperCase() + bindings[kIndex].band.slice(1)}`] = knob;
        }

        knob.addEventListener('mousedown', (e) => {
          isDragging = true;
          startY = e.clientY;
          startVal = parseFloat(knob.dataset.val);
          document.body.style.cursor = 'ns-resize';
        });

        window.addEventListener('mousemove', (e) => {
          if (!isDragging) return;
          const dy = startY - e.clientY;
          let currentVal = Math.min(1, Math.max(0, startVal + dy / 150));
          knob.dataset.val = currentVal;
          renderVisual(currentVal);
          updateEngine(currentVal);
        });

        window.addEventListener('mouseup', () => {
          if(isDragging) {
            isDragging = false;
            document.body.style.cursor = 'default';
          }
        });
      });
    });
  }
  initKnobs();

  // ─── GLOBAL VOLUME CALC (Channel + Crossfader) ───────────────────
  const updateVolumes = () => {
    ensureInit();
    const xFade = state.crossfader;
    const volA = parseFloat(ui.A.vol.value);
    const volB = parseFloat(ui.B.vol.value);
    
    // Equal power curve for crossfader
    const xGainA = Math.cos(xFade * (Math.PI / 2));
    const xGainB = Math.sin(xFade * (Math.PI / 2));

    engine.setVolume('A', volA * xGainA);
    engine.setVolume('B', volB * xGainB);
  };
  ui.A.vol.addEventListener('input', updateVolumes);
  ui.B.vol.addEventListener('input', updateVolumes);
  ui.Mixer.crossfader.addEventListener('input', (e) => {
    state.crossfader = parseFloat(e.target.value);
    updateVolumes();
  });

  // ─── FILE HANDLING & ANALYSIS ───────────────────────────────────────
  const handleFileUpload = async (deckId, file) => {
    ensureInit();
    const u = ui[deckId];
    ui.status.innerText = `ANALYZING ${deckId}...`;
    ui.status.style.color = "var(--orange)";
    u.jog.classList.add('spinning');

    try {
      const arrayBuffer = await file.arrayBuffer();
      const audioBuffer = await engine.ctx.decodeAudioData(arrayBuffer);
      state[deckId].buffer = audioBuffer;

      const bpmData = await MixMindAnalyzer.detectBPM(audioBuffer);
      const keyData = await MixMindAnalyzer.detectKey(audioBuffer);
      const transitions = MixMindAnalyzer.findTransitionPoints(audioBuffer, bpmData.bpm);
      
      state[deckId].analysis = {
        bpm: bpmData.bpm, keyName: keyData.key, mode: keyData.mode,
        camelot: keyData.camelot, outPoint: transitions.outPoint, 
        inPoint: transitions.inPoint, energy: transitions.trackEnergy
      };
      state[deckId].baseBpm = bpmData.bpm;

      // Reset Hot Cues, Pitch, and Buttons on new track
      state[deckId].hotCues = [];
      u.pads.forEach((pad, i) => {
        pad.style.background = '#222';
        pad.style.color = 'var(--orange)';
        pad.innerText = PAD_DEFAULTS[i];
      });
      u.pitch.value = 0;
      u.bpm.innerText = bpmData.bpm.toFixed(1);
      u.key.innerText = keyData.camelot;
      u.play.disabled = false;
      u.cue.disabled = false;

      engine.loadBuffer(deckId, audioBuffer, bpmData.bpm, keyData.camelot, transitions);
      const wave = deckId === 'A' ? waveA : waveB;
      wave.load(audioBuffer, transitions.outPoint, transitions.inPoint);

      ui.status.innerText = 'ENGINE READY';
      ui.status.style.color = "var(--green)";
      u.jog.classList.remove('spinning');
      updateCompatibility();
      
      // Update volume safely
      updateVolumes();

    } catch (err) {
      console.error(err);
      ui.status.innerText = 'ERROR LOADING FILE';
      ui.status.style.color = "var(--red)";
      u.jog.classList.remove('spinning');
    }
  };

  const updateCompatibility = () => {
    if (state.A.analysis && state.B.analysis) {
      const effectiveBpmA = state.A.baseBpm * (1 + parseFloat(ui.A.pitch.value)/100);
      const effectiveBpmB = state.B.baseBpm * (1 + parseFloat(ui.B.pitch.value)/100);
      
      const bpmSc = MixMindAnalyzer.bpmScore(effectiveBpmA, effectiveBpmB, 8);
      let bpmCol = bpmSc > 0.8 ? 'var(--green)' : bpmSc > 0.4 ? 'var(--gold)' : 'var(--red)';
      ui.Mixer.compatBpm.innerHTML = `BPM: <span style="color:${bpmCol}">${effectiveBpmA.toFixed(1)} → ${effectiveBpmB.toFixed(1)}</span>`;

      const keyComp = MixMindAnalyzer.camelotCompat(
        state.A.analysis.camelot, state.B.analysis.camelot, 
        state.A.analysis.energy, state.B.analysis.energy
      );
      let keyCol = keyComp.score >= 0.7 ? 'var(--green)' : keyComp.score >= 0.4 ? 'var(--gold)' : 'var(--red)';
      ui.Mixer.compatKey.innerHTML = `KEY: <span style="color:${keyCol}">${state.A.analysis.camelot} → ${state.B.analysis.camelot}</span>`;

      const total = (bpmSc * 0.6) + (keyComp.score * 0.4);
      ui.Mixer.compatScore.innerText = `${(total*100).toFixed(0)}%`;
      ui.Mixer.compatScore.style.color = total > 0.8 ? 'var(--green)' : 'var(--gold)';
      ui.Mixer.autoMix.disabled = false;
    }
  };

  // ─── TRANSPORT CONTROLS (PITCH, PLAY, CUE, PADS) ─────────────────────
  ['A', 'B'].forEach(id => {
    const u = ui[id];
    const st = state[id];

    // Pitch Slider (-10 to +10 percent)
    u.pitch.addEventListener('input', (e) => {
      ensureInit();
      const pct = parseFloat(e.target.value);
      const rate = 1 + (pct / 100); // 10% change max
      engine.setRate(id, rate);
      if(st.baseBpm) u.bpm.innerText = (st.baseBpm * rate).toFixed(1);
      updateCompatibility();
    });

    u.play.addEventListener('click', () => {
      ensureInit();
      const wave = id === 'A' ? waveA : waveB;
      if (st.isPlaying) {
        engine.pause(id);
        wave.stopAnimation();
        u.jog.classList.remove('spinning');
        u.play.classList.remove('active');
        u.play.style.boxShadow = '';
      } else {
        engine.play(id);
        wave.startAnimation(() => engine.getCurrentTime(id));
        u.jog.classList.add('spinning');
        u.play.classList.add('active');
        u.play.style.boxShadow = '0 0 15px var(--green)';
      }
      st.isPlaying = !st.isPlaying;
    });

    u.cue.addEventListener('mousedown', () => {
      ensureInit();
      const cuePoint = engine.decks[id].cuePoint || 0;
      
      if (st.isPlaying) {
        // Stop playback and jump back to cue
        engine.pause(id);
        st.isPlaying = false;
        u.jog.classList.remove('spinning');
        u.play.classList.remove('active');
        u.play.style.boxShadow = '';
        engine.jumpTo(id, cuePoint);
        
        // Temporarily play if held (standard logic)
        // For simplicity: just jump and pause.
      } else {
        // Drop new cue point
        engine.decks[id].cuePoint = engine.getCurrentTime(id);
      }
      
      u.cue.style.boxShadow = '0 0 15px var(--orange)';
      u.cue.style.color = '#fff';
    });
    
    u.cue.addEventListener('mouseup', () => {
       u.cue.style.boxShadow = '';
       u.cue.style.color = 'var(--orange)';
    });

    // 4 Hot Cues mapping
    for(let i=0; i<4; i++) {
        const pad = u.pads[i];
        pad.addEventListener('click', () => {
            ensureInit();
            if(!st.buffer) return;
            // Set hotcue if undefined
            if(st.hotCues[i] === undefined) {
               st.hotCues[i] = engine.getCurrentTime(id);
               pad.style.background = 'var(--orange)';
               pad.style.color = '#111';
               pad.innerText = `HC ${i+1}`;
            } else {
               // Jump
               engine.jumpTo(id, st.hotCues[i]);
               // If paused, force visual play head update
               const wave = id === 'A' ? waveA : waveB;
               wave._drawStatic(); // force re-render if frozen
            }
        });
    }
  });


  // ─── AUTOMIX ENGINE (BIDIRECTIONAL) ────────────────────────────────────
  ui.Mixer.autoMix.addEventListener('click', () => {
    ensureInit();
    
    // Determine direction dynamically
    const fromId = state.activeDeck;
    const toId = fromId === 'A' ? 'B' : 'A';
    
    // Validate engine states
    if (!state[fromId].buffer || !state[toId].buffer) return;
    if (!state[fromId].isPlaying) ui[fromId].play.click(); 
    
    ui.Mixer.autoMix.disabled = true;
    ui.Mixer.autoMix.classList.add('active');
    ui.status.innerText = 'MIXING IN PROGRESS...';
    ui.status.style.color = "var(--orange)";

    engine.onTransitionProgress = (pct, fId, tId) => {
      // Map crossfader progression based on direction
      // A->B means fader goes 0 to 1. B->A means fader goes 1 to 0.
      const targetCross = fId === 'A' ? pct : 1 - pct;
      ui.Mixer.crossfader.value = targetCross;
      state.crossfader = targetCross;
      updateVolumes(); 
      
      // EQ Isolator Visual Update
      let pctCut = Math.min(1, pct * 2); 
      let fLowVal = 0.5 - (0.5 * pctCut);     
      let tLowVal = 0 + (0.5 * pctCut);       
      
      const renderVisual = (knob, val) => {
         knob.dataset.val = val; 
         knob.style.transform = `rotate(${(val - 0.5) * 300}deg)`;
      }
      if(ui[fId].eqLow) renderVisual(ui[fId].eqLow, fLowVal);
      if(ui[tId].eqLow) renderVisual(ui[tId].eqLow, tLowVal);
    };
    
    engine.onTransitionDone = (fId, tId) => {
       ui.Mixer.autoMix.disabled = false;
       ui.Mixer.autoMix.classList.remove('active');
       ui.status.innerText = 'ENGINE READY';
       ui.status.style.color = "var(--green)";
       
       const waveFrom = fId === 'A' ? waveA : waveB;
       waveFrom.stopAnimation();
       ui[fId].jog.classList.remove('spinning');
       ui[fId].play.classList.remove('active');
       ui[fId].play.style.boxShadow = '';
       state[fId].isPlaying = false;
       
       // Switch the active deck permanently!
       state.activeDeck = tId;
    };

    const res = engine.autoMix(fromId, toId, 16);
    if(res.error) {
      alert(res.error);
      ui.Mixer.autoMix.disabled = false;
      ui.Mixer.autoMix.classList.remove('active');
    } else {
      const waveTo = toId === 'A' ? waveA : waveB;
      waveTo.startAnimation(() => engine.getCurrentTime(toId));
      ui[toId].jog.classList.add('spinning');
      ui[toId].play.classList.add('active');
      ui[toId].play.style.boxShadow = '0 0 15px var(--green)';
      state[toId].isPlaying = true;
    }
  });

  // ─── FILE LOAD EVENT MAP ────────────────────────────────────────────────
  ['A', 'B'].forEach(id => {
    ui[id].jog.addEventListener('click', () => ui[id].file.click());
    ui[id].loadBtn.addEventListener('click', () => ui[id].file.click());
    ui[id].file.addEventListener('change', (e) => {
      if (e.target.files.length) handleFileUpload(id, e.target.files[0]);
    });
  });

  // ─── VU METER UPDATE LOOP (FIXED AS HEIGHT BAR) ─────────────────────────
  const renderVU = () => {
    if (engine._initialized) {
      ['A', 'B'].forEach(id => {
        let level = engine.getLevel(id); 
        level = Math.min(1, level * 2.5); // scale response
        if(!state[id].isPlaying) level *= 0.1; 
        
        // Sets the height to simulate glowing LED blocks turning on
        ui[id].vu.style.height = `${level * 100}%`;
      });
    }
    requestAnimationFrame(renderVU);
  };
  requestAnimationFrame(renderVU);
});
