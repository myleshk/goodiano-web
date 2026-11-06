/**
 * Screen wake lock.
 *
 * A piano is played with the screen on, and an iPhone that dims after thirty
 * seconds takes the keyboard away mid-piece. It is also the way into the one
 * failure this app cannot repair from inside the page: going away is what lets
 * iOS suspend the audio unit, and a silent return is what follows. Keeping the
 * screen lit while the app is in front of the player prevents the situation
 * rather than trying to recover from it.
 *
 * The platform drops the lock whenever the page stops being visible, so this
 * holds nothing across a background trip and asks again on the way back. It is
 * best effort throughout: Low Power Mode refuses the request outright, and a
 * refused lock is a dimmer screen, not a broken app.
 */

import { describeError, diagnostics } from './diagnostics';

export interface WakeLockSentinelLike {
  readonly released: boolean;
  release(): Promise<void>;
  addEventListener?(type: 'release', listener: () => void): void;
}

export interface WakeLockApiLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

export interface ScreenWakeLockOptions {
  /** Defaults to navigator.wakeLock, which is absent on every browser but Safari and Chromium. */
  wakeLock?: WakeLockApiLike | null;
  /** Defaults to document.visibilityState; a lock cannot be taken while hidden. */
  visibility?: () => DocumentVisibilityState;
}

function defaultWakeLock(): WakeLockApiLike | null {
  try {
    if (typeof navigator === 'undefined') return null;
    // Declared by the DOM types as always present; absent at runtime on every
    // browser that does not implement it, which is most of them.
    return (navigator as Navigator & { wakeLock?: WakeLockApiLike }).wakeLock ?? null;
  } catch (_) {
    // Reading the property throws in some restricted contexts.
    return null;
  }
}

function defaultVisibility(): DocumentVisibilityState {
  try {
    return typeof document === 'undefined' ? 'visible' : document.visibilityState;
  } catch (_) {
    return 'visible';
  }
}

export class ScreenWakeLock {
  private _sentinel: WakeLockSentinelLike | null = null;
  private _requesting = false;
  /** Bumped whenever the lock is dropped, so a request that lands late can be undone. */
  private _generation = 0;
  private _reportedUnavailable = false;
  private readonly _wakeLock: () => WakeLockApiLike | null;
  private readonly _visibility: () => DocumentVisibilityState;

  constructor(options: ScreenWakeLockOptions = {}) {
    this._wakeLock = options.wakeLock === undefined
      ? defaultWakeLock
      : () => options.wakeLock ?? null;
    this._visibility = options.visibility ?? defaultVisibility;
  }

  /** Whether this page is currently keeping the screen awake. */
  get held(): boolean {
    return this._sentinel !== null && !this._sentinel.released;
  }

  /**
   * Take the lock, or keep the one already held. Safe to call on every return
   * to the foreground and on every gesture-shaped wake-up.
   */
  async hold(reason: string): Promise<void> {
    if (this.held || this._requesting) return;
    const api = this._wakeLock();
    if (!api) {
      if (!this._reportedUnavailable) {
        this._reportedUnavailable = true;
        diagnostics.record('page', 'screen wake lock unavailable');
      }
      return;
    }
    if (this._visibility() !== 'visible') {
      diagnostics.record('page', 'screen wake lock skipped while hidden', { reason });
      return;
    }
    const generation = this._generation;
    this._requesting = true;
    try {
      const sentinel = await api.request('screen');
      if (generation !== this._generation) {
        // The page went away while the platform was deciding. The lock is no
        // longer wanted, and holding it here would leave the screen awake for
        // a page nobody is looking at.
        void Promise.resolve(sentinel.release()).catch(() => {});
        return;
      }
      this._sentinel = sentinel;
      sentinel.addEventListener?.('release', () => {
        if (this._sentinel !== sentinel) return;
        this._sentinel = null;
        diagnostics.record('page', 'screen wake lock taken back');
      });
      diagnostics.record('page', 'screen wake lock held', { reason });
    } catch (error) {
      // Low Power Mode is the usual reason, and it is the player's choice.
      diagnostics.record('page', 'screen wake lock refused', { reason, ...describeError(error) });
    } finally {
      this._requesting = false;
    }
  }

  /** Drop the lock. Called when the page goes away, where the platform would drop it anyway. */
  release(reason: string): void {
    this._generation += 1;
    const sentinel = this._sentinel;
    this._sentinel = null;
    if (!sentinel) return;
    diagnostics.record('page', 'screen wake lock released', { reason });
    try {
      void Promise.resolve(sentinel.release()).catch(() => {});
    } catch (_) {
      // Already released by the platform.
    }
  }
}
