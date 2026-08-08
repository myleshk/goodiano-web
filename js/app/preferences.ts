/**
 * Small persisted output preferences. Keys are versioned like the velocity
 * settings so a future format change can be introduced without reading back
 * values it cannot interpret.
 */

const VOLUME_STORAGE_KEY = 'goodiano.volume.v1';
const KEY_LABELS_STORAGE_KEY = 'goodiano.key-labels.v1';

const DEFAULT_VOLUME_PERCENT = 100;
const DEFAULT_KEY_LABELS_VISIBLE = true;

function normalizeVolumePercent(value: unknown, fallback = DEFAULT_VOLUME_PERCENT): number {
  if (typeof value === 'string' && value.trim() === '') return fallback;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function loadVolumePercent(storage: Pick<Storage, 'getItem'> = localStorage): number {
  try {
    const stored = storage.getItem(VOLUME_STORAGE_KEY);
    return stored === null ? DEFAULT_VOLUME_PERCENT : normalizeVolumePercent(stored);
  } catch (_) {
    return DEFAULT_VOLUME_PERCENT;
  }
}

function saveVolumePercent(value: number, storage: Pick<Storage, 'setItem'> = localStorage): number {
  const normalized = normalizeVolumePercent(value);
  try { storage.setItem(VOLUME_STORAGE_KEY, String(normalized)); } catch (_) { /* unavailable storage */ }
  return normalized;
}

function loadKeyLabelsVisible(storage: Pick<Storage, 'getItem'> = localStorage): boolean {
  try {
    const stored = storage.getItem(KEY_LABELS_STORAGE_KEY);
    if (stored === null) return DEFAULT_KEY_LABELS_VISIBLE;
    return stored !== '0';
  } catch (_) {
    return DEFAULT_KEY_LABELS_VISIBLE;
  }
}

function saveKeyLabelsVisible(visible: boolean, storage: Pick<Storage, 'setItem'> = localStorage): boolean {
  try { storage.setItem(KEY_LABELS_STORAGE_KEY, visible ? '1' : '0'); } catch (_) { /* unavailable storage */ }
  return visible;
}

export {
  DEFAULT_KEY_LABELS_VISIBLE,
  DEFAULT_VOLUME_PERCENT,
  KEY_LABELS_STORAGE_KEY,
  VOLUME_STORAGE_KEY,
  loadKeyLabelsVisible,
  loadVolumePercent,
  normalizeVolumePercent,
  saveKeyLabelsVisible,
  saveVolumePercent,
};
