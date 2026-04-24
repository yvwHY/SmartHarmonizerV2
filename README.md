# Smart HarmonizerV2

**Date:** April 2026  
**Author:** Yu Ting Liao  
**Project Type:** WCC2 Final Project — Technical Proof of Concept

## Short Description

Smart HarmonizerV2 is a web-based real-time vocal harmony simulator. The user sings into a microphone and the system generates up to three harmony voices automatically, building a full chord around the input pitch. Hand gestures — tracked via webcam — control the harmony volume (pinch) and tremolo depth (horizontal hand position), turning the body into a live instrument controller.

## Concept / Intent

This project explores the intersection of voice, gesture, and machine listening. Rather than using a keyboard or pedal to trigger harmony, the user's hands become the performance interface — opening a pinch to swell the choir in, or sweeping a hand across the screen to add tremolo shimmer. The system listens continuously, auto-detects the tonal context of the singing (major or minor), and selects an appropriate harmony preset in real time. The goal is to collapse the distance between intention and sound: to sing and immediately be surrounded by a choir of your own voice.

## Technology Used

- **Language:** JavaScript (ES6+)
- **Libraries:**
  - **p5.js (v1.9.0):** Canvas rendering, draw loop, input handling
  - **Tone.js (v14.8.49):** Web Audio synthesis and effects chain
    - `Tone.PitchShift` — real-time vocal harmony generation
    - `Tone.Tremolo` — gesture-controlled tremolo effect
    - `Tone.Reverb` — shared hall reverb across all voices
    - `Tone.Limiter` — master output protection
  - **ml5.js (v0.12.2):** Hand pose detection for gesture control
- **Audio Algorithm:** YIN pitch detection (custom implementation) for real-time fundamental frequency estimation

## Audio Architecture

```
Microphone
  │
  ├── AnalyserNode ──────────────────── YIN pitch detection (visuals only)
  │
  ├── Soprano Dry ──── Reverb ─┐
  │                             │
  ├── PitchShift (Alto)  ─┐    │
  ├── PitchShift (Tenor) ─┼─ VoiceGain ─ Tremolo ─ Reverb ─┤
  └── PitchShift (Bass)  ─┘                                  │
                                                    MasterGain (2.0)
                                                    Limiter (−2 dB)
                                                    Speakers
```

## Harmony Presets

Five selectable chord types, each defined as fixed semitone intervals above the input pitch:

| Preset  | Intervals    | Character                   |
|---------|--------------|-----------------------------|
| Major   | +4, +7, −5   | Bright, uplifting           |
| Minor   | +3, +7, −5   | Dark, emotional             |
| Octave  | +12, −12, +7 | Full, powerful              |
| Cluster | +2, +5, +9   | Modern, tense               |
| Gospel  | +4, +7, +11  | Soulful, lush               |

**Auto mode** detects whether the singing context is major or minor from a rolling pitch-class histogram and selects the best preset automatically.

## Gesture Controls

| Gesture                       | Action                          |
|-------------------------------|---------------------------------|
| Pinch open                    | Harmony volume swells in        |
| Pinch closed                  | Harmony fades to silence        |
| Hand on right side of screen  | Tremolo off (0%)                |
| Hand moves left               | Tremolo increases toward 100%   |
| Keys 1–5                      | Select harmony preset manually  |
| Key 0                         | Return to Auto mode             |

## How to Run

1. **Clone the repository:**
   ```bash
   git clone https://github.com/yvwHY/SmartHarmonizerV2.git
   cd SmartHarmonizerV2
   ```

2. **Start a local server** (required for camera/microphone CORS):
   - **VS Code:** Install the Live Server extension, right-click `index.html` → Open with Live Server
   - **Terminal:** `python -m http.server`

3. **Open** `http://127.0.0.1:5500` in Chrome

4. **Allow** camera and microphone permissions when prompted

5. **Click Start** — sing, then use hand gestures to shape the harmony

## Requirements

**Software:**
- Chrome (recommended) or any modern Chromium-based browser
- Local web server

**Hardware:**

> ⚠️ **Headphones or an external microphone are strongly recommended.**
>
> The built-in laptop microphone sits physically 2–3 cm from the built-in speakers. When the harmony voices play through the speakers, the microphone picks them up and the system begins harmonising with itself — a feedback loop that degrades both the audio output and the pitch detection.
>
> The system already applies several software mitigations:
> - `echoCancellation: true` on the mic stream (Chrome's built-in AEC)
> - The user's dry voice is never routed through speakers (they hear themselves naturally)
> - All harmony voices share a reverb send rather than a direct output
>
> These help significantly, but cannot fully compensate for the physical proximity of mic and speaker on a laptop. **The definitive fix is hardware:**
>
> - **Option A — Headphones (easiest):** Any wired or wireless headphones. Sound goes into your ears only, never reaches the mic. Instant fix.
> - **Option B — External USB/audio interface mic:** A cardioid microphone on a stand, pointed away from the speakers, physically separated from the audio output.
> - **Option C — AirPods or earbuds:** The mic is close to your mouth and far from the laptop speakers. Much better isolation than the built-in mic.

## Notes on Feedback

For reference, this is what causes feedback and what each mitigation does:

| Cause | Mitigation | Effectiveness |
|-------|-----------|---------------|
| Harmony plays through speakers → enters mic | `echoCancellation: true` | Partial — AEC works best when speaker and mic are far apart |
| Dry voice plays through speakers → enters mic | Soprano not routed to speakers | Good — removes the loudest feedback path |
| Room reverb of harmony voices enters mic | All voices through shared reverb (not direct) | Minor improvement |
| Physical proximity of laptop mic to speaker | **Use headphones or external mic** | Complete fix |

## Credits / Acknowledgements

- **Student:** Yu Ting Liao
- **Course:** Workshops in Creative Coding 2, Goldsmiths University of London
- **References:**
  - Dourish, P. (2001). *Where the Action Is: The Foundations of Embodied Interaction.* MIT Press.
  - Heap, I. (2014). Mi.Mu Gloves. http://mimugloves.com
  - de Cheveigné, A. & Kawahara, H. (2002). YIN, a fundamental frequency estimator for speech and music. *Journal of the Acoustical Society of America*, 111(4), 1917–1930.
  - McCarthy, L. et al. (2015). p5.js Reference. https://p5js.org/reference/
  - Mann, Y. (2019). Tone.js. https://tonejs.github.io
  - Shiffman, D. "ml5.js: Handpose". The Coding Train. https://thecodingtrain.com
  - RVC-Project. (2023). Retrieval-based-Voice-Conversion-WebUI. https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI

## License

Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)

## Contact

- **GitHub:** https://github.com/yvwHY/SmartHarmonizerV2
- **Email:** yvw.liao@gmail.com