import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoodianoApp } from '../../js/app/app';
import { DIAGNOSTICS_STORAGE_KEY } from '../../js/app/diagnostics';

function mountShell(): void {
  document.body.innerHTML = `
    <main class="app">
      <div class="minimap-container"></div>
      <div class="keyboard-area"><div class="keyboard-scroll" tabindex="0">
        <div class="keyboard-content"></div>
      </div></div>
      <p class="visually-hidden keyboard-announcer" role="status"></p>
    </main>
    <button class="settings-toggle" type="button" aria-expanded="false"></button>
    <section class="settings-panel" hidden aria-label="Settings">
      <button class="settings-action log-export-button" type="button">Download Log</button>
      <p class="settings-help log-export-status" role="status" hidden></p>
    </section>
  `;
}

async function setupApp(): Promise<GoodianoApp> {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  mountShell();
  const app = new GoodianoApp();
  vi.spyOn(app, '_loadAudio').mockResolvedValue(undefined);
  await app.init();
  return app;
}

/** Capture the file the page hands over, whichever route it takes. */
function captureExport() {
  const blobs: Blob[] = [];
  const downloads: string[] = [];
  vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
    blobs.push(blob as Blob);
    return 'blob:goodiano-test';
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push(this.download);
  });
  return { blobs, downloads, click };
}

function stubShare(share: () => Promise<void>): ReturnType<typeof vi.fn> {
  const shareMock = vi.fn(share);
  Object.defineProperty(navigator, 'share', { value: shareMock, configurable: true, writable: true });
  Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true, writable: true });
  return shareMock;
}

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.removeItem(DIAGNOSTICS_STORAGE_KEY);
  Reflect.deleteProperty(navigator, 'share');
  Reflect.deleteProperty(navigator, 'canShare');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('diagnostics export', () => {
  it('downloads a report naming the build, the engine, and what happened', async () => {
    const { blobs, downloads, click } = captureExport();
    await setupApp();

    document.querySelector<HTMLButtonElement>('.log-export-button')!.click();
    await vi.waitFor(() => expect(click).toHaveBeenCalled());

    expect(downloads[0]).toMatch(/^goodiano-log-\d{8}-\d{6}\.txt$/);
    const report = await blobs[0].text();
    expect(report).toContain('Goodiano diagnostics log');
    expect(report).toContain('State at export');
    expect(report).toMatch(/engineState\s+\w/);
    expect(report).toContain('app starting');
    expect(report).toContain('log export requested');
  });

  it('tells the player where the log went', async () => {
    captureExport();
    await setupApp();
    const status = document.querySelector<HTMLElement>('.log-export-status')!;

    document.querySelector<HTMLButtonElement>('.log-export-button')!.click();
    await vi.waitFor(() => expect(status.hidden).toBe(false));

    expect(status.textContent).toBe('Log saved to your files.');
  });

  it('offers the file to the share sheet where one exists', async () => {
    const { click } = captureExport();
    const share = stubShare(() => Promise.resolve());
    const app = await setupApp();
    const status = document.querySelector<HTMLElement>('.log-export-status')!;

    await app._exportDiagnostics();

    const shared = share.mock.calls[0][0] as ShareData;
    expect(shared.files?.[0]?.name).toMatch(/^goodiano-log-/);
    expect(status.textContent).toBe('Log shared.');
    // A share sheet that took the file must not also start a download.
    expect(click).not.toHaveBeenCalled();
  });

  it('says nothing when the share sheet is dismissed', async () => {
    const { click } = captureExport();
    const share = stubShare(() => Promise.reject(new DOMException('cancelled', 'AbortError')));
    const app = await setupApp();
    const status = document.querySelector<HTMLElement>('.log-export-status')!;

    await app._exportDiagnostics();

    expect(share).toHaveBeenCalled();
    expect(status.hidden).toBe(true);
    expect(click).not.toHaveBeenCalled();
  });

  it('falls back to a download when sharing fails for any other reason', async () => {
    const { click, downloads } = captureExport();
    const share = stubShare(() => Promise.reject(new Error('no target app')));
    const app = await setupApp();

    await app._exportDiagnostics();

    expect(click).toHaveBeenCalled();
    expect(share).toHaveBeenCalled();
    expect(downloads[0]).toMatch(/^goodiano-log-/);
  });
});

describe('lifecycle recording', () => {
  it('keeps the page events that explain a silent return from the background', async () => {
    const { blobs, click } = captureExport();
    await setupApp();

    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    document.querySelector<HTMLButtonElement>('.log-export-button')!.click();
    await vi.waitFor(() => expect(click).toHaveBeenCalled());

    const report = await blobs[0].text();
    expect(report).toContain('network offline');
    expect(report).toContain('network online');
    expect(report).toContain('pageshow  {"persisted":true');
  });
});
