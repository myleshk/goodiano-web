import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoodianoApp } from '../../js/app/app';

const VIEWPORT_WIDTH = 400;
const KEYBOARD_HEIGHT = 300;

function mountShell(): void {
  document.body.innerHTML = `
    <main class="app">
      <div class="minimap-container" role="slider" tabindex="0" aria-label="Keyboard position"
        aria-valuemin="0" aria-valuemax="0" aria-valuenow="0"
        style="width: ${VIEWPORT_WIDTH}px; height: 48px;"></div>
      <div class="keyboard-area" style="width: ${VIEWPORT_WIDTH}px; height: ${KEYBOARD_HEIGHT}px;">
        <div class="keyboard-scroll" tabindex="0"
          style="width: ${VIEWPORT_WIDTH}px; height: ${KEYBOARD_HEIGHT}px; overflow-x: auto;"><div class="keyboard-content"></div></div>
      </div>
      <p class="visually-hidden keyboard-announcer" role="status"></p>
    </main>
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

function miniMap(): HTMLElement {
  return document.querySelector<HTMLElement>('.minimap-container')!;
}

/** Press at a horizontal fraction of the mini-map's own box. */
function pressAt(fraction: number, pointerId = 1): void {
  const rect = miniMap().getBoundingClientRect();
  miniMap().dispatchEvent(new PointerEvent('pointerdown', {
    pointerId,
    clientX: rect.left + rect.width * fraction,
    clientY: rect.top + rect.height / 2,
    bubbles: true,
    cancelable: true,
  }));
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('mini-map navigation', () => {
  it('jumps the keyboard to the tapped position', async () => {
    const app = await setupApp();
    const start = app.input!.scrollOffset;

    pressAt(0.9);

    expect(app.input!.scrollOffset).toBeGreaterThan(start);
    // The DOM scroll position follows, allowing for sub-pixel rounding.
    expect(Math.abs(app.scrollContainer.scrollLeft - app.input!.scrollOffset)).toBeLessThanOrEqual(1);

    pressAt(0);
    expect(app.input!.scrollOffset).toBe(0);
  });

  it('follows a drag only while the pointer is captured', async () => {
    const app = await setupApp();
    const rect = miniMap().getBoundingClientRect();
    const before = app.input!.scrollOffset;
    // No pointerdown first, so nothing is captured and the map must ignore it.
    miniMap().dispatchEvent(new PointerEvent('pointermove', {
      pointerId: 7,
      clientX: rect.left + rect.width * 0.8,
      bubbles: true,
    }));
    expect(app.input!.scrollOffset).toBe(before);

    pressAt(0.2, 7);
    const afterPress = app.input!.scrollOffset;
    miniMap().dispatchEvent(new PointerEvent('pointermove', {
      pointerId: 7,
      clientX: rect.left + rect.width * 0.8,
      bubbles: true,
      cancelable: true,
    }));

    expect(app.input!.scrollOffset).toBeGreaterThan(afterPress);

    // Once the drag ends, further moves over the map are ignored again.
    miniMap().dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, bubbles: true }));
    const afterRelease = app.input!.scrollOffset;
    miniMap().dispatchEvent(new PointerEvent('pointermove', {
      pointerId: 7,
      clientX: rect.left + rect.width * 0.1,
      bubbles: true,
    }));

    expect(app.input!.scrollOffset).toBe(afterRelease);
  });

  it('reports the centred key through the slider value', async () => {
    const app = await setupApp();
    const map = miniMap();

    expect(map.getAttribute('aria-valuemax')).toBe(String(app.layout.whiteKeys.length - 1));

    // Fully scrolled left, the middle of the viewport sits a few keys in.
    pressAt(0);
    expect(app.input!.scrollOffset).toBe(0);
    const leftMost = Number(map.getAttribute('aria-valuenow'));
    expect(leftMost).toBeGreaterThan(0);
    expect(map.getAttribute('aria-valuetext')).toBe(app.layout.whiteKeys[leftMost].name);

    pressAt(1);
    expect(app.input!.scrollOffset).toBe(app.maxScroll);
    const rightMost = Number(map.getAttribute('aria-valuenow'));
    expect(rightMost).toBeGreaterThan(leftMost);
    expect(map.getAttribute('aria-valuetext')).toBe(app.layout.whiteKeys[rightMost].name);
  });

  it('steps and jumps from the keyboard without shifting the playing octave', async () => {
    const app = await setupApp();
    const map = miniMap();
    const octaveBefore = app.computerKeyboard!.octave;

    map.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(app.input!.scrollOffset).toBe(0);

    const home = Number(map.getAttribute('aria-valuenow'));
    map.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(Number(map.getAttribute('aria-valuenow'))).toBe(home + 1);

    map.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }));
    expect(Number(map.getAttribute('aria-valuenow'))).toBe(home + 8);

    map.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(app.input!.scrollOffset).toBe(app.maxScroll);

    // The arrow keys were consumed here, not by the computer-keyboard octave shift.
    expect(app.computerKeyboard!.octave).toBe(octaveBefore);
  });
});
