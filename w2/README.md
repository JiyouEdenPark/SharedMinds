# Thinking Ripples (SharedMinds)

An interactive visualization of spontaneous thinking as ripples on water, built with vanilla HTML/CSS/JavaScript Canvas.

This is a voice interactive piece. Recognized speech appears as a "thought" on the canvas and spawns translation rings (Korean → Japanese → English) that expand and fade like ripples. A pulse ripple around the centered mic button also expands in response to input level while recording.

## How to Use

-   Click the mic button in the center to start/stop recording.
-   Speak; recognized text appears on the canvas and translation rings spawn periodically.
-   While recording, subtle pulse ripples emanate around the mic button, scaled by audio level.

## Visual Behavior

-   Main text size: 20pt. Ring characters: 10pt.
-   Rings spawn every ~1s, expanding outward with a fixed gap.
-   Characters around each ring are spaced by exactly one space; the input word repeats to fill the circle.
-   Fade-in: 0.5s for main and ring characters.
-   Lifetime: ~15s total (≈10s hold + ≈5s fade-out).
-   Fade-out is staggered: main text first, then inner rings to outer rings, with slight per-character delays.
-   Once fading starts, no new rings are created for that thought.

## Mic UI and Pulse Ripples

-   Position: centered (`.input-section` is centered)
-   Button: white circular with a light gray stroke (`#micBtn`)
-   Pulse ripple around the mic button (`#micPulse .ring`) animates as:
    -   0% → 20%: quick fade-in
    -   20% → 60%: hold at max opacity
    -   60% → 100%: scale up and fade out
-   Easing: `ease-in-out`

## Multilingual Rings

-   Ring languages alternate: Korean → Japanese → English.
-   Translations are fetched asynchronously via the free MyMemory API (no key required). If unavailable or limited, the original text is used as a fallback.
-   Language detection (heuristic):
    -   Contains Hangul → treated as Korean
    -   Contains Hiragana/Katakana (or any Han/CJK ideographs) → treated as Japanese
    -   Contains Latin letters → treated as English
    -   Otherwise defaults to English

Note: Free translation services can be rate-limited and may return imperfect results.

## Configure Behavior (script.js)

You can tune these parameters in `script.js`:

-   `baseRadius` (default: 30): initial ring radius.
-   `ringGap` (default: 22): radial distance between consecutive rings.
-   `elementFadeInMs` (default: 500): fade-in duration per element.
-   `elementFadeMs` (default: 500): fade-out duration per element.
-   `ringDelayMs` (default: 250): delay between rings starting fade-out.
-   `charDelayMs` (default: 12): per-character stagger during fade-out in each ring.

Translation/config:

-   `fetchTranslations(...)`: async translation fetch using MyMemory.
-   `translationCache`: caches results per input text.
-   `detectLanguage(text)`: simple ko/ja/en heuristic; Han/CJK ideographs are treated as Japanese.

## Known Notes

-   Public translation APIs may throttle or reject frequent requests. The app gracefully falls back to the original text.
-   If you want a fully offline experience or consistent phrasing, you can disable translation by returning the input string from `translate(...)`, or fix the language cycle to a single language by modifying the `langs` array in `createRipple(...)`.

## Speech Recognition (ASR)

You can choose between two ASR paths for voice input:

-   Local (default): Runs Whisper (Xenova/transformers.js) in a Web Worker. Fully client-side; larger initial load.
-   Proxy API: Uses the ITP-IMA Replicate proxy to transcribe on a remote service.

### Enable Proxy API mode

Pass the flag when constructing `VoiceInput` (in `script.js`):

```js
this.voiceInput = new VoiceInput({
    micBtn: this.micBtn,
    realtime: true,
    useProxyASR: true, // set to false to use local worker ASR
    onAppendText: (text) => this.showThought(text),
});
```

### How it works

-   Local mode: audio is captured and downsampled to 16 kHz mono Float32, sent to the Web Worker (`asrWorker.js`) to run Whisper in the browser.
-   Proxy mode: audio Float32 is encoded to a 16-bit WAV Blob, then posted to the proxy (`proxyASR.js`). The service returns `output.text` which is appended to the canvas visualization.
