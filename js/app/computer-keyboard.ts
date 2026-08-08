/**
 * Computer-keyboard note input.
 *
 * Two rows of the physical keyboard are laid out like an octave each: the
 * Z row starts at the current base octave and the Q row an octave above it,
 * with the black keys on the row directly over each. Codes are used rather
 * than characters so the mapping follows the physical layout and keeps
 * working on non-QWERTY arrangements.
 */

const KEY_CODE_SEMITONES: Readonly<Record<string, number>> = {
  // Lower row: base octave.
  KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4,
  KeyV: 5, KeyG: 6, KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11,
  Comma: 12, KeyL: 13, Period: 14, Semicolon: 15, Slash: 16,
  // Upper row: an octave above.
  KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16,
  KeyR: 17, Digit5: 18, KeyT: 19, Digit6: 20, KeyY: 21, Digit7: 22, KeyU: 23,
  KeyI: 24, Digit9: 25, KeyO: 26, Digit0: 27, KeyP: 28,
};

const OCTAVE_DOWN_CODES = new Set(['ArrowLeft']);
const OCTAVE_UP_CODES = new Set(['ArrowRight']);
const SUSTAIN_CODES = new Set(['Space']);

const DEFAULT_OCTAVE = 4;
const MIN_OCTAVE = 0;
const MAX_OCTAVE = 6;
const LOWEST_MIDI_NOTE = 21;
const HIGHEST_MIDI_NOTE = 108;

/** Struck harder with Shift, softer with Alt, ordinary otherwise. */
const NORMAL_VELOCITY = 100;
const ACCENT_VELOCITY = 120;
const SOFT_VELOCITY = 60;

interface ComputerKeyboardCallbacks {
  onNoteOn?: (midiNote: number, velocity: number) => void;
  onNoteOff?: (midiNote: number) => void;
  onOctaveChange?: (octave: number) => void;
  onSustainChange?: (held: boolean) => void;
}

/** True when the event belongs to a control the user is typing or tabbing in. */
function isEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(target.tagName);
}

function velocityFor(event: KeyboardEvent): number {
  if (event.shiftKey) return ACCENT_VELOCITY;
  if (event.altKey) return SOFT_VELOCITY;
  return NORMAL_VELOCITY;
}

class ComputerKeyboardController {
  octave = DEFAULT_OCTAVE;
  /** Physical code -> the MIDI note it started, so shifts release cleanly. */
  private readonly sounding = new Map<string, number>();
  private readonly onNoteOn: NonNullable<ComputerKeyboardCallbacks['onNoteOn']>;
  private readonly onNoteOff: NonNullable<ComputerKeyboardCallbacks['onNoteOff']>;
  private readonly onOctaveChange: NonNullable<ComputerKeyboardCallbacks['onOctaveChange']>;
  private readonly onSustainChange: NonNullable<ComputerKeyboardCallbacks['onSustainChange']>;
  private sustainHeld = false;
  private readonly target: EventTarget;
  private readonly handleKeyDown = (event: KeyboardEvent): void => this._onKeyDown(event);
  private readonly handleKeyUp = (event: KeyboardEvent): void => this._onKeyUp(event);
  private readonly handleBlur = (): void => this.releaseAll();

  // globalThis is window in the browser, and keeps the mapping constructible
  // under the Node-based unit tests.
  constructor(callbacks: ComputerKeyboardCallbacks = {}, target: EventTarget = globalThis) {
    this.onNoteOn = callbacks.onNoteOn ?? (() => {});
    this.onNoteOff = callbacks.onNoteOff ?? (() => {});
    this.onOctaveChange = callbacks.onOctaveChange ?? (() => {});
    this.onSustainChange = callbacks.onSustainChange ?? (() => {});
    this.target = target;
  }

  attach(): void {
    this.target.addEventListener('keydown', this.handleKeyDown as EventListener);
    this.target.addEventListener('keyup', this.handleKeyUp as EventListener);
    // Keys held while focus leaves never deliver a keyup.
    this.target.addEventListener('blur', this.handleBlur);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleBlur);
    }
  }

  destroy(): void {
    this.releaseAll();
    this.target.removeEventListener('keydown', this.handleKeyDown as EventListener);
    this.target.removeEventListener('keyup', this.handleKeyUp as EventListener);
    this.target.removeEventListener('blur', this.handleBlur);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleBlur);
    }
  }

  /** MIDI note for a physical key at the current octave, or null if unmapped. */
  midiNoteFor(code: string): number | null {
    const semitone = KEY_CODE_SEMITONES[code];
    if (semitone === undefined) return null;
    const midiNote = (this.octave + 1) * 12 + semitone;
    if (midiNote < LOWEST_MIDI_NOTE || midiNote > HIGHEST_MIDI_NOTE) return null;
    return midiNote;
  }

  setOctave(octave: number): void {
    const next = Math.max(MIN_OCTAVE, Math.min(MAX_OCTAVE, Math.round(octave)));
    if (next === this.octave) return;
    // Held keys belong to the octave they started in; end them before moving.
    this.releaseAll();
    this.octave = next;
    this.onOctaveChange(next);
  }

  releaseAll(): void {
    for (const midiNote of this.sounding.values()) this.onNoteOff(midiNote);
    this.sounding.clear();
    this._setSustainHeld(false);
  }

  private _setSustainHeld(held: boolean): void {
    if (held === this.sustainHeld) return;
    this.sustainHeld = held;
    this.onSustainChange(held);
  }

  private _onKeyDown(event: KeyboardEvent): void {
    // Leave browser and OS shortcuts alone, and stay out of form controls.
    if (event.ctrlKey || event.metaKey || isEditingTarget(event.target)) return;
    if (SUSTAIN_CODES.has(event.code)) {
      // Space would otherwise scroll the page under the keyboard.
      event.preventDefault();
      this._setSustainHeld(true);
      return;
    }
    if (OCTAVE_DOWN_CODES.has(event.code)) {
      event.preventDefault();
      this.setOctave(this.octave - 1);
      return;
    }
    if (OCTAVE_UP_CODES.has(event.code)) {
      event.preventDefault();
      this.setOctave(this.octave + 1);
      return;
    }
    const midiNote = this.midiNoteFor(event.code);
    if (midiNote === null) return;
    event.preventDefault();
    // Auto-repeat would restrike a key that is physically still down.
    if (event.repeat || this.sounding.has(event.code)) return;
    this.sounding.set(event.code, midiNote);
    this.onNoteOn(midiNote, velocityFor(event));
  }

  private _onKeyUp(event: KeyboardEvent): void {
    if (SUSTAIN_CODES.has(event.code)) {
      this._setSustainHeld(false);
      return;
    }
    const midiNote = this.sounding.get(event.code);
    if (midiNote === undefined) return;
    this.sounding.delete(event.code);
    this.onNoteOff(midiNote);
  }
}

export { ComputerKeyboardController, KEY_CODE_SEMITONES, DEFAULT_OCTAVE, MIN_OCTAVE, MAX_OCTAVE };
export type { ComputerKeyboardCallbacks };
