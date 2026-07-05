/**
 * Goodiano DOM Renderer
 * Builds the keyboard, mini-map, and manages visual state.
 * Port of WhiteKeyView.swift + BlackKeyView.swift + KeyboardView body
 */

const OCTAVE_COLORS = [
  '#1a3a5c', // dark blue
  '#5c1a1a', // dark red
  '#1a5c2a', // dark green
  '#5c4a1a', // gold/brown
  '#3a1a5c', // purple
];

class KeyboardRenderer {
  /**
   * @param {HTMLElement} keyboardEl - container for the key elements
   * @param {HTMLElement} miniMapEl - container for the mini-map
   * @param {HTMLElement} scrollContainer - the scrollable wrapper
   */
  constructor(keyboardEl, miniMapEl, scrollContainer) {
    this.keyboardEl = keyboardEl;
    this.miniMapEl = miniMapEl;
    this.scrollContainer = scrollContainer;
    this.layout = null;
    this.keyElements = new Map(); // keyId -> HTMLElement
    this.whiteKeyWidth = 50;
    this.keyboardHeight = 300;
    this.viewportWidth = 0;
  }

  /**
   * Build the full keyboard from layout data
   */
  build(layout) {
    this.layout = layout;
    this.keyboardEl.innerHTML = '';
    this.keyElements.clear();

    // Background for keyboard area
    this.keyboardEl.style.position = 'relative';
    this.keyboardEl.style.backgroundColor = '#111';
    this.keyboardEl.style.height = '100%';
    this.keyboardEl.style.width = '100%';

    // White keys row
    const whiteRow = document.createElement('div');
    whiteRow.className = 'keyboard-white-row';
    whiteRow.style.display = 'flex';
    whiteRow.style.height = '100%';
    whiteRow.style.position = 'relative';

    for (const wk of layout.whiteKeys) {
      const el = this._createWhiteKey(wk);
      whiteRow.appendChild(el);
      this.keyElements.set(wk.id, el);
    }

    // Black keys overlay
    const blackLayer = document.createElement('div');
    blackLayer.className = 'keyboard-black-layer';
    blackLayer.style.position = 'absolute';
    blackLayer.style.top = '0';
    blackLayer.style.left = '0';
    blackLayer.style.width = '100%';
    blackLayer.style.height = '60%';
    blackLayer.style.pointerEvents = 'none';

    for (const bk of layout.blackKeys) {
      const el = this._createBlackKey(bk, layout);
      blackLayer.appendChild(el);
      this.keyElements.set(bk.id, el);
    }

    this.keyboardEl.appendChild(whiteRow);
    this.keyboardEl.appendChild(blackLayer);

    this._updateSizes();
  }

  _createWhiteKey(key) {
    const el = document.createElement('div');
    el.className = 'key-white';
    el.dataset.key = key.id;
    el.dataset.midi = key.midiNote;
    el.style.flex = '1 0 auto';
    el.style.position = 'relative';
    el.style.cursor = 'pointer';
    el.style.borderRadius = '0 0 6px 6px';
    el.style.backgroundColor = '#fff';
    el.style.border = '1px solid rgba(128,128,128,0.25)';
    el.style.borderTop = 'none';
    el.style.display = 'flex';
    el.style.alignItems = 'flex-end';
    el.style.justifyContent = 'center';
    el.style.paddingBottom = '4%';
    el.style.userSelect = 'none';
    el.style.webkitUserSelect = 'none';
    el.style.transition = 'transform 0.12s cubic-bezier(0.25, 0.1, 0.25, 1), background-color 0.08s ease';

    const label = document.createElement('span');
    label.className = 'key-label';
    label.textContent = key.name;
    label.style.fontSize = '10px';
    label.style.color = 'rgba(128,128,128,0.5)';
    label.style.fontFamily = 'system-ui, -apple-system, sans-serif';
    label.style.pointerEvents = 'none';

    el.appendChild(label);
    return el;
  }

  _createBlackKey(key, layout) {
    const el = document.createElement('div');
    el.className = 'key-black';
    el.dataset.key = key.id;
    el.dataset.midi = key.midiNote;
    el.style.position = 'absolute';
    el.style.backgroundColor = '#000';
    el.style.borderRadius = '0 0 6px 6px';
    el.style.cursor = 'pointer';
    el.style.userSelect = 'none';
    el.style.webkitUserSelect = 'none';
    el.style.zIndex = '2';
    el.style.pointerEvents = 'auto';
    el.style.transition = 'transform 0.12s cubic-bezier(0.25, 0.1, 0.25, 1), background-color 0.08s ease';

    // Position will be set in _updateSizes
    return el;
  }

  /**
   * Call after resize, orientation change, or scroll
   */
  _updateSizes() {
    if (!this.layout) return;

    const ww = this.whiteKeyWidth;
    const kh = this.keyboardHeight;
    const bw = ww * 0.65;
    const bh = kh * 0.6;

    // Size white keys
    for (const wk of this.layout.whiteKeys) {
      const el = this.keyElements.get(wk.id);
      if (el) {
        el.style.width = ww + 'px';
        el.style.height = kh + 'px';
      }
    }

    // Position and size black keys
    for (const bk of this.layout.blackKeys) {
      const el = this.keyElements.get(bk.id);
      if (!el) continue;
      const wPos = this.layout.blackKeyWhiteIndex[bk.id];
      if (wPos == null) continue;
      const left = wPos * ww - bw / 2;
      el.style.left = left + 'px';
      el.style.width = bw + 'px';
      el.style.height = bh + 'px';
    }
  }

  /**
   * Set pressed visual state on a key
   */
  setPressed(keyId, pressed) {
    const el = this.keyElements.get(keyId);
    if (!el) return;

    if (pressed) {
      if (el.classList.contains('key-white')) {
        el.style.backgroundColor = '#f0f0f0';
        el.style.transform = 'scaleY(0.98)';
      } else {
        el.style.backgroundColor = '#262626';
        el.style.transform = 'scaleY(0.97)';
      }
    } else {
      if (el.classList.contains('key-white')) {
        el.style.backgroundColor = '#fff';
        el.style.transform = 'scaleY(1)';
      } else {
        el.style.backgroundColor = '#000';
        el.style.transform = 'scaleY(1)';
      }
    }
  }

  /**
   * Build the mini-map with octave blocks
   */
  buildMiniMap() {
    if (!this.layout) return;
    this.miniMapEl.innerHTML = '';

    const map = document.createElement('div');
    map.className = 'minimap';
    map.style.display = 'flex';
    map.style.height = '48px';
    map.style.width = '100%';
    map.style.position = 'relative';
    map.style.backgroundColor = '#1a1a1a';
    map.style.borderRadius = '0';
    map.style.overflow = 'hidden';

    const { octaveBlocks, whiteKeyCount, whiteKeys } = this.layout;

    for (let i = 0; i < octaveBlocks.length; i++) {
      const block = octaveBlocks[i];
      const color = OCTAVE_COLORS[i % OCTAVE_COLORS.length];
      const widthPct = ((block.count / whiteKeyCount) * 100).toFixed(2);

      const seg = document.createElement('div');
      seg.style.flex = `0 0 ${widthPct}%`;
      seg.style.backgroundColor = color;
      seg.style.display = 'flex';
      seg.style.alignItems = 'center';
      seg.style.justifyContent = 'center';
      seg.style.position = 'relative';

      const label = document.createElement('span');
      label.textContent = `C${block.octave}`;
      label.style.color = '#fff';
      label.style.fontSize = '10px';
      label.style.fontWeight = '600';
      label.style.fontFamily = 'system-ui, -apple-system, sans-serif';
      seg.appendChild(label);

      map.appendChild(seg);
    }

    // Viewport indicator overlay
    const indicator = document.createElement('div');
    indicator.className = 'minimap-indicator';
    indicator.style.position = 'absolute';
    indicator.style.top = '0';
    indicator.style.height = '100%';
    indicator.style.border = '2px solid rgba(255,255,255,0.8)';
    indicator.style.borderRadius = '3px';
    indicator.style.pointerEvents = 'none';
    indicator.style.boxSizing = 'border-box';
    indicator.style.backgroundColor = 'rgba(255,255,255,0.05)';
    map.appendChild(indicator);

    this.miniMapEl.appendChild(map);
    this._miniMapIndicator = indicator;
  }

  /**
   * Update mini-map viewport indicator position
   */
  updateMiniMap(scrollOffset) {
    if (!this._miniMapIndicator || !this.layout) return;

    const totalWidth = this.layout.whiteKeys.length * this.whiteKeyWidth;
    if (totalWidth <= 0) return;

    const startPct = (scrollOffset / totalWidth) * 100;
    const viewPct = (this.viewportWidth / totalWidth) * 100;

    this._miniMapIndicator.style.left = startPct + '%';
    this._miniMapIndicator.style.width = Math.min(viewPct, 100 - startPct) + '%';
  }

  /**
   * Update sizes when viewport changes
   */
  updateViewport(viewportWidth, keyboardHeight, whiteKeyWidth) {
    this.viewportWidth = viewportWidth;
    this.keyboardHeight = keyboardHeight;
    this.whiteKeyWidth = whiteKeyWidth;
    this._updateSizes();
  }

  /**
   * Set keyboard content width (for scroll calculation)
   */
  getContentWidth() {
    if (!this.layout) return 0;
    return this.layout.whiteKeys.length * this.whiteKeyWidth;
  }
}

export { KeyboardRenderer };
