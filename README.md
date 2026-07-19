# Goodiano

A virtual piano keyboard Progressive Web App (PWA) with realistic **Yamaha U1** grand piano sound. Play a full 88-key keyboard (A0–C8) from your phone or desktop browser, with offline support, a mini-map navigator, and a premium dark-themed interface.

## Features

- **88-key piano** — Full A0 (MIDI 21) through C8 (MIDI 108) range.
- **Realistic sound** — Polyphonic playback from a Yamaha U1 SoundFont (`.sf2`) parsed and rendered with the Web Audio API.
- **Mobile-first** — Optimized for iPhone/iOS: notch & status-bar safe areas, `standalone` PWA mode, touch gestures.
- **Responsive layout** — Adapts between portrait (≥10 visible white keys) and landscape (fixed 50px keys).
- **Mini-map navigator** — Quickly jump across the keyboard.
- **Offline support** — A service worker caches the app shell and lazily caches the SoundFont for offline play.
- **Keyboard & pointer input** — Touch, mouse, and computer-keyboard input with velocity support.

## Tech Stack

- Vanilla JavaScript (ES modules), no build step required.
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
│   ├── app.js              # Orchestrator: wires model → input → layout → render → audio
│   ├── model.js            # Piano data model (Pitch enum, 88-key generation)
│   ├── audio.js            # SF2 parser + Web Audio playback engine
│   ├── keyboard.js         # Layout computation & hit-testing
│   ├── input.js            # Pointer / keyboard input controller
│   └── render.js           # Keyboard + mini-map rendering
└── assets/
    ├── icons/              # PWA icons (180 / 192 / 512 px)
    └── yahama_U1.sf2       # Yamaha U1 SoundFont (audio samples)
```

## Getting Started

Goodiano is a static site, but it **must be served over HTTP(S)** (ES modules and the service worker will not work from `file://`).

Using Python (no install required):

```bash
cd web
python3 -m http.server 8000
# Open http://localhost:8000
```

Or using Node:

```bash
npx serve .
```

> **Note:** On iOS, audio only starts after the first tap/gesture (browser autoplay policy). The app handles this automatically — just tap a key to begin.

## PWA / Offline

- Installable on iOS (Add to Home Screen) and Android/desktop browsers that support PWAs.
- The app shell is cached on first load. The SoundFont is cached on first successful fetch, so the piano works fully offline afterwards.
- If SoundFont storage fails, a non-blocking "retry" prompt appears and the app still runs once online.

## Browser Support

Any modern browser with Web Audio API and Service Worker support: Safari (iOS 14.5+), Chrome, Edge, Firefox. Best experience on mobile Safari/iOS.

## Contributing

1. Fork / clone the repository.
2. Serve locally (see Getting Started) and make changes.
3. Keep the no-build, vanilla-JS approach unless adding a clear benefit.
4. Commit and open a pull request.

## License

Released under the [MIT License](./LICENSE).
