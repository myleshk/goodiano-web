/**
 * Goodiano PWA — App Orchestrator
 * Wires model → input → keyboard layout → render → audio.
 * Port of ContentView.swift + KeyboardView.swift body logic.
 */

import { generateFullPianoKeys } from './model';
import { DEFAULT_VELOCITY, PianoAudioEngine } from './audio';
import { YAMAHA_U1_ZONES } from './sample-zones';
import { computeLayout, hitTest, findMiddleCIndex, getWhiteKeyWidth, scrollToKey } from './keyboard';
import { InputController } from './input';
import type { InputKey, MotionPermissionState } from './input';
import { KeyboardRenderer } from './render';
import type { KeyboardLayout } from './keyboard';
import type { PianoKey } from './model';


class GoodianoApp {
  keys: PianoKey[];
  layout: KeyboardLayout;
  audio: PianoAudioEngine;
  renderer: KeyboardRenderer | null = null;
  input: InputController | null = null;
  viewportWidth = 0;
  keyboardHeight = 0;
  whiteKeyWidth = 50;
  maxScroll = 0;
  keyboardArea!: HTMLElement;
  scrollContainer!: HTMLElement;
  keyboardContent!: HTMLElement;
  miniMapEl!: HTMLElement;
  loadingOverlay: HTMLElement | null = null;
  velocityDebug: HTMLElement | null = null;
  settingsPanel: HTMLElement | null = null;
  private _resizeObserver: ResizeObserver | null = null;

  constructor() {
    this.keys = generateFullPianoKeys();
    this.layout = computeLayout(this.keys);
    this.audio = new PianoAudioEngine();
  }

  async init() {
    // Cache DOM elements
    this.keyboardArea = this._requiredElement('.keyboard-area');
    this.scrollContainer = this._requiredElement('.keyboard-scroll');
    this.keyboardContent = this._requiredElement('.keyboard-content');
    this.miniMapEl = this._requiredElement('.minimap-container');
    this.loadingOverlay = document.querySelector('.loading-overlay');
    this.velocityDebug = document.querySelector('.velocity-debug');
    this.settingsPanel = document.querySelector('.settings-panel');
    document.querySelector<HTMLButtonElement>('.settings-toggle')?.addEventListener('click', () => {
      if (this.settingsPanel) this.settingsPanel.hidden = !this.settingsPanel.hidden;
    });
    const loadingOverlay = this.loadingOverlay;
    loadingOverlay?.querySelector('.loading-retry')?.addEventListener('click', () => {
      loadingOverlay.classList.remove('recoverable-error');
      const text = loadingOverlay.querySelector('.loading-text');
      if (text) text.textContent = 'Retrying audio load…';
      this._loadAudio().then(() => {
        this._hideLoading();
        this._scrollToC4();
      }).catch(() => {});
    });
    navigator.serviceWorker?.addEventListener('message', event => {
      if (event.data?.type === 'CACHE_ERROR' && this.loadingOverlay) {
        const text = this.loadingOverlay.querySelector('.loading-text');
        if (text) text.textContent = 'Audio loaded, but could not be saved offline. Tap to retry.';
        this.loadingOverlay.classList.add('recoverable-error');
      }
    });

    // Init renderer
    this.renderer = new KeyboardRenderer(
      this.keyboardContent,
      this.miniMapEl,
      this.scrollContainer
    );

    // Build keyboard
    this.renderer.build(this.layout);
    this.renderer.buildMiniMap();

    // Compute initial sizes
    this._recalculateLayout();

    // Init input
    this.input = new InputController(this.scrollContainer, {
      onKeyPress: (key: InputKey, pressed: boolean, velocity?: number) => this._handleKeyPress(key, pressed, velocity),
      onScroll: (offset) => this._handleScroll(offset),
      onMotionPermissionChange: state => this._updateMotionPermissionDebug(state),
    });
    this._updateMotionPermissionDebug(this.input.motionPermissionState);

    this.settingsPanel?.querySelector<HTMLButtonElement>('.motion-permission-button')
      ?.addEventListener('click', async () => {
        const input = this.input;
        if (!input) return;
        if (input.motionEnabled) {
          input.setMotionEnabled(false);
          return;
        }
        const state = await input.requestMotionPermission();
        if (state === 'granted') input.setMotionEnabled(true);
      });
    this.settingsPanel?.querySelector<HTMLButtonElement>('.velocity-debug-toggle')
      ?.addEventListener('click', event => {
        const button = event.currentTarget as HTMLButtonElement;
        if (!this.velocityDebug) return;
        const visible = this.velocityDebug.hidden;
        this.velocityDebug.hidden = !visible;
        document.querySelectorAll<HTMLElement>('.motion-permission-status')
          .forEach(status => { status.hidden = !visible; });
        button.textContent = visible ? 'Hide Debug' : 'Show Debug';
      });
    this.settingsPanel?.querySelector<HTMLButtonElement>('.app-reload-button')
      ?.addEventListener('click', () => this.reloadApp());

    this.input.setConverters(
      (cx, cy) => this._screenToKeyboard(cx, cy),
      (x, y) => hitTest(x, y, this.whiteKeyWidth, this.keyboardHeight, this.layout)
    );

    // Attach resize listener
    this._resizeObserver = new ResizeObserver(() => this._recalculateLayout());
    this._resizeObserver.observe(this.keyboardArea);

    // Start fetching immediately. AudioContext may remain suspended until the
    // first pointer gesture, but parsing/caching should never wait for touch.
    this._loadAudio().then(() => {
      this._hideLoading();
      this._scrollToC4();
    }).catch(() => {});

    this._handleScroll(0);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.input?.releaseAll();
        this.audio.allNotesOff();
      } else {
        this.audio.ensureRunning().catch(() => {});
      }
    });
    window.addEventListener('pagehide', () => {
      this.input?.releaseAll();
      this.audio.allNotesOff();
    });
  }

  private _requiredElement(selector: string): HTMLElement {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) throw new Error(`Missing required element: ${selector}`);
    return element;
  }

  async _loadAudio() {
    try {
      await this.audio.loadSampleLibrary(
        'assets/yamaha-u1.m4a',
        YAMAHA_U1_ZONES,
        progress => this._updateLoadingProgress(progress),
      );
    } catch (err) {
      console.error('Failed to load audio:', err);
      // Show error state
      if (this.loadingOverlay) {
        const text = this.loadingOverlay.querySelector('.loading-text');
        if (text) text.textContent = err instanceof DOMException && err.name === 'AbortError'
          ? 'Audio load timed out. Tap to retry.'
          : 'Audio failed to load. Tap to retry.';
        this.loadingOverlay.classList.add('recoverable-error');
      }
      throw err;
    }
  }

  _hideLoading() {
    if (this.loadingOverlay) {
      this.loadingOverlay.classList.add('hidden');
      setTimeout(() => {
        if (this.loadingOverlay) this.loadingOverlay.style.display = 'none';
      }, 500);
    }
  }

  _updateLoadingProgress(progress: number): void {
    const value = Math.round(Math.max(0, Math.min(1, progress)) * 100);
    const indicator = this.loadingOverlay?.querySelector<HTMLElement>('.loading-progress');
    const label = this.loadingOverlay?.querySelector<HTMLElement>('.loading-progress-label');
    indicator?.style.setProperty('--progress', `${value}%`);
    indicator?.setAttribute('aria-valuenow', String(value));
    if (label) label.textContent = `${value}%`;
    const text = this.loadingOverlay?.querySelector<HTMLElement>('.loading-text');
    if (text && value >= 100) text.textContent = 'Preparing audio…';
  }

  _scrollToC4() {
    if (!this.input || !this.renderer) return;
    const c4Idx = findMiddleCIndex(this.layout);
    const target = scrollToKey(c4Idx, this.whiteKeyWidth, this.viewportWidth, this.maxScroll);
    this.input.setScrollOffset(target);
    this.scrollContainer.scrollLeft = target;
    this.renderer.updateMiniMap(target);
  }

  _recalculateLayout() {
    if (!this.keyboardArea) return;
    const rect = this.keyboardArea.getBoundingClientRect();
    this.viewportWidth = rect.width;
    this.keyboardHeight = rect.height;

    this.whiteKeyWidth = getWhiteKeyWidth(this.viewportWidth, this.keyboardHeight);

    if (!this.renderer) return;
    // Resize the keys before deriving any dimensions from their width. Safari
    // otherwise retains the previous content width for one layout pass.
    this.renderer.updateViewport(this.viewportWidth, this.keyboardHeight, this.whiteKeyWidth);
    const contentWidth = this.renderer.getContentWidth();
    this.maxScroll = Math.max(0, contentWidth - this.viewportWidth);

    // Keep the DOM scroll range in sync with the same width used above.
    if (this.keyboardContent) this.keyboardContent.style.width = contentWidth + 'px';

    if (this.input) {
      this.input.setMaxScroll(this.maxScroll);
      this.scrollContainer.scrollLeft = this.input.scrollOffset;
    }

    // Use the clamped scroll offset after the scroll bounds have been updated.
    this.renderer.updateMiniMap(this.input ? this.input.scrollOffset : 0);
  }

  _screenToKeyboard(clientX: number, clientY: number): { x: number; y: number } | null {
    if (!this.keyboardContent) return null;
    const contentRect = this.keyboardContent.getBoundingClientRect();
    return {
      x: clientX - contentRect.left,
      y: clientY - contentRect.top,
    };
  }

  _handleKeyPress(key: InputKey, pressed: boolean, velocity?: number): void {
    if (!this.renderer) return;
    if (pressed) {
      this.audio.ensureRunning().catch(() => {});
      this.audio.noteOn(key.id, this._getMidiNote(key.id), velocity);
      this._updateVelocityDebug(key, velocity ?? DEFAULT_VELOCITY);
    } else {
      this.audio.noteOff(key.id);
    }
    this.renderer.setPressed(key.id, pressed);
  }

  _updateVelocityDebug(key: InputKey, velocity: number): void {
    if (!this.velocityDebug) return;
    const value = this.velocityDebug.querySelector<HTMLElement>('.velocity-debug-value');
    const source = this.velocityDebug.querySelector<HTMLElement>('.velocity-debug-source');
    const raw = this.velocityDebug.querySelector<HTMLElement>('.velocity-debug-raw');
    const fill = this.velocityDebug.querySelector<HTMLElement>('.velocity-debug-fill');
    if (value) value.textContent = `${key.id}  ·  velocity ${velocity}`;
    if (source) source.textContent = `source: ${key.velocitySource ?? 'default'}`;
    if (raw) {
      const pressure = key.pressure == null ? '--' : key.pressure.toFixed(2);
      const motion = key.motionDelta == null ? '--' : key.motionDelta.toFixed(3);
      raw.textContent = `pressure ${pressure}  ·  motion Δ ${motion}`;
    }
    if (fill) fill.style.width = `${velocity / 127 * 100}%`;
  }

  _updateMotionPermissionDebug(state: MotionPermissionState): void {
    document.querySelectorAll<HTMLElement>('.motion-permission-status')
      .forEach(status => { status.textContent = `motion permission: ${state}`; });
    const button = this.settingsPanel?.querySelector<HTMLButtonElement>('.motion-permission-button');
    if (button) button.textContent = this.input?.motionEnabled ? 'Disable Velocity' : 'Enable Velocity';
  }

  reloadApp(): void {
    // The service worker serves the audio sprite from its cache, so this reload
    // refreshes app files without downloading the audio asset again.
    const url = new URL(window.location.href);
    url.searchParams.set('reload', String(Date.now()));
    window.location.replace(url.href);
  }

  _handleScroll(offset: number): void {
    if (!this.renderer) return;
    this.scrollContainer.scrollLeft = offset;
    this.renderer.updateMiniMap(offset);
  }

  _getMidiNote(keyId: string): number {
    const key = this.layout.keys.find(k => k.id === keyId);
    return key ? key.midiNote : 60;
  }
}

// Bootstrap
const app = new GoodianoApp();

// Bootstrap immediately so the shell and audio can be cached before the
// first interaction. A gesture is used only to resume the AudioContext.
const startApp = () => app.init().catch(error => console.error('Goodiano init failed', error));
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startApp, { once: true });
else startApp();

export { GoodianoApp };
