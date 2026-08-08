/**
 * Goodiano Audio Engine
 * Native Web Audio decoding + polyphonic playback from one AAC audio sprite.
 */

const DEFAULT_VELOCITY = 100;
// The source samples reach full scale, so a chord sums well past 1.0. Leave
// headroom here and catch the remaining peaks with the limiter below. The
// velocity curve already lowers typical output, which pays for part of it.
const MASTER_GAIN = 0.9;
// Amplitude is roughly the square of velocity: equal steps of velocity then
// sound like equal steps of loudness, instead of crowding everything loud.
const VELOCITY_CURVE_EXPONENT = 2;
// A struck string is darker when played softly. Approximating that with a
// lowpass costs one filter per note and does far more for realism than gain
// alone. The curve is anchored so the default velocity is fully open: players
// without pressure or motion sensing hear exactly the timbre they heard before.
const TONE_MIN_HZ = 2000;
const TONE_MAX_HZ = 18000;
const RELEASE_SECONDS = 0.2;
// A stolen voice is cut short mid-sustain; fade it rather than click.
const STEAL_FADE_SECONDS = 0.06;
// Ten fingers plus sustained releases stay well inside this. The cap exists to
// bound pathological input such as a fast glissando.
const MAX_POLYPHONY = 32;
// A high ratio with a low knee turns the compressor into a peak limiter: notes
// below the threshold pass untouched, and stacked voices are held just short of
// clipping instead of being distorted by the output stage.
const LIMITER_THRESHOLD_DB = -6;
const LIMITER_KNEE_DB = 0;
const LIMITER_RATIO = 20;
const LIMITER_ATTACK_SECONDS = 0.003;
const LIMITER_RELEASE_SECONDS = 0.25;
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
interface Voice { source: AudioBufferSourceNode; gain: GainNode }
interface ActiveNote {
  voices: Voice[];
  midiNote: number;
  /** Shared tone filter the note's voices feed, when the node is available. */
  filter: BiquadFilterNode | null;
  /** Fading out under its own release envelope. Preferred when stealing. */
  releasing: boolean;
  /** Released by the player but held sounding by the pedal. */
  sustained: boolean;
  /** Already chosen as a steal victim; never counted or chosen twice. */
  stolen: boolean;
}
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
  limiter: DynamicsCompressorNode | null = null;
  sampleBuffer: AudioBuffer | null = null;
  zones: readonly SampleZone[] = [];
  /** Voices still sounding, including notes in their release envelope. */
  voices = new Set<ActiveNote>();
  activeNotes = new Map<string, ActiveNote>();
  queuedNotes = new Map<string, NoteRequest>();
  heldNotes = new Map<string, NoteRequest>();
  /** Notes the player has let go of that the pedal is holding open. */
  sustainedNotes = new Map<string, ActiveNote>();
  sustainEnabled = false;
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
    this.limiter = this._createLimiter(this.ctx);
    if (this.limiter) {
      this.masterGain.connect(this.limiter);
      this.limiter.connect(this.ctx.destination);
    } else {
      this.masterGain.connect(this.ctx.destination);
    }
    this.ctx.onstatechange = () => this._handleStateChange();
    this.state = this.ctx.state === 'running' && this.loaded ? 'ready' :
      this.ctx.state === 'running' ? 'loading' : 'awaitingGesture';
    return this.ctx;
  }

  /** Build the output limiter, or null where the node is unavailable. */
  private _createLimiter(ctx: AudioContext): DynamicsCompressorNode | null {
    if (typeof ctx.createDynamicsCompressor !== 'function') return null;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = LIMITER_THRESHOLD_DB;
    limiter.knee.value = LIMITER_KNEE_DB;
    limiter.ratio.value = LIMITER_RATIO;
    limiter.attack.value = LIMITER_ATTACK_SECONDS;
    limiter.release.value = LIMITER_RELEASE_SECONDS;
    return limiter;
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
        // oxlint-disable-next-line no-useless-spread -- _stopVoice deletes from this.voices while iterating.
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
        // credentials must match the markup preload's crossorigin="anonymous",
        // or this becomes a second download rather than a cache hit.
        response = await fetch(new URL(url, document.baseURI), {
          signal: controller.signal,
          credentials: 'omit',
        });
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

  /**
   * Select the sample(s) to blend for a note. Returns the two bracketing
   * rootKey zones crossfaded by the note's fractional position between them,
   * so timbre transitions smoothly across semitones instead of jumping
   * between recordings. At an exact rootKey or outside the rootKey range,
   * returns a single zone at weight 1.
   */
  _findZoneMix(midiNote: number): Array<{ zone: SampleZone; weight: number }> {
    let below: SampleZone | undefined;
    let above: SampleZone | undefined;
    for (const zone of this.zones) {
      if (zone.rootKey <= midiNote && (!below || zone.rootKey > below.rootKey)) below = zone;
      if (zone.rootKey >= midiNote && (!above || zone.rootKey < above.rootKey)) above = zone;
    }
    if (below && above && below.rootKey !== above.rootKey) {
      const t = (midiNote - below.rootKey) / (above.rootKey - below.rootKey);
      return [{ zone: below, weight: 1 - t }, { zone: above, weight: t }];
    }
    const single = below ?? above;
    return single ? [{ zone: single, weight: 1 }] : [];
  }

  /** Map MIDI velocity onto amplitude along a perceptual curve. */
  private _velocityGain(velocity: number): number {
    const normalized = Math.max(0, Math.min(127, velocity)) / 127;
    return normalized ** VELOCITY_CURVE_EXPONENT;
  }

  /**
   * Build the note's lowpass. Openness is measured against the default
   * velocity, so anything at or above it passes the full spectrum and only
   * softer notes are darkened. Returns null where the node is unavailable.
   */
  private _createToneFilter(velocity: number): BiquadFilterNode | null {
    const ctx = this.ctx;
    if (!ctx || typeof ctx.createBiquadFilter !== 'function') return null;
    const openness = Math.max(0, Math.min(1, velocity / DEFAULT_VELOCITY));
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    // Interpolate in the log domain: pitch and brightness are heard that way.
    filter.frequency.value = TONE_MIN_HZ * (TONE_MAX_HZ / TONE_MIN_HZ) ** openness;
    return filter;
  }

  noteOn(keyId: string, midiNote: number, velocity = DEFAULT_VELOCITY): void {
    const note = { keyId, midiNote, velocity };
    this.heldNotes.set(keyId, note);
    this.queuedNotes.set(keyId, note);
    if (!this.ctx || !this.sampleBuffer || this.ctx.state !== 'running') return;
    this._startNote(note);
  }

  _startNote({ keyId, midiNote, velocity = DEFAULT_VELOCITY }: NoteRequest): void {
    if (!this.ctx || !this.sampleBuffer || !this.masterGain) return;
    const clampedNote = Math.max(0, Math.min(127, midiNote));
    const mix = this._findZoneMix(clampedNote);
    if (mix.length === 0) return;
    this._stealVoicesForNewNote();

    const velocityGain = this._velocityGain(velocity);
    const filter = this._createToneFilter(velocity);
    if (filter) filter.connect(this.masterGain);
    const voiceDestination: AudioNode = filter ?? this.masterGain;
    const voices: Voice[] = [];
    for (const { zone, weight } of mix) {
      const source = this.ctx.createBufferSource();
      source.buffer = this.sampleBuffer;
      source.playbackRate.value = Math.pow(2, (clampedNote - zone.rootKey) / 12);

      const gainNode = this.ctx.createGain();
      gainNode.gain.value = velocityGain * weight;
      gainNode.connect(voiceDestination);
      source.connect(gainNode);
      source.start(0, zone.offsetSeconds, zone.durationSeconds);
      voices.push({ source, gain: gainNode });
    }

    const active: ActiveNote = {
      voices,
      midiNote: clampedNote,
      filter,
      releasing: false,
      sustained: false,
      stolen: false,
    };
    // A fresh press replaces the held voice, but lets an earlier release of
    // the same pitch finish its short release envelope.
    this.activeNotes.set(keyId, active);
    this.voices.add(active);
    for (const voice of voices) {
      voice.source.onended = () => this._finishVoice(keyId, active, voice);
    }
    this.queuedNotes.delete(keyId);
  }

  _flushQueuedNotes(): void {
    if (!this.ctx || this.ctx.state !== 'running' || !this.sampleBuffer) return;
    for (const note of this.queuedNotes.values()) this._startNote(note);
  }

  /**
   * Keep the sounding voice count under the cap before adding another note.
   * Voices already in their release envelope go first, oldest before newest,
   * so a held chord survives a fast run over it.
   */
  private _stealVoicesForNewNote(): void {
    let sounding = 0;
    for (const note of this.voices) if (!note.stolen) sounding += 1;

    while (sounding >= MAX_POLYPHONY) {
      const victim = this._nextStealVictim();
      if (!victim) return;
      victim.stolen = true;
      for (const [keyId, note] of this.activeNotes) {
        if (note === victim) this.activeNotes.delete(keyId);
      }
      for (const [keyId, note] of this.sustainedNotes) {
        if (note === victim) this.sustainedNotes.delete(keyId);
      }
      this._fadeOut(victim, STEAL_FADE_SECONDS);
      sounding -= 1;
    }
  }

  /**
   * Pick the least missed voice: one already fading, then one the pedal alone
   * is holding, then the oldest still under a finger.
   */
  private _nextStealVictim(): ActiveNote | null {
    let oldestSustained: ActiveNote | null = null;
    let oldestHeld: ActiveNote | null = null;
    // Set iteration follows insertion order, so the first match is the oldest.
    for (const note of this.voices) {
      if (note.stolen) continue;
      if (note.releasing) return note;
      if (note.sustained) oldestSustained ??= note;
      else oldestHeld ??= note;
    }
    return oldestSustained ?? oldestHeld;
  }

  /** Ramp a note to silence and stop its sources at the end of the ramp. */
  private _fadeOut(note: ActiveNote, seconds: number): void {
    if (!this.ctx) return;
    note.releasing = true;
    const now = this.ctx.currentTime;
    const end = now + seconds;
    for (const voice of note.voices) {
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
      voice.gain.gain.linearRampToValueAtTime(0, end);
      try {
        voice.source.stop(end);
      } catch (_) {
        // The source may already have reached its natural end.
      }
    }
  }

  noteOff(keyId: string): void {
    this.heldNotes.delete(keyId);
    this.queuedNotes.delete(keyId);
    const note = this.activeNotes.get(keyId);
    this.activeNotes.delete(keyId);
    if (!note || !this.ctx) return;
    if (this.sustainEnabled) {
      // The damper stays off the string: keep it sounding until the pedal
      // lifts. A key struck twice under the pedal retires its earlier voice
      // so one key cannot accumulate them without bound.
      const previous = this.sustainedNotes.get(keyId);
      if (previous && previous !== note) this._fadeOut(previous, RELEASE_SECONDS);
      note.sustained = true;
      this.sustainedNotes.set(keyId, note);
      return;
    }
    this._fadeOut(note, RELEASE_SECONDS);
  }

  /**
   * Raise or lower the sustain pedal. Lowering it only changes what happens to
   * later releases; raising it releases everything the pedal was holding, while
   * keys still physically down keep sounding.
   */
  setSustain(enabled: boolean): void {
    if (enabled === this.sustainEnabled) return;
    this.sustainEnabled = enabled;
    if (enabled) return;
    for (const note of this.sustainedNotes.values()) this._fadeOut(note, RELEASE_SECONDS);
    this.sustainedNotes.clear();
  }

  _finishVoice(keyId: string, note: ActiveNote, voice: Voice): void {
    const index = note.voices.indexOf(voice);
    if (index !== -1) note.voices.splice(index, 1);
    voice.source.disconnect();
    voice.gain.disconnect();
    // Only retire the note once all of its crossfaded voices have ended.
    if (note.voices.length > 0) return;
    note.filter?.disconnect();
    if (!this.voices.delete(note)) return;
    if (this.activeNotes.get(keyId) === note) this.activeNotes.delete(keyId);
    if (this.sustainedNotes.get(keyId) === note) this.sustainedNotes.delete(keyId);
  }

  _stopVoice(note: ActiveNote): void {
    for (const voice of note.voices) {
      try {
        voice.source.stop(0);
      } catch (_) {
        // Already stopped.
      }
      voice.source.disconnect();
      voice.gain.disconnect();
    }
    note.voices = [];
    note.filter?.disconnect();
    this.voices.delete(note);
  }

  allNotesOff(): void {
    this.heldNotes.clear();
    this.queuedNotes.clear();
    this.sustainedNotes.clear();
    // oxlint-disable-next-line no-useless-spread -- _stopVoice deletes from this.voices while iterating.
    for (const note of [...this.voices]) this._stopVoice(note);
    this.activeNotes.clear();
  }

  isReady(): boolean {
    return this.state === 'ready' && this.loaded && this.ctx !== null && this.ctx.state !== 'closed';
  }
}

export { DEFAULT_VELOCITY, PianoAudioEngine };
export type { AudioEngineState, LoadProgressCallback, SampleZone };
