/**
 * Name: Yu Ting Liao
 * Project: Digital Choir V3 - Goldsmiths Final Fix
 * Version: Compatible with ml5.js v0.12.2 + Chrome 130+
 *
 * Fix log:
 * - Replaced ml5.pitchDetection with AnalyserNode + YIN algorithm
 *   because createScriptProcessor is removed in Chrome 130+ and ml5's
 *   pitch model internally depends on it.
 * - Fixed mirrored hand keypoint coordinates (drawKeypoints + updateHarmony).
 * - Fixed thumb direction check for mirrored video.
 * - Moved hand logic outside the push/pop mirror block.
 * - Fixed note index modulo to handle negative values.
 */

let video, handpose, predictions = [];
let mic, pitchShift3rd, pitchShift5th;
let analyser, pitchBuffer;
let isStarted = false, currentFreq = 0, harmonyState = 0;

const scaleArr = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
function setup() {
  createCanvas(windowWidth, windowHeight);

  video = createCapture(VIDEO);
  video.size(640, 480);
  video.hide();

  handpose = ml5.handpose(video, () => {
    console.log("HandPose Ready");
    const hs = document.getElementById('hand-status');
    if (hs) { hs.innerHTML = "Active"; hs.className = "val"; }
  });

  handpose.on("predict", results => {
    predictions = results;
  });
}

// ---------------------------------------------------------------------------
// Start (called after user gesture)
// ---------------------------------------------------------------------------
async function startApp() {
  if (isStarted) return;

  try {
    await Tone.start();
    console.log("Audio context started");

    mic = new Tone.UserMedia();
    await mic.open();
    console.log("Mic opened successfully");

    // Get the underlying MediaStream.
    // Tone wraps the stream; try known internal properties first.
    let streamToUse =
      mic._stream ||
      (mic.stream && mic.stream._nativeStream) ||
      mic.stream;

    if (!streamToUse || !(streamToUse instanceof MediaStream)) {
      console.warn("Tone stream not accessible — requesting stream directly...");
      streamToUse = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    }

    // Harmony effects chain
    pitchShift3rd = new Tone.PitchShift({ pitch: 4, windowSize: 0.1 }).toDestination();
    pitchShift5th = new Tone.PitchShift({ pitch: 7, windowSize: 0.1 }).toDestination();

    mic.connect(pitchShift3rd);
    mic.connect(pitchShift5th);
    mic.connect(Tone.Destination);

    pitchShift3rd.wet.value = 0;
    pitchShift5th.wet.value = 0;

    // Pitch detection via AnalyserNode + YIN — no ScriptProcessor needed.
    // This avoids the Chrome 130+ removal of createScriptProcessor which
    // breaks ml5.pitchDetection internally.
    const rawCtx = Tone.getContext().rawContext;
    analyser = rawCtx.createAnalyser();
    analyser.fftSize = 2048;
    pitchBuffer = new Float32Array(analyser.fftSize);

    const micSource = rawCtx.createMediaStreamSource(streamToUse);
    micSource.connect(analyser);

    console.log("Pitch Model Ready (AnalyserNode + YIN)");
    const ms = document.getElementById('model-status');
    if (ms) { ms.innerHTML = "Ready"; ms.className = "val"; }

    isStarted = true;

  } catch (e) {
    console.error("Critical Start Error:", e);
    const ms = document.getElementById('model-status');
    if (ms) { ms.innerHTML = "Error"; ms.className = "val warn"; }
  }
}

// ---------------------------------------------------------------------------
// YIN pitch detection algorithm
// Estimates fundamental frequency from a float PCM buffer.
// Returns frequency in Hz, or -1 if no clear pitch is found.
// ---------------------------------------------------------------------------
function yinPitch(buffer, sampleRate) {
  const threshold = 0.15;
  const halfLen = Math.floor(buffer.length / 2);
  const yinBuf = new Float32Array(halfLen);

  // Difference function
  for (let tau = 0; tau < halfLen; tau++) {
    let sum = 0;
    for (let i = 0; i < halfLen; i++) {
      const d = buffer[i] - buffer[i + tau];
      sum += d * d;
    }
    yinBuf[tau] = sum;
  }

  // Cumulative mean normalised difference
  yinBuf[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau < halfLen; tau++) {
    runningSum += yinBuf[tau];
    yinBuf[tau] *= tau / runningSum;
  }

  // Absolute threshold — find first tau below threshold
  let tau = 2;
  while (tau < halfLen) {
    if (yinBuf[tau] < threshold) {
      while (tau + 1 < halfLen && yinBuf[tau + 1] < yinBuf[tau]) tau++;
      break;
    }
    tau++;
  }

  if (tau === halfLen || yinBuf[tau] >= threshold) return -1;

  // Parabolic interpolation for sub-sample accuracy
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
// Draw loop
// ---------------------------------------------------------------------------
function draw() {
  background(10, 10, 20);

  // Draw mirrored video ONLY inside push/pop
  push();
  translate(width, 0);
  scale(-1, 1);
  tint(255, 40);
  image(video, 0, 0, width, height);
  pop();
  // Mirror block closed — hand logic runs in normal (unmirrored) space

  if (predictions && predictions.length > 0) {
    drawKeypoints();
    updateHarmony();
  }

  if (isStarted) {
    updatePitch();
    handleAudioDSP();
    renderVisuals();
  }
}

// ---------------------------------------------------------------------------
// Read pitch from analyser buffer each frame
// ---------------------------------------------------------------------------
function updatePitch() {
  if (!analyser) return;
  analyser.getFloatTimeDomainData(pitchBuffer);

  // Skip if signal is too quiet — avoids false pitch readings on silence
  let rms = 0;
  for (let i = 0; i < pitchBuffer.length; i++) rms += pitchBuffer[i] * pitchBuffer[i];
  rms = Math.sqrt(rms / pitchBuffer.length);

  if (rms < 0.01) {
    currentFreq = lerp(currentFreq, 0, 0.1);
    return;
  }

  const sampleRate = Tone.getContext().rawContext.sampleRate;
  const detected = yinPitch(pitchBuffer, sampleRate);

  if (detected > 60 && detected < 1200) {
    currentFreq = lerp(currentFreq, detected, 0.35);
  } else {
    currentFreq = lerp(currentFreq, 0, 0.08);
  }
}

// ---------------------------------------------------------------------------
// Harmony wet/dry control based on hand gesture state
// ---------------------------------------------------------------------------
function handleAudioDSP() {
  if (!pitchShift3rd || !pitchShift5th) return;
  const active = currentFreq > 50;
  pitchShift3rd.wet.rampTo(active && harmonyState >= 2 ? 0.8 : 0, 0.1);
  pitchShift5th.wet.rampTo(active && harmonyState >= 3 ? 0.8 : 0, 0.1);
}

// ---------------------------------------------------------------------------
// Visual feedback — frequency dot + harmony dots
// ---------------------------------------------------------------------------
function renderVisuals() {
  if (currentFreq < 50) return;

  const y = map(currentFreq, 80, 1000, height * 0.85, height * 0.15);
  const sz = 80;

  noStroke();

  // Root note
  fill(255);
  ellipse(width / 2, y, sz);

  // Third (activated at harmonyState >= 2)
  if (harmonyState >= 2) {
    fill(0, 255, 200, 160);
    ellipse(width / 2 - 160, y + 30, sz * 0.7);
  }

  // Fifth (activated at harmonyState >= 3)
  if (harmonyState >= 3) {
    fill(255, 50, 255, 160);
    ellipse(width / 2 + 160, y + 30, sz * 0.7);
  }

  // Note name in UI panel
  const nd = document.getElementById('note-display');
  if (nd) {
    const m = Math.round(12 * Math.log2(currentFreq / 440) + 69);
    nd.innerHTML = scaleArr[((m % 12) + 12) % 12] || "--";
  }
}

// ---------------------------------------------------------------------------
// Determine harmony state from finger count
// ---------------------------------------------------------------------------
function updateHarmony() {
  const mt = document.getElementById('harmony-mode');
  if (!predictions[0]) return;

  let fingerCount = 0;
  const l = predictions[0].landmarks;

  // Thumb: in mirrored video a right hand's thumb tip appears to the
  // RIGHT of its knuckle, so comparison is the opposite of a raw feed.
  if (l[4][0] > l[3][0]) fingerCount++;

  // Index to pinky: tip y < pip y means finger is extended
  const tips  = [8, 12, 16, 20];
  const bases = [6, 10, 14, 18];
  for (let i = 0; i < 4; i++) {
    if (l[tips[i]][1] < l[bases[i]][1]) fingerCount++;
  }

  if (fingerCount >= 4) {
    harmonyState = 3;
    if (mt) { mt.innerHTML = "Trio (1-3-5)"; mt.className = "val"; }
  } else if (fingerCount >= 2) {
    harmonyState = 2;
    if (mt) { mt.innerHTML = "Duet (1-3)"; mt.className = "val"; }
  } else {
    harmonyState = 1;
    if (mt) { mt.innerHTML = "Solo"; mt.className = "val"; }
  }
}

// ---------------------------------------------------------------------------
// Draw hand skeleton dots, mirroring X to match flipped video
// ---------------------------------------------------------------------------
function drawKeypoints() {
  const l = predictions[0].landmarks;
  noStroke();
  fill(0, 255, 255, 200);
  for (let i = 0; i < l.length; i++) {
    // Reverse X direction: map [0,640] to [width,0] to align with mirrored video
    const x = map(l[i][0], 0, 640, width, 0);
    const y = map(l[i][1], 0, 480, 0, height);
    ellipse(x, y, 6);
  }
}

// ---------------------------------------------------------------------------
function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}
