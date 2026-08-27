import { describe, expect, it, vi } from 'vitest';
import {
  DIAGNOSTICS_STORAGE_KEY,
  DiagnosticsLog,
  describeError,
  diagnosticsFileName,
  installGlobalErrorCapture,
} from '../../js/app/diagnostics';
import type { DiagnosticsStorage } from '../../js/app/diagnostics';

function fakeStorage(): DiagnosticsStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

/** A log on a clock the test drives, so elapsed times are assertable. */
function testLog(options: { storage?: DiagnosticsStorage | null; maxEntries?: number } = {}) {
  let clock = 1_700_000_000_000;
  const log = new DiagnosticsLog({
    storage: options.storage ?? null,
    maxEntries: options.maxEntries,
    now: () => clock,
    uptime: () => clock,
  });
  return { log, advance: (milliseconds: number) => { clock += milliseconds; } };
}

function storedSessions(storage: ReturnType<typeof fakeStorage>) {
  const raw = storage.values.get(DIAGNOSTICS_STORAGE_KEY);
  return raw ? JSON.parse(raw).sessions : [];
}

describe('diagnostics log', () => {
  it('records events with a wall clock and an elapsed time', () => {
    const { log, advance } = testLog();

    log.record('audio', 'context created', { contextState: 'suspended' });
    advance(1_500);
    log.record('page', 'visibility change', { visibility: 'hidden' });

    expect(log.entries()).toHaveLength(2);
    expect(log.entries()[0]).toMatchObject({
      category: 'audio',
      message: 'context created',
      uptimeMs: 0,
      data: { contextState: 'suspended' },
    });
    expect(log.entries()[1].uptimeMs).toBe(1_500);
  });

  it('folds consecutive repeats into one entry that keeps the newest details', () => {
    const { log, advance } = testLog();

    log.record('audio', 'note queued, engine not playable', { keyId: 'C4' });
    advance(200);
    log.record('audio', 'note queued, engine not playable', { keyId: 'E4' });
    advance(300);
    log.record('audio', 'note queued, engine not playable', { keyId: 'G4' });
    log.record('page', 'visibility change');

    expect(log.entries()).toHaveLength(2);
    expect(log.entries()[0]).toMatchObject({
      repeats: 2,
      data: { keyId: 'C4' },
      lastData: { keyId: 'G4' },
      lastUptimeMs: 500,
    });
  });

  it('keeps the newest events once the buffer is full', () => {
    const { log } = testLog({ maxEntries: 3 });

    for (let index = 0; index < 5; index += 1) log.record('app', `event ${index}`);

    expect(log.entries().map(entry => entry.message)).toEqual(['event 2', 'event 3', 'event 4']);
  });

  it('persists the session and offers it back as the previous one', () => {
    const storage = fakeStorage();
    const first = testLog({ storage }).log;
    first.record('audio', 'load failed', { message: 'offline' });
    first.flush();

    const second = testLog({ storage }).log;
    second.record('app', 'app starting');

    expect(second.previousSessions()).toHaveLength(1);
    expect(second.previousSessions()[0].entries[0]).toMatchObject({ message: 'load failed' });
    expect(second.buildReport()).toContain('load failed');
  });

  it('keeps only the session before this one', () => {
    const storage = fakeStorage();
    for (const message of ['first run', 'second run', 'third run']) {
      const log = testLog({ storage }).log;
      log.record('app', message);
      log.flush();
    }

    const sessions = storedSessions(storage);
    expect(sessions).toHaveLength(2);
    expect(sessions[0].entries[0].message).toBe('second run');
    expect(sessions[1].entries[0].message).toBe('third run');
  });

  it('does not let a session that recorded nothing evict the one that did', () => {
    const storage = fakeStorage();
    const first = testLog({ storage }).log;
    first.record('audio', 'clock frozen while the context claims to run');
    first.flush();

    // A reload that goes straight back to the background records nothing of
    // its own before it has to write.
    testLog({ storage }).log.flush();
    const third = testLog({ storage }).log;

    expect(third.previousSessions()[0].entries[0]).toMatchObject({
      message: 'clock frozen while the context claims to run',
    });
  });

  it('starts clean when the stored log is unreadable', () => {
    const storage = fakeStorage();
    storage.values.set(DIAGNOSTICS_STORAGE_KEY, '{not json');

    const log = testLog({ storage }).log;

    expect(log.previousSessions()).toEqual([]);
    expect(log.buildReport()).toContain('Goodiano diagnostics log');
  });

  it('ignores stored entries that are not shaped like entries', () => {
    const storage = fakeStorage();
    storage.values.set(DIAGNOSTICS_STORAGE_KEY, JSON.stringify({
      v: 1,
      sessions: [
        'nonsense',
        { id: 'x', startedAt: 1, entries: [{ nope: true }, { time: 2, uptimeMs: 0, category: 'app', message: 'kept' }] },
      ],
    }));

    const log = testLog({ storage }).log;

    expect(log.previousSessions()).toHaveLength(1);
    expect(log.previousSessions()[0].entries.map(entry => entry.message)).toEqual(['kept']);
  });

  it('keeps recording when storage refuses writes, and says so in the report', () => {
    const storage: DiagnosticsStorage = {
      getItem: () => null,
      setItem: () => { throw new DOMException('quota', 'QuotaExceededError'); },
      removeItem: () => {},
    };
    const { log } = testLog({ storage });

    log.record('audio', 'context created');
    log.flush();

    expect(log.entries()).toHaveLength(1);
    expect(log.buildReport()).toContain('storage refused writes');
  });

  it('drops the oldest events rather than exceeding the storage budget', () => {
    const storage = fakeStorage();
    const { log } = testLog({ storage });

    for (let index = 0; index < 400; index += 1) {
      log.record('audio', `event ${index}`, { padding: 'x'.repeat(1_000) });
    }
    log.flush();

    const [session] = storedSessions(storage);
    expect(storage.values.get(DIAGNOSTICS_STORAGE_KEY)!.length).toBeLessThanOrEqual(192_000);
    expect(session.entries.length).toBeLessThan(400);
    // Whatever has to go, the events nearest the failure are the ones kept.
    expect(session.entries[session.entries.length - 1].message).toBe('event 399');
    // Trimming the stored copy must not cost the running log its history.
    expect(log.entries()).toHaveLength(400);
  });

  it('works with no storage at all', () => {
    const { log } = testLog({ storage: null });

    log.record('app', 'app starting');

    expect(log.buildReport()).toContain('storage unavailable');
  });
});

describe('diagnostics report', () => {
  it('leads with the build, the live state, and every event', () => {
    const { log, advance } = testLog();
    log.record('audio', 'context created', { contextState: 'suspended' });
    advance(65_432);
    log.record('audio', 'gesture found a frozen clock', { currentTime: 12.5 });

    const report = log.buildReport({ engineState: 'ready', contextState: 'running' });

    expect(report).toContain('Goodiano diagnostics log');
    expect(report).toContain('build');
    expect(report).toContain('State at export');
    expect(report).toMatch(/engineState\s+ready/);
    expect(report).toContain('context created  {"contextState":"suspended"}');
    // Elapsed time is minutes and seconds, so a long silence is easy to spot.
    expect(report).toContain('+01:05.432');
    expect(report).toContain('(current)');
  });

  it('renders a repeated event once, with its count', () => {
    const { log } = testLog();
    log.record('audio', 'note started', { keyId: 'C4' });
    log.record('audio', 'note started', { keyId: 'D4' });
    log.record('audio', 'note started', { keyId: 'E4' });

    const report = log.buildReport();

    expect(report).toContain('×3');
    expect(report).toContain('{"keyId":"E4"}');
  });

  it('says so when a session recorded nothing', () => {
    expect(testLog().log.buildReport()).toContain('(no events)');
  });

  it('survives a value that cannot be serialized', () => {
    const { log } = testLog();
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    log.record('app', 'odd payload', circular);

    expect(log.buildReport()).toContain('{unserializable}');
  });
});

describe('describeError', () => {
  it('keeps the name and message of a real error', () => {
    expect(describeError(new TypeError('bad zone'))).toEqual({ name: 'TypeError', message: 'bad zone' });
  });

  it('stringifies anything else', () => {
    expect(describeError('plain reason')).toEqual({ message: 'plain reason' });
  });
});

describe('diagnosticsFileName', () => {
  it('names the file after the local time it was taken', () => {
    const name = diagnosticsFileName(new Date(2026, 7, 27, 9, 5, 3).getTime());

    expect(name).toBe('goodiano-log-20260827-090503.txt');
  });
});

describe('installGlobalErrorCapture', () => {
  it('records uncaught errors and unhandled rejections', () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const target = {
      addEventListener: (type: string, listener: (event: unknown) => void) => { listeners.set(type, listener); },
    } as unknown as Window;
    const { log } = testLog();

    installGlobalErrorCapture(target, log);
    listeners.get('error')?.({ message: 'boom', filename: 'app.js', lineno: 12, colno: 3 });
    listeners.get('unhandledrejection')?.({ reason: new Error('rejected') });

    expect(log.entries()[0]).toMatchObject({
      category: 'error',
      message: 'uncaught error',
      data: { message: 'boom', source: 'app.js', line: 12, column: 3 },
    });
    expect(log.entries()[1]).toMatchObject({ message: 'unhandled rejection', data: { message: 'rejected' } });
  });
});

describe('scheduled writes', () => {
  it('writes once for a burst of events', () => {
    vi.useFakeTimers();
    const storage = fakeStorage();
    const setItem = vi.spyOn(storage, 'setItem');
    const log = new DiagnosticsLog({ storage });

    log.record('app', 'one');
    log.record('page', 'two');
    log.record('audio', 'three');
    expect(setItem).not.toHaveBeenCalled();
    vi.runAllTimers();

    expect(setItem).toHaveBeenCalledTimes(1);
    expect(storedSessions(storage)[0].entries).toHaveLength(3);
    vi.useRealTimers();
  });
});
