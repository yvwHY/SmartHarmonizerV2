/**
 * Name: Yu Ting Liao
 * Project: Digital Choir V3 — Realtime Choir Simulator
 * Version: Blob Opera style, Chrome 130+ safe
 *
 * Architecture:
 *   User sings → detected as Soprano (highest voice)
 *   Three pitch shifters generate Alto, Tenor, Bass automatically
 *   Each voice snaps to the nearest chord tone within its own MIDI range
 *   Key is estimated in real time from singing history
 *   No hand detection — choir always active when singing
 *   Each voice has an individual mute toggle (click the blob or the button)
 */

// ---------------------------------------------------------------------------
// Voice definitions — MIDI ranges for each choir part
// ---------------------------------------------------------------------------
const VOICES = [
  { name: "Soprano", range: [57, 84], color: [255, 220, 200] },
  { name: "Alto",    range: [48, 72], color: [200, 240, 255] },
  { name: "Tenor",   range: [42, 66], color: [180, 255, 210] },
  { name: "Bass",    range: [28, 57], color: [220, 190, 255] },
];

// Mute state — true = muted. Soprano starts unmuted (it's the user's own voice).
const voiceMuted = [false, false, false, false];

// ---------------------------------------------------------------------------
// Smart harmony — key estimation + chord tone snapping
// ---------------------------------------------------------------------------
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];
const CHORD_TONES = [0, 4, 7];

const pitchHist = new Array(12).fill(0);

function updateKeyHistory(freqHz) {
  const midi = Math.round(12 * Math.log2(freqHz / 440) + 69);
  const pc   = ((midi % 12) + 12) % 12;
  pitchHist[pc] += 1;
  for (let i = 0; i < 12; i++) pitchHist[i] *= 0.995;
}

function estimateKey() {
  let bestScore = -1, bestRoot = 0, bestScale = MAJOR_SCALE;
  for (let root = 0; root < 12; root++) {
    for (const scale of [MAJOR_SCALE, MINOR_SCALE]) {
      let score = 0;
      for (const interval of scale) score += pitchHist[(root + interval) % 12];
      if (score > bestScore) { bestScore = score; bestRoot = root; bestScale = scale; }
    }
  }
  return { root: bestRoot, scale: bestScale };
}

function snapToChordToneInRange(targetMidi, key, minMidi, maxMidi) {
  const candidates = [];
  for (let oct = -3; oct <= 3; oct++) {
    for (const interval of CHORD_TONES) {
      const m = key.root + interval + oct * 12 + 60;
      if (m >= minMidi && m <= maxMidi) candidates.push(m);
    }
  }
  if (candidates.length === 0) return targetMidi;
  return candidates.reduce((best, m) =>
    Math.abs(m - targetMidi) < Math.abs(best - targetMidi) ? m : best
  );
}

function midiToHz(midi)       { return 440 * Math.pow(2, (midi - 69) / 12); }
function midiToShift(hz, mid) { return 12 * Math.log2(midiToHz(mid) / hz); }

// ---------------------------------------------------------------------------
// p5 + audio state
// ---------------------------------------------------------------------------
let video;
let mic, sopranoDry, analyser, pitchBuffer;
let pitchShifters = []; // index 0=Alto, 1=Tenor, 2=Bass
let isStarted = false;
let currentFreq = 0;

let voiceAmps    = [0, 0, 0, 0];
let voicePitches = [0, 0, 0, 0];
let mouthPhase   = [0, 0, 0, 0];

const scaleArr = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

// ---------------------------------------------------------------------------
// Toggle mute for a voice index (called from HTML buttons and mousePressed)
// ---------------------------------------------------------------------------
function toggleMute(index) {
  voiceMuted[index] = !voiceMuted[index];

  if (index === 0) {
    // Soprano = dry mic signal through a Gain node
    if (sopranoDry) sopranoDry.gain.rampTo(voiceMuted[0] ? 0 : 1, 0.05);
  } else {
    // Alto/Tenor/Bass = pitch shifters [index-1]
    const ps = pitchShifters[index - 1];
    if (ps) ps.wet.rampTo(voiceMuted[index] ? 0 : 0.85, 0.05);
  }

  // Sync the mute button visuals in index.html
  syncMuteButtons();
}

function syncMuteButtons() {
  for (let i = 0; i < 4; i++) {
    const btn = document.getElementById('mute-btn-' + i);
    if (!btn) continue;
    const muted = voiceMuted[i];
    btn.textContent  = muted ? 'Unmute' : 'Mute';
    btn.style.opacity       = muted ? '1' : '0.55';
    btn.style.borderColor   = muted ? '#ff6b6b' : 'rgba(255,255,255,0.25)';
    btn.style.color         = muted ? '#ff6b6b' : 'rgba(255,255,255,0.7)';
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
function setup() {
  createCanvas(windowWidth, windowHeight);
  video = createCapture(VIDEO);
  video.size(1, 1);
  video.hide();
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function startApp() {
  if (isStarted) return;

  try {
    await Tone.start();

    mic = new Tone.UserMedia();
    await mic.open();

    let streamToUse =
      mic._stream ||
      (mic.stream && mic.stream._nativeStream) ||
      mic.stream;

    if (!streamToUse || !(streamToUse instanceof MediaStream)) {
      streamToUse = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    }

    // Soprano — dry signal via a Gain node so we can mute it independently
    sopranoDry = new Tone.Gain(1).toDestination();
    mic.connect(sopranoDry);

    // Alto, Tenor, Bass pitch shifters
    for (let i = 0; i < 3; i++) {
      const ps = new Tone.PitchShift({ pitch: 0, windowSize: 0.08 }).toDestination();
      ps.wet.value = 0.85;
      mic.connect(ps);
      pitchShifters.push(ps);
    }

    // AnalyserNode for YIN
    const rawCtx  = Tone.getContext().rawContext;
    analyser      = rawCtx.createAnalyser();
    analyser.fftSize = 2048;
    pitchBuffer   = new Float32Array(analyser.fftSize);
    const micSrc  = rawCtx.createMediaStreamSource(streamToUse);
    micSrc.connect(analyser);

    const ms = document.getElementById('model-status');
    if (ms) { ms.innerHTML = 'Ready'; ms.style.color = '#00ffcc'; }

    syncMuteButtons();
    isStarted = true;

  } catch (e) {
    console.error('Start error:', e);
    const ms = document.getElementById('model-status');
    if (ms) { ms.innerHTML = 'Error: ' + e.message; ms.style.color = '#ff4444'; }
  }
}

// ---------------------------------------------------------------------------
// YIN pitch detection
// ---------------------------------------------------------------------------
function yinPitch(buffer, sampleRate) {
  const threshold = 0.15;
  const halfLen   = Math.floor(buffer.length / 2);
  const yinBuf    = new Float32Array(halfLen);

  for (let tau = 0; tau < halfLen; tau++) {
    let sum = 0;
    for (let i = 0; i < halfLen; i++) {
      const d = buffer[i] - buffer[i + tau];
      sum += d * d;
    }
    yinBuf[tau] = sum;
  }

  yinBuf[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau < halfLen; tau++) {
    runningSum  += yinBuf[tau];
    yinBuf[tau] *= tau / runningSum;
  }

  let tau = 2;
  while (tau < halfLen) {
    if (yinBuf[tau] < threshold) {
      while (tau + 1 < halfLen && yinBuf[tau + 1] < yinBuf[tau]) tau++;
      break;
    }
    tau++;
  }

  if (tau === halfLen || yinBuf[tau] >= threshold) return -1;

  const x0 = tau > 1 ? tau - 1 : tau;
  const x2 = tau + 1 < halfLen ? tau + 1 : tau;
  let betterTau;
  if (x0 === tau) {
    betterTau = yinBuf[tau] <= yinBuf[x2] ? tau : x2;
  } else if (x2 === tau) {
    betterTau = yinBuf[tau] <= yinBuf[x0] ? tau : x0;
  } else {
    const s0 = yinBuf[x0], s1 = yinBuf[tau], s2 = yinBuf[x2];
    betterTau = tau + (s2 - s0) / (2 * (2 * s1 - s2 - s0));
  }

  return sampleRate / betterTau;
}

// ---------------------------------------------------------------------------
// Update pitch each frame
// ---------------------------------------------------------------------------
function updatePitch() {
  if (!analyser) return;
  analyser.getFloatTimeDomainData(pitchBuffer);

  let rms = 0;
  for (let i = 0; i < pitchBuffer.length; i++) rms += pitchBuffer[i] * pitchBuffer[i];
  rms = Math.sqrt(rms / pitchBuffer.length);

  if (rms < 0.008) { currentFreq = lerp(currentFreq, 0, 0.12); return; }

  const sampleRate = Tone.getContext().rawContext.sampleRate;
  const detected   = yinPitch(pitchBuffer, sampleRate);
  if (detected > 60 && detected < 1400) {
    currentFreq = lerp(currentFreq, detected, 0.3);
  } else {
    currentFreq = lerp(currentFreq, 0, 0.08);
  }
}

// ---------------------------------------------------------------------------
// Choir DSP
// ---------------------------------------------------------------------------
function updateChoirDSP() {
  if (!pitchShifters.length || currentFreq < 50) {
    for (const ps of pitchShifters) ps.wet.rampTo(0, 0.2);
    return;
  }

  updateKeyHistory(currentFreq);
  const key       = estimateKey();
  const inputMidi = 12 * Math.log2(currentFreq / 440) + 69;

  voicePitches[0] = inputMidi;

  const harmonyVoices = [VOICES[1], VOICES[2], VOICES[3]];
  const searchOffsets = [-5, -12, -19];

  harmonyVoices.forEach((voice, i) => {
    const targetMidi = snapToChordToneInRange(
      inputMidi + searchOffsets[i], key, voice.range[0], voice.range[1]
    );
    voicePitches[i + 1]      = targetMidi;
    pitchShifters[i].pitch   = midiToShift(currentFreq, targetMidi);
    // Only set wet if not muted
    if (!voiceMuted[i + 1]) pitchShifters[i].wet.rampTo(0.85, 0.05);
  });
}

// ---------------------------------------------------------------------------
// Draw loop
// ---------------------------------------------------------------------------
function draw() {
  background(8, 8, 16);

  if (isStarted) {
    updatePitch();
    updateChoirDSP();
  }

  drawChoir();
  updateUI();
}

// ---------------------------------------------------------------------------
// Draw the four choir blobs
// ---------------------------------------------------------------------------
function drawChoir() {
  const singing = currentFreq > 50;
  const rms     = getAmplitude();

  for (let i = 0; i < 4; i++) {
    const muted  = voiceMuted[i];
    // Muted voices have very low, still animation
    const target = (!singing || muted)
      ? 0.04
      : (0.4 + rms * 1.2 + noise(frameCount * 0.04 + i * 10) * 0.15);
    voiceAmps[i]  = lerp(voiceAmps[i], target, 0.12);
    mouthPhase[i] += 0.08 + voiceAmps[i] * 0.12;
  }

  const positions = getVoicePositions();
  const labels    = ["Soprano\n(you)", "Alto", "Tenor", "Bass"];

  for (let i = 0; i < 4; i++) {
    const [bx, by]   = positions[i];
    const amp        = voiceAmps[i];
    const [r, g, b]  = VOICES[i].color;
    const muted      = voiceMuted[i];

    drawBlob(bx, by, amp, r, g, b, mouthPhase[i], singing && i === 0, muted);

    // Voice label
    noStroke();
    fill(r, g, b, muted ? 80 : 180);
    textAlign(CENTER, TOP);
    textSize(13);
    textFont('monospace');
    text(labels[i], bx, by + blobRadius(amp) + 18);

    // Note name
    if (singing && !muted && voicePitches[i] > 0) {
      const m    = Math.round(voicePitches[i]);
      const note = scaleArr[((m % 12) + 12) % 12];
      fill(r, g, b, 120);
      textSize(11);
      text(note, bx, by + blobRadius(amp) + 36);
    }

    // "MUTED" label over blob
    if (muted) {
      fill(255, 80, 80, 180);
      textSize(11);
      textAlign(CENTER, CENTER);
      textFont('monospace');
      text('MUTED', bx, by);
    }
  }

  // Key display
  if (singing) {
    const key      = estimateKey();
    const keyName  = scaleArr[key.root];
    const modeName = key.scale === MAJOR_SCALE ? 'major' : 'minor';
    fill(255, 255, 255, 60);
    textAlign(CENTER, BOTTOM);
    textSize(12);
    textFont('monospace');
    text(`Key: ${keyName} ${modeName}`, width / 2, height - 60);
  }
}

function blobRadius(amp) { return 55 + amp * 30; }

function getVoicePositions() {
  const y   = height * 0.46;
  const gap = width / 5;
  return [
    [gap * 1, y],
    [gap * 2, y],
    [gap * 3, y],
    [gap * 4, y],
  ];
}

function drawBlob(x, y, amp, r, g, b, phase, isUser, muted) {
  const baseR   = blobRadius(amp);
  const opacity = muted ? 0.35 : 1;

  // Outer glow
  noFill();
  stroke(r, g, b, (20 + amp * 30) * opacity);
  strokeWeight(baseR * 0.35);
  ellipse(x, y, baseR * 2.6);

  // Body
  noStroke();
  fill(r, g, b, (200 + amp * 40) * opacity);
  const bodyW = baseR * 2 + sin(phase * 0.7) * amp * 8;
  const bodyH = baseR * 2.1 + cos(phase * 0.5) * amp * 6;
  ellipse(x, y, bodyW, bodyH);

  // Highlight
  fill(255, 255, 255, (50 + amp * 40) * opacity);
  ellipse(x - baseR * 0.2, y - baseR * 0.25, baseR * 0.55, baseR * 0.4);

  // Mouth
  const mouthW = baseR * 0.55;
  const mouthH = muted ? 3 : max(2, amp * baseR * 0.55);
  fill(20, 10, 30, 220 * opacity);
  noStroke();
  ellipse(x, y + baseR * 0.28, mouthW, mouthH);

  // Eyes — X eyes when muted
  fill(20, 10, 30, 200 * opacity);
  const eyeY   = y - baseR * 0.15;
  const eyeGap = baseR * 0.22;
  const eyeR   = baseR * 0.13;
  if (muted) {
    // Draw X eyes
    stroke(20, 10, 30, 200);
    strokeWeight(2);
    const s = eyeR * 0.6;
    line(x - eyeGap - s, eyeY - s, x - eyeGap + s, eyeY + s);
    line(x - eyeGap + s, eyeY - s, x - eyeGap - s, eyeY + s);
    line(x + eyeGap - s, eyeY - s, x + eyeGap + s, eyeY + s);
    line(x + eyeGap + s, eyeY - s, x + eyeGap - s, eyeY + s);
    noStroke();
  } else {
    ellipse(x - eyeGap, eyeY, eyeR, eyeR);
    ellipse(x + eyeGap, eyeY, eyeR, eyeR);
  }

  // User halo
  if (isUser) {
    noFill();
    stroke(255, 255, 200, 120);
    strokeWeight(1.5);
    ellipse(x, y, bodyW + 14, bodyH + 14);
    noStroke();
  }
}

// ---------------------------------------------------------------------------
// Click on canvas — toggle mute if clicking on a blob
// ---------------------------------------------------------------------------
function mousePressed() {
  if (!isStarted) return;
  const positions = getVoicePositions();
  for (let i = 0; i < 4; i++) {
    const [bx, by] = positions[i];
    const r = blobRadius(voiceAmps[i]);
    if (dist(mouseX, mouseY, bx, by) < r) {
      toggleMute(i);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
function getAmplitude() {
  if (!analyser) return 0;
  let sum = 0;
  for (let i = 0; i < pitchBuffer.length; i++) sum += pitchBuffer[i] * pitchBuffer[i];
  return Math.sqrt(sum / pitchBuffer.length) * 6;
}

// ---------------------------------------------------------------------------
function updateUI() {
  const singing = currentFreq > 50;
  const ms = document.getElementById('model-status');
  if (ms && isStarted) ms.innerHTML = singing ? 'Singing' : 'Listening';

  const nd = document.getElementById('note-display');
  if (nd) {
    if (singing) {
      const m = Math.round(12 * Math.log2(currentFreq / 440) + 69);
      nd.innerHTML = scaleArr[((m % 12) + 12) % 12] || '--';
    } else {
      nd.innerHTML = '--';
    }
  }

  const hm = document.getElementById('harmony-mode');
  if (hm) hm.innerHTML = singing ? 'SATB Choir' : 'Silent';
}

// ---------------------------------------------------------------------------
function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}