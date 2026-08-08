import { describe, expect, it, vi } from 'vitest';
import { ComputerKeyboardController, DEFAULT_OCTAVE, KEY_CODE_SEMITONES } from '../../js/app/computer-keyboard';

function controller() {
  const onNoteOn = vi.fn();
  const onNoteOff = vi.fn();
  const onOctaveChange = vi.fn();
  const keyboard = new ComputerKeyboardController({ onNoteOn, onNoteOff, onOctaveChange });
  return { keyboard, onNoteOn, onNoteOff, onOctaveChange };
}

describe('computer keyboard mapping', () => {
  it('lays the two rows an octave apart from middle C', () => {
    const { keyboard } = controller();
    expect(keyboard.octave).toBe(DEFAULT_OCTAVE);
    // Lower row starts at the base octave's C, upper row an octave above.
    expect(keyboard.midiNoteFor('KeyZ')).toBe(60);
    expect(keyboard.midiNoteFor('KeyQ')).toBe(72);
    // Black keys sit on the row directly above their white neighbours.
    expect(keyboard.midiNoteFor('KeyS')).toBe(61);
    expect(keyboard.midiNoteFor('Digit2')).toBe(73);
    expect(keyboard.midiNoteFor('BracketRight')).toBeNull();
  });

  it('spells a chromatic run with no gaps or repeats across the lower row', () => {
    const { keyboard } = controller();
    const lowerRow = ['KeyZ', 'KeyS', 'KeyX', 'KeyD', 'KeyC', 'KeyV', 'KeyG',
      'KeyB', 'KeyH', 'KeyN', 'KeyJ', 'KeyM', 'Comma'];

    const notes = lowerRow.map(code => keyboard.midiNoteFor(code));
    expect(notes).toEqual([60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72]);
  });

  it('keeps every mapped key inside the 88-key range at both extremes', () => {
    const { keyboard } = controller();
    const codes = Object.keys(KEY_CODE_SEMITONES);

    for (const octave of [0, 1, 2, 3, 4, 5, 6]) {
      keyboard.setOctave(octave);
      for (const code of codes) {
        const midiNote = keyboard.midiNoteFor(code);
        if (midiNote === null) continue;
        expect(midiNote).toBeGreaterThanOrEqual(21);
        expect(midiNote).toBeLessThanOrEqual(108);
      }
    }
  });

  it('clamps octave shifts and reports only real changes', () => {
    const { keyboard, onOctaveChange } = controller();

    keyboard.setOctave(-5);
    expect(keyboard.octave).toBe(0);
    keyboard.setOctave(-5);
    keyboard.setOctave(99);

    expect(keyboard.octave).toBe(6);
    expect(onOctaveChange).toHaveBeenCalledTimes(2);
  });
});
