import { afterEach, describe, expect, it, vi } from 'vitest';
import { InputController } from '../../js/app/input';
import { Pitch, createKey } from '../../js/app/model';

const key = createKey(Pitch.C, 4);

function pointer(type: string, pointerId: number, clientX: number, clientY = 20, pressure?: number): PointerEvent {
  return new PointerEvent(type, { pointerId, clientX, clientY, pressure, pointerType: 'touch', bubbles: true, cancelable: true });
}

function setup() {
  const container = document.createElement('div');
  container.tabIndex = 0;
  document.body.appendChild(container);
  const presses: Array<[string, boolean]> = [];
  const velocities: Array<number | undefined> = [];
  const velocitySources: Array<string | undefined> = [];
  const scrolls: number[] = [];
  const input = new InputController(container, {
    onKeyPress: (pressedKey, pressed, velocity) => {
      presses.push([pressedKey.id, pressed]);
      if (pressed) {
        velocities.push(velocity);
        velocitySources.push(pressedKey.velocitySource);
      }
    },
    onScroll: offset => scrolls.push(offset),
  });
  input.setConverters((x, y) => ({ x, y }), x => x >= 0 && x < 100 ? key : null);
  input.setMaxScroll(500);
  return { container, input, presses, scrolls, velocities, velocitySources };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('pointer input', () => {
  it('starts the first note immediately and releases it on pointer up', () => {
    const { container, input, presses } = setup();
    container.dispatchEvent(pointer('pointerdown', 1, 20));
    expect(presses).toEqual([['C4', true]]);
    container.dispatchEvent(pointer('pointerup', 1, 20));
    expect(presses).toEqual([['C4', true], ['C4', false]]);
    input.destroy();
  });

  it('turns a single horizontal drag into scrolling', () => {
    const { container, input, presses, scrolls } = setup();
    input.setScrollOffset(100);
    container.dispatchEvent(pointer('pointerdown', 1, 50));
    container.dispatchEvent(pointer('pointermove', 1, 20));
    expect(presses).toEqual([['C4', true], ['C4', false]]);
    expect(scrolls.at(-1)).toBe(130);
    input.destroy();
  });

  it('keeps a shared key held until the final pointer releases', () => {
    const { container, input, presses } = setup();
    container.dispatchEvent(pointer('pointerdown', 1, 20));
    container.dispatchEvent(pointer('pointerdown', 2, 30));
    container.dispatchEvent(pointer('pointerup', 1, 20));
    expect(presses).toEqual([['C4', true]]);
    container.dispatchEvent(pointer('pointerup', 2, 30));
    expect(presses).toEqual([['C4', true], ['C4', false]]);
    input.destroy();
  });

  it('synchronizes Safari native scrolling back to the controller', () => {
    const { container, input, scrolls } = setup();
    Object.defineProperty(container, 'scrollLeft', { value: 180, writable: true });
    container.dispatchEvent(new Event('scroll'));

    expect(input.scrollOffset).toBe(180);
    expect(scrolls.at(-1)).toBe(180);
    input.destroy();
  });

  it('applies touch pressure velocity to the initial note', () => {
    const { container, input, velocities } = setup();
    container.dispatchEvent(pointer('pointerdown', 1, 20, 20, 0.75));

    expect(velocities).toEqual([104]);
    input.destroy();
  });

  it('applies a recent motion impulse to the initial note', () => {
    const { container, input, velocities } = setup();
    const now = performance.now();
    input.motionSamples = [
      { time: now - 150, magnitude: 1 },
      { time: now - 10, magnitude: 2.4 },
    ];
    container.dispatchEvent(pointer('pointerdown', 1, 20));

    expect(velocities).toEqual([127]);
    input.destroy();
  });

  it('requests and reports motion permission from a user gesture', async () => {
    const requestPermission = vi.fn().mockResolvedValue('granted');
    vi.stubGlobal('DeviceMotionEvent', { requestPermission });
    const container = document.createElement('div');
    const states: string[] = [];
    const input = new InputController(container, {
      onMotionPermissionChange: state => states.push(state),
    });

    await expect(input.requestMotionPermission()).resolves.toBe('granted');
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(states).toEqual(['requesting', 'granted']);
    input.destroy();
  });

});
