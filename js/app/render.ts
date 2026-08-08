/**
 * Goodiano DOM Renderer
 * Builds the keyboard, mini-map, and manages visual state.
 * Port of WhiteKeyView.swift + BlackKeyView.swift + KeyboardView body
 */

import { getMiniMapViewport } from './keyboard';
import type { KeyboardLayout } from './keyboard';
import type { PianoKey } from './model';

const OCTAVE_COLORS = [
  '#1a3a5c', // dark blue
  '#5c1a1a', // dark red
  '#1a5c2a', // dark green
  '#5c4a1a', // gold/brown
  '#3a1a5c', // purple
];

class KeyboardRenderer {
  keyboardEl: HTMLElement;
  miniMapEl: HTMLElement;
  scrollContainer: HTMLElement;
  layout: KeyboardLayout | null = null;
  keyElements = new Map<string, HTMLElement>();
  whiteKeyWidth = 50;
  keyboardHeight = 300;
  viewportWidth = 0;
  private _miniMapIndicator: HTMLDivElement | null = null;

  /**
   * @param {HTMLElement} keyboardEl - container for the key elements
   * @param {HTMLElement} miniMapEl - container for the mini-map
   * @param {HTMLElement} scrollContainer - the scrollable wrapper
   */
  constructor(keyboardEl: HTMLElement, miniMapEl: HTMLElement, scrollContainer: HTMLElement) {
    this.keyboardEl = keyboardEl;
    this.miniMapEl = miniMapEl;
    this.scrollContainer = scrollContainer;
  }

  /**
   * Build the full keyboard from layout data
   */
  build(layout: KeyboardLayout): void {
    this.layout = layout;
    this.keyboardEl.innerHTML = '';
    this.keyElements.clear();

    // Background for keyboard area (static styles live in css/main.css)

    // White keys row
    const whiteRow = document.createElement('div');
    whiteRow.className = 'keyboard-white-row';

    for (const wk of layout.whiteKeys) {
      const el = this._createWhiteKey(wk);
      whiteRow.appendChild(el);
      this.keyElements.set(wk.id, el);
    }

    // Black keys overlay
    const blackLayer = document.createElement('div');
    blackLayer.className = 'keyboard-black-layer';

    for (const bk of layout.blackKeys) {
      const el = this._createBlackKey(bk, layout);
      blackLayer.appendChild(el);
      this.keyElements.set(bk.id, el);
    }

    this.keyboardEl.appendChild(whiteRow);
    this.keyboardEl.appendChild(blackLayer);

    this._updateSizes();
  }

  _createWhiteKey(key: PianoKey): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'key-white';
    el.dataset.key = key.id;
    el.dataset.midi = String(key.midiNote);

    const label = document.createElement('span');
    label.className = 'key-label';
    label.textContent = key.name;

    el.appendChild(label);
    return el;
  }

  _createBlackKey(key: PianoKey, layout: KeyboardLayout): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'key-black';
    el.dataset.key = key.id;
    el.dataset.midi = String(key.midiNote);

    // How many white keys precede this one never changes, so its horizontal
    // position can be expressed in CSS against the current key width.
    const whiteIndex = layout.blackKeyWhiteIndex[key.id];
    if (whiteIndex != null) el.style.setProperty('--white-index', String(whiteIndex));
    return el;
  }

  /**
   * Call after resize or orientation change. Every key derives its size and
   * position from this one custom property, so a resize is a single style
   * write rather than one per key.
   */
  _updateSizes(): void {
    if (!this.layout) return;
    this.keyboardEl.style.setProperty('--white-key-width', `${this.whiteKeyWidth}px`);
  }

  /**
   * Set pressed visual state on a key
   */
  setPressed(keyId: string, pressed: boolean): void {
    const el = this.keyElements.get(keyId);
    if (!el) return;
    el.classList.toggle('pressed', pressed);
  }

  /**
   * Build the mini-map with octave blocks
   */
  buildMiniMap(): void {
    if (!this.layout) return;
    this.miniMapEl.innerHTML = '';

    const map = document.createElement('div');
    map.className = 'minimap';

    const { octaveBlocks } = this.layout;

    const totalUnits = octaveBlocks.reduce((sum, block) => sum + (block.widthMultiplier || 1), 0);
    for (let i = 0; i < octaveBlocks.length; i++) {
      const block = octaveBlocks[i];
      const color = OCTAVE_COLORS[i % OCTAVE_COLORS.length];
      const widthPct = (((block.widthMultiplier || 1) / totalUnits) * 100).toFixed(4);

      const seg = document.createElement('div');
      seg.className = 'minimap-seg';
      seg.style.flex = `0 0 ${widthPct}%`;
      seg.style.backgroundColor = color;

      const label = document.createElement('span');
      label.className = 'minimap-seg-label';
      label.textContent = `C${block.octave}`;
      seg.appendChild(label);

      map.appendChild(seg);
    }

    // Viewport indicator overlay
    const indicator = document.createElement('div');
    indicator.className = 'minimap-indicator';
    map.appendChild(indicator);

    this.miniMapEl.appendChild(map);
    this._miniMapIndicator = indicator;
  }

  /**
   * Update mini-map viewport indicator position
   */
  updateMiniMap(scrollOffset: number): void {
    if (!this._miniMapIndicator || !this.layout) return;

    const { start, end } = getMiniMapViewport(
      this.layout,
      scrollOffset,
      this.whiteKeyWidth,
      this.viewportWidth,
    );

    this._miniMapIndicator.style.left = `${start * 100}%`;
    this._miniMapIndicator.style.width = `${(end - start) * 100}%`;
  }

  /**
   * Update sizes when viewport changes
   */
  updateViewport(viewportWidth: number, keyboardHeight: number, whiteKeyWidth: number): void {
    this.viewportWidth = viewportWidth;
    this.keyboardHeight = keyboardHeight;
    this.whiteKeyWidth = whiteKeyWidth;
    this._updateSizes();
  }

  /**
   * Set keyboard content width (for scroll calculation)
   */
  getContentWidth(): number {
    if (!this.layout) return 0;
    return this.layout.whiteKeys.length * this.whiteKeyWidth;
  }
}

export { KeyboardRenderer };
