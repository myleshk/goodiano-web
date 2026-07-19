import { afterEach, describe, expect, it, vi } from 'vitest';
import { InputController } from '../../js/app/input';
import { Pitch, createKey } from '../../js/app/model';

const key = createKey(Pitch.C, 4);

function pointer(type: string, pointerId: number, clientX: number, clientY = 20): PointerEvent {
  return new PointerEvent(type, { pointerId, clientX, clientY, bubbles: true, cancelable: true });
}

function setup() {
  const container = document.createElement('div');
  container.tabIndex = 0;
  document.body.appendChild(container);
  const presses: Array<[string, boolean]> = [];
  const scrolls: number[] = [];
  const input = new InputController(container, {
    onKeyPress: (pressedKey, pressed) => presses.push([pressedKey.id, pressed]),
    onScroll: offset => scrolls.push(offset),
  });
  input.setConverters((x, y) => ({ x, y }), x => x >= 0 && x < 100 ? key : null);
  input.setMaxScroll(500);
  return { container, input, presses, scrolls };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
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
});
