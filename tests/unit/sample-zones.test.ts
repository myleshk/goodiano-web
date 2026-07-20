import { describe, expect, it } from 'vitest';
import { YAMAHA_U1_ZONES } from '../../js/app/sample-zones';

describe('Yamaha U1 sample zones', () => {
  it('retains the 14 ordered source mappings and the MIDI 102 overlap', () => {
    expect(YAMAHA_U1_ZONES).toHaveLength(14);
    expect(YAMAHA_U1_ZONES.map(zone => zone.loKey)).toEqual([
      0, 31, 36, 43, 48, 55, 60, 67, 72, 79, 84, 91, 96, 102,
    ]);
    expect(YAMAHA_U1_ZONES[12].hiKey).toBe(102);
    expect(YAMAHA_U1_ZONES[13].loKey).toBe(102);
  });

  it('covers every piano note with positive, non-overlapping sprite ranges', () => {
    for (let midiNote = 21; midiNote <= 108; midiNote++) {
      expect(YAMAHA_U1_ZONES.some(zone => midiNote >= zone.loKey && midiNote <= zone.hiKey)).toBe(true);
    }
    for (const [index, zone] of YAMAHA_U1_ZONES.entries()) {
      expect(zone.durationSeconds).toBeGreaterThan(0);
      expect(zone.offsetSeconds * 44_100 / 1_024).toBeCloseTo(
        Math.round(zone.offsetSeconds * 44_100 / 1_024),
        8,
      );
      const next = YAMAHA_U1_ZONES[index + 1];
      if (next) expect(zone.offsetSeconds + zone.durationSeconds).toBeLessThan(next.offsetSeconds);
    }
  });
});
