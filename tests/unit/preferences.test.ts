import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VOLUME_PERCENT,
  KEY_LABELS_STORAGE_KEY,
  VOLUME_STORAGE_KEY,
  loadKeyLabelsVisible,
  loadVolumePercent,
  normalizeVolumePercent,
  saveKeyLabelsVisible,
  saveVolumePercent,
} from '../../js/app/preferences';

function fakeStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    values,
  };
}

const unavailableStorage = {
  getItem: () => { throw new Error('storage disabled'); },
  setItem: () => { throw new Error('storage disabled'); },
};

describe('output preferences', () => {
  it('clamps and rounds restored volume values', () => {
    expect(normalizeVolumePercent('55')).toBe(55);
    expect(normalizeVolumePercent(140)).toBe(100);
    expect(normalizeVolumePercent(-20)).toBe(0);
    expect(normalizeVolumePercent(61.6)).toBe(62);
    expect(normalizeVolumePercent('  ')).toBe(DEFAULT_VOLUME_PERCENT);
    expect(normalizeVolumePercent('loud')).toBe(DEFAULT_VOLUME_PERCENT);
  });

  it('round trips volume through its versioned key', () => {
    const storage = fakeStorage();
    expect(loadVolumePercent(storage)).toBe(DEFAULT_VOLUME_PERCENT);

    expect(saveVolumePercent(72, storage)).toBe(72);
    expect(storage.values.get(VOLUME_STORAGE_KEY)).toBe('72');
    expect(loadVolumePercent(storage)).toBe(72);
  });

  it('treats a silenced setting as a real choice rather than a missing one', () => {
    const storage = fakeStorage();
    saveVolumePercent(0, storage);
    expect(loadVolumePercent(storage)).toBe(0);
  });

  it('round trips key label visibility, defaulting to shown', () => {
    const storage = fakeStorage();
    expect(loadKeyLabelsVisible(storage)).toBe(true);

    saveKeyLabelsVisible(false, storage);
    expect(storage.values.get(KEY_LABELS_STORAGE_KEY)).toBe('0');
    expect(loadKeyLabelsVisible(storage)).toBe(false);

    saveKeyLabelsVisible(true, storage);
    expect(loadKeyLabelsVisible(storage)).toBe(true);
  });

  it('falls back to defaults when storage is unavailable', () => {
    expect(loadVolumePercent(unavailableStorage)).toBe(DEFAULT_VOLUME_PERCENT);
    expect(loadKeyLabelsVisible(unavailableStorage)).toBe(true);
    expect(saveVolumePercent(40, unavailableStorage)).toBe(40);
    expect(saveKeyLabelsVisible(false, unavailableStorage)).toBe(false);
  });
});
