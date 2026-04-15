/**
 * Name: Yu Ting Liao
 * Project: Digital Choir V3 — Multi-mode Harmony
 *
 * Five harmony presets selectable at runtime:
 *   Major    — +4, +7, -5   (bright, uplifting)
 *   Minor    — +3, +7, -5   (dark, emotional)
 *   Octave   — +12, -12, +7  (full, powerful)
 *   Cluster  — +2, +5, +9   (modern, tense)
 *   Gospel   — +4, +7, +11  (soulful, lush)
 */

// ---------------------------------------------------------------------------
// Harmony presets
// ---------------------------------------------------------------------------
const PRESETS = [
  { name: 'Major', intervals: [4, 7, -5], color: '#00ffcc' },
  { name: 'Minor', intervals: [3, 7, -5], color: '#aa88ff' },
  { name: 'Octave', intervals: [12, -12, 7], color: '#ffaa00' },
  { name: 'Cluster', intervals: [2, 5, 9], color: '#ff6688' },
  { name: 'Gospel', intervals: [4, 7, 11], color: '#88ffaa' },
];

let currentPreset = 0; // index into PRESETS

// ---------------------------------------------------------------------------
// Voice definitions (visuals)
// ---------------------------------------------------------------------------
const VOICES = [
  { name: 'Soprano', color: [255, 220, 200] },
  { name: 'Alto', color: [200, 240, 255] },
  { name: 'Tenor', color: [180, 255, 210] },
  { name: 'Bass', color: [220, 190, 255] },
];

// voiceMuted controls AUDIO output only.
// Soprano (index 0) is never sent to speakers — always audio-silent.
// For visuals, Soprano is always drawn as active (reacts to mic input).
const voiceMuted = [true, false, false, false];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let mic, micGate, analyser, pitchBuffer;
let isStarted = false;
let isSinging = false;
let currentFreq = 0;
let lastValidFreq = 0;

let pitchShifters = [];
let voiceGains = [];
let roomReverb;

let voiceAmps = [0, 0, 0, 0];
let mouthPhase = [0, 0, 0, 0];
let voiceNotes = ['', '', '', ''];

const scaleArr = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// ---------------------------------------------------------------------------
// Preset switching
// ---------------------------------------------------------------------------
function setPreset(index) {
  currentPreset = index;
  if (!isStarted) { syncPresetButtons(); return; }

  const preset = PRESETS[index];
  pitchShifters.forEach((ps, i) => {
    ps.pitch = preset.intervals[i];
  });

  syncPresetButtons();
  updateHarmonyLabel();
}

function syncPresetButtons() {
  PRESETS.forEach((p, i) => {
    const btn = document.getElementById('preset-btn-' + i);
    if (!btn) return;
    const active = i === currentPreset;
    btn.style.background = active ? p.color : 'transparent';
    btn.style.color = active ? '#08080f' : p.color;
    btn.style.borderColor = active ? p.color : 'rgba(255,255,255,0.2)';
    btn.style.opacity = '1';
  });
}

function updateHarmonyLabel() {
  const hm = document.getElementById('harmony-mode');
  if (hm) hm.innerHTML = PRESETS[currentPreset].name;
}

// ---------------------------------------------------------------------------
// Mute
// ---------------------------------------------------------------------------
function toggleMute(index) {
  if (index === 0) return; // Soprano has no speaker output — nothing to toggle
  voiceMuted[index] = !voiceMuted[index];
  const vg = voiceGains[index - 1];
  if (vg) vg.gain.rampTo(voiceMuted[index] ? 0 : 0.8, 0.06);
  syncMuteButtons();
}

function syncMuteButtons() {
  for (let i = 0; i < 4; i++) {
    const btn = document.getElementById('mute-btn-' + i);
    if (!btn) continue;
    const m = voiceMuted[i];
    btn.textContent = m ? 'Unmute' : 'Mute';
    btn.style.opacity = m ? '1' : '0.55';
    btn.style.borderColor = m ? '#ff6b6b' : 'rgba(255,255,255,0.25)';
    btn.style.color = m ? '#ff6b6b' : 'rgba(255,255,255,0.7)';
  }
}

// ---------------------------------------------------------------------------
// Push-to-sing
// ---------------------------------------------------------------------------
function openMic() {
  if (!isStarted || isSinging) return;
  isSinging = true;
  if (micGate) micGate.gain.rampTo(1, 0.05);
  updateSingButton(true);
}

function closeMic() {
  if (!isStarted || !isSinging) return;
  isSinging = false;
  if (micGate) micGate.gain.rampTo(0, 0.15);
  currentFreq = 0;
  updateSingButton(false);
}

function updateSingButton(active) {
  const btn = document.getElementById('sing-btn');
  if (!btn) return;
  btn.textContent = active ? 'Release to stop' : 'Hold to sing';
  btn.style.background = active ? 'rgba(0,255,150,0.15)' : 'transparent';
  btn.style.borderColor = active ? '#00ff96' : 'rgba(0,255,204,0.4)';
  btn.style.color = active ? '#00ff96' : '#00ffcc';
}

function keyPressed() { if (key === ' ') { openMic(); return false; } }
function keyReleased() { if (key === ' ') { closeMic(); return false; } }

// Number keys 1-5 switch presets
function keyTyped() {
  const n = parseInt(key);
  if (n >= 1 && n <= PRESETS.length) setPreset(n - 1);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
function setup() {
  createCanvas(windowWidth, windowHeight);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function startApp() {
  if (isStarted) return;

  const setStatus = (msg, color) => {
    const el = document.getElementById('model-status');
    if (el) { el.innerHTML = msg; el.style.color = color || '#ffcc00'; }
  };

  try {
    setStatus('Starting…');
    await Tone.start();

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });

    mic = new Tone.UserMedia();
    await mic.open();

    const rawCtx = Tone.getContext().rawContext;

    // Pitch detection — isolated, never touches speakers
    analyser = rawCtx.createAnalyser();
    analyser.fftSize = 2048;
    pitchBuffer = new Float32Array(analyser.fftSize);
    rawCtx.createMediaStreamSource(stream).connect(analyser);

    // Master: Reverb → Gain → Limiter → speakers
    const limiter = new Tone.Limiter(-2).toDestination();
    const master = new Tone.Gain(2.0).connect(limiter);

    setStatus('Loading reverb…');
    try {
      roomReverb = new Tone.Reverb({ decay: 2.0, preDelay: 0.02, wet: 0.3 });
      await Promise.race([
        roomReverb.ready,
        new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 4000)),
      ]);
      roomReverb.connect(master);
    } catch (e) {
      console.warn('Reverb failed, dry fallback');
      roomReverb = new Tone.Gain(1).connect(master);
    }

    // Mic gate
    micGate = new Tone.Gain(0);
    mic.connect(micGate);

    // Soprano is NOT routed to speakers.
    // The user hears their own voice naturally (bone conduction + air).
    // Routing it to speakers causes feedback and clashes with harmony.
    // sopranoDry intentionally omitted.

    // Three harmony voices — intervals come from the active preset
    const preset = PRESETS[currentPreset];
    for (let i = 0; i < 3; i++) {
      const ps = new Tone.PitchShift({
        pitch: preset.intervals[i],
        windowSize: 0.1,
        delayTime: 0,
        feedback: 0,
      });
      ps.wet.value = 1.0;

      const vg = new Tone.Gain(voiceMuted[i + 1] ? 0 : 0.8);
      micGate.connect(ps);
      ps.connect(vg);
      vg.connect(roomReverb);

      pitchShifters.push(ps);
      voiceGains.push(vg);
    }

    isStarted = true;
    setStatus('Ready', '#00ffcc');
    syncMuteButtons();
    syncPresetButtons();
    updateSingButton(false);
    updateHarmonyLabel();

  } catch (e) {
    console.error('Start error:', e);
    const el = document.getElementById('model-status');
    if (el) { el.innerHTML = 'Error: ' + e.message; el.style.color = '#ff4444'; }
  }
}

// ---------------------------------------------------------------------------
// YIN pitch detection (visuals only)
// ---------------------------------------------------------------------------
function yinPitch(buffer, sampleRate) {
  const threshold = 0.15;
  const halfLen = Math.floor(buffer.length / 2);
  const yinBuf = new Float32Array(halfLen);
  for (let tau = 0; tau < halfLen; tau++) {
    let sum = 0;
    for (let i = 0; i < halfLen; i++) { const d = buffer[i] - buffer[i + tau]; sum += d * d; }
    yinBuf[tau] = sum;
  }
  yinBuf[0] = 1;
  let rs = 0;
  for (let tau = 1; tau < halfLen; tau++) { rs += yinBuf[tau]; yinBuf[tau] *= tau / rs; }
  let tau = 2;
  while (tau < halfLen) {
    if (yinBuf[tau] < threshold) { while (tau + 1 < halfLen && yinBuf[tau + 1] < yinBuf[tau]) tau++; break; }
    tau++;
  }
  if (tau === halfLen || yinBuf[tau] >= threshold) return -1;
  const x0 = tau > 1 ? tau - 1 : tau;
  const x2 = tau + 1 < halfLen ? tau + 1 : tau;
  let bt;
  if (x0 === tau) bt = yinBuf[tau] <= yinBuf[x2] ? tau : x2;
  else if (x2 === tau) bt = yinBuf[tau] <= yinBuf[x0] ? tau : x0;
  else { const s0 = yinBuf[x0], s1 = yinBuf[tau], s2 = yinBuf[x2]; bt = tau + (s2 - s0) / (2 * (2 * s1 - s2 - s0)); }
  return sampleRate / bt;
}

function updatePitch() {
  if (!analyser || !isSinging) return;
  analyser.getFloatTimeDomainData(pitchBuffer);
  let rms = 0;
  for (let i = 0; i < pitchBuffer.length; i++) rms += pitchBuffer[i] * pitchBuffer[i];
  rms = Math.sqrt(rms / pitchBuffer.length);
  if (rms < 0.01) { currentFreq = lerp(currentFreq, 0, 0.1); return; }
  const detected = yinPitch(pitchBuffer, Tone.getContext().rawContext.sampleRate);
  if (detected > 60 && detected < 1400) {
    currentFreq = lerp(currentFreq, detected, 0.2);
    lastValidFreq = currentFreq;
  } else {
    currentFreq = lerp(currentFreq, 0, 0.05);
  }
}

function updateVisualNotes() {
  const freq = isSinging ? currentFreq : lastValidFreq;
  if (freq < 50) { voiceNotes.fill(''); return; }
  const inputMidi = 12 * Math.log2(freq / 440) + 69;
  voiceNotes[0] = scaleArr[((Math.round(inputMidi) % 12) + 12) % 12];
  PRESETS[currentPreset].intervals.forEach((interval, i) => {
    const m = Math.round(inputMidi + interval);
    voiceNotes[i + 1] = scaleArr[((m % 12) + 12) % 12];
    if (!voiceMuted[i + 1]) voiceGains[i].gain.rampTo(0.8, 0.1);
  });
}

// ---------------------------------------------------------------------------
// Draw
// ---------------------------------------------------------------------------
function draw() {
  background(8, 8, 16);
  if (isStarted) { updatePitch(); updateVisualNotes(); }
  drawChoir();
  updateUI();
}

function drawChoir() {
  const singing = isSinging && currentFreq > 50;
  const holding = !isSinging && lastValidFreq > 50;
  const rms = getAmplitude();
  const preset = PRESETS[currentPreset];

  for (let i = 0; i < 4; i++) {
    // Soprano (i===0) is always drawn as active regardless of voiceMuted —
    // it has no speaker output but its visual reacts to the live mic.
    const visuallyActive = (i === 0) || !voiceMuted[i];
    let target;
    if (!visuallyActive) target = 0.04;
    else if (singing) target = 0.38 + rms * 1.1 + noise(frameCount * 0.04 + i * 10) * 0.12;
    else if (holding) target = 0.07 + noise(frameCount * 0.015 + i * 10) * 0.05;
    else target = 0.04;
    voiceAmps[i] = lerp(voiceAmps[i], target, 0.12);
    mouthPhase[i] += 0.08 + voiceAmps[i] * 0.12;
  }

  const positions = getVoicePositions();

  // Interval labels for harmony voices
  const intervalLabels = PRESETS[currentPreset].intervals.map(n =>
    (n > 0 ? '+' : '') + n + ' st'
  );
  const labels = ['Soprano\n(you)', ...intervalLabels.map((l, i) => VOICES[i + 1].name + '\n' + l)];

  for (let i = 0; i < 4; i++) {
    const [bx, by] = positions[i];
    const amp = voiceAmps[i];
    const [r, g, b] = VOICES[i].color;
    // Soprano is visually active (reacts to mic) but has no speaker output.
    // Other voices show as muted only when their audio is toggled off.
    const visuallyMuted = (i !== 0) && voiceMuted[i];

    drawBlob(bx, by, amp, r, g, b, mouthPhase[i], singing && i === 0, visuallyMuted);

    noStroke();
    fill(r, g, b, visuallyMuted ? 80 : 180);
    textAlign(CENTER, TOP);
    textSize(12);
    textFont('monospace');
    text(labels[i], bx, by + blobRadius(amp) + 14);

    if ((singing || holding) && !visuallyMuted && voiceNotes[i]) {
      fill(r, g, b, holding ? 70 : 140);
      textSize(13);
      textFont('monospace');
      text(voiceNotes[i], bx, by + blobRadius(amp) + 44);
    }

    if (visuallyMuted) {
      fill(255, 80, 80, 160);
      textSize(11);
      textAlign(CENTER, CENTER);
      text('MUTED', bx, by);
    }
  }

  // Preset name in centre bottom
  fill(255, 255, 255, singing ? 70 : holding ? 45 : 20);
  textAlign(CENTER, BOTTOM);
  textSize(12);
  textFont('monospace');
  text(preset.name + ' harmony', width / 2, height - 72);

  if (!isSinging && lastValidFreq < 50) {
    fill(255, 255, 255, 22);
    textAlign(CENTER, CENTER);
    textSize(13);
    textFont('monospace');
    text('Hold SPACE or the button below to sing', width / 2, height * 0.82);
  }
  if (holding) {
    fill(180, 255, 210, 45);
    textAlign(CENTER, CENTER);
    textSize(11);
    textFont('monospace');
    text('holding chord...', width / 2, height * 0.82);
  }
}

function blobRadius(amp) { return 52 + amp * 28; }

function getVoicePositions() {
  const y = height * 0.44, gap = width / 5;
  return [[gap, y], [gap * 2, y], [gap * 3, y], [gap * 4, y]];
}

function drawBlob(x, y, amp, r, g, b, phase, isUser, muted) {
  const baseR = blobRadius(amp), op = muted ? 0.32 : 1;
  noFill();
  stroke(r, g, b, (18 + amp * 28) * op); strokeWeight(baseR * 0.33);
  ellipse(x, y, baseR * 2.6);
  noStroke();
  fill(r, g, b, (195 + amp * 45) * op);
  const bw = baseR * 2 + sin(phase * 0.7) * amp * 7;
  const bh = baseR * 2.1 + cos(phase * 0.5) * amp * 5;
  ellipse(x, y, bw, bh);
  fill(255, 255, 255, (45 + amp * 38) * op);
  ellipse(x - baseR * 0.2, y - baseR * 0.25, baseR * 0.52, baseR * 0.38);
  fill(20, 10, 30, 215 * op); noStroke();
  ellipse(x, y + baseR * 0.28, baseR * 0.52, muted ? 3 : max(2, amp * baseR * 0.52));
  const eyeY = y - baseR * 0.15, eyeGap = baseR * 0.22, eyeR = baseR * 0.12;
  if (muted) {
    stroke(20, 10, 30, 200); strokeWeight(1.8);
    const s = eyeR * 0.55;
    line(x - eyeGap - s, eyeY - s, x - eyeGap + s, eyeY + s);
    line(x - eyeGap + s, eyeY - s, x - eyeGap - s, eyeY + s);
    line(x + eyeGap - s, eyeY - s, x + eyeGap + s, eyeY + s);
    line(x + eyeGap + s, eyeY - s, x + eyeGap - s, eyeY + s);
    noStroke();
  } else {
    fill(20, 10, 30, 195 * op);
    ellipse(x - eyeGap, eyeY, eyeR, eyeR);
    ellipse(x + eyeGap, eyeY, eyeR, eyeR);
  }
  if (isUser) {
    noFill(); stroke(255, 255, 200, 110); strokeWeight(1.5);
    ellipse(x, y, bw + 12, bh + 12); noStroke();
  }
}

function mousePressed() {
  if (!isStarted) return;
  const pos = getVoicePositions();
  for (let i = 0; i < 4; i++) {
    const [bx, by] = pos[i];
    if (dist(mouseX, mouseY, bx, by) < blobRadius(voiceAmps[i])) { toggleMute(i); return; }
  }
}

function getAmplitude() {
  if (!analyser || !isSinging) return 0;
  let sum = 0;
  for (let i = 0; i < pitchBuffer.length; i++) sum += pitchBuffer[i] * pitchBuffer[i];
  return Math.sqrt(sum / pitchBuffer.length) * 6;
}

function updateUI() {
  const ms = document.getElementById('model-status');
  if (ms && isStarted) {
    if (isSinging && currentFreq > 50) ms.innerHTML = 'Singing';
    else if (isSinging) ms.innerHTML = 'Listening';
    else if (lastValidFreq > 50) ms.innerHTML = 'Holding';
    else ms.innerHTML = 'Ready';
  }
  const nd = document.getElementById('note-display');
  if (nd) {
    const f = isSinging ? currentFreq : lastValidFreq;
    nd.innerHTML = f > 50
      ? scaleArr[((Math.round(12 * Math.log2(f / 440) + 69) % 12) + 12) % 12] || '--'
      : '--';
  }
  const hm = document.getElementById('harmony-mode');
  if (hm) hm.innerHTML = PRESETS[currentPreset].name;
}

function windowResized() { resizeCanvas(windowWidth, windowHeight); }