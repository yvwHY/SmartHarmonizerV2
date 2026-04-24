/**
 * ============================================================================
 * Smart Harmonizer V2
 * ============================================================================
 * Author  : Yu-Ting Liao
 * Course  : Workshops in Creative Coding 2, Goldsmiths University of London
 * Date    : April 2026
 *
 * Description:
 *   A web-based real-time vocal harmony simulator. The user sings into a
 *   microphone and the system generates three pitch-shifted harmony voices
 *   (Alto, Tenor, Bass) from their own voice. Hand gestures — tracked via
 *   webcam using ml5.js Handpose — control harmony volume (pinch) and
 *   tremolo depth (horizontal hand position).
 *
 * Audio chain:
 *   Mic → micGate → PitchShift (×3) → VoiceGain → Tremolo → Reverb
 *                                                             → MasterGain
 *                                                             → Limiter
 *                                                             → Speakers
 *   Mic → AnalyserNode (isolated — pitch detection only, never to speakers)
 *
 * Libraries:
 *   p5.js     v1.9.0   — canvas, draw loop
 *   Tone.js   v14.8.49 — Web Audio effects chain
 *   ml5.js    v0.12.2  — Handpose landmark detection
 *
 * Pitch detection algorithm:
 *   YIN — de Cheveigné, A. & Kawahara, H. (2002).
 *   "YIN, a fundamental frequency estimator for speech and music."
 *   Journal of the Acoustical Society of America, 111(4), 1917–1930.
 *
 * Handpose landmarks:
 *   ml5.js Handpose docs — https://learn.ml5js.org/#/reference/handpose
 *   lm[0]  = wrist
 *   lm[4]  = thumb tip
 *   lm[8]  = index finger tip
 * ============================================================================
 */

// ============================================================================
// HARMONY PRESETS
// Each preset is three semitone intervals above the user's singing pitch.
// Intervals are passed directly to Tone.PitchShift.pitch at runtime.
// ============================================================================
const PRESETS = [
  { name: 'Major', intervals: [4, 7, -5], color: '#00ffcc' }, // root, 3rd, 4th below
  { name: 'Minor', intervals: [3, 7, -5], color: '#aa88ff' }, // flat third = minor feel
  { name: 'Octave', intervals: [12, -12, 7], color: '#ffaa00' }, // wide spread, powerful
  { name: 'Cluster', intervals: [2, 5, 9], color: '#ff6688' }, // tense, jazz-like
  { name: 'Gospel', intervals: [4, 7, 11], color: '#88ffaa' }, // adds major 7th
];

let currentPreset = 0;    // index into PRESETS array
let autoMode = true; // true = auto-detect harmony; false = manual selection

// ============================================================================
// PITCH HISTORY & AUTO KEY DETECTION
// A rolling histogram of which pitch classes (C, C#, D...) the user has sung.
// Used to estimate whether the user is singing in a major or minor context.
// ============================================================================

// 12-element array, one per pitch class (C=0, C#=1, ... B=11)
const pitchHist = new Array(12).fill(0);

let lastDetectedMidi = 0;
let pitchStability = 0; // 0.0 = moving pitch, 1.0 = very stable held note
let stableFrames = 0; // consecutive frames within CALIB_STABILITY semitones

/**
 * Feed a new MIDI note value into the pitch histogram.
 * Decay factor 0.992 means notes from ~8 seconds ago have faded to ~50%.
 * Reference: pitch-class histogram approach used in key-finding algorithms
 * (Krumhansl & Kessler, 1982; Temperley, 1999).
 */
function updatePitchHistory(midi) {
  const pc = ((Math.round(midi) % 12) + 12) % 12; // pitch class 0–11
  pitchHist[pc] += 1;
  for (let i = 0; i < 12; i++) pitchHist[i] *= 0.992; // slow decay
}

/**
 * Compare pitch histogram against major and minor chord templates.
 * For each possible root, score how well the histogram matches:
 *   major: root + major third (4st) + fifth (7st)
 *   minor: root + minor third (3st) + fifth (7st)
 * Returns 'major', 'minor', or 'neutral' (not enough data yet).
 */
function detectMajorMinor() {
  const total = pitchHist.reduce((a, b) => a + b, 0);
  if (total < 2) return 'neutral'; // not enough singing history

  let majorScore = 0, minorScore = 0;
  for (let root = 0; root < 12; root++) {
    const rootWeight = pitchHist[root];
    if (rootWeight < 0.1) continue;
    majorScore += rootWeight * (pitchHist[(root + 4) % 12] + pitchHist[(root + 7) % 12]);
    minorScore += rootWeight * (pitchHist[(root + 3) % 12] + pitchHist[(root + 7) % 12]);
  }

  // 1.15 threshold = one must be 15% stronger than the other to declare a winner
  if (majorScore > minorScore * 1.15) return 'major';
  if (minorScore > majorScore * 1.15) return 'minor';
  return 'neutral';
}

/**
 * Choose the most appropriate harmony preset based on:
 *   1. Pitch register — high singing (above C5/MIDI 72) → Octave for depth
 *   2. Stability + major context → Gospel (lush sustained quality)
 *   3. Minor context → Minor preset
 *   4. Default → Major
 * Only runs when autoMode is enabled.
 */
function autoSelectPreset(currentMidi) {
  if (!autoMode) return;

  const context = detectMajorMinor();
  const isHigh = currentMidi > 72;   // C5 threshold
  const isStable = pitchStability > 0.7; // 70% stability = held note

  let targetPreset;
  if (isHigh) targetPreset = 2; // Octave
  else if (isStable && context === 'major') targetPreset = 4; // Gospel
  else if (context === 'minor') targetPreset = 1; // Minor
  else targetPreset = 0; // Major (default)

  if (targetPreset !== currentPreset) setPreset(targetPreset, true);
}

// ============================================================================
// VOICE DEFINITIONS (visuals only — audio uses PRESETS.intervals)
// ============================================================================
const VOICES = [
  { name: 'Soprano', color: [255, 220, 200] }, // warm peach — the user
  { name: 'Alto', color: [200, 240, 255] }, // cool blue
  { name: 'Tenor', color: [180, 255, 210] }, // mint green
  { name: 'Bass', color: [220, 190, 255] }, // soft purple
];

// voiceMuted[0] = Soprano is always true (never routed to speakers).
// The user hears their own voice naturally through bone conduction/air.
// Routing it through speakers causes feedback. See notes in documentation.
const voiceMuted = [true, false, false, false];

// ============================================================================
// AUDIO STATE
// ============================================================================
let mic, micGate, analyser, pitchBuffer;
let isStarted = false;
let isSinging = true;  // mic is always open — no push-to-sing gate
let currentFreq = 0;     // current detected frequency (Hz), smoothed
let lastValidFreq = 0;    // last freq > 50Hz — held for visual "chord hold"

let pitchShifters = []; // Tone.PitchShift nodes [Alto, Tenor, Bass]
let voiceGains = []; // Tone.Gain nodes per harmony voice (mute + pinch)
let roomReverb;          // Tone.Reverb — shared by all voices
let sharedTremolo;       // Tone.Tremolo — shared by all harmony voices

let tremoloDepth = 0;  // 0.0–1.0, controlled by hand X position
let handTiltX = 0;  // smoothed hand X position (lerp target)

// ============================================================================
// HAND TRACKING STATE (ml5.js Handpose)
// ============================================================================
let handpose, predictions = []; // ml5 Handpose model + latest frame results

let harmonyVolume = 0.8; // 0.0–1.0+, default full — pinch adjusts when hand present
let pinchOpen = false;

// Pinch distance thresholds in raw landmark space (camera pixels, 0–640).
// Empirically tuned for a hand at ~40cm from a laptop webcam.
const PINCH_OPEN = 100; // above this distance = fully open = harmony at max
const PINCH_CLOSED = 20;  // below this distance = fully closed = harmony silent

// ============================================================================
// VISUAL STATE
// ============================================================================
let voiceAmps = [0, 0, 0, 0]; // smoothed amplitude per orb (drives size)
let mouthPhase = [0, 0, 0, 0]; // oscillating phase for idle breathing animation
let voiceNotes = ['', '', '', '']; // current note name per voice (e.g. 'G#')

const scaleArr = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Orb orbit state — each voice orbits the canvas centre at a different speed
const ORB_COLORS = [
  [255, 210, 180], // Soprano — warm peach
  [160, 220, 255], // Alto    — cool blue
  [160, 255, 200], // Tenor   — mint green
  [210, 170, 255], // Bass    — soft purple
];

// Starting angles evenly spaced (0, π/2, π, 3π/2)
let orbAngles = [0, 1.5708, 3.1416, 4.7124];
let orbRadii = [0, 0, 0, 0]; // current orbital radius (animated)
let orbSizes = [0, 0, 0, 0]; // current glow diameter (animated)
let orbX = [0, 0, 0, 0];
let orbY = [0, 0, 0, 0];

// Each voice orbits at a slightly different speed for organic feel
const ORB_SPEED = [0.008, 0.011, 0.009, 0.007];
// Phase offsets so voices don't start at the same angle
const ORB_OFFSET = [0, 1.885, 3.770, 5.655]; // 0, 3π/5, 6π/5, 9π/5

// ============================================================================
// PRESET CONTROL
// ============================================================================

/**
 * Switch to a harmony preset by index.
 * If called manually (fromAuto = false), auto mode is disabled.
 * Updates PitchShift pitch values immediately if audio is running.
 */
function setPreset(index, fromAuto) {
  if (!fromAuto) autoMode = false;
  currentPreset = index;
  if (!isStarted) { syncPresetButtons(); return; }

  const preset = PRESETS[index];
  pitchShifters.forEach((ps, i) => { ps.pitch = preset.intervals[i]; });

  syncPresetButtons();
  updateHarmonyLabel();
}

/** Re-enable auto mode and reset pitch history for a clean detection start. */
function enableAutoMode() {
  autoMode = true;
  pitchHist.fill(0);
  stableFrames = 0;
  pitchStability = 0;
  syncPresetButtons();
  const hm = document.getElementById('harmony-mode');
  if (hm) hm.innerHTML = 'Auto';
}

/** Update preset pill button styles to reflect current state. */
function syncPresetButtons() {
  const autoBtn = document.getElementById('preset-btn-auto');
  if (autoBtn) {
    autoBtn.style.background = autoMode ? '#ffffff' : 'transparent';
    autoBtn.style.color = autoMode ? '#08080f' : 'rgba(255,255,255,0.6)';
    autoBtn.style.borderColor = autoMode ? '#ffffff' : 'rgba(255,255,255,0.2)';
  }
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

/** Update the HUD harmony label. */
function updateHarmonyLabel() {
  const hm = document.getElementById('harmony-mode');
  if (!hm) return;
  hm.innerHTML = autoMode
    ? 'Auto → ' + PRESETS[currentPreset].name
    : PRESETS[currentPreset].name;
}

// ============================================================================
// MUTE CONTROL
// ============================================================================

/**
 * Toggle mute for a harmony voice (Alto=1, Tenor=2, Bass=3).
 * Soprano (0) is ignored — it has no speaker output by design.
 */
function toggleMute(index) {
  if (index === 0) return;
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

// ============================================================================
// KEYBOARD SHORTCUTS
// ============================================================================
function keyTyped() {
  if (key === '0') { enableAutoMode(); return; }         // 0 = auto mode
  const n = parseInt(key);
  if (n >= 1 && n <= PRESETS.length) setPreset(n - 1);  // 1–5 = presets
}

// ============================================================================
// p5.js SETUP
// ============================================================================
function setup() {
  createCanvas(windowWidth, windowHeight);
  pixelDensity(1); // disable retina scaling for performance

  // Create a small hidden video element for ml5 Handpose.
  // The visible camera feed is handled by the <video id="cam"> element in HTML.
  // Using a separate capture here avoids interfering with the background video.
  const handVideo = createCapture(VIDEO);
  handVideo.size(320, 240); // small size = faster inference
  handVideo.hide();

  // ml5.js Handpose — tracks 21 landmarks per hand
  // Reference: https://learn.ml5js.org/#/reference/handpose
  handpose = ml5.handpose(handVideo, () => {
    console.log('[Harmonizer] HandPose ready');
  });
  handpose.on('predict', results => { predictions = results; });
}

// ============================================================================
// AUDIO INITIALISATION (called after user gesture — browser audio policy)
// ============================================================================
async function startApp() {
  if (isStarted) return;

  const setStatus = (msg, color) => {
    const el = document.getElementById('model-status');
    if (el) { el.innerHTML = msg; el.style.color = color || '#ffcc00'; }
  };

  try {
    setStatus('Starting…');

    // Browser requires user gesture before AudioContext can start
    await Tone.start();

    // Single getUserMedia call with echo cancellation.
    // One stream is used for both pitch detection and audio output chain.
    // echoCancellation reduces speaker-to-mic bleed (feedback mitigation).
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,  // subtract speaker output from mic input
        noiseSuppression: true,  // reduce ambient room noise
        autoGainControl: true,  // stabilise voice level
      },
      video: false,
    });

    mic = new Tone.UserMedia();
    await mic.open();

    const rawCtx = Tone.getContext().rawContext;

    // ── Pitch detection branch (isolated — never reaches speakers) ──────────
    // The analyser reads the raw mic signal independently of the output chain.
    // This prevents speaker bleed from affecting pitch detection.
    analyser = rawCtx.createAnalyser();
    analyser.fftSize = 2048; // 2048-sample window for YIN (~46ms at 44.1kHz)
    pitchBuffer = new Float32Array(analyser.fftSize);
    rawCtx.createMediaStreamSource(stream).connect(analyser);
    // NOTE: analyser intentionally NOT connected to rawCtx.destination

    // ── Master output chain ─────────────────────────────────────────────────
    // Gain(2.0) boosts overall loudness; Limiter prevents clipping at peaks.
    const limiter = new Tone.Limiter(-2).toDestination(); // -2dBFS ceiling
    const master = new Tone.Gain(2.0).connect(limiter);

    // ── Shared reverb ───────────────────────────────────────────────────────
    // All voices (including Soprano dry) share one reverb for acoustic cohesion.
    // Promise.race() with 4s timeout prevents reverb init from blocking startup.
    setStatus('Loading reverb…');
    try {
      roomReverb = new Tone.Reverb({ decay: 2.0, preDelay: 0.02, wet: 0.3 });
      await Promise.race([
        roomReverb.ready,
        new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 4000)),
      ]);
      roomReverb.connect(master);
    } catch (e) {
      console.warn('[Harmonizer] Reverb failed — using dry fallback:', e.message);
      roomReverb = new Tone.Gain(1).connect(master); // pass-through fallback
    }

    // ── Mic gate ────────────────────────────────────────────────────────────
    // Gain(1) = always open. Previously this was a push-to-sing gate (Gain(0)),
    // but that was removed in favour of the always-on mic + pinch volume control.
    micGate = new Tone.Gain(1);
    mic.connect(micGate);

    // ── Soprano dry signal ──────────────────────────────────────────────────
    // Soprano is audible through the user's own ears (bone conduction + air).
    // A small reverb send gives it the same acoustic space as the harmony voices.
    // Routing it directly to speakers would cause feedback — avoided by design.
    const sopranoDry = new Tone.Gain(0.85).connect(roomReverb);
    micGate.connect(sopranoDry);

    // ── Shared tremolo ──────────────────────────────────────────────────────
    // Sits between voiceGains and reverb. Rate 6Hz, depth starts at 0.
    // Depth is controlled in real time by horizontal hand position (getHandX).
    // Spread 180° = stereo width between left and right copies.
    sharedTremolo = new Tone.Tremolo({
      frequency: 6,    // 6Hz = natural tremolo rate (reference: ~8Hz in Antares Auto-Shift)
      depth: 0,    // starts off — hand position sweeps this to 1.0
      spread: 180,  // degrees of stereo spread
      wet: 1.0,
    }).connect(roomReverb).start();

    // ── Harmony voices: Alto, Tenor, Bass ───────────────────────────────────
    // Signal chain: micGate → PitchShift → VoiceGain → Tremolo → Reverb
    //
    // PitchShift.windowSize = 0.1s: shorter = crisper transients but more
    // artefacts on large intervals; 0.1s is a good compromise for vocals.
    // PitchShift.wet = 1.0: fully shifted signal, no dry bleed.
    const preset = PRESETS[currentPreset];
    for (let i = 0; i < 3; i++) {
      const ps = new Tone.PitchShift({
        pitch: preset.intervals[i], // semitone offset (updated by setPreset)
        windowSize: 0.1,                 // phase vocoder window size in seconds
        delayTime: 0,
        feedback: 0,
      });
      ps.wet.value = 1.0;

      // VoiceGain: initial value 0.8 unless muted. Pinch gesture adjusts this.
      const vg = new Tone.Gain(voiceMuted[i + 1] ? 0 : 0.8);
      micGate.connect(ps);
      ps.connect(vg);
      vg.connect(sharedTremolo);

      pitchShifters.push(ps);
      voiceGains.push(vg);
    }

    isStarted = true;
    setStatus('Ready', '#00ffcc');
    syncMuteButtons();
    syncPresetButtons();
    updateHarmonyLabel();

  } catch (e) {
    console.error('[Harmonizer] Start error:', e);
    const el = document.getElementById('model-status');
    if (el) { el.innerHTML = 'Error: ' + e.message; el.style.color = '#ff4444'; }
  }
}

// ============================================================================
// HAND GESTURE DETECTION
// ============================================================================

/**
 * Returns pinch openness: 0.0 (closed) to 1.0 (fully open), or -1 if no hand.
 * Measures 2D Euclidean distance between thumb tip (lm[4]) and index tip (lm[8])
 * in raw camera landmark space (0–640 pixels wide).
 * Mapped to 0–1 using PINCH_CLOSED and PINCH_OPEN thresholds.
 */
function getPinchOpenness() {
  if (!predictions || predictions.length === 0) return -1;

  const lm = predictions[0].landmarks;
  const thumbTip = lm[4]; // thumb tip (ml5 Handpose landmark index 4)
  const indexTip = lm[8]; // index finger tip (landmark index 8)

  const dx = thumbTip[0] - indexTip[0];
  const dy = thumbTip[1] - indexTip[1];
  const dist = Math.sqrt(dx * dx + dy * dy);

  return constrain(map(dist, PINCH_CLOSED, PINCH_OPEN, 0, 1), 0, 1);
}

/**
 * Returns tremolo control value: 0.0 (right side) to 1.0 (left side), or -1.
 * Reads wrist landmark (lm[0]) X position in camera space.
 * Camera is mirrored in the HTML <video> element, so raw landmark X runs
 * opposite to what the user sees — mapping is inverted accordingly.
 * Range: landmark x=480 (user's hand on right of screen) → 0%
 *        landmark x=100 (user's hand on left of screen)  → 100%
 */
function getHandX() {
  if (!predictions || predictions.length === 0) return -1;
  const lm = predictions[0].landmarks;
  const wrist = lm[0]; // wrist landmark (ml5 Handpose index 0)
  return constrain(map(wrist[0], 480, 100, 0, 1), 0, 1);
}

/**
 * Update harmony volume from pinch gesture each frame.
 * Uses a quadratic power curve so the swell accelerates as the hand opens:
 *   gain = openness² × 1.2
 * This feels more expressive than a linear mapping.
 * If no hand is detected, the current volume is held (no change).
 */
function updatePinchVolume() {
  const openness = getPinchOpenness();
  if (openness < 0) return; // no hand detected — hold current volume

  pinchOpen = openness > 0.45;
  harmonyVolume = lerp(harmonyVolume, openness, 0.18); // fast lerp for snappy response

  // Quadratic power curve: stays quiet until ~40% open, swells quickly to full
  const gainTarget = Math.pow(harmonyVolume, 2.0) * 1.2;

  voiceGains.forEach((vg, i) => {
    if (!voiceMuted[i + 1]) vg.gain.rampTo(gainTarget, 0.03); // 30ms ramp
  });

  // Tremolo: read wrist X position → smoothed → applied to Tone.Tremolo.depth
  const handX = getHandX();
  if (handX >= 0) {
    handTiltX = lerp(handTiltX, handX, 0.10);    // smooth so small movements don't jitter
    tremoloDepth = lerp(tremoloDepth, handTiltX, 0.08);
    if (sharedTremolo) sharedTremolo.depth.rampTo(tremoloDepth, 0.1);
  }
}

// Stub retained for safety — push-to-sing button was removed, but some
// older call sites may still reference this function name.
function updateSingButton(active) { }

// ============================================================================
// YIN PITCH DETECTION ALGORITHM
// ============================================================================
/**
 * Estimates the fundamental frequency of a monophonic audio signal.
 * Implemented from: de Cheveigné & Kawahara (2002), JASA 111(4).
 *
 * Steps:
 *   1. Difference function — squared difference of signal shifted by τ
 *   2. Cumulative mean normalised difference — normalise to remove DC bias
 *   3. Absolute threshold — find first τ where d'(τ) < 0.15
 *   4. Parabolic interpolation — sub-sample accuracy between integer τ values
 *
 * @param {Float32Array} buffer     — raw PCM samples from AnalyserNode
 * @param {number}       sampleRate — audio context sample rate (e.g. 44100)
 * @returns {number} frequency in Hz, or -1 if no clear pitch found
 */
function yinPitch(buffer, sampleRate) {
  const threshold = 0.15; // YIN confidence threshold (paper recommends 0.10–0.15)
  const halfLen = Math.floor(buffer.length / 2);
  const yinBuf = new Float32Array(halfLen);

  // Step 1: Difference function
  for (let tau = 0; tau < halfLen; tau++) {
    let sum = 0;
    for (let i = 0; i < halfLen; i++) {
      const d = buffer[i] - buffer[i + tau];
      sum += d * d;
    }
    yinBuf[tau] = sum;
  }

  // Step 2: Cumulative mean normalised difference
  yinBuf[0] = 1;
  let rs = 0;
  for (let tau = 1; tau < halfLen; tau++) {
    rs += yinBuf[tau];
    yinBuf[tau] *= tau / rs;
  }

  // Step 3: Absolute threshold — find first local minimum below threshold
  let tau = 2;
  while (tau < halfLen) {
    if (yinBuf[tau] < threshold) {
      while (tau + 1 < halfLen && yinBuf[tau + 1] < yinBuf[tau]) tau++;
      break;
    }
    tau++;
  }
  if (tau === halfLen || yinBuf[tau] >= threshold) return -1; // no pitch found

  // Step 4: Parabolic interpolation for sub-sample accuracy
  const x0 = tau > 1 ? tau - 1 : tau;
  const x2 = tau + 1 < halfLen ? tau + 1 : tau;
  let bt;
  if (x0 === tau) bt = yinBuf[tau] <= yinBuf[x2] ? tau : x2;
  else if (x2 === tau) bt = yinBuf[tau] <= yinBuf[x0] ? tau : x0;
  else {
    const s0 = yinBuf[x0], s1 = yinBuf[tau], s2 = yinBuf[x2];
    bt = tau + (s2 - s0) / (2 * (2 * s1 - s2 - s0));
  }

  return sampleRate / bt; // convert period (samples) to frequency (Hz)
}

// ============================================================================
// PITCH UPDATE (runs every frame)
// ============================================================================
/**
 * Read the AnalyserNode buffer, compute RMS, run YIN pitch detection,
 * smooth the result, and feed it into the pitch history for auto-detection.
 * RMS threshold 0.01 = silence gate (prevents false readings on ambient noise).
 */
function updatePitch() {
  if (!analyser || !isSinging) return;
  analyser.getFloatTimeDomainData(pitchBuffer);

  // RMS silence gate — skip pitch detection below noise floor
  let rms = 0;
  for (let i = 0; i < pitchBuffer.length; i++) rms += pitchBuffer[i] * pitchBuffer[i];
  rms = Math.sqrt(rms / pitchBuffer.length);
  if (rms < 0.01) { currentFreq = lerp(currentFreq, 0, 0.1); return; }

  const detected = yinPitch(pitchBuffer, Tone.getContext().rawContext.sampleRate);

  if (detected > 60 && detected < 1400) { // valid vocal range: ~B1 to F6
    currentFreq = lerp(currentFreq, detected, 0.2); // 0.2 lerp = smooth tracking
    lastValidFreq = currentFreq;

    const currentMidi = 12 * Math.log2(currentFreq / 440) + 69;
    updatePitchHistory(currentMidi);

    // Pitch stability: count frames within 0.8 semitones of previous frame
    const delta = Math.abs(currentMidi - lastDetectedMidi);
    if (delta < 0.8) stableFrames = min(stableFrames + 1, 60);
    else stableFrames = max(stableFrames - 3, 0);
    pitchStability = stableFrames / 60; // 0–1 where 1 = held stable for ~1s
    lastDetectedMidi = currentMidi;

    autoSelectPreset(currentMidi);
  } else {
    currentFreq = lerp(currentFreq, 0, 0.05);
    stableFrames = max(stableFrames - 1, 0);
    pitchStability = stableFrames / 60;
  }
}

/**
 * Compute note names for each voice based on current pitch and preset intervals.
 * Used for the note labels displayed under each orb.
 */
function updateVisualNotes() {
  const freq = currentFreq > 50 ? currentFreq : lastValidFreq;
  if (freq < 50) { voiceNotes.fill(''); return; }

  const inputMidi = 12 * Math.log2(freq / 440) + 69;
  voiceNotes[0] = scaleArr[((Math.round(inputMidi) % 12) + 12) % 12]; // Soprano

  PRESETS[currentPreset].intervals.forEach((interval, i) => {
    const m = Math.round(inputMidi + interval);
    voiceNotes[i + 1] = scaleArr[((m % 12) + 12) % 12];
  });
}

// ============================================================================
// p5.js DRAW LOOP
// ============================================================================
function draw() {
  clear(); // transparent background — live camera feed shows through canvas

  if (isStarted) {
    updatePitch();
    updateVisualNotes();
    updatePinchVolume();
  }

  drawOrbs();
  drawHandKeypoints();
  updateUI();
}

// ============================================================================
// VISUAL — GLOWING ORBS
// ============================================================================
/**
 * Draw four glowing orbs orbiting the canvas centre, one per voice.
 * Soprano orb (i=0) always visible, reacts to mic amplitude.
 * Harmony orbs expand and brighten as harmonyVolume increases.
 * Orbital motion is elliptical (×0.55 on Y axis) for a perspective feel.
 * Kandinsky reference: harmony visualised as orbital/planetary motion
 * (Kandinsky, W. (1926). Point and Line to Plane. Bauhaus Books.)
 */
function drawOrbs() {
  const singing = isStarted && currentFreq > 50;
  const holding = isStarted && !singing && lastValidFreq > 50;
  const active = singing || holding;
  const rms = getAmplitude();
  const cx = width * 0.5;
  const cy = height * 0.48;

  const targetOrbitR = active
    ? min(width, height) * 0.28  // expanded when singing
    : min(width, height) * 0.08; // contracted when silent

  for (let i = 0; i < 4; i++) {
    const isUser = i === 0;
    const audioActive = isUser || (!voiceMuted[i] && harmonyVolume > 0.05);
    const visualActive = isUser ? active : (active && audioActive);

    const tR = visualActive ? targetOrbitR * (0.85 + i * 0.08) : (isUser ? 10 : 0);
    orbRadii[i] = lerp(orbRadii[i], tR, 0.05);
    orbAngles[i] += ORB_SPEED[i]; // continuous rotation

    orbX[i] = cx + cos(orbAngles[i] + ORB_OFFSET[i]) * orbRadii[i];
    orbY[i] = cy + sin(orbAngles[i] + ORB_OFFSET[i]) * orbRadii[i] * 0.55; // elliptical

    // Breathing animation: subtle sin oscillation on top of amplitude response
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

    // Multi-ring soft glow — 4 rings from large/transparent to small/opaque
    for (let ring = 4; ring >= 1; ring--) {
      fill(r, g, b, map(ring, 4, 1, 8, 35));
      ellipse(ox, oy, sz * (1 + ring * 0.5), sz * (1 + ring * 0.5));
    }

    // Solid core orb
    fill(r, g, b, isUser ? 200 : 160);
    ellipse(ox, oy, sz * 0.55, sz * 0.55);

    // Specular highlight (offset top-left for 3D feel)
    fill(255, 255, 255, isUser ? 180 : 120);
    ellipse(ox - sz * 0.08, oy - sz * 0.08, sz * 0.18, sz * 0.18);

    // Note name label below orb
    if (active && voiceNotes[i]) {
      fill(r, g, b, isUser ? 220 : 160);
      noStroke();
      textAlign(CENTER, CENTER);
      textSize(isUser ? 16 : 13);
      textFont('monospace');
      text(voiceNotes[i], ox, oy + sz * 0.5 + 14);
    }

    // "you" tag below Soprano note
    if (isUser && active) {
      fill(255, 255, 255, 40);
      textSize(9);
      textAlign(CENTER, CENTER);
      textFont('monospace');
      text('you', ox, oy + sz * 0.5 + 30);
    }
  }

  // Current preset label — subtle, centre bottom of orbit
  if (active) {
    fill(255, 255, 255, autoMode ? 50 : 35);
    textAlign(CENTER, CENTER);
    textSize(11);
    textFont('monospace');
    noStroke();
    text((autoMode ? 'auto · ' : '') + PRESETS[currentPreset].name,
      cx, cy + min(width, height) * 0.42);
  }
}

// ============================================================================
// VISUAL — HAND KEYPOINTS
// ============================================================================
/**
 * Draw ml5 Handpose landmarks as glowing dots over the camera feed.
 * X coordinates are mirrored (map 0→640 to width→0) to match the
 * horizontally flipped <video id="cam"> element in HTML.
 * Thumb tip (lm[4]) and index tip (lm[8]) are highlighted for pinch visibility.
 * A colour-coded line between them shows pinch state: orange=closed, green=open.
 * A wrist-mounted bar shows current tremolo depth.
 */
function drawHandKeypoints() {
  if (!predictions || predictions.length === 0) return;
  const lm = predictions[0].landmarks;

  noStroke();
  for (let i = 0; i < lm.length; i++) {
    const x = map(lm[i][0], 0, 640, width, 0); // mirror X
    const y = map(lm[i][1], 0, 480, 0, height);
    const isKey = (i === 4 || i === 8);             // thumb tip and index tip
    fill(255, 255, 255, isKey ? 200 : 60);
    ellipse(x, y, isKey ? 10 : 5);
  }

  // Pinch line: colour lerps orange→green as hand opens
  const tx = map(lm[4][0], 0, 640, width, 0);
  const ty = map(lm[4][1], 0, 480, 0, height);
  const ix = map(lm[8][0], 0, 640, width, 0);
  const iy = map(lm[8][1], 0, 480, 0, height);
  const openness = getPinchOpenness();
  stroke(lerp(255, 100, openness), lerp(100, 255, openness), 150, 140);
  strokeWeight(1.5);
  line(tx, ty, ix, iy);

  // Tremolo bar above wrist — fills left-to-right as depth increases
  const wx = map(lm[0][0], 0, 640, width, 0);
  const wy = map(lm[0][1], 0, 480, 0, height);
  const td = tremoloDepth;
  if (td > 0.02) {
    const barW = 60, barH = 4;
    const bx = wx - barW / 2;
    const by = wy - 28;
    noStroke();
    fill(255, 255, 255, 25); // background track
    rect(bx, by, barW, barH, 2);
    fill(lerp(100, 255, td), lerp(180, 120, td), lerp(255, 60, td), 200); // blue→orange
    rect(bx, by, barW * td, barH, 2);
    fill(255, 255, 255, 120);
    textSize(9); textFont('monospace'); textAlign(CENTER, BOTTOM);
    text('tremolo', wx, by - 2);
  }
  noStroke();
}

// ============================================================================
// HELPERS
// ============================================================================

/** Compute RMS amplitude from the current analyser buffer (0–1 normalised). */
function getAmplitude() {
  if (!analyser || !isSinging) return 0;
  let sum = 0;
  for (let i = 0; i < pitchBuffer.length; i++) sum += pitchBuffer[i] * pitchBuffer[i];
  return Math.sqrt(sum / pitchBuffer.length) * 6; // ×6 to scale into visible range
}

/** Update HUD text elements (note name, harmony mode, status). */
function updateUI() {
  const ms = document.getElementById('model-status');
  if (ms && isStarted) {
    ms.innerHTML = currentFreq > 50 ? 'singing'
      : lastValidFreq > 50 ? 'holding'
        : 'listening';
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