# Goodiano

A virtual piano keyboard Progressive Web App (PWA) with realistic **Yamaha U1** grand piano sound. Play a full 88-key keyboard (A0–C8) from your phone or desktop browser, with offline support, a mini-map overview, and a premium dark-themed interface.

Play Goodiano at [goodiano.myles.hk](https://goodiano.myles.hk).

## Features

- **88-key piano** — Full A0 (MIDI 21) through C8 (MIDI 108) range.
- **Realistic sound** — Polyphonic playback from a compact Yamaha U1 AAC audio sprite decoded by the Web Audio API.
- **Mobile-first** — Optimized for iPhone/iOS: notch & status-bar safe areas, `standalone` PWA mode, touch gestures.
- **Responsive layout** — Adapts between portrait (≥10 visible white keys) and landscape (55px logical keys).
- **Mini-map navigator** — Colour-coded octave blocks showing which part of the keyboard is on screen. Tap or drag it to jump anywhere on the 88 keys; focus it and use the arrows, Page Up/Down, Home, and End.
- **Offline support** — A service worker caches the app shell and lazily caches the audio sprite for offline play.
- **Pointer input** — Touch and mouse input, with velocity from touch pressure or device motion where available.
- **Computer keyboard** — `Z`–`M` and `Q`–`P` play two octaves with the black keys on the row above; `←`/`→` shift octave and scroll the view; `Shift` and `Alt` accent or soften. Mapped by physical key position, so non-QWERTY layouts work unchanged.
- **Sustain pedal** — Hold `Space`, or latch the pedal from the settings panel. Released keys keep ringing until the pedal lifts.
- **Output settings** — Master volume and a note-name toggle, both remembered between visits.
- **Diagnostics log** — The app records what the page and the audio engine did, and the settings panel exports it as a text file to share or download.

## Tech Stack

- Vanilla TypeScript modules built with Vite (no UI framework).
- Vitest unit tests and real-browser pointer tests through Playwright/WebKit.
- Web Audio API for sample-accurate polyphonic playback.
- Workbox service worker + localized Web App Manifests for installable PWA / offline use.
- Pure CSS dark theme (no framework).

## Project Structure

```
web/
├── index.html              # App shell / entry point
├── build/                  # Content-hashed asset/manifest build plugin
├── css/
│   └── main.css            # Styles (dark theme, responsive)
├── js/sw.ts               # Workbox service worker (offline caching)
├── js/app/
│   ├── app.ts              # Orchestrator: wires model → input → layout → render → audio
│   ├── model.ts            # Piano data model (Pitch enum, 88-key generation)
│   ├── audio.ts            # Audio-sprite loader + Web Audio playback engine
│   ├── sample-zones.ts     # Generated sample offsets and pitch mappings
│   ├── diagnostics.ts      # Lifecycle event log + settings-panel export
│   ├── keyboard.ts         # Layout computation & hit-testing
│   ├── input.ts            # Pointer / keyboard input controller
│   └── render.ts           # Keyboard + mini-map rendering
├── tests/                  # Unit and browser interaction tests
└── public/                 # Source assets; emitted with hashes in production
    ├── manifest.*.json     # Localized PWA manifest templates
    └── assets/
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
npm run lint
npm run typecheck
npm test
npm run test:browser
npm run test:coverage   # both suites in one run, with a coverage floor
npm run build
npm run preview
```

The browser suite drives a real WebKit build, which needs a one-time
download of the browser and its system libraries:

```bash
npx playwright install --with-deps webkit
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
- Production JS, CSS, audio, icons, and localized manifests use content-hashed filenames. The build fails if a stable source URL leaks into `dist`.
- The versioned app shell is precached. The hashed audio sprite is cached on first successful fetch, so the piano works fully offline afterwards.
- New workers activate immediately, remove legacy `goodiano-*` shell caches, and refresh an open app once. Development mode never precaches source URLs; on the dedicated development origin it instead serves a one-shot cleanup worker that removes legacy service workers and caches, reloads controlled pages, then unregisters itself.
- If audio storage fails, a non-blocking "retry" prompt appears and the app still runs once online.

## Diagnostics Log

Audio that dies after the phone comes back from the lock screen leaves nothing
behind: there is no console to open on a phone, and the page often reloads
before anyone can look. So the app keeps its own record — the audio context
being created, resumed, found frozen and replaced, the sample download and
decode, every visibility change, and keys that arrive at an engine that cannot
play them. Repeated events fold into one line with a count, so a burst of
tapping cannot push out the history that explains it.

**Settings → Download Log** writes the last two sessions to a text file. On iOS
the share sheet opens first, so the file can go straight into a message; other
browsers download it, and a browser that will do neither gets it on the
clipboard. The log is stored in `localStorage` under `goodiano.diagnostics.v1`
and is flushed whenever the app is backgrounded, which is what makes the
session *before* an iOS-forced reload survive to be read.

The file carries the build and commit, the user agent, language, time zone,
display mode, and online state, plus the engine's own state at the moment of
export. It records which keys were played, and nothing else about the player.

## Browser Support

Any modern browser with Web Audio API and Service Worker support: Safari (iOS 14.5+), Chrome, Edge, Firefox. Best experience on mobile Safari/iOS.

## Versioning

The patch number is never typed by a person. The build derives the version and
stamps it into the bundle, so the number in the settings panel always names the
build that is actually running:

```
major.minor  from package.json      chosen by hand, changed rarely
patch        git rev-list --count   advances on every commit
commit       git rev-parse --short  names the exact build
```

The settings panel shows the two together, for example `Goodiano · v0.4.63
(a1b2c3d)`. Every push to `main` deploys and carries a higher patch number than
the one before it — nothing to merge, nothing to approve, and nothing written
back to the repository to make it happen.

Bump `major`/`minor` in `package.json` when a release deserves it; the patch
digits there are ignored and exist only to keep the field valid semver. Where
git is unavailable, such as a build from a source archive, the version falls
back to the `package.json` value verbatim and the commit is omitted.

CI checks out with `fetch-depth: 0` for this. A shallow clone would count one
commit and pin every build to `.1`.

## Contributing

1. Fork / clone the repository.
2. Serve locally (see Getting Started) and make changes.
3. Keep the imperative, framework-free piano surface unless a UI framework adds a clear product benefit.
4. Commit and open a pull request.

## License

Released under the [MIT License](./LICENSE).
