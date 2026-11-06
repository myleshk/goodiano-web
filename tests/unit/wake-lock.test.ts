import { afterEach, describe, expect, it, vi } from 'vitest';
import { diagnostics } from '../../js/app/diagnostics';
import { ScreenWakeLock } from '../../js/app/wake-lock';

class FakeSentinel {
  released = false;
  listeners: Array<() => void> = [];
  release = vi.fn(async () => { this.released = true; });
  addEventListener = vi.fn((type: string, listener: () => void) => {
    if (type === 'release') this.listeners.push(listener);
  });

  /** The platform dropping the lock on its own, as it does when the page hides. */
  takeBack(): void {
    this.released = true;
    for (const listener of this.listeners) listener();
  }
}

function stubWakeLock() {
  const sentinels: FakeSentinel[] = [];
  const request = vi.fn(async (_type: 'screen') => {
    const sentinel = new FakeSentinel();
    sentinels.push(sentinel);
    return sentinel;
  });
  return { api: { request }, request, sentinels };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ScreenWakeLock', () => {
  it('keeps the screen awake while the page is visible', async () => {
    const { api, request } = stubWakeLock();
    const lock = new ScreenWakeLock({ wakeLock: api, visibility: () => 'visible' });

    await lock.hold('startup');

    expect(request).toHaveBeenCalledWith('screen');
    expect(lock.held).toBe(true);
  });

  it('asks once for a lock it already holds', async () => {
    const { api, request } = stubWakeLock();
    const lock = new ScreenWakeLock({ wakeLock: api, visibility: () => 'visible' });

    await lock.hold('startup');
    await lock.hold('visible');
    await lock.hold('pageshow');

    // Every return to the foreground calls hold(); a second request would be
    // a lock the page has to keep track of twice.
    expect(request).toHaveBeenCalledOnce();
  });

  it('takes the lock again after the platform takes it back', async () => {
    const { api, request, sentinels } = stubWakeLock();
    const lock = new ScreenWakeLock({ wakeLock: api, visibility: () => 'visible' });
    await lock.hold('startup');

    // iOS drops the lock when the page is hidden, without telling the page
    // first; the release event is the only notice.
    sentinels[0].takeBack();
    expect(lock.held).toBe(false);

    await lock.hold('visible');
    expect(request).toHaveBeenCalledTimes(2);
    expect(lock.held).toBe(true);
  });

  it('drops the lock when the page goes away and takes it again on the way back', async () => {
    const { api, request, sentinels } = stubWakeLock();
    const lock = new ScreenWakeLock({ wakeLock: api, visibility: () => 'visible' });
    await lock.hold('startup');

    lock.release('hidden');
    expect(sentinels[0].release).toHaveBeenCalledOnce();
    expect(lock.held).toBe(false);

    await lock.hold('visible');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('undoes a lock that arrives after the page went away', async () => {
    const pending = deferred<FakeSentinel>();
    const request = vi.fn(() => pending.promise);
    const lock = new ScreenWakeLock({ wakeLock: { request }, visibility: () => 'visible' });

    const holding = lock.hold('startup');
    // The page is hidden before the platform answers: the lock is no longer
    // wanted, and keeping it would leave the screen lit for nobody.
    lock.release('hidden');
    const sentinel = new FakeSentinel();
    pending.resolve(sentinel);
    await holding;

    expect(sentinel.release).toHaveBeenCalledOnce();
    expect(lock.held).toBe(false);
  });

  it('does not ask while the page is hidden', async () => {
    const { api, request } = stubWakeLock();
    const lock = new ScreenWakeLock({ wakeLock: api, visibility: () => 'hidden' });

    await lock.hold('hidden');

    expect(request).not.toHaveBeenCalled();
    expect(lock.held).toBe(false);
  });

  it('survives a refusal without throwing', async () => {
    const request = vi.fn(async () => {
      throw new DOMException('Low Power Mode', 'NotAllowedError');
    });
    const lock = new ScreenWakeLock({ wakeLock: { request }, visibility: () => 'visible' });

    // A refused lock is a dimmer screen, not a broken app.
    await expect(lock.hold('low power')).resolves.toBeUndefined();
    expect(lock.held).toBe(false);
  });

  it('says once that the browser has no wake lock at all', async () => {
    const record = vi.spyOn(diagnostics, 'record');
    const lock = new ScreenWakeLock({ wakeLock: null });

    await lock.hold('startup');
    await lock.hold('visible');

    expect(lock.held).toBe(false);
    expect(record).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith('page', 'screen wake lock unavailable');
  });
});
