import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComputerKeyboardController } from '../../js/app/computer-keyboard';

let active: ComputerKeyboardController | null = null;

function attached() {
  const onNoteOn = vi.fn();
  const onNoteOff = vi.fn();
  const onSustainChange = vi.fn();
  const keyboard = new ComputerKeyboardController({ onNoteOn, onNoteOff, onSustainChange });
  keyboard.attach();
  active = keyboard;
  return { keyboard, onNoteOn, onNoteOff, onSustainChange };
}

afterEach(() => {
  active?.destroy();
  active = null;
  document.body.innerHTML = '';
});

describe('computer keyboard input', () => {
  it('strikes a held key once despite auto-repeat', () => {
    const { onNoteOn, onNoteOff } = attached();

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', repeat: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC' }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyC' }));

    expect(onNoteOn).toHaveBeenCalledTimes(1);
    expect(onNoteOn).toHaveBeenCalledWith(64, 100);
    expect(onNoteOff).toHaveBeenCalledExactlyOnceWith(64);
  });

  it('reads dynamics from modifier keys', () => {
    const { onNoteOn } = attached();

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ', shiftKey: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyX', altKey: true }));

    expect(onNoteOn).toHaveBeenNthCalledWith(1, 60, 120);
    expect(onNoteOn).toHaveBeenNthCalledWith(2, 62, 60);
  });

  it('shifts octaves with the arrow keys and releases what was held', () => {
    const { keyboard, onNoteOn, onNoteOff } = attached();

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight' }));

    expect(onNoteOff).toHaveBeenCalledExactlyOnceWith(60);
    expect(keyboard.octave).toBe(5);

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ' }));
    expect(onNoteOn).toHaveBeenLastCalledWith(72, 100);

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowLeft' }));
    expect(keyboard.octave).toBe(4);
  });

  it('leaves browser shortcuts and form controls alone', () => {
    const { onNoteOn } = attached();
    const slider = document.createElement('input');
    slider.type = 'range';
    document.body.append(slider);

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', metaKey: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', ctrlKey: true }));
    slider.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', bubbles: true }));

    expect(onNoteOn).not.toHaveBeenCalled();
  });

  it('releases everything still held when the page is hidden', () => {
    const { onNoteOff } = attached();

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyQ' }));
    document.dispatchEvent(new Event('visibilitychange'));

    expect(onNoteOff.mock.calls.map(call => call[0]).toSorted()).toEqual([60, 72]);
  });

  it('holds the pedal for as long as space is down', () => {
    const { onSustainChange, onNoteOn } = attached();

    const down = new KeyboardEvent('keydown', { code: 'Space', cancelable: true });
    window.dispatchEvent(down);
    // Space would otherwise scroll the page out from under the keyboard.
    expect(down.defaultPrevented).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', repeat: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' }));

    expect(onSustainChange.mock.calls).toEqual([[true], [false]]);
    expect(onNoteOn).not.toHaveBeenCalled();
  });

  it('lifts the pedal when the page is hidden mid-press', () => {
    const { onSustainChange } = attached();

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
    document.dispatchEvent(new Event('visibilitychange'));

    expect(onSustainChange).toHaveBeenLastCalledWith(false);
  });

  it('stops sending notes once destroyed', () => {
    const { keyboard, onNoteOn } = attached();
    keyboard.destroy();

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ' }));

    expect(onNoteOn).not.toHaveBeenCalled();
  });
});
