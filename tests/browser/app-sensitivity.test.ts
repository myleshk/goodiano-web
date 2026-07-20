import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoodianoApp } from '../../js/app/app';
import { VELOCITY_SENSITIVITY_STORAGE_KEYS } from '../../js/app/velocity-settings';

function mountAppShell(): void {
  document.body.innerHTML = `
    <main class="app">
      <div class="minimap-container"></div>
      <div class="keyboard-area"><div class="keyboard-scroll" tabindex="0"><div class="keyboard-content"></div></div></div>
    </main>
    <button class="settings-toggle" type="button"></button>
    <section class="settings-panel" aria-label="Settings">
      <button class="velocity-toggle" type="button" aria-pressed="false">Enable Velocity</button>
      <div class="sensitivity-control" hidden>
        <label id="velocity-sensitivity-label" for="velocity-sensitivity">Motion Sensitivity</label>
        <input id="velocity-sensitivity" class="velocity-sensitivity" type="range" min="1" max="100" value="50"
          aria-describedby="velocity-sensitivity-description motion-permission-feedback">
        <output class="velocity-sensitivity-output" for="velocity-sensitivity">50</output>
        <p id="velocity-sensitivity-description"></p>
      </div>
      <p class="motion-permission-guidance">Motion permission is needed for touch velocity.</p>
      <p id="motion-permission-feedback" class="motion-permission-feedback" hidden></p>
      <div class="motion-permission-status" hidden></div>
      <button class="velocity-debug-toggle" type="button">Show Debug</button>
    </section>
    <aside class="velocity-debug" hidden></aside>
  `;
}

async function setupApp(): Promise<GoodianoApp> {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
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

describe('adaptive velocity sensitivity control', () => {
  it('enables motion velocity from the generic control and restores its sensitivity', async () => {
    mountAppShell();
    localStorage.setItem(VELOCITY_SENSITIVITY_STORAGE_KEYS.motion, '42');
    const requestPermission = vi.fn().mockResolvedValue('granted');
    vi.stubGlobal('DeviceMotionEvent', { requestPermission });
    const app = await setupApp();
    const slider = document.querySelector<HTMLInputElement>('.velocity-sensitivity')!;
    const toggle = document.querySelector<HTMLButtonElement>('.velocity-toggle')!;

    expect(toggle.textContent).toBe('Enable Velocity');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect((document.querySelector('.sensitivity-control') as HTMLElement).hidden).toBe(true);
    expect(slider.type).toBe('range');
    expect(slider.value).toBe('42');
    expect(document.querySelector('label')?.htmlFor).toBe(slider.id);
    expect(document.querySelector('output')?.textContent).toBe('42');

    toggle.click();
    await vi.waitFor(() => expect(app.input?.motionEnabled).toBe(true));
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(toggle.textContent).toBe('Disable Velocity');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect((document.querySelector('.sensitivity-control') as HTMLElement).hidden).toBe(false);

    slider.value = '61';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    expect(app.input?.sensitivities.motion).toBe(61);
    expect(localStorage.getItem(VELOCITY_SENSITIVITY_STORAGE_KEYS.motion)).toBe('61');
  });

  it('reports denied permission and keeps the enable control retryable', async () => {
    mountAppShell();
    const requestPermission = vi.fn().mockResolvedValue('denied');
    vi.stubGlobal('DeviceMotionEvent', { requestPermission });
    await setupApp();
    const toggle = document.querySelector<HTMLButtonElement>('.velocity-toggle')!;

    toggle.click();
    await vi.waitFor(() => expect(document.querySelector('.motion-permission-feedback')?.textContent).toContain('denied'));
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(toggle.textContent).toBe('Enable Velocity');
    expect((document.querySelector('.sensitivity-control') as HTMLElement).hidden).toBe(true);

    toggle.click();
    await vi.waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(2));
  });

  it('disables and re-enables motion without requesting permission again', async () => {
    mountAppShell();
    const requestPermission = vi.fn().mockResolvedValue('granted');
    vi.stubGlobal('DeviceMotionEvent', { requestPermission });
    const app = await setupApp();
    const toggle = document.querySelector<HTMLButtonElement>('.velocity-toggle')!;

    toggle.click();
    await vi.waitFor(() => expect(app.input?.velocityEnabled).toBe(true));
    toggle.click();
    expect(app.input?.velocityEnabled).toBe(false);
    expect(app.input?.motionPermissionState).toBe('granted');
    expect((document.querySelector('.sensitivity-control') as HTMLElement).hidden).toBe(true);

    toggle.click();
    expect(app.input?.velocityEnabled).toBe(true);
    expect(requestPermission).toHaveBeenCalledOnce();
  });

  it('switches immediately to the saved pressure control and hides motion diagnostics', async () => {
    mountAppShell();
    localStorage.setItem(VELOCITY_SENSITIVITY_STORAGE_KEYS.pressure, '83');
    const app = await setupApp();
    app.input!._setMotionPermissionState('granted');
    app.input!.setVelocityEnabled(true);
    app.input!.motionSamples = [{ time: performance.now(), magnitude: 2 }];
    document.querySelector<HTMLButtonElement>('.velocity-debug-toggle')!.click();

    app.input!._velocityFromPressure(new PointerEvent('pointerdown', { pressure: 0.35, pointerType: 'pen' }));

    const slider = document.querySelector<HTMLInputElement>('.velocity-sensitivity')!;
    expect(document.querySelector('#velocity-sensitivity-label')?.textContent).toBe('Pressure Sensitivity');
    expect(document.querySelector('.velocity-toggle')?.textContent).toBe('Disable Velocity');
    expect(slider.value).toBe('83');
    expect(document.querySelector('output')?.textContent).toBe('83');
    expect(slider.getAttribute('aria-describedby')).toBe('velocity-sensitivity-description');
    expect((document.querySelector('.motion-permission-guidance') as HTMLElement).hidden).toBe(true);
    expect((document.querySelector('.motion-permission-status') as HTMLElement).hidden).toBe(true);
    expect(app.input!.motionEnabled).toBe(false);
    expect(app.input!.motionSamples).toEqual([]);

    document.querySelector<HTMLButtonElement>('.velocity-toggle')!.click();
    expect(app.input!.velocityEnabled).toBe(false);
    expect((document.querySelector('.sensitivity-control') as HTMLElement).hidden).toBe(true);
    app.input!._velocityFromPressure(new PointerEvent('pointerdown', { pressure: 0.8, pointerType: 'pen' }));
    expect(app.input!.velocityEnabled).toBe(false);
  });
});
