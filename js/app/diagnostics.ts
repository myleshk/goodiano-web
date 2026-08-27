/**
 * Goodiano diagnostics log
 *
 * A ring buffer of lifecycle events that the settings panel can export as a
 * text file. It exists for one failure in particular: audio that stays silent
 * after the phone returns from the lock screen or the app switcher. That path
 * cannot be reproduced on a desktop and leaves nothing behind in a console
 * nobody can open on a phone, so the app keeps its own record of what the page
 * and the audio engine did, and hands it over as a file that can be sent on.
 *
 * The log is persisted, because iOS sometimes reloads the page on the way back
 * to the foreground: the events that explain a silent app can belong to the
 * session before the one the player is looking at.
 */

import { commit, version } from 'virtual:goodiano-assets';

export type DiagnosticCategory = 'app' | 'page' | 'audio' | 'error';
export type DiagnosticData = Readonly<Record<string, unknown>>;

export interface DiagnosticEntry {
  /** Wall clock, epoch milliseconds. */
  time: number;
  /** Milliseconds since the session started; unaffected by a clock change. */
  uptimeMs: number;
  category: DiagnosticCategory;
  message: string;
  data?: DiagnosticData;
  /** Identical consecutive events folded into this one, newest details kept. */
  repeats?: number;
  lastTime?: number;
  lastUptimeMs?: number;
  lastData?: DiagnosticData;
}

export interface DiagnosticSession {
  id: string;
  startedAt: number;
  entries: DiagnosticEntry[];
}

export type DiagnosticsStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface DiagnosticsOptions {
  storage?: DiagnosticsStorage | null;
  maxEntries?: number;
  /** Wall clock in epoch milliseconds. */
  now?: () => number;
  /** Monotonic milliseconds, used for elapsed times. */
  uptime?: () => number;
}

export const DIAGNOSTICS_STORAGE_KEY = 'goodiano.diagnostics.v1';

/** Roughly an hour of ordinary use, and a few minutes of a stuck app. */
const MAX_ENTRIES = 500;
/** The running session plus the one before it, which a reload would hide. */
const MAX_SESSIONS = 2;
/** Well inside every browser's storage quota, even beside the other keys. */
const MAX_STORED_CHARS = 192_000;
const TRIM_BATCH = 25;
/** Long enough to fold a burst of events into one write. */
const FLUSH_DELAY_MS = 2_000;
const STORED_FORMAT = 1;

function defaultNow(): number {
  return Date.now();
}

function defaultUptime(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function defaultStorage(): DiagnosticsStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch (_) {
    // Storage access throws outright in some private/restricted contexts.
    return null;
  }
}

/**
 * How this page was reached. A session that begins with a reload is iOS having
 * discarded the app while it was backgrounded, which otherwise looks exactly
 * like the player opening Goodiano for the first time.
 */
export function navigationType(): string | undefined {
  try {
    const entries = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
    return entries.length > 0 ? entries[0].type : undefined;
  } catch (_) {
    return undefined;
  }
}

/** Reduce an unknown throwable to something worth reading in a log. */
export function describeError(error: unknown): DiagnosticData {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { message: String(error) };
}

function isEntry(value: unknown): value is DiagnosticEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<DiagnosticEntry>;
  return typeof entry.time === 'number'
    && typeof entry.uptimeMs === 'number'
    && typeof entry.category === 'string'
    && typeof entry.message === 'string';
}

function isSession(value: unknown): value is DiagnosticSession {
  if (typeof value !== 'object' || value === null) return false;
  const session = value as Partial<DiagnosticSession>;
  return typeof session.id === 'string'
    && typeof session.startedAt === 'number'
    && Array.isArray(session.entries);
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, milliseconds) / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds - minutes * 60).toFixed(3).padStart(6, '0');
  return `${String(minutes).padStart(2, '0')}:${seconds}`;
}

function formatTime(time: number): string {
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? String(time) : date.toISOString();
}

function formatData(data: DiagnosticData | undefined): string {
  if (!data) return '';
  try {
    return JSON.stringify(data);
  } catch (_) {
    // A value that cannot be serialized must not cost us the whole report.
    return '{unserializable}';
  }
}

function formatScalar(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch (_) {
    return String(value);
  }
}

function formatFields(fields: Readonly<Record<string, unknown>>): string[] {
  const names = Object.keys(fields).filter(name => fields[name] !== undefined);
  const width = names.reduce((longest, name) => Math.max(longest, name.length), 0);
  return names.map(name => `  ${name.padEnd(width)}  ${formatScalar(fields[name])}`);
}

function formatEntry(entry: DiagnosticEntry): string {
  const head = `${formatTime(entry.time)}  +${formatDuration(entry.uptimeMs)}  ${entry.category.padEnd(5)}  ${entry.message}`;
  const data = formatData(entry.data);
  const repeated = entry.repeats
    ? ` ×${entry.repeats + 1} (last +${formatDuration(entry.lastUptimeMs ?? entry.uptimeMs)}${entry.lastData ? ' ' + formatData(entry.lastData) : ''})`
    : '';
  return `${head}${data ? '  ' + data : ''}${repeated}`;
}

/**
 * Everything about the device and the page that shapes how audio behaves and
 * cannot be inferred from the events themselves. Every lookup is guarded: the
 * report has to be produced from whatever the environment does expose.
 */
function describeEnvironment(): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    build: commit ? `${version} (${commit})` : version,
  };
  try {
    fields.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    fields.utcOffsetMinutes = -new Date().getTimezoneOffset();
  } catch (_) { /* Intl can be absent from a minimal runtime. */ }
  if (typeof location !== 'undefined') fields.url = location.href;
  if (typeof navigator !== 'undefined') {
    fields.userAgent = navigator.userAgent;
    fields.languages = navigator.languages?.length ? navigator.languages.join(', ') : navigator.language;
    fields.online = navigator.onLine;
    const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone;
    if (iosStandalone !== undefined) fields.iosStandalone = iosStandalone;
    const controller = navigator.serviceWorker?.controller;
    fields.serviceWorker = navigator.serviceWorker
      ? (controller ? `controlled (${controller.state})` : 'uncontrolled')
      : 'unsupported';
  }
  if (typeof window !== 'undefined') {
    try {
      fields.displayMode = window.matchMedia('(display-mode: standalone)').matches ? 'standalone' : 'browser';
    } catch (_) { /* matchMedia is stubbed away in some test shells. */ }
    fields.viewport = `${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio ?? 1}`;
    if (typeof screen !== 'undefined') fields.screen = `${screen.width}×${screen.height}`;
  }
  return fields;
}

/**
 * The log itself. One instance per page, exported below as `diagnostics`;
 * the class is exported so tests can drive one with their own clock and
 * storage instead of the page's.
 */
export class DiagnosticsLog {
  readonly id: string;
  readonly startedAt: number;
  private readonly _maxEntries: number;
  private readonly _now: () => number;
  private readonly _uptime: () => number;
  private readonly _storage: DiagnosticsStorage | null;
  private readonly _startedUptime: number;
  private _entries: DiagnosticEntry[] = [];
  private _previous: DiagnosticSession[] = [];
  private _restored = false;
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set once a write is refused, so the report can say the log is volatile. */
  private _storageFailed = false;

  constructor(options: DiagnosticsOptions = {}) {
    this._maxEntries = options.maxEntries ?? MAX_ENTRIES;
    this._now = options.now ?? defaultNow;
    this._uptime = options.uptime ?? defaultUptime;
    this._storage = options.storage === undefined ? defaultStorage() : options.storage;
    this.startedAt = this._now();
    this._startedUptime = this._uptime();
    this.id = `${this.startedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Append an event. Consecutive events with the same category and message are
   * folded into one entry that counts them and keeps the newest details, so a
   * player hammering keys at a silent app cannot push the history that explains
   * the silence out of the buffer.
   */
  record(category: DiagnosticCategory, message: string, data?: DiagnosticData): void {
    this._ensureRestored();
    const time = this._now();
    const uptimeMs = Math.round(this._uptime() - this._startedUptime);
    const previous = this._entries.length > 0 ? this._entries[this._entries.length - 1] : undefined;
    if (previous && previous.category === category && previous.message === message) {
      previous.repeats = (previous.repeats ?? 0) + 1;
      previous.lastTime = time;
      previous.lastUptimeMs = uptimeMs;
      if (data) previous.lastData = data;
    } else {
      this._entries.push(data ? { time, uptimeMs, category, message, data } : { time, uptimeMs, category, message });
      if (this._entries.length > this._maxEntries) {
        this._entries.splice(0, this._entries.length - this._maxEntries);
      }
    }
    this._scheduleFlush();
  }

  /** Events recorded in this session, oldest first. */
  entries(): readonly DiagnosticEntry[] {
    return this._entries;
  }

  /** Sessions that ended before this one, oldest first. */
  previousSessions(): readonly DiagnosticSession[] {
    this._ensureRestored();
    return this._previous;
  }

  /** Write the log out now, rather than on the pending debounce. */
  flush(): void {
    this._cancelFlush();
    const storage = this._storage;
    if (!storage) return;
    // Read before writing: a session that flushes before it has recorded
    // anything would otherwise overwrite the session it never loaded.
    this._ensureRestored();
    const payload = this._serialize();
    try {
      if (payload === null) storage.removeItem(DIAGNOSTICS_STORAGE_KEY);
      else storage.setItem(DIAGNOSTICS_STORAGE_KEY, payload);
      this._storageFailed = false;
    } catch (_) {
      // A full or disabled store costs the history across a reload, not the
      // running log, so keep recording and say so in the report.
      this._storageFailed = true;
    }
  }

  /**
   * Render the whole log as the text the export button writes to a file:
   * an environment header, whatever live state the caller passes in, then
   * every event of the earlier session and this one.
   */
  buildReport(details: Readonly<Record<string, unknown>> = {}): string {
    this._ensureRestored();
    const now = this._now();
    const lines: string[] = ['Goodiano diagnostics log', ''];
    lines.push('Environment');
    lines.push(...formatFields({
      generated: formatTime(now),
      sessionStarted: formatTime(this.startedAt),
      sessionUptime: formatDuration(this._uptime() - this._startedUptime),
      ...describeEnvironment(),
      persisted: this._storage ? (this._storageFailed ? 'failed (storage refused writes)' : 'yes') : 'no (storage unavailable)',
    }));
    if (Object.keys(details).length > 0) {
      lines.push('', 'State at export');
      lines.push(...formatFields(details));
    }
    for (const session of this._previous) {
      lines.push('', `Session ${session.id} — started ${formatTime(session.startedAt)} (before this one)`);
      lines.push(...this._renderEntries(session.entries));
    }
    lines.push('', `Session ${this.id} — started ${formatTime(this.startedAt)} (current)`);
    lines.push(...this._renderEntries(this._entries));
    lines.push('');
    return lines.join('\n');
  }

  private _renderEntries(entries: readonly DiagnosticEntry[]): string[] {
    if (entries.length === 0) return ['  (no events)'];
    return entries.map(entry => '  ' + formatEntry(entry));
  }

  /** Load the stored sessions once, on the first use of the log. */
  private _ensureRestored(): void {
    if (this._restored) return;
    this._restored = true;
    const storage = this._storage;
    if (!storage) return;
    try {
      const raw = storage.getItem(DIAGNOSTICS_STORAGE_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      const sessions = (parsed as { sessions?: unknown })?.sessions;
      if (!Array.isArray(sessions)) return;
      this._previous = sessions
        .filter(isSession)
        .slice(-(MAX_SESSIONS - 1))
        .map(session => ({
          id: session.id,
          startedAt: session.startedAt,
          entries: session.entries.filter(isEntry),
        }));
    } catch (_) {
      // Anything unreadable is someone else's data or a truncated write.
      this._previous = [];
    }
  }

  private _scheduleFlush(): void {
    if (this._flushTimer !== null || !this._storage || typeof setTimeout !== 'function') return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this.flush();
    }, FLUSH_DELAY_MS);
  }

  private _cancelFlush(): void {
    if (this._flushTimer === null) return;
    clearTimeout(this._flushTimer);
    this._flushTimer = null;
  }

  /**
   * Serialize the stored sessions, dropping the oldest events until the result
   * fits the budget. Trimming the copy rather than the log keeps the events in
   * memory available to a report taken before the next reload.
   */
  private _serialize(): string | null {
    // A session that recorded nothing is not worth the one stored slot it would
    // take, and storing it would push out the session that does explain something.
    const sessions: DiagnosticSession[] = this._previous
      .filter(session => session.entries.length > 0)
      .map(session => ({
        id: session.id,
        startedAt: session.startedAt,
        entries: session.entries.slice(),
      }));
    if (this._entries.length > 0) {
      sessions.push({ id: this.id, startedAt: this.startedAt, entries: this._entries.slice() });
    }
    if (sessions.length === 0) return null;
    for (;;) {
      const payload = JSON.stringify({ v: STORED_FORMAT, sessions });
      if (payload.length <= MAX_STORED_CHARS) return payload;
      const oldest = sessions.find(session => session.entries.length > 0);
      if (!oldest) return payload;
      oldest.entries.splice(0, TRIM_BATCH);
    }
  }
}

export const diagnostics = new DiagnosticsLog();

/**
 * Record what the page never asked about: a script that threw, or a promise
 * that rejected with nobody watching. Both are ways audio can quietly stop
 * working, and neither shows up in any of the deliberate log points.
 */
export function installGlobalErrorCapture(
  target: Pick<Window, 'addEventListener'> = window,
  log: DiagnosticsLog = diagnostics,
): void {
  target.addEventListener('error', event => {
    const { message, filename, lineno, colno } = event as ErrorEvent;
    log.record('error', 'uncaught error', { message, source: filename, line: lineno, column: colno });
  });
  target.addEventListener('unhandledrejection', event => {
    log.record('error', 'unhandled rejection', describeError((event as PromiseRejectionEvent).reason));
  });
}

export type DiagnosticsExportMethod = 'share' | 'download' | 'cancelled';

/** Name a report after the moment it was taken, in the local time zone. */
export function diagnosticsFileName(time: number = Date.now()): string {
  const date = new Date(time);
  const stamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
    '-',
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
    String(date.getSeconds()).padStart(2, '0'),
  ].join('');
  return `goodiano-log-${stamp}.txt`;
}

/**
 * Hand the report to the player as a file. The share sheet is tried first
 * because it is the one route that reliably reaches a message or a mail draft
 * from an installed iOS app, where a download can land somewhere the player
 * then has to go looking for. Everywhere else, and whenever sharing is refused,
 * the file is downloaded instead.
 *
 * Resolves with the route taken, or 'cancelled' when the share sheet was
 * dismissed — a deliberate cancel must not be answered with a download.
 */
export async function exportDiagnosticsReport(
  report: string,
  fileName: string = diagnosticsFileName(),
): Promise<DiagnosticsExportMethod> {
  const blob = new Blob([report], { type: 'text/plain' });
  if (typeof File === 'function'
    && typeof navigator.share === 'function'
    && typeof navigator.canShare === 'function') {
    const file = new File([blob], fileName, { type: 'text/plain' });
    let shareable = false;
    try {
      shareable = navigator.canShare({ files: [file] });
    } catch (_) {
      // Some implementations throw instead of returning false.
    }
    if (shareable) {
      try {
        await navigator.share({ files: [file], title: fileName });
        return 'share';
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
        // Anything else — no target app, a policy refusal — falls through to
        // the download, which needs no cooperation from another app.
      }
    }
  }
  downloadBlob(blob, fileName);
  return 'download';
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  // Safari only follows a click on a link that is in the document.
  document.body.append(link);
  link.click();
  link.remove();
  // Revoking too early cancels a download Safari has not started writing yet.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
