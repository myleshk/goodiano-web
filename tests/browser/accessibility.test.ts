import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoodianoApp } from '../../js/app/app';

function mountShell(): void {
  document.body.innerHTML = `
    <main class="app">
      <div class="minimap-container" aria-hidden="true"></div>
      <div class="keyboard-area" role="group" aria-label="Piano keyboard">
        <div class="keyboard-scroll" tabindex="0" role="group" aria-label="Piano keyboard"
          aria-describedby="keyboard-bindings">
          <div class="keyboard-content" aria-hidden="true"></div>
        </div>
      </div>
      <p id="keyboard-bindings" class="visually-hidden">bindings</p>
      <p class="visually-hidden keyboard-announcer" role="status" aria-live="polite"></p>
    </main>
    <button class="settings-toggle" type="button" aria-expanded="false" aria-controls="settings-panel"></button>
    <section id="settings-panel" class="settings-panel" hidden aria-label="Settings">
      <button class="settings-action sustain-toggle" type="button" aria-pressed="false">Sustain</button>
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('keyboard accessibility', () => {
  it('exposes the scroll region as the focusable keyboard control', async () => {
    await setupApp();
    const region = document.querySelector<HTMLElement>('.keyboard-scroll')!;

    region.focus();

    expect(document.activeElement).toBe(region);
    // role="application" would have suppressed the screen reader's own
    // navigation over a subtree with nothing focusable inside it.
    expect(document.querySelector('[role="application"]')).toBeNull();
    expect(region.getAttribute('aria-describedby')).toBe('keyboard-bindings');
    expect(document.getElementById('keyboard-bindings')).not.toBeNull();
  });

  it('reports the settings panel expanded state on its toggle', async () => {
    await setupApp();
    const toggle = document.querySelector<HTMLButtonElement>('.settings-toggle')!;
    const panel = document.querySelector<HTMLElement>('.settings-panel')!;

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    toggle.click();
    expect(panel.hidden).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    toggle.click();
    expect(panel.hidden).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes the panel on Escape and returns focus to the toggle', async () => {
    await setupApp();
    const toggle = document.querySelector<HTMLButtonElement>('.settings-toggle')!;
    const panel = document.querySelector<HTMLElement>('.settings-panel')!;
    toggle.click();
    const sustain = panel.querySelector<HTMLButtonElement>('.sustain-toggle')!;
    sustain.focus();

    sustain.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(panel.hidden).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);
  });

  it('announces pedal and octave changes that have no visible text', async () => {
    const app = await setupApp();
    const announcer = document.querySelector<HTMLElement>('.keyboard-announcer')!;
    const sustain = document.querySelector<HTMLButtonElement>('.sustain-toggle')!;

    sustain.click();
    expect(sustain.getAttribute('aria-pressed')).toBe('true');
    expect(announcer.textContent).toBe('Sustain pedal down');

    sustain.click();
    expect(announcer.textContent).toBe('Sustain pedal up');

    app.computerKeyboard!.setOctave(5);
    expect(announcer.textContent).toBe('Octave 5');
  });
});
