import type { VelocityInputMode } from './input';

const DEFAULT_VELOCITY_SENSITIVITY = 50;
const VELOCITY_SENSITIVITY_STORAGE_KEYS: Record<VelocityInputMode, string> = {
  motion: 'goodiano.velocity-sensitivity.v1.motion',
  pressure: 'goodiano.velocity-sensitivity.v1.pressure',
};

function normalizeSensitivity(value: unknown, fallback = DEFAULT_VELOCITY_SENSITIVITY): number {
  if (typeof value === 'string' && value.trim() === '') return fallback;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1, Math.min(100, Math.round(numeric)));
}

function loadSensitivity(mode: VelocityInputMode, storage: Pick<Storage, 'getItem'> = localStorage): number {
  try {
    const stored = storage.getItem(VELOCITY_SENSITIVITY_STORAGE_KEYS[mode]);
    return stored === null ? DEFAULT_VELOCITY_SENSITIVITY : normalizeSensitivity(stored);
  } catch (_) {
    return DEFAULT_VELOCITY_SENSITIVITY;
  }
}

function saveSensitivity(mode: VelocityInputMode, value: number, storage: Pick<Storage, 'setItem'> = localStorage): number {
  const normalized = normalizeSensitivity(value);
  try { storage.setItem(VELOCITY_SENSITIVITY_STORAGE_KEYS[mode], String(normalized)); } catch (_) { /* unavailable storage */ }
  return normalized;
}

export {
  DEFAULT_VELOCITY_SENSITIVITY,
  VELOCITY_SENSITIVITY_STORAGE_KEYS,
  loadSensitivity,
  normalizeSensitivity,
  saveSensitivity,
};
