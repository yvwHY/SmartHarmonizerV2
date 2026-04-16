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

let currentPreset = 0;   // index into PRESETS
let autoMode = true; // auto-detect harmony vs manual

// Pitch class histogram — tracks which notes you've been singing
const pitchHist = new Array(12).fill(0);
// Pitch stability tracking — how much pitch is moving frame to frame
let lastDetectedMidi = 0;
let pitchStability = 0; // 0=moving, 1=very stable
let stableFrames = 0;

// Semitone offsets that distinguish major vs minor context:
// major third interval (4 semitones) above root = major feel
// minor third interval (3 semitones) above root = minor feel
const MAJOR_THIRD_WEIGHT = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]; // +4 from any root
const MINOR_THIRD_WEIGHT = [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]; // +3 from any root

function updatePitchHistory(midi) {
  const pc = ((Math.round(midi) % 12) + 12) % 12;
  pitchHist[pc] += 1;
  for (let i = 0; i < 12; i++) pitchHist[i] *= 0.992; // slow decay
}

// Returns 'major', 'minor', or 'neutral' based on singing history
function detectMajorMinor() {
  const total = pitchHist.reduce((a, b) => a + b, 0);
  if (total < 2) return 'neutral'; // not enough history yet

  // For each possible root, score how much the pitch history
  // resembles a major vs minor scale pattern
  let majorScore = 0, minorScore = 0;

  for (let root = 0; root < 12; root++) {
    const rootWeight = pitchHist[root];
    if (rootWeight < 0.1) continue;
    // Major: check if notes a major third (4st) and fifth (7st) above are present
    majorScore += rootWeight * (pitchHist[(root + 4) % 12] + pitchHist[(root + 7) % 12]);
    // Minor: check if notes a minor third (3st) and fifth (7st) above are present
    minorScore += rootWeight * (pitchHist[(root + 3) % 12] + pitchHist[(root + 7) % 12]);
  }

  if (majorScore > minorScore * 1.15) return 'major';
  if (minorScore > majorScore * 1.15) return 'minor';
  return 'neutral';
}

// Auto-selects the best preset based on:
// 1. Major/minor context from pitch history
// 2. Pitch stability (stable = Gospel lush, moving = Major/Minor clean)
// 3. Pitch register (high singing = Octave for fullness)
function autoSelectPreset(currentMidi) {
  if (!autoMode) return;

  const context = detectMajorMinor();
  const isHigh = currentMidi > 72;  // above C5 = high voice
  const isStable = pitchStability > 0.7;

  let targetPreset;

  if (isHigh) {
    // High notes — use Octave to add depth below
    targetPreset = 2; // Octave
  } else if (isStable && context === 'major') {
    // Stable major — Gospel for lush sustained sound
    targetPreset = 4; // Gospel
  } else if (context === 'minor') {
    targetPreset = 1; // Minor
  } else if (context === 'major') {
    targetPreset = 0; // Major
  } else {
    targetPreset = 0; // Default to Major
  }

  if (targetPreset !== currentPreset) {
    setPreset(targetPreset, true);
  }
}

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
let isSinging = true;  // always on — no push-to-sing gate
let currentFreq = 0;
let lastValidFreq = 0;

let pitchShifters = [];
let voiceGains = [];
let roomReverb;
let sharedTremolo;          // Tone.Tremolo — shared by all voices
let tremoloDepth = 0;      // 0=off, 1=full — controlled by hand tilt
let handTiltX = 0;      // smoothed hand tilt (-1=left, +1=right)

// Hand tracking — pinch controls harmony volume
let handpose, predictions = [];
let harmonyVolume = 0.8;  // default full — pinch adjusts when hand detected
let pinchOpen = false; // current pinch state for visual feedback
// Pinch distance thresholds (in normalised 0-640 landmark space)
const PINCH_OPEN = 100;  // distance above this = fully open
const PINCH_CLOSED = 20;   // distance below this = fully closed

let voiceAmps = [0, 0, 0, 0];
let mouthPhase = [0, 0, 0, 0];
let voiceNotes = ['', '', '', ''];

const scaleArr = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// ---------------------------------------------------------------------------
// Preset switching
// ---------------------------------------------------------------------------
function setPreset(index, fromAuto) {
  // If called manually (not from auto), disable auto mode
  if (!fromAuto) autoMode = false;
  currentPreset = index;
  if (!isStarted) { syncPresetButtons(); return; }

  const preset = PRESETS[index];
  pitchShifters.forEach((ps, i) => {
    ps.pitch = preset.intervals[i];
  });

  syncPresetButtons();
  updateHarmonyLabel();
}

function enableAutoMode() {
  autoMode = true;
  // Clear pitch history so auto-detection starts fresh
  pitchHist.fill(0);
  stableFrames = 0;
  pitchStability = 0;
  syncPresetButtons();
  const hm = document.getElementById('harmony-mode');
  if (hm) hm.innerHTML = 'Auto';
}

function syncPresetButtons() {
  // Auto button
  const autoBtn = document.getElementById('preset-btn-auto');
  if (autoBtn) {
    autoBtn.style.background = autoMode ? '#ffffff' : 'transparent';
    autoBtn.style.color = autoMode ? '#08080f' : 'rgba(255,255,255,0.6)';
    autoBtn.style.borderColor = autoMode ? '#ffffff' : 'rgba(255,255,255,0.2)';
  }
  // Preset buttons — dim all when auto is on, highlight active when manual
  PRESETS.forEach((p, i) => {
    const btn = document.getElementById('preset-btn-' + i);
    if (!btn) return;
    const active = !autoMode && i === currentPreset;
    btn.style.background = active ? p.color : 'transparent';
    btn.style.color = active ? '#08080f' : p.color;
    btn.style.borderColor = active ? p.color : 'rgba(255,255,255,0.2)';
    btn.style.opacity = autoMode ? '0.4' : '1';
  });
}

function updateHarmonyLabel() {
  const hm = document.getElementById('harmony-mode');
  if (!hm) return;
  hm.innerHTML = autoMode
    ? 'Auto → ' + PRESETS[currentPreset].name
    : PRESETS[currentPreset].name;
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
// Keyboard shortcuts
// ---------------------------------------------------------------------------
function keyTyped() {
  if (key === '0') { enableAutoMode(); return; }
  const n = parseInt(key);
  if (n >= 1 && n <= PRESETS.length) setPreset(n - 1);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
function setup() {
  createCanvas(windowWidth, windowHeight);
  pixelDensity(1);

  // Initialise handpose using the webcam
  // We create a small hidden video just for hand tracking
  const handVideo = createCapture(VIDEO);
  handVideo.size(320, 240);
  handVideo.hide();

  handpose = ml5.handpose(handVideo, () => {
    console.log('[Choir] HandPose ready');
  });
  handpose.on('predict', results => { predictions = results; });
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

    // Mic always open — pinch controls harmony volume
    micGate = new Tone.Gain(1);
    mic.connect(micGate);

    // Soprano dry — always on, fixed level, so user hears their own
    // voice regardless of pinch state. Routes through reverb so it
    // sits in the same acoustic space as the harmony voices.
    const sopranoDry = new Tone.Gain(0.85).connect(roomReverb);
    micGate.connect(sopranoDry);

    // Shared Tremolo — sits between voiceGains and reverb
    // Rate 6Hz matches the reference video's 8.33Hz feel
    // Starts with depth 0 — hand tilt controls how much tremolo applies
    sharedTremolo = new Tone.Tremolo({
      frequency: 6,
      depth: 0,    // starts off — tilt hand to bring in
      spread: 180,  // stereo spread between L/R
      wet: 1.0,
    }).connect(roomReverb).start();

    // Three harmony voices: micGate → PitchShift → VoiceGain → Tremolo → Reverb
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
      vg.connect(sharedTremolo);   // → tremolo → reverb → master

      pitchShifters.push(ps);
      voiceGains.push(vg);
    }

    isStarted = true;
    setStatus('Ready', '#00ffcc');
    syncMuteButtons();
    syncPresetButtons();
    updateHarmonyLabel();

  } catch (e) {
    console.error('Start error:', e);
    const el = document.getElementById('model-status');
    if (el) { el.innerHTML = 'Error: ' + e.message; el.style.color = '#ff4444'; }
  }
}

// ---------------------------------------------------------------------------
// Pinch detection — returns 0.0 (closed) to 1.0 (fully open)
// ---------------------------------------------------------------------------
function getPinchOpenness() {
  if (!predictions || predictions.length === 0) return -1; // no hand

  const lm = predictions[0].landmarks;
  const thumbTip = lm[4];   // thumb tip
  const indexTip = lm[8];   // index finger tip

  // 2D distance between thumb and index tip in landmark space
  const dx = thumbTip[0] - indexTip[0];
  const dy = thumbTip[1] - indexTip[1];
  const dist = Math.sqrt(dx * dx + dy * dy);

  // Map distance to 0–1 openness
  return constrain(map(dist, PINCH_CLOSED, PINCH_OPEN, 0, 1), 0, 1);
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

    // Track pitch history and stability for auto-preset selection
    const currentMidi = 12 * Math.log2(currentFreq / 440) + 69;
    updatePitchHistory(currentMidi);

    // Stability: how close is current midi to last frame's midi
    const delta = Math.abs(currentMidi - lastDetectedMidi);
    if (delta < 0.8) {
      stableFrames = min(stableFrames + 1, 60);
    } else {
      stableFrames = max(stableFrames - 3, 0);
    }
    pitchStability = stableFrames / 60;
    lastDetectedMidi = currentMidi;

    // Auto-select harmony preset based on what we've detected
    autoSelectPreset(currentMidi);
  } else {
    currentFreq = lerp(currentFreq, 0, 0.05);
    stableFrames = max(stableFrames - 1, 0);
    pitchStability = stableFrames / 60;
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
    // Volume is now driven by pinch — updatePinchVolume handles gain ramps
    // Just make sure unmuted voices are eligible (gain set by pinch)
  });
}

// ---------------------------------------------------------------------------
// Draw
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Hand X position — wrist landmark mapped to screen width
// Hand on RIGHT side = tremolo 0%
// Hand moves LEFT    = tremolo increases to 100%
// Returns 0.0 (right) to 1.0 (left), or -1 if no hand
// ---------------------------------------------------------------------------
function getHandX() {
  if (!predictions || predictions.length === 0) return -1;
  const lm = predictions[0].landmarks;
  const wrist = lm[0];
  // Landmark x is in camera space (0=left, 640=right).
  // Because camera is mirrored, landmark 0 on left = user's right hand side.
  // So: landmark x near 640 = hand on left of screen (user's right) = tremolo 0
  //     landmark x near 0   = hand on right of screen (user's left) = tremolo 100
  // Map landmark x 640→0 to tremolo 0→1
  return constrain(map(wrist[0], 480, 100, 0, 1), 0, 1);
}

// ---------------------------------------------------------------------------
// Pinch volume control
// ---------------------------------------------------------------------------
function updatePinchVolume() {
  const openness = getPinchOpenness();
  if (openness < 0) return; // no hand — hold current volume

  pinchOpen = openness > 0.45;

  // Fast lerp (0.18) = snappy response to pinch movement
  harmonyVolume = lerp(harmonyVolume, openness, 0.18);

  // Cubic power curve: silent until ~40% open, then swells quickly to full
  // closed (0.0) → near silent, half-open (0.5) → 0.125, fully open (1.0) → 1.2
  const gainTarget = Math.pow(harmonyVolume, 2.0) * 1.2;

  // Short ramp (0.03s) so changes feel immediate
  voiceGains.forEach((vg, i) => {
    if (!voiceMuted[i + 1]) {
      vg.gain.rampTo(gainTarget, 0.03);
    }
  });

  // Hand X position → tremolo depth
  // Hand on right side of screen = 0% tremolo
  // Hand moves to left side      = 100% tremolo
  const handX = getHandX();
  if (handX >= 0) {
    handTiltX = lerp(handTiltX, handX, 0.10);
    tremoloDepth = lerp(tremoloDepth, handTiltX, 0.08);
    if (sharedTremolo) sharedTremolo.depth.rampTo(tremoloDepth, 0.1);
  }
}

// ---------------------------------------------------------------------------
// updateSingButton stub (kept for safety, no-op since button removed)
// ---------------------------------------------------------------------------
function updateSingButton(active) { }

function draw() {
  // Transparent background — camera feed shows through
  clear();

  if (isStarted) {
    updatePitch();
    updateVisualNotes();
    updatePinchVolume();
  }

  drawOrbs();
  drawHandKeypoints();
  updateUI();
}

// ---------------------------------------------------------------------------
// Glowing orbs — one per voice, float around singer position
// ---------------------------------------------------------------------------

// Orb state — each orbits at different speed/radius around canvas centre
const ORB_COLORS = [
  [255, 210, 180],  // Soprano — warm peach
  [160, 220, 255],  // Alto    — cool blue
  [160, 255, 200],  // Tenor   — mint green
  [210, 170, 255],  // Bass    — soft purple
];

let orbAngles = [0, 1.5708, 3.1416, 4.7124];
let orbRadii = [0, 0, 0, 0];   // current orbit radius (animated)
let orbSizes = [0, 0, 0, 0];   // current glow size
let orbX = [0, 0, 0, 0];
let orbY = [0, 0, 0, 0];

// Speed and target orbit radius per voice
const ORB_SPEED = [0.008, 0.011, 0.009, 0.007];
const ORB_OFFSET = [0, 1.885, 3.770, 5.655];

function drawOrbs() {
  const singing = isStarted && currentFreq > 50;
  const holding = isStarted && !singing && lastValidFreq > 50;
  const active = singing || holding;
  const rms = getAmplitude();
  const cx = width * 0.5;
  const cy = height * 0.48;

  // Target orbit radius — grows when singing, shrinks when silent
  const targetOrbitR = active ? min(width, height) * 0.28 : min(width, height) * 0.08;

  for (let i = 0; i < 4; i++) {
    // Soprano always visible (it's the user) — others only when harmony active
    const isUser = i === 0;
    const audioActive = isUser || (!voiceMuted[i] && harmonyVolume > 0.05);
    const visualActive = isUser ? active : (active && audioActive);

    // Orbit radius
    const tR = visualActive ? targetOrbitR * (0.85 + i * 0.08) : (isUser ? 10 : 0);
    orbRadii[i] = lerp(orbRadii[i], tR, 0.05);

    // Orbit angle
    orbAngles[i] += ORB_SPEED[i];

    // Position
    orbX[i] = cx + cos(orbAngles[i] + ORB_OFFSET[i]) * orbRadii[i];
    orbY[i] = cy + sin(orbAngles[i] + ORB_OFFSET[i]) * orbRadii[i] * 0.55; // elliptical

    // Size — reacts to amplitude for soprano, to harmonyVolume for others
    const breathe = 1 + sin(frameCount * 0.04 + i * 1.3) * 0.06;
    let targetSize;
    if (isUser) {
      targetSize = singing ? (60 + rms * 120) * breathe : (active ? 32 : 20);
    } else {
      targetSize = visualActive ? (45 + harmonyVolume * 60 + rms * 50) * breathe : 0;
    }
    orbSizes[i] = lerp(orbSizes[i], targetSize, 0.1);

    if (orbSizes[i] < 1) continue;

    const [r, g, b] = ORB_COLORS[i];
    const sz = orbSizes[i];
    const ox = orbX[i];
    const oy = orbY[i];

    noStroke();

    // Outer soft glow — large, very transparent
    for (let ring = 4; ring >= 1; ring--) {
      const alpha = map(ring, 4, 1, 8, 35);
      const rSz = sz * (1 + ring * 0.5);
      fill(r, g, b, alpha);
      ellipse(ox, oy, rSz, rSz);
    }

    // Core orb
    fill(r, g, b, isUser ? 200 : 160);
    ellipse(ox, oy, sz * 0.55, sz * 0.55);

    // Bright centre
    fill(255, 255, 255, isUser ? 180 : 120);
    ellipse(ox - sz * 0.08, oy - sz * 0.08, sz * 0.18, sz * 0.18);

    // Note label floating below orb
    if (active && voiceNotes[i]) {
      fill(r, g, b, isUser ? 220 : 160);
      noStroke();
      textAlign(CENTER, CENTER);
      textSize(isUser ? 16 : 13);
      textFont('monospace');
      text(voiceNotes[i], ox, oy + sz * 0.5 + 14);
    }

    // "you" tag for soprano
    if (isUser && active) {
      fill(255, 255, 255, 40);
      textSize(9);
      textAlign(CENTER, CENTER);
      textFont('monospace');
      text('you', ox, oy + sz * 0.5 + 30);
    }
  }

  // Harmony type label — centre, subtle, only when active
  if (active) {
    const preset = PRESETS[currentPreset];
    fill(255, 255, 255, autoMode ? 50 : 35);
    textAlign(CENTER, CENTER);
    textSize(11);
    textFont('monospace');
    noStroke();
    text((autoMode ? 'auto · ' : '') + preset.name, cx, cy + min(width, height) * 0.42);
  }
}

// ---------------------------------------------------------------------------
// Draw hand keypoints as small glowing dots (mirrored to match camera)
// ---------------------------------------------------------------------------
function drawHandKeypoints() {
  if (!predictions || predictions.length === 0) return;
  const lm = predictions[0].landmarks;
  noStroke();
  for (let i = 0; i < lm.length; i++) {
    // Mirror X to match the flipped camera feed
    const x = map(lm[i][0], 0, 640, width, 0);
    const y = map(lm[i][1], 0, 480, 0, height);
    // Highlight thumb and index tips for pinch visibility
    const isKey = (i === 4 || i === 8);
    fill(255, 255, 255, isKey ? 200 : 60);
    ellipse(x, y, isKey ? 10 : 5);
  }

  // Pinch line: thumb tip → index tip, colour shows volume
  const tx = map(lm[4][0], 0, 640, width, 0);
  const ty = map(lm[4][1], 0, 480, 0, height);
  const ix = map(lm[8][0], 0, 640, width, 0);
  const iy = map(lm[8][1], 0, 480, 0, height);
  const openness = getPinchOpenness();
  stroke(lerp(255, 100, openness), lerp(100, 255, openness), 150, 140);
  strokeWeight(1.5);
  line(tx, ty, ix, iy);

  // Tremolo bar — appears above the wrist, shows current tremolo depth
  const wx = map(lm[0][0], 0, 640, width, 0);
  const wy = map(lm[0][1], 0, 480, 0, height);
  const td = tremoloDepth;
  if (td > 0.02) {
    const barW = 60;
    const barH = 4;
    const bx = wx - barW / 2;
    const by = wy - 28;
    // Background
    noStroke();
    fill(255, 255, 255, 25);
    rect(bx, by, barW, barH, 2);
    // Fill — blue when low, orange when high
    fill(lerp(100, 255, td), lerp(180, 120, td), lerp(255, 60, td), 200);
    rect(bx, by, barW * td, barH, 2);
    // Label
    fill(255, 255, 255, 120);
    textSize(9);
    textFont('monospace');
    textAlign(CENTER, BOTTOM);
    text('tremolo', wx, by - 2);
  }
  noStroke();
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
    ms.innerHTML = currentFreq > 50 ? 'singing' : lastValidFreq > 50 ? 'holding' : 'listening';
  }
  const nd = document.getElementById('note-display');
  if (nd) {
    const f = currentFreq > 50 ? currentFreq : lastValidFreq;
    nd.innerHTML = f > 50
      ? scaleArr[((Math.round(12 * Math.log2(f / 440) + 69) % 12) + 12) % 12] || '--'
      : '--';
  }
  const hm = document.getElementById('harmony-mode');
  if (hm) hm.innerHTML = autoMode
    ? 'auto → ' + PRESETS[currentPreset].name
    : PRESETS[currentPreset].name;
}

function windowResized() { resizeCanvas(windowWidth, windowHeight); }