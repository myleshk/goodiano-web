/**
 * Pointer input for the piano. Each pointer owns its current key; the
 * rendered/audio pressed set is derived from every active pointer.
 */
class InputController {
  constructor(container, callbacks = {}) {
    this.container = container;
    this.onKeyPress = callbacks.onKeyPress || (() => {});
    this.onScroll = callbacks.onScroll || (() => {});
    this.activePointers = new Map();
    this.pressedKeys = new Set();
    this.scrollOffset = 0;
    this.maxScroll = 0;
    this.scrollThreshold = 8;
    this.primaryPointerId = null;
    this.scrollDisabled = false;
    this.screenToKeyboardCoord = null;
    this.hitTestFn = null;
    this.motionSamples = [];
    this.motionPermissionRequested = false;
    this._bindEvents();
  }

  _bindEvents() {
    const el = this.container;
    this._handlers = {
      down: e => this._onPointerDown(e),
      move: e => this._onPointerMove(e),
      up: e => this._onPointerUp(e),
      wheel: e => this._onWheel(e),
    };
    el.addEventListener('pointerdown', this._handlers.down, { passive: false });
    el.addEventListener('pointermove', this._handlers.move, { passive: false });
    el.addEventListener('pointerup', this._handlers.up);
    el.addEventListener('pointercancel', this._handlers.up);
    el.addEventListener('lostpointercapture', this._handlers.up);
    el.addEventListener('wheel', this._handlers.wheel, { passive: false });
    el.addEventListener('gesturestart', e => e.preventDefault());
    el.addEventListener('gesturechange', e => e.preventDefault());
    el.addEventListener('gestureend', e => e.preventDefault());
    this._onVisibilityChange = () => {
      if (document.hidden) this.releaseAll();
    };
    document.addEventListener('visibilitychange', this._onVisibilityChange);
    window.addEventListener('pagehide', this._onVisibilityChange);
    window.addEventListener('orientationchange', () => this.releaseAll());
    window.addEventListener('devicemotion', e => {
      const a = e.accelerationIncludingGravity;
      if (!a) return;
      const magnitude = Math.hypot(a.x || 0, a.y || 0, a.z || 0);
      this.motionSamples.push({ time: performance.now(), magnitude });
      const cutoff = performance.now() - 1000;
      this.motionSamples = this.motionSamples.filter(sample => sample.time >= cutoff);
    }, { passive: true });
  }

  setConverters(screenToKeyboardCoord, hitTestFn) {
    this.screenToKeyboardCoord = screenToKeyboardCoord;
    this.hitTestFn = hitTestFn;
  }

  setMaxScroll(max) {
    this.maxScroll = Math.max(0, max);
    this.setScrollOffset(this.scrollOffset);
  }

  setScrollOffset(offset) {
    this.scrollOffset = Math.max(0, Math.min(this.maxScroll, offset));
    this.onScroll(this.scrollOffset);
  }

  _findKeyAtPoint(clientX, clientY) {
    if (!this.screenToKeyboardCoord || !this.hitTestFn) return null;
    const point = this.screenToKeyboardCoord(clientX, clientY);
    return point ? this.hitTestFn(point.x, point.y) : null;
  }

  _onPointerDown(e) {
    e.preventDefault();
    try { this.container.setPointerCapture(e.pointerId); } catch (_) { /* Safari */ }
    this.container.focus();
    this._requestMotionPermission();
    const key = this._findKeyAtPoint(e.clientX, e.clientY);
    const isFirst = this.activePointers.size === 0;
    if (isFirst) {
      this.primaryPointerId = e.pointerId;
      this.scrollDisabled = false;
    } else {
      // Chords always win over scrolling. Existing pointers remain tracked.
      this.scrollDisabled = true;
      const primary = this.activePointers.get(this.primaryPointerId);
      if (primary) primary.mode = 'note';
    }
    const pointer = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      startOffset: this.scrollOffset,
      mode: isFirst && !this.scrollDisabled ? 'note-or-scroll' : 'note',
      key,
      keyId: key?.id || null,
      motionStart: performance.now(),
    };
    this.activePointers.set(e.pointerId, pointer);
    this._syncPressedKeys(); // first finger starts immediately
  }

  _onPointerMove(e) {
    const pointer = this.activePointers.get(e.pointerId);
    if (!pointer) return;
    e.preventDefault();
    pointer.lastX = e.clientX;
    pointer.lastY = e.clientY;
    const dx = e.clientX - pointer.startX;
    const dy = e.clientY - pointer.startY;

    if (pointer.mode === 'note-or-scroll' && !this.scrollDisabled &&
        Math.abs(dx) > this.scrollThreshold && Math.abs(dx) >= Math.abs(dy)) {
      pointer.mode = 'scroll';
      pointer.key = null;
      pointer.keyId = null;
      this._syncPressedKeys();
    }
    if (pointer.mode === 'scroll') {
      this.setScrollOffset(pointer.startOffset - dx);
      return;
    }
    const key = this._findKeyAtPoint(e.clientX, e.clientY);
    pointer.key = key;
    pointer.keyId = key?.id || null;
    pointer.velocity = this._estimateVelocity(pointer.motionStart);
    this._syncPressedKeys();
  }

  _onPointerUp(e) {
    const pointer = this.activePointers.get(e.pointerId);
    if (!pointer) return;
    try { this.container.releasePointerCapture(e.pointerId); } catch (_) { /* Safari */ }
    this.activePointers.delete(e.pointerId);
    this._syncPressedKeys();
    if (this.activePointers.size === 0) {
      this.primaryPointerId = null;
      this.scrollDisabled = false;
    }
  }

  _onWheel(e) {
    e.preventDefault();
    this.setScrollOffset(this.scrollOffset + (e.deltaX || e.deltaY));
  }

  _syncPressedKeys() {
    const next = new Set();
    const keyObjects = new Map();
    for (const pointer of this.activePointers.values()) {
      if (pointer.mode !== 'scroll' && pointer.keyId) {
        next.add(pointer.keyId);
        keyObjects.set(pointer.keyId, { ...(pointer.key || { id: pointer.keyId }), velocity: pointer.velocity });
      }
    }
    for (const id of next) {
      if (!this.pressedKeys.has(id)) {
        const key = keyObjects.get(id) || { id };
        this.onKeyPress(key, true, key.velocity);
      }
    }
    for (const id of this.pressedKeys) {
      if (!next.has(id)) this.onKeyPress({ id }, false);
    }
    this.pressedKeys = next;
  }

  _requestMotionPermission() {
    if (this.motionPermissionRequested) return;
    this.motionPermissionRequested = true;
    const permission = window.DeviceMotionEvent?.requestPermission;
    if (typeof permission === 'function') permission.call(window.DeviceMotionEvent).catch(() => {});
  }

  _estimateVelocity(startTime) {
    const samples = this.motionSamples.filter(sample => sample.time >= startTime);
    if (!samples.length) return undefined;
    const baseline = this.motionSamples
      .filter(sample => sample.time < startTime && sample.time >= startTime - 100)
      .map(sample => sample.magnitude);
    const base = baseline.length ? baseline.reduce((a, b) => a + b, 0) / baseline.length : samples[0].magnitude;
    const delta = Math.max(0, ...samples.map(sample => sample.magnitude - base));
    return Math.round(35 + Math.min(delta / 4.5, 1) * 92);
  }

  releaseAll() {
    this.activePointers.clear();
    for (const id of this.pressedKeys) this.onKeyPress({ id }, false);
    this.pressedKeys.clear();
    this.primaryPointerId = null;
    this.scrollDisabled = false;
  }

  destroy() {
    this.releaseAll();
    document.removeEventListener('visibilitychange', this._onVisibilityChange);
    window.removeEventListener('pagehide', this._onVisibilityChange);
  }
}

export { InputController };
