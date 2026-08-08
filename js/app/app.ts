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
import type { InputKey, MotionPermissionState, VelocityInputMode } from './input';
import { loadSensitivity, saveSensitivity } from './velocity-settings';
import { KeyboardRenderer } from './render';
import type { KeyboardLayout } from './keyboard';
import type { PianoKey } from './model';
import { audioSpriteUrl, version } from 'virtual:goodiano-assets';
import { registerServiceWorker, RELOAD_MARKER } from './service-worker';
import { InstallPromotionController } from './install-promotion';
import { ComputerKeyboardController } from './computer-keyboard';
import {
  getLocale,
  initializeLocalization,
  setLocalePreference,
  subscribeLocaleChange,
  t,
  translateDocument,
} from './i18n';
import type { SupportedLocale, TranslationKey } from './i18n';

/** Must outlast the overlay's opacity transition in css/main.css. */
const LOADING_FADE_MS = 500;

/** What is holding a key down. A note ends when the last of them releases. */
type PressSource = 'pointer' | 'keyboard';

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
  private _loadingMessage: TranslationKey = 'loading.initial';
  private _lastVelocityDebug: { key: InputKey; velocity: number } | null = null;
  private _resizeObserver: ResizeObserver | null = null;
  private readonly _pressSources = new Map<string, Set<PressSource>>();
  private readonly installPromotion: InstallPromotionController;
  computerKeyboard: ComputerKeyboardController | null = null;
  private _sustainLatched = false;

  constructor(installPromotion: InstallPromotionController = new InstallPromotionController()) {
    this.installPromotion = installPromotion;
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
    // Render the version from the single source of truth (package.json).
    const versionEl = document.querySelector<HTMLElement>('.app-version');
    if (versionEl) versionEl.textContent = `Goodiano · v${version}`;
    this._setupLocaleControl();
    this._setupSettingsPanel();
    const loadingOverlay = this.loadingOverlay;
    loadingOverlay?.querySelector('.loading-retry')?.addEventListener('click', () => this._retry());
    navigator.serviceWorker?.addEventListener('message', event => {
      const type = event.data?.type;
      if (type === 'CACHE_ERROR') this._showStorageWarning();
      else if (type === 'CACHE_READY') this._dismissLoading();
      else if (type === 'GOODIANO_DEV_SW_CLEANUP') this.reloadOnce();
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
      onVelocityInputModeChange: mode => this._updateVelocityInputMode(mode),
      onVelocityEnabledChange: () => this._updateVelocityControl(),
    });
    this.input.setSensitivity('motion', loadSensitivity('motion'));
    this.input.setSensitivity('pressure', loadSensitivity('pressure'));
    this._setupSensitivityControl();
    this._updateMotionPermissionDebug(this.input.motionPermissionState);
    this.settingsPanel?.querySelector<HTMLButtonElement>('.velocity-debug-toggle')
      ?.addEventListener('click', event => {
        const button = event.currentTarget as HTMLButtonElement;
        if (!this.velocityDebug) return;
        const visible = this.velocityDebug.hidden;
        this.velocityDebug.hidden = !visible;
        document.querySelectorAll<HTMLElement>('.motion-permission-status')
          .forEach(status => { status.hidden = !visible || this.input?.velocityInputMode === 'pressure'; });
        button.textContent = t(visible ? 'debug.hide' : 'debug.show');
      });
    this.settingsPanel?.querySelector<HTMLButtonElement>('.app-reload-button')
      ?.addEventListener('click', () => this.reloadApp());

    this.computerKeyboard = new ComputerKeyboardController({
      onNoteOn: (midiNote, velocity) => this._handleMidiPress(midiNote, true, velocity),
      onNoteOff: midiNote => this._handleMidiPress(midiNote, false),
      onOctaveChange: octave => {
        this._scrollToOctave(octave);
        this._announce(t('keyboard.octave', { octave }));
      },
      // Space is momentary, so it overrides the latched button while held and
      // hands control back on release.
      onSustainChange: held => this._setSustain(held || this._sustainLatched),
    });
    this.computerKeyboard.attach();
    this._setupSustainControl();

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
    // Resume the AudioContext on every real gesture (pointer + touch/mouse
    // fallback for older iOS). Persistent so background-return taps also work.
    // Cheap early-return inside ensureRunning when already running.
    const resumeOnGesture = () => { this.audio.ensureRunning(); };
    for (const eventName of ['pointerdown', 'touchstart', 'mousedown']) {
      document.addEventListener(eventName, resumeOnGesture, { capture: true, passive: true });
    }
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this._releaseAllNotes();
      // On show: do not call resume() here — visibilitychange is not a user
      // gesture on iOS, so it would be ignored. The gesture listener above
      // resumes on the next tap.
    });
    window.addEventListener('pagehide', () => this._releaseAllNotes());
  }

  private _requiredElement(selector: string): HTMLElement {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) throw new Error(`Missing required element: ${selector}`);
    return element;
  }

  async _loadAudio() {
    try {
      await this.audio.loadSampleLibrary(
        audioSpriteUrl,
        YAMAHA_U1_ZONES,
        progress => this._updateLoadingProgress(progress),
      );
    } catch (err) {
      console.error('Failed to load audio:', err);
      // Show error state
      if (this.loadingOverlay) {
        this._setLoadingMessage(err instanceof DOMException && err.name === 'AbortError'
          ? 'loading.timeout'
          : 'loading.failed');
        this.loadingOverlay.classList.add('recoverable-error');
      }
      throw err;
    }
  }

  _hideLoading() {
    const overlay = this.loadingOverlay;
    if (!overlay) {
      this.installPromotion.markAppReady();
      return;
    }
    // Reaching here means the audio loaded, so a pending error can only be the
    // non-blocking storage warning. Keep its retry affordance instead of
    // dismissing it, collapsed so it never covers the keyboard.
    if (overlay.classList.contains('recoverable-error')) {
      overlay.classList.add('as-toast');
      this.installPromotion.markAppReady();
      return;
    }
    this._dismissLoading();
  }

  /** Fade the overlay out and take it out of the layout once faded. */
  private _dismissLoading(): void {
    const overlay = this.loadingOverlay;
    if (!overlay) return;
    overlay.classList.remove('recoverable-error', 'as-toast');
    overlay.classList.add('hidden');
    setTimeout(() => {
      overlay.classList.add('dismissed');
      this.installPromotion.markAppReady();
    }, LOADING_FADE_MS);
  }

  /**
   * Surface a failed offline write. Playback is unaffected, so once the sprite
   * has loaded this is shown as a toast rather than a blocking overlay — and it
   * can reappear after the overlay was already dismissed.
   */
  private _showStorageWarning(): void {
    const overlay = this.loadingOverlay;
    if (!overlay) return;
    this._setLoadingMessage('loading.cacheFailed');
    overlay.classList.remove('hidden', 'dismissed');
    overlay.classList.add('recoverable-error');
    overlay.classList.toggle('as-toast', this.audio.loaded);
  }

  private _retry(): void {
    const overlay = this.loadingOverlay;
    if (!overlay) return;
    // A loaded sprite means only the offline copy failed: ask the worker to
    // store it again rather than re-downloading and re-decoding the audio.
    const storageOnly = this.audio.loaded;
    overlay.classList.remove('recoverable-error');
    if (!storageOnly) overlay.classList.remove('as-toast');
    this._setLoadingMessage('loading.retrying');
    if (storageOnly) {
      this._retryAudioStorage();
      return;
    }
    this._loadAudio().then(() => {
      this._hideLoading();
      this._scrollToC4();
    }).catch(() => {});
  }

  private _retryAudioStorage(): void {
    const controller = navigator.serviceWorker?.controller;
    if (!controller) {
      this._showStorageWarning();
      return;
    }
    controller.postMessage({
      type: 'RETRY_AUDIO_CACHE',
      url: new URL(audioSpriteUrl, document.baseURI).href,
    });
  }

  _updateLoadingProgress(progress: number): void {
    const value = Math.round(Math.max(0, Math.min(1, progress)) * 100);
    const indicator = this.loadingOverlay?.querySelector<HTMLElement>('.loading-progress');
    const label = this.loadingOverlay?.querySelector<HTMLElement>('.loading-progress-label');
    indicator?.style.setProperty('--progress', `${value}%`);
    indicator?.setAttribute('aria-valuenow', String(value));
    if (label) label.textContent = `${value}%`;
    const text = this.loadingOverlay?.querySelector<HTMLElement>('.loading-text');
    if (text && value >= 100) this._setLoadingMessage('loading.preparing');
  }

  _scrollToC4() {
    this._scrollToWhiteKeyIndex(findMiddleCIndex(this.layout));
  }

  /**
   * Follow an octave shift with the view. The computer keyboard spans two
   * octaves upward from its base, so centring the upper C keeps both rows on
   * screen rather than pushing the higher row off the right edge.
   */
  private _scrollToOctave(octave: number): void {
    const index = ['C' + (octave + 1), 'C' + octave]
      .map(id => this.layout.whiteKeys.findIndex(key => key.id === id))
      .find(found => found >= 0);
    this._scrollToWhiteKeyIndex(index ?? findMiddleCIndex(this.layout));
  }

  private _scrollToWhiteKeyIndex(whiteKeyIndex: number): void {
    if (!this.input || !this.renderer) return;
    const target = scrollToKey(whiteKeyIndex, this.whiteKeyWidth, this.viewportWidth, this.maxScroll);
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

  /**
   * Start or stop a note. Pointers and the computer keyboard can hold the same
   * key at once, so a note only stops once every source has let go of it.
   */
  _handleKeyPress(key: InputKey, pressed: boolean, velocity?: number, source: PressSource = 'pointer'): void {
    if (!this.renderer) return;
    const sources = this._pressSources.get(key.id) ?? new Set<PressSource>();
    if (pressed) {
      const alreadySounding = sources.size > 0;
      sources.add(source);
      this._pressSources.set(key.id, sources);
      this.audio.ensureRunning();
      this._updateVelocityDebug(key, velocity ?? DEFAULT_VELOCITY);
      // A key that is already down cannot be struck again.
      if (alreadySounding) return;
      this.audio.noteOn(key.id, this._getMidiNote(key.id), velocity);
      this.renderer.setPressed(key.id, true);
      return;
    }
    sources.delete(source);
    if (sources.size > 0) return;
    this._pressSources.delete(key.id);
    this.audio.noteOff(key.id);
    this.renderer.setPressed(key.id, false);
  }

  /**
   * Keep the toggle's expanded state truthful, and let Escape close the panel
   * from anywhere inside it, returning focus to the control that opened it.
   */
  private _setupSettingsPanel(): void {
    const toggle = document.querySelector<HTMLButtonElement>('.settings-toggle');
    const panel = this.settingsPanel;
    if (!toggle || !panel) return;
    const setOpen = (open: boolean): void => {
      panel.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
    };
    // hidden is boolean | "until-found" in the DOM types, so coerce before
    // using it as the "currently closed, so open it" signal.
    toggle.addEventListener('click', () => setOpen(Boolean(panel.hidden)));
    panel.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      toggle.focus();
    });
  }

  /** Announce a state change that has no visible text of its own. */
  private _announce(message: string): void {
    const announcer = document.querySelector<HTMLElement>('.keyboard-announcer');
    if (announcer) announcer.textContent = message;
  }

  /**
   * The pedal is reachable two ways: a latching button that suits touch, and
   * the space bar held down, which is closer to how a pedal really behaves.
   */
  private _setupSustainControl(): void {
    const toggle = this.settingsPanel?.querySelector<HTMLButtonElement>('.sustain-toggle');
    toggle?.addEventListener('click', () => {
      this._sustainLatched = !this._sustainLatched;
      this._setSustain(this._sustainLatched);
    });
  }

  private _setSustain(enabled: boolean): void {
    if (enabled === this.audio.sustainEnabled) return;
    this.audio.setSustain(enabled);
    this.settingsPanel?.querySelector<HTMLButtonElement>('.sustain-toggle')
      ?.setAttribute('aria-pressed', String(enabled));
    this._announce(t(enabled ? 'sustain.on' : 'sustain.off'));
  }

  /** Drop every sounding note and the bookkeeping that tracks who held it. */
  private _releaseAllNotes(): void {
    this.input?.releaseAll();
    this.computerKeyboard?.releaseAll();
    this._pressSources.clear();
    this._sustainLatched = false;
    this._setSustain(false);
    this.audio.allNotesOff();
  }

  /** Play a note addressed by pitch, as the computer keyboard does. */
  private _handleMidiPress(midiNote: number, pressed: boolean, velocity?: number): void {
    const key = this.layout.keys.find(candidate => candidate.midiNote === midiNote);
    if (!key) return;
    this._handleKeyPress(key, pressed, velocity, 'keyboard');
  }

  _updateVelocityDebug(key: InputKey, velocity: number): void {
    if (!this.velocityDebug) return;
    this._lastVelocityDebug = { key, velocity };
    const value = this.velocityDebug.querySelector<HTMLElement>('.velocity-debug-value');
    const source = this.velocityDebug.querySelector<HTMLElement>('.velocity-debug-source');
    const raw = this.velocityDebug.querySelector<HTMLElement>('.velocity-debug-raw');
    const fill = this.velocityDebug.querySelector<HTMLElement>('.velocity-debug-fill');
    if (value) value.textContent = t('debug.velocity', { note: key.id, velocity });
    const sourceName = key.velocitySource ?? 'default';
    if (source) source.textContent = t('debug.source', { source: t(`debug.source.${sourceName}`) });
    if (raw) {
      const pressure = key.pressure == null ? '--' : key.pressure.toFixed(2);
      const motion = key.motionDelta == null ? '--' : key.motionDelta.toFixed(3);
      raw.textContent = t('debug.raw', { pressure, motion });
    }
    if (fill) fill.style.width = `${velocity / 127 * 100}%`;
  }

  _updateMotionPermissionDebug(state: MotionPermissionState): void {
    const stateKeys: Record<MotionPermissionState, TranslationKey> = {
      disabled: 'permission.state.disabled',
      unknown: 'permission.state.unknown',
      requesting: 'permission.state.requesting',
      granted: 'permission.state.granted',
      denied: 'permission.state.denied',
      unavailable: 'permission.state.unavailable',
    };
    document.querySelectorAll<HTMLElement>('.motion-permission-status')
      .forEach(status => { status.textContent = t('permission.status', { state: t(stateKeys[state]) }); });
    const feedback = this.settingsPanel?.querySelector<HTMLElement>('.motion-permission-feedback');
    if (!feedback || this.input?.velocityInputMode === 'pressure') return;
    const messages: Partial<Record<MotionPermissionState, TranslationKey>> = {
      requesting: 'permission.requesting',
      denied: 'permission.denied',
      unavailable: 'permission.unavailable',
    };
    feedback.textContent = messages[state] ? t(messages[state]) : '';
    feedback.hidden = !messages[state];
  }

  private _setupSensitivityControl(): void {
    const slider = this.settingsPanel?.querySelector<HTMLInputElement>('.velocity-sensitivity');
    const toggle = this.settingsPanel?.querySelector<HTMLButtonElement>('.velocity-toggle');
    if (!slider || !toggle || !this.input) return;
    toggle.addEventListener('click', () => { void this._toggleVelocity(); });
    slider.addEventListener('input', () => {
      const mode = this.input?.velocityInputMode ?? 'motion';
      const value = saveSensitivity(mode, Number(slider.value));
      this.input?.setSensitivity(mode, value);
      const output = this.settingsPanel?.querySelector<HTMLOutputElement>('.velocity-sensitivity-output');
      if (output) output.value = String(value);
    });
    this._updateVelocityInputMode('motion');
  }

  private async _toggleVelocity(): Promise<void> {
    const input = this.input;
    if (!input) return;
    if (input.velocityEnabled) {
      input.setVelocityEnabled(false);
      return;
    }
    if (input.pressureDetected || input.motionPermissionState === 'granted') {
      input.setVelocityEnabled(true);
      return;
    }
    const state = await input.requestMotionPermission();
    if (state === 'granted' && !input.pressureDetected) input.setVelocityEnabled(true);
    this._updateVelocityControl();
  }

  _updateVelocityInputMode(mode: VelocityInputMode): void {
    const slider = this.settingsPanel?.querySelector<HTMLInputElement>('.velocity-sensitivity');
    const label = this.settingsPanel?.querySelector<HTMLLabelElement>('#velocity-sensitivity-label');
    const output = this.settingsPanel?.querySelector<HTMLOutputElement>('.velocity-sensitivity-output');
    const description = this.settingsPanel?.querySelector<HTMLElement>('#velocity-sensitivity-description');
    const pressureMode = mode === 'pressure';
    const value = this.input?.sensitivities[mode] ?? loadSensitivity(mode);
    if (slider) {
      slider.value = String(value);
      slider.setAttribute('aria-describedby', pressureMode
        ? 'velocity-sensitivity-description'
        : 'velocity-sensitivity-description motion-permission-feedback');
    }
    if (label) label.textContent = t(pressureMode ? 'velocity.pressureSensitivity' : 'velocity.motionSensitivity');
    if (output) output.value = String(value);
    if (description) description.textContent = t(pressureMode
      ? 'velocity.pressureDescription'
      : 'velocity.motionDescription');
    this.settingsPanel?.querySelectorAll<HTMLElement>('.motion-permission-guidance, .motion-permission-feedback, .motion-permission-status')
      .forEach(element => { element.hidden = pressureMode || element.classList.contains('motion-permission-status'); });
    this._updateVelocityControl();
  }

  private _updateVelocityControl(): void {
    const input = this.input;
    if (!input) return;
    const enabled = input.velocityEnabled;
    const pressureMode = input.pressureDetected;
    const toggle = this.settingsPanel?.querySelector<HTMLButtonElement>('.velocity-toggle');
    const sensitivity = this.settingsPanel?.querySelector<HTMLElement>('.sensitivity-control');
    const guidance = this.settingsPanel?.querySelector<HTMLElement>('.motion-permission-guidance');
    const feedback = this.settingsPanel?.querySelector<HTMLElement>('.motion-permission-feedback');
    if (toggle) {
      toggle.textContent = t(enabled ? 'velocity.disable' : 'velocity.enable');
      toggle.setAttribute('aria-pressed', String(enabled));
    }
    if (sensitivity) sensitivity.hidden = !enabled;
    if (guidance) guidance.hidden = pressureMode || enabled;
    if (feedback && pressureMode) feedback.hidden = true;
  }

  reloadApp(): void {
    // The service worker serves the audio sprite from its cache, so this reload
    // refreshes app files without downloading the audio asset again.
    const url = new URL(window.location.href);
    url.searchParams.set('reload', String(Date.now()));
    window.location.replace(url.href);
  }

  /** Reload at most once per session to avoid cleanup-driven reload loops. */
  reloadOnce(): void {
    try {
      if (sessionStorage.getItem(RELOAD_MARKER) === '1') return;
      sessionStorage.setItem(RELOAD_MARKER, '1');
    } catch (_) { /* Best effort. */ }
    window.location.reload();
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

  private _setLoadingMessage(key: TranslationKey): void {
    this._loadingMessage = key;
    const text = this.loadingOverlay?.querySelector<HTMLElement>('.loading-text');
    if (text) text.textContent = t(key);
  }

  private _setupLocaleControl(): void {
    this.settingsPanel?.querySelectorAll<HTMLButtonElement>('.locale-control [data-locale]')
      .forEach(button => {
        button.addEventListener('click', () => {
          setLocalePreference(button.dataset.locale as SupportedLocale);
          // An automatic locale can be persisted without changing the effective locale.
          this._renderLocalizedState();
        });
      });
    subscribeLocaleChange(() => this._renderLocalizedState());
    this._renderLocalizedState();
  }

  private _renderLocalizedState(): void {
    translateDocument();
    const activeLocale = getLocale();
    this.settingsPanel?.querySelectorAll<HTMLButtonElement>('.locale-control [data-locale]')
      .forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.locale === activeLocale));
      });
    this._setLoadingMessage(this._loadingMessage);
    if (this.input) {
      this._updateVelocityInputMode(this.input.velocityInputMode);
      this._updateMotionPermissionDebug(this.input.motionPermissionState);
    }
    const debugButton = this.settingsPanel?.querySelector<HTMLButtonElement>('.velocity-debug-toggle');
    if (debugButton) debugButton.textContent = t(this.velocityDebug?.hidden === false ? 'debug.hide' : 'debug.show');
    if (this._lastVelocityDebug) {
      this._updateVelocityDebug(this._lastVelocityDebug.key, this._lastVelocityDebug.velocity);
    } else {
      const source = this.velocityDebug?.querySelector<HTMLElement>('.velocity-debug-source');
      const raw = this.velocityDebug?.querySelector<HTMLElement>('.velocity-debug-raw');
      if (source) source.textContent = t('debug.source', { source: '--' });
      if (raw) raw.textContent = t('debug.raw', { pressure: '--', motion: '--' });
    }
  }
}

// Bootstrap
initializeLocalization();
translateDocument();
registerServiceWorker();
const installPromotion = new InstallPromotionController();
installPromotion.init();
const app = new GoodianoApp(installPromotion);

// Bootstrap immediately so the shell and audio can be cached before the
// first interaction. A gesture is used only to resume the AudioContext.
const startApp = () => app.init().catch(error => console.error('Goodiano init failed', error));
if (document.querySelector('.app')) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startApp, { once: true });
  else startApp();
}

export { GoodianoApp };
