/**
 * Goodiano Input Controller
 * Unified pointer/touch handling + horizontal scroll via single-finger drag.
 * Replaces the UIKit PianoScrollView bridge from the iOS app.
 */

class InputController {
  /**
   * @param {HTMLElement} container - the keyboard container element
   * @param {object} callbacks
   * @param {function} callbacks.onKeyPress - (key, pressed: boolean) => void
   * @param {function} callbacks.onScroll - (offset: number) => void
   */
  constructor(container, callbacks) {
    this.container = container;
    this.onKeyPress = callbacks.onKeyPress || (() => {});
    this.onScroll = callbacks.onScroll || (() => {});

    // Active touch/pointer state
    this.activePointers = new Map(); // pointerId -> { keyId, clientX, clientY }
    this.pressedKeys = new Set();    // currently pressed key IDs

    // Scroll state
    this.scrollOffset = 0;
    this.maxScroll = 0;
    this.isScrolling = false;
    this.scrollStartX = 0;
    this.scrollStartOffset = 0;
    this.scrollPointerId = null;
    this.hasMovedFromStart = false;
    this.keyAtStart = null; // key hit when pointer went down

    // Config
    this.scrollThreshold = 8; // px to distinguish scroll from tap

    // Conversion functions (set by render module)
    this.screenToKeyboardCoord = null;
    this.hitTestFn = null;

    this._bindEvents();
  }

  _bindEvents() {
    const el = this.container;

    el.addEventListener('pointerdown', this._onPointerDown.bind(this), { passive: false });
    el.addEventListener('pointermove', this._onPointerMove.bind(this), { passive: false });
    el.addEventListener('pointerup', this._onPointerUp.bind(this));
    el.addEventListener('pointercancel', this._onPointerUp.bind(this));
    el.addEventListener('pointerleave', this._onPointerLeave.bind(this));
    el.addEventListener('lostpointercapture', this._onPointerUp.bind(this));

    // Prevent default browser gestures on the keyboard area
    el.addEventListener('touchstart', e => {
      if (e.target.closest('[data-key]')) {
        e.preventDefault();
      }
    }, { passive: false });

    el.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
    el.addEventListener('gesturestart', e => e.preventDefault());
    el.addEventListener('gesturechange', e => e.preventDefault());
    el.addEventListener('gestureend', e => e.preventDefault());

    // Mouse wheel for desktop scrolling
    el.addEventListener('wheel', this._onWheel.bind(this), { passive: false });
  }

  /**
   * Set coordinate converter and hit test function
   */
  setConverters(screenToKeyboardCoord, hitTestFn) {
    this.screenToKeyboardCoord = screenToKeyboardCoord;
    this.hitTestFn = hitTestFn;
  }

  /**
   * Update max scroll range (called when layout changes)
   */
  setMaxScroll(max) {
    this.maxScroll = Math.max(0, max);
    this.scrollOffset = Math.min(this.scrollOffset, this.maxScroll);
  }

  /**
   * Programmatically set scroll offset
   */
  setScrollOffset(offset) {
    this.scrollOffset = Math.max(0, Math.min(this.maxScroll, offset));
    this.onScroll(this.scrollOffset);
  }

  _findKeyAtPoint(clientX, clientY) {
    if (!this.screenToKeyboardCoord || !this.hitTestFn) return null;
    const kb = this.screenToKeyboardCoord(clientX, clientY);
    if (!kb) return null;
    return this.hitTestFn(kb.x, kb.y);
  }

  _onPointerDown(e) {
    const el = this.container;
    el.setPointerCapture(e.pointerId);
    el.focus();

    const key = this._findKeyAtPoint(e.clientX, e.clientY);
    this.keyAtStart = key;

    // Single-finger: could be scroll or note
    if (this.activePointers.size === 0) {
      this.scrollPointerId = e.pointerId;
      this.scrollStartX = e.clientX;
      this.scrollStartOffset = this.scrollOffset;
      this.hasMovedFromStart = false;
      this.isScrolling = false;
    }

    // Multiple pointers: cancel scroll, treat as notes
    if (this.activePointers.size >= 1) {
      this.isScrolling = true;
    }

    this.activePointers.set(e.pointerId, {
      clientX: e.clientX,
      clientY: e.clientY,
      keyId: key ? key.id : null,
    });

    // Immediately fire note if we have a key and aren't potentially scrolling
    if (key && this.activePointers.size > 1) {
      this._pressKey(key);
    }
  }

  _onPointerMove(e) {
    const ptr = this.activePointers.get(e.pointerId);
    if (!ptr) return;

    ptr.clientX = e.clientX;
    ptr.clientY = e.clientY;

    const key = this._findKeyAtPoint(e.clientX, e.clientY);
    ptr.keyId = key ? key.id : null;

    // Handle scroll for primary pointer
    if (e.pointerId === this.scrollPointerId && !this.isScrolling) {
      const dx = e.clientX - this.scrollStartX;

      if (!this.hasMovedFromStart && Math.abs(dx) > this.scrollThreshold) {
        this.isScrolling = true;
        // Release the start key if we started scrolling from a key
        if (this.keyAtStart && this.pressedKeys.has(this.keyAtStart.id)) {
          this._releaseKey(this.keyAtStart);
        }
      }

      if (this.isScrolling) {
        let newOffset = this.scrollStartOffset - dx;
        newOffset = Math.max(0, Math.min(this.maxScroll, newOffset));
        this.scrollOffset = newOffset;
        this.onScroll(newOffset);
        return;
      }
    }

    // Not scrolling: track key state
    if (!this.isScrolling || this.activePointers.size > 1) {
      this._syncPressedKeys();
    }
  }

  _onPointerUp(e) {
    this.container.releasePointerCapture(e.pointerId);
    const ptr = this.activePointers.get(e.pointerId);
    this.activePointers.delete(e.pointerId);

    if (e.pointerId === this.scrollPointerId) {
      // If we never scrolled, treat as tap
      if (!this.isScrolling && this.pressedKeys.size === 0 && ptr?.keyId && this.keyAtStart) {
        this._pressKey(this.keyAtStart);
        this._releaseKey(this.keyAtStart);
      }
      this.scrollPointerId = null;
      this.isScrolling = false;
    }

    // Release any keys held by this pointer
    if (ptr?.keyId && this.pressedKeys.has(ptr.keyId)) {
      const keyObj = this.keyAtStart; // approximate
      this._releaseKey(keyObj || { id: ptr.keyId });
    }

    this._syncPressedKeys();
  }

  _onPointerLeave(e) {
    // Similar to pointer up
    const ptr = this.activePointers.get(e.pointerId);
    if (ptr?.keyId && this.pressedKeys.has(ptr.keyId)) {
      const keyObj = this.keyAtStart;
      this._releaseKey(keyObj || { id: ptr.keyId });
    }
    this.activePointers.delete(e.pointerId);
    if (e.pointerId === this.scrollPointerId) {
      this.scrollPointerId = null;
      this.isScrolling = false;
    }
    this._syncPressedKeys();
  }

  _onWheel(e) {
    e.preventDefault();
    let newOffset = this.scrollOffset + e.deltaX + e.deltaY;
    newOffset = Math.max(0, Math.min(this.maxScroll, newOffset));
    this.scrollOffset = newOffset;
    this.onScroll(newOffset);
  }

  /**
   * Compare current active pointers against pressedKeys set,
   * fire onKeyPress for presses and releases.
   * Port of KeyboardView.swift syncPressedKeys()
   */
  _syncPressedKeys() {
    const currentKeyIds = new Set();
    for (const ptr of this.activePointers.values()) {
      if (ptr.keyId) currentKeyIds.add(ptr.keyId);
    }

    // Find new presses
    for (const kid of currentKeyIds) {
      if (!this.pressedKeys.has(kid)) {
        this.pressedKeys.add(kid);
        this.onKeyPress({ id: kid }, true);
      }
    }

    // Find releases
    for (const kid of this.pressedKeys) {
      if (!currentKeyIds.has(kid)) {
        this.pressedKeys.delete(kid);
        this.onKeyPress({ id: kid }, false);
      }
    }
  }

  _pressKey(key) {
    if (this.pressedKeys.has(key.id)) return;
    this.pressedKeys.add(key.id);
    this.onKeyPress(key, true);
  }

  _releaseKey(key) {
    if (!this.pressedKeys.has(key.id)) return;
    this.pressedKeys.delete(key.id);
    this.onKeyPress(key, false);
  }

  /**
   * Cleanup
   */
  destroy() {
    // Pointer events are bound to container; garbage collection handles cleanup
    this.activePointers.clear();
    this.pressedKeys.clear();
  }
}

export { InputController };
