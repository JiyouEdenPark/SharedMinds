# Thinking Ripples (SharedMinds)

An interactive visualization of spontaneous thinking as ripples on water, built with vanilla HTML/CSS/JavaScript Canvas.

한국어 요약: 물결처럼 생성·확산·소멸하는 생각을 캔버스로 시각화한 인터랙티브 프로젝트입니다. 텍스트를 입력하면 메인 텍스트가 나타나고, 1초마다 작은 텍스트가 물결(ripple) 형태로 둘러싸이며, 일정 시간이 지나면 안쪽에서 바깥쪽으로 서서히 사라집니다. 링 텍스트는 한국어 → 일본어 → 영어 순서로 번갈아 나타납니다.

## Quick Start

Option A: Just open `index.html` in a modern browser.

Option B: Serve locally (recommended for API requests and consistent behavior):

```bash
# using Node
npx serve .

# or Python
python3 -m http.server 3000
```

Open the shown URL (e.g., http://localhost:3000).

## How to Use

- Type a word/phrase in the input box at the bottom center.
- Press Enter or click the "Think" button.
- Main text appears at a random position. Every second a new ring of small characters forms around it.
- You can also click on the canvas to place the main text exactly at the click position (when the input has text).

## Visual Behavior

- Main text size: 20pt. Ring characters: 10pt.
- Rings spawn every ~1s, expanding outward with a fixed gap.
- Characters around each ring are spaced by exactly one space; the input word repeats to fill the circle.
- Fade-in: 0.5s for main and ring characters.
- Lifetime: ~15s total (≈10s hold + ≈5s fade-out).
- Fade-out is staggered: main text first, then inner rings to outer rings, with slight per-character delays.
- Once fading starts, no new rings are created for that thought.

## Multilingual Rings

- Ring languages alternate: Korean → Japanese → English.
- Translations are fetched asynchronously via the free MyMemory API (no key required). If unavailable or limited, the original text is used as a fallback.
- Language detection (heuristic):
  - Contains Hangul → treated as Korean
  - Contains Hiragana/Katakana (or any Han/CJK ideographs) → treated as Japanese
  - Contains Latin letters → treated as English
  - Otherwise defaults to English

Note: Free translation services can be rate-limited and may return imperfect results.

## Configure Behavior (script.js)

You can tune these parameters in `script.js`:

- `baseRadius` (default: 30): initial ring radius.
- `ringGap` (default: 22): radial distance between consecutive rings.
- `elementFadeInMs` (default: 500): fade-in duration per element.
- `elementFadeMs` (default: 500): fade-out duration per element.
- `ringDelayMs` (default: 250): delay between rings starting fade-out.
- `charDelayMs` (default: 12): per-character stagger during fade-out in each ring.

Translation/config:
- `fetchTranslations(...)`: async translation fetch using MyMemory.
- `translationCache`: caches results per input text.
- `detectLanguage(text)`: simple ko/ja/en heuristic; Han/CJK ideographs are treated as Japanese.

## Styling

Edit `style.css` to customize:
- Background color (currently white)
- Input and button placement/size (bottom-center, compact button attached to the input)
- Cursor and responsive layout

## Known Notes

- Public translation APIs may throttle or reject frequent requests. The app gracefully falls back to the original text.
- If you want a fully offline experience or consistent phrasing, you can disable translation by returning the input string from `translate(...)`, or fix the language cycle to a single language by modifying the `langs` array in `createRipple(...)`.
