import { afterEach, describe, expect, it } from 'vitest';
import { computeLayout, findMiddleCIndex, getMiniMapViewport, scrollToKey } from '../../js/app/keyboard';
import { generateFullPianoKeys } from '../../js/app/model';
import { KeyboardRenderer } from '../../js/app/render';
import '../../css/main.css';

function setupRenderer() {
  const content = document.createElement('div');
  content.className = 'keyboard-content';
  const minimap = document.createElement('div');
  const scroll = document.createElement('div');
  document.body.append(content, minimap, scroll);
  const renderer = new KeyboardRenderer(content, minimap, scroll);
  const layout = computeLayout(generateFullPianoKeys());
  renderer.build(layout);
  renderer.buildMiniMap();
  renderer.updateViewport(390, 320, 39);
  return { renderer, layout, content, minimap };
}

afterEach(() => { document.body.innerHTML = ''; });

describe('keyboard rendering', () => {
  it('bottom-anchors white-key labels without flex or percentage padding', () => {
    const { content } = setupRenderer();
    const key = content.querySelector<HTMLElement>('.key-white')!;
    const label = key.querySelector<HTMLElement>('.key-label')!;

    expect(key.style.display).not.toBe('flex');
    expect(key.style.paddingBottom).toBe('');
    const labelStyle = getComputedStyle(label);
    expect(labelStyle.position).toBe('absolute');
    expect(labelStyle.bottom).toBe('10px');
    expect(labelStyle.left).not.toBe('');
  });

  it('draws keys where the hit test expects them, at both key widths', () => {
    const { renderer, layout, content } = setupRenderer();

    for (const whiteKeyWidth of [39, 55]) {
      renderer.updateViewport(390, 320, whiteKeyWidth);
      const blackWidth = whiteKeyWidth * 0.65;

      // Tolerances are loose enough for WebKit's 1/64px layout quantisation.
      const white = content.querySelector<HTMLElement>('.key-white')!;
      expect(parseFloat(getComputedStyle(white).width)).toBeCloseTo(whiteKeyWidth, 1);

      // hitTest centres a black key on the boundary after the white keys that
      // precede it; the drawn position has to agree or touches land wrong.
      for (const blackKey of [layout.blackKeys[0], layout.blackKeys[10], layout.blackKeys.at(-1)!]) {
        const element = content.querySelector<HTMLElement>(`.key-black[data-key="${blackKey.id}"]`)!;
        const style = getComputedStyle(element);
        const centre = layout.blackKeyWhiteIndex[blackKey.id] * whiteKeyWidth;
        expect(parseFloat(style.width)).toBeCloseTo(blackWidth, 1);
        expect(parseFloat(style.left)).toBeCloseTo(centre - blackWidth / 2, 1);
      }
    }
  });

  it('resizes every key from a single style write', () => {
    const { renderer, content } = setupRenderer();
    const white = content.querySelector<HTMLElement>('.key-white')!;
    const black = content.querySelector<HTMLElement>('.key-black')!;

    renderer.updateViewport(390, 320, 55);

    // Geometry lives in CSS: the keys carry no inline width or position.
    expect(white.getAttribute('style')).toBeNull();
    expect(black.style.width).toBe('');
    expect(black.style.left).toBe('');
    expect(content.style.getPropertyValue('--white-key-width')).toBe('55px');
  });

  it('places and moves the mini-map indicator using key-index coordinates', () => {
    const { renderer, layout, minimap } = setupRenderer();
    const indicator = minimap.querySelector<HTMLElement>('.minimap-indicator')!;
    const c4Scroll = scrollToKey(findMiddleCIndex(layout), 39, 390, 52 * 39 - 390);

    renderer.updateMiniMap(c4Scroll);
    const initial = getMiniMapViewport(layout, c4Scroll, 39, 390);
    expect(parseFloat(indicator.style.left)).toBeCloseTo(initial.start * 100, 5);
    expect(parseFloat(indicator.style.width)).toBeCloseTo((initial.end - initial.start) * 100, 5);

    renderer.updateViewport(100, 320, 50);
    renderer.updateMiniMap(0);
    expect(indicator.style.left).toBe('0%');
    expect(indicator.style.width).toBe('6.25%');
  });
});
