/**
 * Name: Yu Ting Liao
 * Date: 08/01/2026
 * Sketch: Smart Vocal Harmonizer
 * Instructions: 
 * 1. Allow microphone and camera access.
 * 2. Sing or hum a steady note into the microphone.
 * 3. Use hand gestures to build vocal harmonies:
 * - 1 Finger: Unison (Root Note)
 * - 3 Fingers: Major 3rd Harmony
 * - 5 Fingers: Full Major Triad (Root + 3rd + 5th)
 * - Fist (0 Fingers): Mute Harmony
 * * Description: 
 * An interactive "body-instrument" that uses machine learning to transform a solo singer 
 * into a choir. It combines real-time pitch detection (CREPE) with hand pose estimation 
 * to generate synthesized vocal harmonies. The visual system uses a "satellite" metaphor 
 * where harmonic intervals orbit the root note, with particle effects representing 
 * vocal energy.
 */

// --- Variables ---
let video;
let handpose;
let predictions = [];

let audioContext;
let mic;
let pitch;
const model_url = 'https://cdn.jsdelivr.net/gh/ml5js/ml5-data-and-models/models/pitch-detection/crepe/';

// Audio Variables
let oscRoot; // Root Note (Unison) - NEW
let osc3rd;  // Major 3rd (x1.25)
let osc5th;  // Perfect 5th (x1.5)
let filter;
let reverb;

let currentFreq = 0;
// Harmony State: 0=Mute, 1=Root, 2=Root+3rd, 3=Root+3rd+5th
let harmonyState = 0;

let particles = [];

const scaleArr = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function setup() {
  createCanvas(windowWidth, windowHeight);

  // 1. Audio Input Setup
  audioContext = getAudioContext();
  mic = new p5.AudioIn();
  mic.start(() => {
    console.log("Mic started, capturing RVC output...");
    loadPitchModel(); // 這裡啟動 ml5.pitchDetection
  });

  fft = new p5.FFT(0.8, 512);
  fft.setInput(mic);

  // 2. Audio Output Setup (Triad Synthesizer)

  // Voice 0: The Root (Unison)
  oscRoot = new p5.Oscillator('triangle');
  oscRoot.amp(0);

  // Voice 1: The Major 3rd
  osc3rd = new p5.Oscillator('triangle');
  osc3rd.amp(0);

  // Voice 2: The Perfect 5th
  osc5th = new p5.Oscillator('triangle');
  osc5th.amp(0);

  // Effects Chain
  filter = new p5.LowPass();
  reverb = new p5.Reverb();

  // Connect all oscillators to the filter
  oscRoot.disconnect();
  osc3rd.disconnect();
  osc5th.disconnect();

  oscRoot.connect(filter);
  osc3rd.connect(filter);
  osc5th.connect(filter);

  // Process filter output with reverb
  reverb.process(filter, 3, 2);

  // 3. Video Setup
  video = createCapture(VIDEO);
  video.size(640, 480);
  video.hide();

  // 4. HandPose Setup
  handpose = ml5.handpose(video, modelReadyHand);
  handpose.on("predict", results => {
    predictions = results;
  });
}

// load pitch model
function loadPitchModel() {
  pitch = ml5.pitchDetection(model_url, audioContext, mic.stream, modelReadyPitch);
}

function modelReadyPitch() {
  select('#model-status').html('Ready');
  select('#model-status').style('color', '#00ff00');
  console.log("Pitch Detection Ready!");
  checkAllModelsReady();
  getPitch();
}

function modelReadyHand() {
  console.log("HandPose Ready!");
  checkAllModelsReady();
}

function checkAllModelsReady() {
  if (select('#model-status').html().includes('Ready')) {
    let btn = select('#start-btn');
    btn.html('Start Experience');
    btn.removeAttribute('disabled');
  }
}

// --- App Start ---
function startApp() {
  userStartAudio();
  oscRoot.start();
  osc3rd.start();
  osc5th.start(); // Start all voices

  // Stereo Separation (Wide Soundstage)
  oscRoot.pan(0.0);   // Root in Center
  osc3rd.pan(-0.5);   // 3rd on Left
  osc5th.pan(0.5);    // 5th on Right

  select('#overlay').style('display', 'none');
}

// --- Pitch Detection Loop ---
function getPitch() {
  pitch.getPitch(function (err, frequency) {
    if (frequency) {
      currentFreq = frequency;
      let midiNum = freqToMidi(frequency);
      let note = scaleArr[midiNum % 12];
      select('#note-display').html(`${note} (${Math.round(frequency)}Hz)`);
    } else {
      select('#note-display').html("--");
    }
    getPitch();
  })
}

function draw() {
  background(30);

  // 1. Draw Mirrored Video
  push();
  translate(width, 0);
  scale(-1, 1);
  tint(10, 10, 10, 100);
  image(video, 0, 0, width, height);

  // 2. Hand Logic
  let fingerCount = 0;
  if (predictions.length > 0) {
    drawKeypoints();
    fingerCount = countFingers(predictions[0]);
  }
  pop();

  // 3. Update Harmony Logic
  updateHarmony(fingerCount);

  // 4. Audio Synthesis & Visuals
  if (currentFreq > 0 && harmonyState > 0) {

    // Calculate Target Frequencies
    let freqRoot = currentFreq;
    let freq3rd = currentFreq * 1.25;
    let freq5th = currentFreq * 1.5;

    // Set Frequencies
    oscRoot.freq(freqRoot, 0.1);
    osc3rd.freq(freq3rd, 0.1);
    osc5th.freq(freq5th, 0.1);

    filter.freq(freq5th * 2); // Brightness follows highest pitch

    let vol = mic.getLevel();

    // --- MIXER LOGIC (Progressive Stacking) ---
    // Base volume per voice
    let v = vol * 0.3;

    // State 1 (1 Finger): Root Only
    if (harmonyState >= 1) {
      oscRoot.amp(v, 0.1);
    } else {
      oscRoot.amp(0, 0.1);
    }

    // State 2 (3 Fingers): Root + 3rd
    if (harmonyState >= 2) {
      osc3rd.amp(v, 0.1);
    } else {
      osc3rd.amp(0, 0.1);
    }

    // State 3 (5 Fingers): Root + 3rd + 5th
    if (harmonyState >= 3) {
      osc5th.amp(v, 0.1);
    } else {
      osc5th.amp(0, 0.1);
    }

    drawVisuals(freqRoot, freq3rd, freq5th, vol);
  } else {
    // Mute All
    oscRoot.amp(0, 0.1);
    osc3rd.amp(0, 0.1);
    osc5th.amp(0, 0.1);

    // Draw ghost ball just to show listening
    drawVisuals(currentFreq, 0, 0, 0);
  }

  // 5. Update and Draw Particles
  for (let i = particles.length - 1; i >= 0; i--) {
    particles[i].update();
    particles[i].show();
    if (particles[i].isDead()) {
      particles.splice(i, 1);
    }
  }
}

function drawVisuals(fRoot, f3rd, f5th, vol) {
  // Map Y positions
  let yRoot = map(currentFreq, 100, 1000, height * 0.5, height * 0.3);
  let y3rd = map(f3rd, 100, 1000, height * 0.5, height * 0.3);
  let y5th = map(f5th, 100, 1000, height * 0.5, height * 0.3);

  let size = (vol > 0) ? vol * 1000 + 20 : 20;
  let centerX = width / 2;
  let radius = size * 0.8 + 40;

  // 1. Draw Root Voice (White) - Center
  if (harmonyState >= 1 || vol === 0) {
    fill(255, 255, 255, (vol > 0) ? 200 : 50);
    noStroke();
    circle(centerX, yRoot, size/2);

    // Particles for Root
    if (vol > 0.01 && harmonyState >= 1 && random(1) < 0.2) {
      particles.push(new Particle(centerX, yRoot, color(255, 255, 255)));
    }
  }

  // 2. Draw 3rd Voice (Cyan) - Left Side
  if (harmonyState >= 2) {
    let angle3 = frameCount * 0.05;
    let x3 = centerX + cos(angle3) * radius;
    let y3 = y3rd + sin(angle3) * 20;

    fill(0, 255, 200, 200); // Cyan
    circle(x3, y3, size * 0.8);

    stroke(0, 255, 200, 100);
    strokeWeight(2);
    line(centerX, yRoot, x3, y3);

    if (vol > 0.01) {
      for (let i = 0; i < 3; i++) {
        particles.push(new Particle(x3, y3, color(0, 255, 200)));
      }
    }
  }

  // 3. Draw 5th Voice (Magenta) - Right Side
  if (harmonyState >= 3) {
    let angle5 = frameCount * 0.05 + PI;
    let x5 = centerX + cos(angle5) * radius;
    let y5 = y5th + sin(angle5) * 20;

    fill(255, 0, 255, 200); // Magenta
    circle(x5, y5, size * 0.8);

    stroke(255, 0, 255, 100);
    strokeWeight(2);
    line(centerX, yRoot, x5, y5);

    if (vol > 0.01) {
      for (let i = 0; i < 3; i++) {
        particles.push(new Particle(x5, y5, color(255, 0, 255)));
      }
    }
  }
}

// update harmony based on number of fingers
function updateHarmony(fingers) {
  let modeText = select('#harmony-mode');
  let handText = select('#hand-status');

  handText.html(`${fingers} Fingers`);

  if (fingers >= 4) {
    harmonyState = 3; // Root + 3rd + 5th
    modeText.html('🖐️ Full Triad (1+3+5)');
    modeText.style('color', '#ff00ff');
  } else if (fingers === 3) {
    harmonyState = 2; // Root + 3rd
    modeText.html('✌️ Harmony (1+3)');
    modeText.style('color', '#00ffcc');
  } else if (fingers === 1) {
    harmonyState = 1; // Root Only
    modeText.html('☝️ Root Note (1)');
    modeText.style('color', '#ffffff'); 
  } else {
    harmonyState = 0; // Mute
    modeText.html('✊ Muted');
    modeText.style('color', '#aaa');
  }
}

// Draw the keypoints of the hand
function drawKeypoints() {
  let prediction = predictions[0];
  for (let j = 0; j < prediction.landmarks.length; j++) {
    let keypoint = prediction.landmarks[j];
    fill(255, 255, 0);
    noStroke();
    let x = map(keypoint[0], 0, video.width, 0, width);
    let y = map(keypoint[1], 0, video.height, 0, height);
    ellipse(x, y, 10, 10);
  }
}

// count extended fingers
function countFingers(prediction) {
  let landmarks = prediction.landmarks;
  let count = 0;

  let tips = [4, 8, 12, 16, 20];
  let bases = [2, 6, 10, 14, 18];

  // Thumb check (x-axis)
  if (landmarks[4][0] < landmarks[3][0]) count++;

  // Other fingers (y-axis)
  for (let i = 1; i < 5; i++) {
    if (landmarks[tips[i]][1] < landmarks[bases[i]][1]) {
      count++;
    }
  }
  return count;
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

class Particle {
  constructor(x, y, col) {
    this.x = x;
    this.y = y;
    this.vx = random(-3, 3);
    this.vy = random(-3, 3);
    this.alpha = 255;
    this.color = col;
    this.size = random(3, 10);
  }

  update() {
    this.x += this.vx;
    this.y += this.vy;
    this.alpha -= 5;
  }

  show() {
    noStroke();
    fill(red(this.color), green(this.color), blue(this.color), this.alpha);
    circle(this.x, this.y, this.size);
  }

  isDead() {
    return this.alpha < 0;
  }
}