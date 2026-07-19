import { describe, expect, it } from 'vitest';
import { computeLayout, findMiddleCIndex, getViewportRange, hitTest, scrollToKey } from '../../js/app/keyboard';
import { generateFullPianoKeys } from '../../js/app/model';

describe('88-key keyboard model and layout', () => {
  const keys = generateFullPianoKeys();
  const layout = computeLayout(keys);

  it('covers A0 through C8 with MIDI-compatible identifiers', () => {
    expect(keys).toHaveLength(88);
    expect(keys[0]).toMatchObject({ id: 'A0', midiNote: 21 });
    expect(keys.at(-1)).toMatchObject({ id: 'C8', midiNote: 108 });
    expect(layout.whiteKeys).toHaveLength(52);
    expect(layout.blackKeys).toHaveLength(36);
  });

  it('uses preceding-white indices for black keys', () => {
    expect(layout.blackKeyWhiteIndex['A#0']).toBe(0);
    expect(layout.blackKeyWhiteIndex['C#1']).toBe(2);
    expect(hitTest(0, 10, 50, 300, layout)?.id).toBe('A#0');
  });

  it('gives partial edge octaves half-width mini-map blocks', () => {
    expect(layout.octaveBlocks.map(block => block.count)).toEqual([2, 7, 7, 7, 7, 7, 7, 7, 1]);
    expect(layout.octaveBlocks.map(block => block.widthMultiplier)).toEqual([0.5, 1, 1, 1, 1, 1, 1, 1, 0.5]);
  });

  it('centers C4 and clamps scroll calculations', () => {
    expect(findMiddleCIndex(layout)).toBe(23);
    expect(scrollToKey(23, 50, 500, 2100)).toBe(925);
    expect(scrollToKey(0, 50, 500, 2100)).toBe(0);
    expect(getViewportRange(925, 50, 500, 52)).toEqual({ start: 18, end: 29 });
  });
});
