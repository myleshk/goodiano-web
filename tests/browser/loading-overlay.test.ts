import { afterEach, describe, expect, it, vi } from 'vitest';
import { audioSpriteUrl } from 'virtual:goodiano-assets';
import { GoodianoApp } from '../../js/app/app';

interface ControlledApp {
  app: GoodianoApp;
  /** Resolve the pending audio load, as a real successful download would. */
  finishLoad: () => void;
  loadAudio: ReturnType<typeof vi.spyOn>;
}

function mountShell(): void {
  document.body.innerHTML = `
    <main class="app">
      <div class="loading-overlay">
        <div class="loading-progress"><span class="loading-progress-label">0%</span></div>
        <div class="loading-text">Loading Yamaha U1…</div>
        <button class="loading-retry" type="button">Retry</button>
      </div>
      <div class="minimap-container"></div>
      <div class="keyboard-area"><div class="keyboard-scroll"><div class="keyboard-content"></div></div></div>
    </main>
  `;
}

function overlay(): HTMLElement {
  return document.querySelector<HTMLElement>('.loading-overlay')!;
}

/** Dispatch a worker->page message the way an active service worker would. */
function postFromWorker(data: unknown): void {
  navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data }));
}

function stubController(): ReturnType<typeof vi.fn> {
  const postMessage = vi.fn();
  Object.defineProperty(navigator.serviceWorker, 'controller', {
    configurable: true,
    get: () => ({ postMessage }),
  });
  return postMessage;
}

async function setupApp(): Promise<ControlledApp> {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  mountShell();
  const app = new GoodianoApp();
  let finishLoad = (): void => {};
  const pending = new Promise<void>(resolve => {
    finishLoad = () => {
      app.audio.loaded = true;
      resolve();
    };
  });
  const loadAudio = vi.spyOn(app, '_loadAudio').mockReturnValue(pending);
  await app.init();
  return { app, finishLoad, loadAudio };
}

afterEach(() => {
  document.body.innerHTML = '';
  // Restores the prototype accessor that stubController shadowed.
  delete (navigator.serviceWorker as unknown as Record<string, unknown>).controller;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('loading overlay lifecycle', () => {
  it('keeps a storage warning on screen after the audio load succeeds', async () => {
    const { finishLoad } = await setupApp();

    // The worker reports the failed write before the page's fetch resolves,
    // which is the ordering that used to hide the warning immediately.
    postFromWorker({ type: 'CACHE_ERROR', asset: 'audio' });
    expect(overlay().classList.contains('recoverable-error')).toBe(true);

    finishLoad();

    await vi.waitFor(() => expect(overlay().classList.contains('as-toast')).toBe(true));
    // Give the dismissal timer more than its fade window to prove it never runs.
    await new Promise(resolve => setTimeout(resolve, 700));
    expect(overlay().classList.contains('recoverable-error')).toBe(true);
    expect(overlay().classList.contains('dismissed')).toBe(false);
    expect(overlay().classList.contains('hidden')).toBe(false);
    expect(document.querySelector('.loading-text')?.textContent).toContain('offline');
  });

  it('dismisses the overlay completely when nothing failed', async () => {
    const { finishLoad } = await setupApp();

    finishLoad();

    await vi.waitFor(() => expect(overlay().classList.contains('hidden')).toBe(true));
    await vi.waitFor(() => expect(overlay().classList.contains('dismissed')).toBe(true), { timeout: 2000 });
    expect(overlay().classList.contains('as-toast')).toBe(false);
  });

  it('restores a dismissed overlay as a toast when storage fails later', async () => {
    const { finishLoad } = await setupApp();
    finishLoad();
    await vi.waitFor(() => expect(overlay().classList.contains('dismissed')).toBe(true), { timeout: 2000 });

    postFromWorker({ type: 'CACHE_ERROR', asset: 'audio' });

    expect(overlay().classList.contains('dismissed')).toBe(false);
    expect(overlay().classList.contains('hidden')).toBe(false);
    expect(overlay().classList.contains('as-toast')).toBe(true);
    expect(overlay().classList.contains('recoverable-error')).toBe(true);
  });

  it('retries a failed write through the worker instead of re-decoding audio', async () => {
    const postMessage = stubController();
    const { finishLoad, loadAudio } = await setupApp();
    finishLoad();
    await vi.waitFor(() => expect(loadAudio).toHaveBeenCalledTimes(1));
    postFromWorker({ type: 'CACHE_ERROR', asset: 'audio' });

    document.querySelector<HTMLButtonElement>('.loading-retry')!.click();

    expect(postMessage).toHaveBeenCalledWith({
      type: 'RETRY_AUDIO_CACHE',
      url: new URL(audioSpriteUrl, document.baseURI).href,
    });
    // The decoded buffer is already in memory; retrying must not refetch it.
    expect(loadAudio).toHaveBeenCalledTimes(1);
    // The toast stays put while the retry is in flight, so it cannot block play.
    expect(overlay().classList.contains('as-toast')).toBe(true);

    postFromWorker({ type: 'CACHE_READY', asset: 'audio' });

    expect(overlay().classList.contains('recoverable-error')).toBe(false);
    expect(overlay().classList.contains('hidden')).toBe(true);
  });

  it('re-downloads the audio when the load itself failed', async () => {
    const { loadAudio } = await setupApp();
    loadAudio.mockRejectedValueOnce(new Error('network'));
    overlay().classList.add('recoverable-error');

    document.querySelector<HTMLButtonElement>('.loading-retry')!.click();

    expect(loadAudio).toHaveBeenCalledTimes(2);
    expect(overlay().classList.contains('recoverable-error')).toBe(false);
  });
});
