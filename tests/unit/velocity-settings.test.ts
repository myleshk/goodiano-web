import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VELOCITY_SENSITIVITY,
  VELOCITY_SENSITIVITY_STORAGE_KEYS,
  loadSensitivity,
  normalizeSensitivity,
  saveSensitivity,
} from '../../js/app/velocity-settings';

describe('velocity sensitivity settings', () => {
  it('validates and clamps restored values', () => {
    expect(normalizeSensitivity('73.6')).toBe(74);
    expect(normalizeSensitivity('-10')).toBe(1);
    expect(normalizeSensitivity('250')).toBe(100);
    expect(normalizeSensitivity('')).toBe(DEFAULT_VELOCITY_SENSITIVITY);
    expect(normalizeSensitivity('invalid')).toBe(DEFAULT_VELOCITY_SENSITIVITY);
  });

  it('uses separate versioned storage keys for motion and pressure', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };

    saveSensitivity('motion', 22, storage);
    saveSensitivity('pressure', 88, storage);
    expect(loadSensitivity('motion', storage)).toBe(22);
    expect(loadSensitivity('pressure', storage)).toBe(88);
    expect(VELOCITY_SENSITIVITY_STORAGE_KEYS.motion).not.toBe(VELOCITY_SENSITIVITY_STORAGE_KEYS.pressure);
    expect(VELOCITY_SENSITIVITY_STORAGE_KEYS.motion).toContain('.v1.');
  });
});
