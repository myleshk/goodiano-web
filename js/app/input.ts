/**
 * Pointer input for the piano. Each pointer owns its current key; the
 * rendered/audio pressed set is derived from every active pointer.
 */
import type { PianoKey } from './model';

type VelocitySource = 'pressure' | 'motion' | 'default';
type VelocityInputMode = 'motion' | 'pressure';
type MotionPermissionState = 'disabled' | 'unknown' | 'requesting' | 'granted' | 'denied' | 'unavailable';
// Calibrate the accelerometer impulse to the observed motion-delta range.
const MOTION_FULL_SCALE = 1.4;
const MOTION_FULL_SCALE_AT_MAX_SENSITIVITY = 0.5;
interface InputKey extends Partial<PianoKey> {
  id: string;
  velocity?: number;
  velocitySource?: VelocitySource;
  pressure?: number;
  motionDelta?: number;
}
interface Point { x: number; y: number }
interface MotionSample { time: number; magnitude: number }
interface PointerState {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  startOffset: number;
  mode: 'note-or-scroll' | 'note' | 'scroll';
  key: PianoKey | null;
  keyId: string | null;
  motionStart: number;
  velocity?: number;
  velocitySource: VelocitySource;
  pressure?: number;
  motionDelta?: number;
}
interface InputCallbacks {
  onKeyPress?: (key: InputKey, pressed: boolean, velocity?: number) => void;
  onScroll?: (offset: number) => void;
  onMotionPermissionChange?: (state: MotionPermissionState) => void;
  onVelocityInputModeChange?: (mode: VelocityInputMode) => void;
  onVelocityEnabledChange?: (enabled: boolean) => void;
}
interface DeviceMotionEventConstructorWithPermission {
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

class InputController {
  container: HTMLElement;
  onKeyPress: NonNullable<InputCallbacks['onKeyPress']>;
  onScroll: NonNullable<InputCallbacks['onScroll']>;
  onMotionPermissionChange: NonNullable<InputCallbacks['onMotionPermissionChange']>;
  onVelocityInputModeChange: NonNullable<InputCallbacks['onVelocityInputModeChange']>;
  onVelocityEnabledChange: NonNullable<InputCallbacks['onVelocityEnabledChange']>;
  activePointers = new Map<number, PointerState>();
  pressedKeys = new Set<string>();
  scrollOffset = 0;
  maxScroll = 0;
  scrollThreshold = 8;
  primaryPointerId: number | null = null;
  scrollDisabled = false;
  screenToKeyboardCoord: ((clientX: number, clientY: number) => Point | null) | null = null;
  hitTestFn: ((x: number, y: number) => PianoKey | null) | null = null;
  motionSamples: MotionSample[] = [];
  motionEnabled = false;
  motionPermissionState: MotionPermissionState = 'unknown';
  velocityEnabled = false;
  pressureDetected = false;
  velocityInputMode: VelocityInputMode = 'motion';
  sensitivities: Record<VelocityInputMode, number> = { motion: 50, pressure: 50 };
  private _motionPermissionRequest: Promise<MotionPermissionState> | null = null;
  private _velocityExplicitlyDisabled = false;
  private _handlers!: {
    down: (e: PointerEvent) => void;
    move: (e: PointerEvent) => void;
    up: (e: PointerEvent) => void;
    wheel: (e: WheelEvent) => void;
    scroll: () => void;
  };
  private _onVisibilityChange!: () => void;

  constructor(container: HTMLElement, callbacks: InputCallbacks = {}) {
    this.container = container;
    this.onKeyPress = callbacks.onKeyPress || (() => {});
    this.onScroll = callbacks.onScroll || (() => {});
    this.onMotionPermissionChange = callbacks.onMotionPermissionChange || (() => {});
    this.onVelocityInputModeChange = callbacks.onVelocityInputModeChange || (() => {});
    this.onVelocityEnabledChange = callbacks.onVelocityEnabledChange || (() => {});
    this._bindEvents();
  }

  _bindEvents() {
    const el = this.container;
    this._handlers = {
      down: e => this._onPointerDown(e),
      move: e => this._onPointerMove(e),
      up: e => this._onPointerUp(e),
      wheel: e => this._onWheel(e),
      scroll: () => this._onNativeScroll(),
    };
    el.addEventListener('pointerdown', this._handlers.down, { passive: false });
    el.addEventListener('pointermove', this._handlers.move, { passive: false });
    el.addEventListener('pointerup', this._handlers.up);
    el.addEventListener('pointercancel', this._handlers.up);
    el.addEventListener('lostpointercapture', this._handlers.up);
    el.addEventListener('wheel', this._handlers.wheel, { passive: false });
    el.addEventListener('scroll', this._handlers.scroll, { passive: true });
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
      if (!this.motionEnabled) return;
      const a = e.accelerationIncludingGravity;
      if (!a) return;
      const magnitude = Math.hypot(a.x || 0, a.y || 0, a.z || 0);
      this.motionSamples.push({ time: performance.now(), magnitude });
      const cutoff = performance.now() - 1000;
      this.motionSamples = this.motionSamples.filter(sample => sample.time >= cutoff);
    }, { passive: true });
  }

  setConverters(screenToKeyboardCoord: (clientX: number, clientY: number) => Point | null, hitTestFn: (x: number, y: number) => PianoKey | null): void {
    this.screenToKeyboardCoord = screenToKeyboardCoord;
    this.hitTestFn = hitTestFn;
  }

  setMaxScroll(max: number): void {
    this.maxScroll = Math.max(0, max);
    this.setScrollOffset(this.scrollOffset);
  }

  setScrollOffset(offset: number): void {
    this.scrollOffset = Math.max(0, Math.min(this.maxScroll, offset));
    this.onScroll(this.scrollOffset);
  }

  _findKeyAtPoint(clientX: number, clientY: number): PianoKey | null {
    if (!this.screenToKeyboardCoord || !this.hitTestFn) return null;
    const point = this.screenToKeyboardCoord(clientX, clientY);
    return point ? this.hitTestFn(point.x, point.y) : null;
  }

  _onPointerDown(e: PointerEvent): void {
    e.preventDefault();
    try { this.container.setPointerCapture(e.pointerId); } catch (_) { /* Safari */ }
    // Deliberately no focus() here. Nothing needs the container focused —
    // computer-keyboard notes are captured on the window and the mini-map
    // handles its own keys — and focusing it from a tap paints a focus ring
    // across the whole keyboard. preventDefault above already stops the
    // browser's own focus-on-press, so a ring appears only for Tab.
    const key = this._findKeyAtPoint(e.clientX, e.clientY);
    const isFirst = this.activePointers.size === 0;
    if (isFirst) {
      this.primaryPointerId = e.pointerId;
      this.scrollDisabled = false;
    } else {
      // Chords always win over scrolling. Existing pointers remain tracked.
      this.scrollDisabled = true;
      const primary = this.primaryPointerId === null ? undefined : this.activePointers.get(this.primaryPointerId);
      if (primary) primary.mode = 'note';
    }
    const motionStart = performance.now();
    const pointer: PointerState = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      startOffset: this.scrollOffset,
      mode: isFirst && !this.scrollDisabled ? 'note-or-scroll' : 'note',
      key,
      keyId: key?.id || null,
      motionStart,
      velocitySource: 'default',
    };
    this._updatePointerVelocity(pointer, e);
    this.activePointers.set(e.pointerId, pointer);
    this._syncPressedKeys(); // first finger starts immediately
  }

  _onPointerMove(e: PointerEvent): void {
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
    this._updatePointerVelocity(pointer, e);
    this._syncPressedKeys();
  }

  _onPointerUp(e: PointerEvent): void {
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

  _onWheel(e: WheelEvent): void {
    e.preventDefault();
    this.setScrollOffset(this.scrollOffset + (e.deltaX || e.deltaY));
  }

  _onNativeScroll(): void {
    const offset = Math.max(0, Math.min(this.maxScroll, this.container.scrollLeft));
    if (offset === this.scrollOffset) return;
    this.scrollOffset = offset;
    this.onScroll(offset);
  }

  _syncPressedKeys(): void {
    const next = new Set<string>();
    const keyObjects = new Map<string, InputKey>();
    for (const pointer of this.activePointers.values()) {
      if (pointer.mode !== 'scroll' && pointer.keyId) {
        next.add(pointer.keyId);
        keyObjects.set(pointer.keyId, {
          ...(pointer.key || { id: pointer.keyId }),
          velocity: pointer.velocity,
          velocitySource: pointer.velocitySource,
          pressure: pointer.pressure,
          motionDelta: pointer.motionDelta,
        });
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

  async requestMotionPermission(): Promise<MotionPermissionState> {
    if (this.velocityInputMode === 'pressure') return 'unavailable';
    if (this.motionPermissionState === 'granted') return 'granted';
    if (this._motionPermissionRequest) return this._motionPermissionRequest;
    const request = this._requestMotionPermission();
    this._motionPermissionRequest = request;
    return request.finally(() => { this._motionPermissionRequest = null; });
  }

  private async _requestMotionPermission(): Promise<MotionPermissionState> {
    const constructor = window.DeviceMotionEvent as (typeof DeviceMotionEvent & DeviceMotionEventConstructorWithPermission) | undefined;
    if (!constructor) return this._setMotionPermissionState('unavailable');
    const permission = constructor.requestPermission;
    if (typeof permission !== 'function') return this._setMotionPermissionState('granted');
    this._setMotionPermissionState('requesting');
    try {
      const result = await permission.call(constructor);
      return this._setMotionPermissionState(result === 'granted' ? 'granted' : 'denied');
    } catch (_) {
      return this._setMotionPermissionState('denied');
    }
  }

  setMotionEnabled(enabled: boolean): void {
    this.motionEnabled = enabled && this.velocityEnabled && !this.pressureDetected;
    this.motionSamples = [];
  }

  setVelocityEnabled(enabled: boolean): void {
    this._velocityExplicitlyDisabled = !enabled;
    const canEnable = this.pressureDetected || this.motionPermissionState === 'granted';
    this.velocityEnabled = enabled && canEnable;
    this.setMotionEnabled(this.velocityEnabled && !this.pressureDetected && this.motionPermissionState === 'granted');
    this.onVelocityEnabledChange(this.velocityEnabled);
  }

  setSensitivity(mode: VelocityInputMode, value: number): void {
    if (!Number.isFinite(value)) return;
    this.sensitivities[mode] = Math.max(1, Math.min(100, Math.round(value)));
  }

  _setMotionPermissionState(state: MotionPermissionState): MotionPermissionState {
    this.motionPermissionState = state;
    this.onMotionPermissionChange(state);
    return state;
  }

  _estimateVelocity(startTime: number): { velocity: number; delta: number } | undefined {
    // A physical tap often reaches the accelerometer just before the browser
    // dispatches pointerdown. Include that leading window so the very first
    // note receives velocity instead of waiting for pointermove.
    const samples = this.motionSamples.filter(sample =>
      sample.time >= startTime - 100 && sample.time <= startTime + 100
    );
    if (!samples.length) return undefined;
    const baseline = this.motionSamples
      .filter(sample => sample.time < startTime - 100 && sample.time >= startTime - 250)
      .map(sample => sample.magnitude);
    const base = baseline.length ? baseline.reduce((a, b) => a + b, 0) / baseline.length : samples[0].magnitude;
    const delta = Math.max(0, ...samples.map(sample => sample.magnitude - base));
    const adjustedDelta = delta * this._sensitivityGain('motion');
    return {
      velocity: Math.round(35 + Math.min(adjustedDelta / MOTION_FULL_SCALE, 1) * 92),
      delta,
    };
  }

  _velocityFromPressure(e: PointerEvent): number | undefined {
    const pressure = e.pressure;
    if (!Number.isFinite(pressure) || pressure <= 0) return undefined;
    // Browsers report 0.5 as the generic active-touch value when the hardware
    // has no pressure sensor. Treat it as unavailable for fingers, while still
    // accepting real Apple Pencil pressure and non-default touch values.
    if (pressure === 0.5) return undefined;
    this._detectPressureInput();
    if (!this.velocityEnabled) return undefined;
    const adjustedPressure = pressure * this._sensitivityGain('pressure');
    return Math.round(35 + Math.max(0, Math.min(1, adjustedPressure)) * 92);
  }

  private _sensitivityGain(mode: VelocityInputMode): number {
    const position = (this.sensitivities[mode] - 50) / 50;
    const maxGain = mode === 'motion'
      ? MOTION_FULL_SCALE / MOTION_FULL_SCALE_AT_MAX_SENSITIVITY
      : 2;
    return (position >= 0 ? maxGain : 2) ** position;
  }

  private _detectPressureInput(): void {
    if (this.pressureDetected) return;
    this.pressureDetected = true;
    this.velocityInputMode = 'pressure';
    this.motionEnabled = false;
    this.motionSamples = [];
    if (!this._velocityExplicitlyDisabled) {
      this.velocityEnabled = true;
      this.onVelocityEnabledChange(true);
    }
    this.onVelocityInputModeChange('pressure');
  }

  _updatePointerVelocity(pointer: PointerState, event: PointerEvent): void {
    pointer.pressure = Number.isFinite(event.pressure) ? event.pressure : undefined;
    const pressureVelocity = this._velocityFromPressure(event);
    const motion = this.velocityEnabled && this.motionEnabled
      ? this._estimateVelocity(pointer.motionStart)
      : undefined;
    pointer.motionDelta = motion?.delta;
    if (pressureVelocity !== undefined) {
      pointer.velocity = pressureVelocity;
      pointer.velocitySource = 'pressure';
    } else if (motion) {
      pointer.velocity = motion.velocity;
      pointer.velocitySource = 'motion';
    } else {
      pointer.velocity = undefined;
      pointer.velocitySource = 'default';
    }
  }

  releaseAll(): void {
    this.activePointers.clear();
    for (const id of this.pressedKeys) this.onKeyPress({ id }, false);
    this.pressedKeys.clear();
    this.primaryPointerId = null;
    this.scrollDisabled = false;
  }

  destroy(): void {
    this.releaseAll();
    this.container.removeEventListener('scroll', this._handlers.scroll);
    document.removeEventListener('visibilitychange', this._onVisibilityChange);
    window.removeEventListener('pagehide', this._onVisibilityChange);
  }
}

export { InputController };
export type { InputCallbacks, InputKey, MotionPermissionState, VelocityInputMode, VelocitySource };
