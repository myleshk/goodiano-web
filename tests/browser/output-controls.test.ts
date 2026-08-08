import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoodianoApp } from '../../js/app/app';
import { KEY_LABELS_STORAGE_KEY, VOLUME_STORAGE_KEY } from '../../js/app/preferences';

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
      <div class="volume-control">
        <label id="master-volume-label" for="master-volume">Volume</label>
        <input id="master-volume" class="master-volume" type="range" min="0" max="100" value="100">
        <output class="master-volume-output" for="master-volume">100</output>
      </div>
      <button class="settings-action key-labels-toggle" type="button" aria-pressed="true">Note Names</button>
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

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('volume control', () => {
  it('applies and persists a new level', async () => {
    const app = await setupApp();
    const slider = document.querySelector<HTMLInputElement>('.master-volume')!;

    slider.value = '40';
    slider.dispatchEvent(new Event('input', { bubbles: true }));

    expect(app.audio.volume).toBeCloseTo(0.4);
    expect(localStorage.getItem(VOLUME_STORAGE_KEY)).toBe('40');
    expect(document.querySelector('output')?.value).toBe('40');
  });

  it('restores a saved level on start, including silence', async () => {
    localStorage.setItem(VOLUME_STORAGE_KEY, '0');

    const app = await setupApp();

    expect(app.audio.volume).toBe(0);
    expect(document.querySelector<HTMLInputElement>('.master-volume')!.value).toBe('0');
  });

  it('scales under the fixed headroom so the limiter still protects', async () => {
    const app = await setupApp();
    await app.audio.init();

    app.audio.setVolume(1);
    const full = app.audio.masterGain!.gain.value;

    expect(full).toBeLessThan(1);
  });
});

describe('note label toggle', () => {
  it('hides and restores the labels, remembering the choice', async () => {
    await setupApp();
    const toggle = document.querySelector<HTMLButtonElement>('.key-labels-toggle')!;
    const content = document.querySelector<HTMLElement>('.keyboard-content')!;

    expect(content.classList.contains('hide-key-labels')).toBe(false);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');

    toggle.click();

    expect(content.classList.contains('hide-key-labels')).toBe(true);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(localStorage.getItem(KEY_LABELS_STORAGE_KEY)).toBe('0');

    toggle.click();
    expect(content.classList.contains('hide-key-labels')).toBe(false);
    expect(localStorage.getItem(KEY_LABELS_STORAGE_KEY)).toBe('1');
  });

  it('starts hidden when that was the saved choice', async () => {
    localStorage.setItem(KEY_LABELS_STORAGE_KEY, '0');

    await setupApp();

    expect(document.querySelector('.keyboard-content')!.classList.contains('hide-key-labels')).toBe(true);
    expect(document.querySelector('.key-labels-toggle')!.getAttribute('aria-pressed')).toBe('false');
  });
});
