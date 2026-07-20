# Goodiano

A virtual piano keyboard Progressive Web App (PWA) with realistic **Yamaha U1** grand piano sound. Play a full 88-key keyboard (A0–C8) from your phone or desktop browser, with offline support, a mini-map navigator, and a premium dark-themed interface.

## Features

- **88-key piano** — Full A0 (MIDI 21) through C8 (MIDI 108) range.
- **Realistic sound** — Polyphonic playback from a compact Yamaha U1 AAC audio sprite decoded by the Web Audio API.
- **Mobile-first** — Optimized for iPhone/iOS: notch & status-bar safe areas, `standalone` PWA mode, touch gestures.
- **Responsive layout** — Adapts between portrait (≥10 visible white keys) and landscape (55px logical keys).
- **Mini-map navigator** — Quickly jump across the keyboard.
- **Offline support** — A service worker caches the app shell and lazily caches the audio sprite for offline play.
- **Keyboard & pointer input** — Touch, mouse, and computer-keyboard input with velocity support.

## Tech Stack

- Vanilla TypeScript modules built with Vite (no UI framework).
- Vitest unit tests and real-browser pointer tests through Playwright/WebKit.
- Web Audio API for sample-accurate polyphonic playback.
- Service Worker + Web App Manifest for installable PWA / offline use.
- Pure CSS dark theme (no framework).

## Project Structure

```
web/
├── index.html              # App shell / entry point
├── manifest.json           # PWA manifest
├── sw.js                   # Service worker (offline caching)
├── css/
│   └── main.css            # Styles (dark theme, responsive)
├── js/app/
│   ├── app.ts              # Orchestrator: wires model → input → layout → render → audio
│   ├── model.ts            # Piano data model (Pitch enum, 88-key generation)
│   ├── audio.ts            # Audio-sprite loader + Web Audio playback engine
│   ├── sample-zones.ts     # Generated sample offsets and pitch mappings
│   ├── keyboard.ts         # Layout computation & hit-testing
│   ├── input.ts            # Pointer / keyboard input controller
│   └── render.ts           # Keyboard + mini-map rendering
├── tests/                  # Unit and browser interaction tests
└── public/assets/
    ├── icons/              # PWA icons (180 / 192 / 512 px)
    └── yamaha-u1.m4a       # Generated mono AAC-LC audio sprite
```

## Getting Started

Goodiano is a static site, but it **must be served over HTTP(S)** (ES modules and the service worker will not work from `file://`).

Install dependencies and start the Vite development server:

```bash
npm install
npm run dev
```

Production and verification commands:

```bash
npm run typecheck
npm test
npm run test:browser
npm run build
npm run preview
```

The generated audio and zone metadata are committed, so normal development and
CI do not need FFmpeg. To regenerate them, install FFmpeg and supply the
original SoundFont explicitly (the source SF2 is not deployed):

```bash
npm run audio:generate -- /path/to/yamaha-u1.sf2
```

The conversion selects the same 14 left-channel zones reached by the original
player's ordered first-match lookup, retains each complete recorded sample,
and adds AAC-frame-aligned silent guards between samples.

> **Note:** On iOS, audio only starts after the first tap/gesture (browser autoplay policy). The app handles this automatically — just tap a key to begin.

## PWA / Offline

- Installable on iOS (Add to Home Screen) and Android/desktop browsers that support PWAs.
- The app shell is cached on first load. The audio sprite is cached on first successful fetch, so the piano works fully offline afterwards.
- If audio storage fails, a non-blocking "retry" prompt appears and the app still runs once online.

## Browser Support

Any modern browser with Web Audio API and Service Worker support: Safari (iOS 14.5+), Chrome, Edge, Firefox. Best experience on mobile Safari/iOS.

## Contributing

1. Fork / clone the repository.
2. Serve locally (see Getting Started) and make changes.
3. Keep the imperative, framework-free piano surface unless a UI framework adds a clear product benefit.
4. Commit and open a pull request.

## License

Released under the [MIT License](./LICENSE).
