import { describe, expect, it } from 'vitest';
import { computeLayout, findMiddleCIndex, getMiniMapViewport, getViewportRange, getWhiteKeyWidth, hitTest, scrollToKey, whiteKeyIndexAtMiniMapX } from '../../js/app/keyboard';
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

  it('centers black keys on the boundary after their preceding white key', () => {
    expect(layout.blackKeyWhiteIndex['A#0']).toBe(1);
    expect(layout.blackKeyWhiteIndex['C#1']).toBe(3);
    expect(hitTest(0, 10, 50, 300, layout)?.id).toBe('A0');
    expect(hitTest(50, 10, 50, 300, layout)?.id).toBe('A#0');
    expect(hitTest(150, 10, 50, 300, layout)?.id).toBe('C#1');
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

  it('maps mini-map viewports through white-key positions, including partial octaves', () => {
    expect(getMiniMapViewport(layout, 0, 50, 100)).toEqual({ start: 0, end: 0.0625 });

    const c4Scroll = scrollToKey(findMiddleCIndex(layout), 50, 500, 2100);
    expect(getMiniMapViewport(layout, c4Scroll, 50, 500)).toEqual({
      start: 0.3571428571428571,
      end: 0.5357142857142857,
    });
  });

  it('inverts the mini-map projection back onto white keys', () => {
    expect(whiteKeyIndexAtMiniMapX(layout, 0)).toBe(0);
    expect(whiteKeyIndexAtMiniMapX(layout, 1)).toBe(layout.whiteKeys.length - 1);
    // Out-of-range fractions clamp rather than escaping the keyboard.
    expect(whiteKeyIndexAtMiniMapX(layout, -3)).toBe(0);
    expect(whiteKeyIndexAtMiniMapX(layout, 9)).toBe(layout.whiteKeys.length - 1);

    // Round trip: every stored position maps back to its own key.
    for (const [index, position] of layout.miniMapKeyXs.entries()) {
      expect(whiteKeyIndexAtMiniMapX(layout, position.x)).toBe(index);
    }
  });

  it('uses the iOS 55-point logical key width in landscape', () => {
    expect(getWhiteKeyWidth(1024, 385)).toBe(55);
    expect(385 / getWhiteKeyWidth(1024, 385)).toBe(7);
    expect(getWhiteKeyWidth(844, 343)).toBe(55);
  });
});
