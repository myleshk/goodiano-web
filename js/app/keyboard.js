/**
 * Goodiano Keyboard Layout Engine
 * Port of KeyboardView.swift layout math, hit testing, and octave grouping.
 */

/**
 * Compute full keyboard layout data from a set of keys.
 * @param {object[]} keys - array of PianoKeyModel from model.js
 * @returns {object} layout data
 */
function computeLayout(keys) {
  const whiteKeys = keys.filter(k => !k.isBlack);
  const blackKeys = keys.filter(k => k.isBlack);

  // Map white key ID -> index in whiteKeys array
  const whiteIndexMap = new Map();
  whiteKeys.forEach((k, i) => whiteIndexMap.set(k.id, i));

  // For each black key, find its position relative to preceding white keys
  const blackKeyWhiteIndex = {};
  for (const bk of blackKeys) {
    // A black key sits between the white key below and above.
    // The white key below is the same note letter without sharp (e.g., C for C#)
    const belowName = bk.pitch.name.charAt(0) + bk.octave;
    const wIdx = whiteIndexMap.get(belowName);
    blackKeyWhiteIndex[bk.id] = wIdx != null ? wIdx + 0.5 : 0;
  }

  // Group white keys into octave blocks (for mini-map)
  // Octave N contains white keys from C(N) to B(N)
  const octaveBlocks = [];
  let currentOctave = null;
  let currentStart = 0;

  whiteKeys.forEach((wk, i) => {
    if (wk.octave !== currentOctave) {
      if (currentOctave !== null) {
        octaveBlocks.push({
          octave: currentOctave,
          startIndex: currentStart,
          endIndex: i - 1,
          count: i - currentStart,
        });
      }
      currentOctave = wk.octave;
      currentStart = i;
    }
  });
  // Push last octave
  if (currentOctave !== null) {
    octaveBlocks.push({
      octave: currentOctave,
      startIndex: currentStart,
      endIndex: whiteKeys.length - 1,
      count: whiteKeys.length - currentStart,
    });
  }

  // Mini-map X positions (normalized 0-1)
  const miniMapKeyXs = whiteKeys.map((wk, i) => ({
    keyId: wk.id,
    x: i / Math.max(whiteKeys.length - 1, 1),
  }));

  return {
    keys,
    whiteKeys,
    blackKeys,
    whiteKeyCount: whiteKeys.length,
    blackKeyWhiteIndex,
    octaveBlocks,
    miniMapKeyXs,
    whiteIndexMap,
    // MIDI range for reference
    midiLow: keys[0]?.midiNote ?? 21,
    midiHigh: keys[keys.length - 1]?.midiNote ?? 108,
  };
}

/**
 * Hit test: given a point within the keyboard view, return the pressed key or null.
 * @param {number} x - x coordinate relative to keyboard content
 * @param {number} y - y coordinate relative to keyboard content
 * @param {number} whiteKeyWidth - current white key width in px
 * @param {number} keyboardHeight - total keyboard height in px
 * @param {object} layout - result of computeLayout()
 * @returns {object|null} PianoKeyModel or null
 */
function hitTest(x, y, whiteKeyWidth, keyboardHeight, layout) {
  const { whiteKeys, blackKeys, blackKeyWhiteIndex } = layout;

  const blackWidth = whiteKeyWidth * 0.65;
  const blackHeight = keyboardHeight * 0.6;

  // Check black keys first (upper 60% of keyboard)
  if (y < blackHeight) {
    for (const bk of blackKeys) {
      const wPos = blackKeyWhiteIndex[bk.id];
      if (wPos == null) continue;
      const centerX = wPos * whiteKeyWidth;
      const left = centerX - blackWidth / 2;
      const right = centerX + blackWidth / 2;
      if (x >= left && x <= right && y >= 0 && y <= blackHeight) {
        return bk;
      }
    }
  }

  // Fallback: hit white key
  const wIdx = Math.floor(x / whiteKeyWidth);
  if (wIdx >= 0 && wIdx < whiteKeys.length) {
    return whiteKeys[wIdx];
  }

  return null;
}

/**
 * Get the current scroll position's viewport in white-key-index space.
 * @param {number} scrollOffset - current scroll offset in px
 * @param {number} whiteKeyWidth - current white key width
 * @param {number} viewportWidth - visible width in px
 * @param {number} totalWhiteKeys - total count of white keys
 * @returns {{ start: number, end: number }}
 */
function getViewportRange(scrollOffset, whiteKeyWidth, viewportWidth, totalWhiteKeys) {
  const start = Math.max(0, Math.floor(scrollOffset / whiteKeyWidth));
  const end = Math.min(totalWhiteKeys - 1, Math.ceil((scrollOffset + viewportWidth) / whiteKeyWidth));
  return { start, end };
}

/**
 * Compute scroll offset to center a specific white key index.
 * @param {number} whiteKeyIndex - index in whiteKeys array
 * @param {number} whiteKeyWidth - current white key width
 * @param {number} viewportWidth - visible width in px
 * @param {number} maxScroll - maximum scroll offset
 * @returns {number} target scroll offset
 */
function scrollToKey(whiteKeyIndex, whiteKeyWidth, viewportWidth, maxScroll) {
  const keyCenterX = whiteKeyIndex * whiteKeyWidth + whiteKeyWidth / 2;
  return Math.max(0, Math.min(maxScroll, keyCenterX - viewportWidth / 2));
}

/**
 * Find the white key index for Middle C (C4)
 * @param {object} layout
 * @returns {number} white key index
 */
function findMiddleCIndex(layout) {
  const idx = layout.whiteKeys.findIndex(k => k.id === 'C4');
  return idx >= 0 ? idx : Math.floor(layout.whiteKeys.length / 2);
}

export { computeLayout, hitTest, getViewportRange, scrollToKey, findMiddleCIndex };
