/**
 * Goodiano Piano Data Model
 * Port of PianoKeyModel.swift + Pitch enum + generatePianoKeys()
 * 88-key piano: A0 (MIDI 21) through C8 (MIDI 108)
 */

interface PitchDefinition {
  readonly name: string;
  readonly semitoneOffset: number;
  readonly isBlack: boolean;
}

interface PianoKey {
  id: string;
  name: string;
  pitch: PitchDefinition;
  octave: number;
  isBlack: boolean;
  midiNote: number;
}

interface KeyBoundary {
  pitch: PitchDefinition;
  octave: number;
}

const Pitch = Object.freeze({
  C:      { name: 'C',  semitoneOffset: 0,  isBlack: false },
  CSharp: { name: 'C#', semitoneOffset: 1,  isBlack: true  },
  D:      { name: 'D',  semitoneOffset: 2,  isBlack: false },
  DSharp: { name: 'D#', semitoneOffset: 3,  isBlack: true  },
  E:      { name: 'E',  semitoneOffset: 4,  isBlack: false },
  F:      { name: 'F',  semitoneOffset: 5,  isBlack: false },
  FSharp: { name: 'F#', semitoneOffset: 6,  isBlack: true  },
  G:      { name: 'G',  semitoneOffset: 7,  isBlack: false },
  GSharp: { name: 'G#', semitoneOffset: 8,  isBlack: true  },
  A:      { name: 'A',  semitoneOffset: 9,  isBlack: false },
  ASharp: { name: 'A#', semitoneOffset: 10, isBlack: true  },
  B:      { name: 'B',  semitoneOffset: 11, isBlack: false },
});

const PITCHES_BY_SEMITONE = Object.values(Pitch).reduce<Record<number, PitchDefinition>>((map, p) => {
  map[p.semitoneOffset] = p;
  return map;
}, {});

/**
 * Create a piano key model
 * @param {object} pitch - Pitch enum value
 * @param {number} octave
 * @returns {object} PianoKeyModel
 */
function createKey(pitch: PitchDefinition, octave: number): PianoKey {
  const midiNote = (octave + 1) * 12 + pitch.semitoneOffset;
  const name = `${pitch.name}${octave}`;
  return {
    id: name,
    name,
    pitch,
    octave,
    isBlack: pitch.isBlack,
    midiNote,
  };
}

/**
 * Generate a contiguous chromatic range of piano keys
 * @param {{pitch: object, octave: number}} from - starting key
 * @param {{pitch: object, octave: number}} to - ending key (inclusive)
 * @returns {object[]} Array of PianoKeyModel objects
 */
function generatePianoKeys(from: KeyBoundary, to: KeyBoundary): PianoKey[] {
  const startMIDI = (from.octave + 1) * 12 + from.pitch.semitoneOffset;
  const endMIDI = (to.octave + 1) * 12 + to.pitch.semitoneOffset;
  if (startMIDI > endMIDI) return [];

  const keys: PianoKey[] = [];
  for (let midi = startMIDI; midi <= endMIDI; midi++) {
    const octave = Math.floor(midi / 12) - 1;
    const semitone = ((midi % 12) + 12) % 12;
    const pitch = PITCHES_BY_SEMITONE[semitone];
    if (pitch) keys.push(createKey(pitch, octave));
  }
  return keys;
}

/**
 * Default 88-key piano range: A0 through C8
 */
function generateFullPianoKeys() {
  return generatePianoKeys(
    { pitch: Pitch.A, octave: 0 },
    { pitch: Pitch.C, octave: 8 }
  );
}

export { Pitch, PITCHES_BY_SEMITONE, createKey, generatePianoKeys, generateFullPianoKeys };
export type { KeyBoundary, PianoKey, PitchDefinition };
