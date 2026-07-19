/**
 * Goodiano PWA — App Orchestrator
 * Wires model → input → keyboard layout → render → audio.
 * Port of ContentView.swift + KeyboardView.swift body logic.
 */

import { generateFullPianoKeys } from './model.js';
import { PianoAudioEngine } from './audio.js';
import { computeLayout, hitTest, findMiddleCIndex, scrollToKey } from './keyboard.js';
import { InputController } from './input.js';
import { KeyboardRenderer } from './render.js';

class GoodianoApp {
  constructor() {
    this.keys = generateFullPianoKeys();
    this.layout = computeLayout(this.keys);
    this.audio = new PianoAudioEngine();
    this.renderer = null;
    this.input = null;

    // Viewport state
    this.viewportWidth = 0;
    this.keyboardHeight = 0;
    this.whiteKeyWidth = 50;
    this.maxScroll = 0;
  }

  async init() {
    // Cache DOM elements
    this.keyboardArea = document.querySelector('.keyboard-area');
    this.scrollContainer = document.querySelector('.keyboard-scroll');
    this.keyboardContent = document.querySelector('.keyboard-content');
    this.miniMapEl = document.querySelector('.minimap-container');
    this.loadingOverlay = document.querySelector('.loading-overlay');
    this.loadingOverlay?.querySelector('.loading-retry')?.addEventListener('click', () => {
      this.loadingOverlay.classList.remove('recoverable-error');
      const text = this.loadingOverlay.querySelector('.loading-text');
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
      onKeyPress: (key, pressed, velocity) => this._handleKeyPress(key, pressed, velocity),
      onScroll: (offset) => this._handleScroll(offset),
    });

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

  async _loadAudio() {
    try {
      await this.audio.loadSoundFont('assets/yahama_U1.sf2');
    } catch (err) {
      console.error('Failed to load SoundFont:', err);
      // Show error state
      if (this.loadingOverlay) {
        const text = this.loadingOverlay.querySelector('.loading-text');
        if (text) text.textContent = 'Audio failed to load. Tap to retry.';
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

  _scrollToC4() {
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

    // Calculate white key width based on orientation
    // Landscape (wider than tall): fixed 50px per key
    // Portrait: fit at least 10 white keys
    const minVisibleKeys = 10;
    const portraitWidth = this.viewportWidth / minVisibleKeys;
    const landscapeWidth = 50;

    if (this.viewportWidth > this.keyboardHeight * 1.2) {
      this.whiteKeyWidth = landscapeWidth;
    } else {
      this.whiteKeyWidth = Math.min(portraitWidth, 50);
    }

    // Update max scroll
    const contentWidth = this.renderer.getContentWidth();
    this.maxScroll = Math.max(0, contentWidth - this.viewportWidth);

    // Update renderer
    this.renderer.updateViewport(this.viewportWidth, this.keyboardHeight, this.whiteKeyWidth);

    // Update input
    if (this.input) {
      this.input.setMaxScroll(this.maxScroll);
    }

    // Update mini-map
    this.renderer.updateMiniMap(this.input ? this.input.scrollOffset : 0);

    // Ensure scroll container content width
    if (this.keyboardContent) {
      this.keyboardContent.style.width = contentWidth + 'px';
    }
  }

  _screenToKeyboard(clientX, clientY) {
    if (!this.keyboardContent) return null;
    const contentRect = this.keyboardContent.getBoundingClientRect();
    return {
      x: clientX - contentRect.left,
      y: clientY - contentRect.top,
    };
  }

  _handleKeyPress(key, pressed, velocity) {
    if (pressed) {
      this.audio.ensureRunning().catch(() => {});
      this.audio.noteOn(key.id, this._getMidiNote(key.id), velocity);
    } else {
      this.audio.noteOff(key.id);
    }
    this.renderer.setPressed(key.id, pressed);
  }

  _handleScroll(offset) {
    this.scrollContainer.scrollLeft = offset;
    this.renderer.updateMiniMap(offset);
  }

  _getMidiNote(keyId) {
    const key = this.layout.keys.find(k => k.id === keyId);
    return key ? key.midiNote : 60;
  }
}

// Bootstrap
const app = new GoodianoApp();

// Bootstrap immediately so the shell and SoundFont can be cached before the
// first interaction. A gesture is used only to resume the AudioContext.
const startApp = () => app.init().catch(error => console.error('Goodiano init failed', error));
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startApp, { once: true });
else startApp();

export { GoodianoApp };
