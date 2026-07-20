/**
 * Goodiano Audio Engine
 * Native Web Audio decoding + polyphonic playback from one AAC audio sprite.
 */

const DEFAULT_VELOCITY = 100;
// Keep headroom for velocity differences. The source samples reach full scale.
const MASTER_GAIN = 1;
const RELEASE_SECONDS = 0.2;
const AUDIO_FETCH_TIMEOUT_MS = 30_000;
const DOWNLOAD_PROGRESS_SHARE = 0.9;

type AudioEngineState = 'loading' | 'awaitingGesture' | 'ready' | 'error';
type LoadProgressCallback = (progress: number) => void;
interface SampleZone {
  loKey: number;
  hiKey: number;
  rootKey: number;
  offsetSeconds: number;
  durationSeconds: number;
}
interface NoteRequest { keyId: string; midiNote: number; velocity: number }
interface ActiveNote { source: AudioBufferSourceNode; gain: GainNode; midiNote: number }
interface WebKitAudioWindow extends Window { webkitAudioContext?: typeof AudioContext }
interface ExperimentalAudioSession { type: 'playback' }
interface NavigatorWithAudioSession extends Navigator { audioSession?: ExperimentalAudioSession }

function configurePlaybackAudioSession(): void {
  try {
    if (typeof navigator === 'undefined') return;
    const audioSession = (navigator as NavigatorWithAudioSession).audioSession;
    if (audioSession) audioSession.type = 'playback';
  } catch (_) {
    // The experimental API may reject assignment. Web Audio
    // should continue to initialize with the browser's default session type.
  }
}

class PianoAudioEngine {
  ctx: AudioContext | null = null;
  masterGain: GainNode | null = null;
  sampleBuffer: AudioBuffer | null = null;
  zones: readonly SampleZone[] = [];
  /** Voices still sounding, including notes in their release envelope. */
  voices = new Set<ActiveNote>();
  activeNotes = new Map<string, ActiveNote>();
  queuedNotes = new Map<string, NoteRequest>();
  heldNotes = new Map<string, NoteRequest>();
  loaded = false;
  loading = false;
  state: AudioEngineState = 'loading';

  /** Initialize AudioContext (must be resumed from a user gesture on iOS). */
  async init(): Promise<AudioContext> {
    if (this.ctx) return this.ctx;
    const AudioContextClass = window.AudioContext || (window as WebKitAudioWindow).webkitAudioContext;
    if (!AudioContextClass) {
      this.state = 'error';
      throw new Error('Web Audio is unavailable in this browser');
    }
    configurePlaybackAudioSession();
    this.ctx = new AudioContextClass();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = MASTER_GAIN;
    this.masterGain.connect(this.ctx.destination);
    this.ctx.onstatechange = () => this._handleStateChange();
    this.state = this.ctx.state === 'running' && this.loaded ? 'ready' :
      this.ctx.state === 'running' ? 'loading' : 'awaitingGesture';
    return this.ctx;
  }

  /**
   * Handle context state changes. When the context reaches 'running',
   * flush any queued notes. When it leaves 'running' (suspended or
   * interrupted), mark the engine as awaiting a gesture.
   */
  private _handleStateChange(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state === 'running') {
      this.state = this.loaded ? 'ready' : 'loading';
      this._flushQueuedNotes();
    } else if (ctx.state === 'suspended' || (ctx.state as string) === 'interrupted') {
      this.state = 'awaitingGesture';
    }
  }

  /**
   * Resume the AudioContext. Must be called synchronously from a user
   * gesture handler — iOS Safari ignores resume() calls that cross a
   * microtask/task boundary (e.g. after await).
   */
  ensureRunning(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'closed') return;
    if (ctx.state === 'running') {
      this.state = this.loaded ? 'ready' : 'loading';
      return;
    }
    configurePlaybackAudioSession();
    // Call resume() synchronously to stay within the gesture context.
    // Do NOT cache the promise — if resume is ignored by iOS (no gesture),
    // the promise never resolves and would block all future attempts.
    ctx.resume().then(() => {
      if (ctx.state === 'running') {
        this.state = this.loaded ? 'ready' : 'loading';
        // Safari can suspend a context while fingers are still down.
        // Rebuild those voices from the held-key snapshot after resuming.
        for (const active of [...this.voices]) this._stopVoice(active);
        for (const note of this.heldNotes.values()) this.queuedNotes.set(note.keyId, note);
        this._flushQueuedNotes();
      } else {
        this.state = 'awaitingGesture';
      }
    }).catch(() => {
      this.state = 'awaitingGesture';
    });
  }

  /** Download and natively decode the shared audio sprite. */
  async loadSampleLibrary(
    url: string,
    zones: readonly SampleZone[],
    onProgress?: LoadProgressCallback,
  ): Promise<void> {
    if (this.loaded || this.loading) return;
    this.loading = true;
    try {
      const ctx = await this.init();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), AUDIO_FETCH_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(new URL(url, document.baseURI), { signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) throw new Error(`Audio request failed (${response.status})`);

      const contentLength = Number(response.headers?.get('content-length')) || 0;
      let encodedAudio: ArrayBuffer;
      if (response.body && typeof response.body.getReader === 'function') {
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          chunks.push(value);
          received += value.byteLength;
          if (contentLength && received < contentLength) {
            onProgress?.(Math.min(received / contentLength, 1) * DOWNLOAD_PROGRESS_SHARE);
          }
        }
        const bytes = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        encodedAudio = bytes.buffer;
      } else {
        encodedAudio = await response.arrayBuffer();
      }
      if (encodedAudio.byteLength === 0) throw new Error('Audio response is empty');
      onProgress?.(DOWNLOAD_PROGRESS_SHARE);

      const decoded = await ctx.decodeAudioData(encodedAudio);
      if (decoded.length === 0 || decoded.numberOfChannels === 0) {
        throw new Error('Decoded audio is empty');
      }
      this.sampleBuffer = decoded;
      this.zones = zones;
      this.loaded = true;
      this.state = ctx.state === 'running' ? 'ready' : 'awaitingGesture';
      onProgress?.(1);
      this._flushQueuedNotes();
    } catch (error) {
      this.sampleBuffer = null;
      this.zones = [];
      this.state = 'error';
      throw error;
    } finally {
      this.loading = false;
    }
  }

  /** Find the first matching zone, preserving the source SoundFont ordering. */
  _findZone(midiNote: number): SampleZone | undefined {
    for (const zone of this.zones) {
      if (midiNote >= zone.loKey && midiNote <= zone.hiKey) return zone;
    }
    let nearest = this.zones[0];
    let minDistance = Infinity;
    for (const zone of this.zones) {
      const distance = Math.min(
        Math.abs(midiNote - zone.loKey),
        Math.abs(midiNote - zone.hiKey),
      );
      if (distance < minDistance) {
        minDistance = distance;
        nearest = zone;
      }
    }
    return nearest;
  }

  noteOn(keyId: string, midiNote: number, velocity = DEFAULT_VELOCITY): void {
    const note = { keyId, midiNote, velocity };
    this.heldNotes.set(keyId, note);
    this.queuedNotes.set(keyId, note);
    if (!this.ctx || !this.sampleBuffer || this.ctx.state !== 'running') return;
    this._startNote(note);
  }

  _startNote({ keyId, midiNote, velocity = DEFAULT_VELOCITY }: NoteRequest): void {
    if (!this.ctx || !this.sampleBuffer) return;
    const clampedNote = Math.max(0, Math.min(127, midiNote));
    const zone = this._findZone(clampedNote);
    if (!zone) return;

    const source = this.ctx.createBufferSource();
    source.buffer = this.sampleBuffer;
    source.playbackRate.value = Math.pow(2, (clampedNote - zone.rootKey) / 12);

    const gainNode = this.ctx.createGain();
    gainNode.gain.value = Math.max(0, Math.min(127, velocity)) / 127;
    if (!this.masterGain) return;
    gainNode.connect(this.masterGain);
    source.connect(gainNode);
    source.start(0, zone.offsetSeconds, zone.durationSeconds);

    const active = { source, gain: gainNode, midiNote: clampedNote };
    // A fresh press replaces the held voice, but lets an earlier release of
    // the same pitch finish its short release envelope.
    this.activeNotes.set(keyId, active);
    this.voices.add(active);
    source.onended = () => this._finishVoice(keyId, active);
    this.queuedNotes.delete(keyId);
  }

  _flushQueuedNotes(): void {
    if (!this.ctx || this.ctx.state !== 'running' || !this.sampleBuffer) return;
    for (const note of this.queuedNotes.values()) this._startNote(note);
  }

  noteOff(keyId: string): void {
    this.heldNotes.delete(keyId);
    this.queuedNotes.delete(keyId);
    const note = this.activeNotes.get(keyId);
    this.activeNotes.delete(keyId);
    if (!note || !this.ctx) return;

    const now = this.ctx.currentTime;
    const releaseEnd = now + RELEASE_SECONDS;
    note.gain.gain.cancelScheduledValues(now);
    note.gain.gain.setValueAtTime(note.gain.gain.value, now);
    note.gain.gain.linearRampToValueAtTime(0, releaseEnd);
    try {
      note.source.stop(releaseEnd);
    } catch (_) {
      // The source may already have reached its natural end.
    }
  }

  _finishVoice(keyId: string, note: ActiveNote): void {
    if (!this.voices.delete(note)) return;
    if (this.activeNotes.get(keyId) === note) this.activeNotes.delete(keyId);
    note.source.disconnect();
    note.gain.disconnect();
  }

  _stopVoice(note: ActiveNote): void {
    try {
      note.source.stop(0);
    } catch (_) {
      // Already stopped.
    }
    this.voices.delete(note);
    note.source.disconnect();
    note.gain.disconnect();
  }

  allNotesOff(): void {
    this.heldNotes.clear();
    this.queuedNotes.clear();
    for (const note of [...this.voices]) this._stopVoice(note);
    this.activeNotes.clear();
  }

  isReady(): boolean {
    return this.state === 'ready' && this.loaded && this.ctx !== null && this.ctx.state !== 'closed';
  }
}

export { DEFAULT_VELOCITY, PianoAudioEngine };
export type { AudioEngineState, LoadProgressCallback, SampleZone };
