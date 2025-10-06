# Shared Minds - Collaborative Ripple Thoughts

A canvas-based shared board. When you submit a thought (voice or text), it appears as ripple text, then slowly “sinks below the water” and becomes blurred. All thoughts are stored and streamed via Firebase Firestore—no custom server required.

### Key Features
- **Input**: Microphone (Replicate Whisper proxy or local worker) + bottom text input
  - Placeholder: "Type your thought"
  - Button label: "Throw"
- **Translation**: Auto language detection with parallel KO/JA/EN translation. Persist/broadcast only after translation is ready.
- **Display rules**:
  - Ripple rings with character animation; after ~10s the ripples fade out in sequence
  - The main text then sinks below the water with a natural easing curve and blur
  - Click a text to resurface instantly (clear view) for 10 seconds, then it sinks again

### Data Sync (Firebase Firestore)
- **Collection**: `shared_thoughts`
- **Writes**: After translation completes, save `{ id, text, x, y, createdAt(serverTimestamp), translations }`
- **Subscription**:
  - First snapshot: render all existing documents (deduped)
  - Subsequent snapshots: process only `added` changes to display new items
- **De-duplication**:
  - `sentMessageIds`: avoids showing the item you just sent
  - `displayedDocIds`: avoids re-rendering items already drawn

### Visualization
- **Ripples**: new ring every 1s, character-level fade-in/out (staggered)
- **Submerge animation**: smooth cubic ease-in-out; canvas `filter: blur(px)` plus slight downward offset
- **Surface hold time**: 10 seconds after click

### Architecture
- **Realtime**: Firestore `onSnapshot` (you can force Long Polling if WebChannel is blocked)
- **Voice**: Proxy ASR (Replicate) or local Web Worker (Transformers.js Whisper)
- **Translation**: MyMemory Translation API




