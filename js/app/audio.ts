/**
 * Goodiano Audio Engine
 * Native Web Audio decoding + polyphonic playback from one AAC audio sprite.
 */

import { describeError, diagnostics } from './diagnostics';
import type { DiagnosticData } from './diagnostics';

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
// Time constant for volume changes, short enough to feel immediate.
const VOLUME_RAMP_SECONDS = 0.015;
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
// iOS can come back from the lock screen or the app switcher with the context
// still reporting 'running' while the audio unit behind it is gone: silence,
// and no state change to react to. The one observable symptom is that the
// context clock stops advancing, so the clock is what we watch.
const STALL_PROBE_INTERVAL_MS = 250;
// Restoring the audio unit is not instant, so give it a few intervals to start
// moving the clock again before writing the context off.
const STALL_PROBE_ATTEMPTS = 3;
// A gesture can only prove a stall once enough wall-clock time has passed for a
// healthy clock to have visibly moved since the last reading.
const STALL_GESTURE_MIN_ELAPSED_MS = 250;
// The other way a context goes quiet is subtler than a stopped clock: the clock
// keeps moving, the graph keeps rendering, and the output goes nowhere because
// iOS took the audio session away and never gave it back. Nothing in the Web
// Audio API reports that, so the output is tapped and measured instead.
const OUTPUT_TAP_FFT_SIZE = 2048;
// A note that is really sounding is orders of magnitude above this a moment
// after it starts. Only true digital silence reads below it.
const SILENT_OUTPUT_PEAK = 1e-4;
// Long enough after the attack for the sample to be well underway, short enough
// that the shortest usable tap still lands inside the note.
const OUTPUT_PROBE_DELAY_MS = 140;
// One silent reading is a scheduling accident. A run of them is a dead output.
const SILENT_OUTPUT_READINGS = 3;
// Healthy readings are logged sparsely: the point of a healthy one is to prove
// the output was live at all, and a line per note would crowd out the events
// that explain a silence.
const OUTPUT_LEVEL_LOG_INTERVAL_MS = 5_000;

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, milliseconds); });
}

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
type ZoneMix = Array<{ zone: SampleZone; weight: number }>;
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
/** iOS reports 'auto' | 'playback' | ... here, and may revert what we set. */
interface ExperimentalAudioSession { type: string; state?: string }
interface NavigatorWithAudioSession extends Navigator { audioSession?: ExperimentalAudioSession }

function audioSession(): ExperimentalAudioSession | undefined {
  try {
    if (typeof navigator === 'undefined') return undefined;
    return (navigator as NavigatorWithAudioSession).audioSession;
  } catch (_) {
    // Reading the experimental property throws in some restricted contexts.
    return undefined;
  }
}

/**
 * What iOS currently thinks this page's audio is for. Undefined everywhere the
 * Audio Session API is absent, which is every browser but Safari.
 */
export function describeAudioSession(): DiagnosticData {
  const session = audioSession();
  if (!session) return {};
  try {
    return { audioSessionType: session.type, audioSessionState: session.state };
  } catch (_) {
    return { audioSessionType: 'unreadable' };
  }
}

/**
 * Claim the playback session, and say so in the log when the claim had to be
 * remade. iOS hands the session to whatever app interrupted us and does not
 * hand it back, which leaves a context that still runs, still renders, and is
 * routed nowhere — so every path that could be a return from an interruption
 * re-asserts it, and the reason it was re-asserted is what the log records.
 */
function configurePlaybackAudioSession(reason: string): void {
  const session = audioSession();
  if (!session) return;
  try {
    const before = session.type;
    if (before === 'playback') return;
    session.type = 'playback';
    diagnostics.record('audio', 'audio session claimed for playback', {
      reason,
      before,
      after: session.type,
      state: session.state,
    });
  } catch (error) {
    // The experimental API may reject assignment. Web Audio should continue to
    // work on the browser's default session type, quieter than we asked for.
    diagnostics.record('audio', 'audio session refused configuration', { reason, ...describeError(error) });
  }
}

/**
 * Everything about where the samples are supposed to be going. A route that
 * changed while the app was backgrounded is the other half of the silent-return
 * story, and none of it can be inferred from the context state.
 */
function describeRoute(ctx: AudioContext): DiagnosticData {
  const destination: AudioDestinationNode | undefined = ctx.destination;
  return {
    sampleRate: ctx.sampleRate,
    channels: destination?.channelCount,
    maxChannels: destination?.maxChannelCount,
    baseLatency: ctx.baseLatency,
    // Declared as always present, absent in Safari; undefined is a real answer.
    outputLatency: ctx.outputLatency as number | undefined,
    ...describeAudioSession(),
  };
}

class PianoAudioEngine {
  ctx: AudioContext | null = null;
  masterGain: GainNode | null = null;
  limiter: DynamicsCompressorNode | null = null;
  /** Side tap on the output, used to measure what the graph really renders. */
  outputTap: AnalyserNode | null = null;
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
  /** Listening level, 0 to 1, applied on top of the fixed headroom. */
  private _volume = 1;
  /** Memoised zone selection, rebuilt whenever the zone set is replaced. */
  private _zoneMixSource: readonly SampleZone[] | null = null;
  private _zoneMixTable: ZoneMix[] = [];
  loaded = false;
  loading = false;
  state: AudioEngineState = 'loading';
  /** Last reading of the context clock, paired with the wall clock beside it. */
  private _clockAudioTime: number | null = null;
  private _clockWallTime = 0;
  /** A resume is in flight and the notes still held should be rebuilt on it. */
  private _restorePending = false;
  /** A stalled context was found mid-load and still needs replacing. */
  private _rebuildDeferred = false;
  /** Scratch buffer for the output tap, sized once per context. */
  private _outputSamples: Float32Array<ArrayBuffer> | null = null;
  private _outputProbeTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The tap has read a real signal at least once on this context. Until it
   * has, a zero reading says nothing about the audio — it may just as well be
   * a browser that never renders a node with no path to the destination — so
   * silence is only believed, and only acted on, after the tap has proven it
   * can see sound at all.
   */
  private _outputTapProven = false;
  private _silentReadings = 0;
  /** Peak of the last reading, for the export snapshot. Null once nothing has been measured. */
  private _lastOutputPeak: number | null = null;
  private _lastOutputLevelLog = 0;

  /** Initialize AudioContext (must be resumed from a user gesture on iOS). */
  async init(): Promise<AudioContext> {
    if (this.ctx) return this.ctx;
    return this._createContext();
  }

  /**
   * Build the context and its output chain. Synchronous so a gesture handler
   * can replace a dead context and resume the replacement without crossing a
   * task boundary, which iOS would treat as being outside the gesture.
   */
  private _createContext(): AudioContext {
    const AudioContextClass = window.AudioContext || (window as WebKitAudioWindow).webkitAudioContext;
    if (!AudioContextClass) {
      this.state = 'error';
      diagnostics.record('audio', 'web audio unavailable');
      throw new Error('Web Audio is unavailable in this browser');
    }
    configurePlaybackAudioSession('context created');
    const ctx = new AudioContextClass();
    this.ctx = ctx;
    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = MASTER_GAIN * this._volume;
    this.limiter = this._createLimiter(ctx);
    if (this.limiter) {
      this.masterGain.connect(this.limiter);
      this.limiter.connect(ctx.destination);
    } else {
      this.masterGain.connect(ctx.destination);
    }
    // Tapped off the last node before the destination, so the reading is the
    // finished mix: every gain, the limiter, and nothing the device does after.
    this.outputTap = this._createOutputTap(ctx);
    if (this.outputTap) (this.limiter ?? this.masterGain).connect(this.outputTap);
    this._outputSamples = null;
    this._outputTapProven = false;
    this._silentReadings = 0;
    this._lastOutputPeak = null;
    ctx.onstatechange = () => this._handleStateChange();
    this.state = ctx.state === 'running' && this.loaded ? 'ready' :
      ctx.state === 'running' ? 'loading' : 'awaitingGesture';
    this._observeClock();
    diagnostics.record('audio', 'context created', {
      contextState: ctx.state,
      limiter: this.limiter !== null,
      outputTap: this.outputTap !== null,
      engineState: this.state,
      ...describeRoute(ctx),
    });
    return ctx;
  }

  get volume(): number {
    return this._volume;
  }

  /**
   * Set the listening level, 0 to 1. Applied above the fixed headroom so the
   * limiter keeps protecting the output at any setting, and ramped rather than
   * stepped so dragging a slider does not produce zipper noise.
   */
  setVolume(volume: number): void {
    if (!Number.isFinite(volume)) return;
    this._volume = Math.max(0, Math.min(1, volume));
    const target = MASTER_GAIN * this._volume;
    const gain = this.masterGain?.gain;
    if (!gain) return;
    if (this.ctx) gain.setTargetAtTime(target, this.ctx.currentTime, VOLUME_RAMP_SECONDS);
    else gain.value = target;
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
   * Build the output tap, or null where the node is unavailable. It is a side
   * branch with nothing connected after it: an analyser reads whatever its
   * input node renders, and that node is already rendering because it also
   * feeds the destination, so the tap costs a copy and changes no audio.
   */
  private _createOutputTap(ctx: AudioContext): AnalyserNode | null {
    if (typeof ctx.createAnalyser !== 'function') return null;
    try {
      const analyser = ctx.createAnalyser();
      analyser.fftSize = OUTPUT_TAP_FFT_SIZE;
      return analyser;
    } catch (_) {
      // A browser that refuses the node leaves us with the clock probe alone.
      return null;
    }
  }

  /**
   * The largest sample magnitude in the tap's most recent window, 0 to 1.
   * Null when there is no usable tap, which is not the same as a zero reading:
   * zero is a claim about the audio, null is the absence of one.
   */
  measureOutputPeak(): number | null {
    const analyser = this.outputTap;
    if (!analyser) return null;
    try {
      const size = analyser.fftSize;
      if (typeof analyser.getFloatTimeDomainData === 'function') {
        const samples = this._outputSamples?.length === size
          ? this._outputSamples
          : (this._outputSamples = new Float32Array(size));
        analyser.getFloatTimeDomainData(samples);
        let peak = 0;
        for (const sample of samples) {
          const magnitude = Math.abs(sample);
          if (magnitude > peak) peak = magnitude;
        }
        return peak;
      }
      if (typeof analyser.getByteTimeDomainData === 'function') {
        // The byte view is the same waveform centred on 128.
        const bytes = new Uint8Array(size);
        analyser.getByteTimeDomainData(bytes);
        let peak = 0;
        for (const sample of bytes) {
          const magnitude = Math.abs(sample - 128) / 128;
          if (magnitude > peak) peak = magnitude;
        }
        return peak;
      }
      return null;
    } catch (_) {
      // A tap that throws is a tap we have no reading from.
      return null;
    }
  }

  /**
   * What the output tap has seen, for the exported report. `outputPeak` is the
   * last reading rather than a fresh one: a reading taken with nothing sounding
   * is legitimately zero and would only mislead whoever reads the log.
   */
  describeOutput(): DiagnosticData {
    const ctx = this.ctx;
    return {
      outputTap: this.outputTap ? (this._outputTapProven ? 'proven' : 'unproven') : 'unavailable',
      outputPeak: this._lastOutputPeak ?? undefined,
      silentReadings: this._silentReadings,
      ...(ctx ? describeRoute(ctx) : describeAudioSession()),
    };
  }

  /**
   * Read the output shortly after a note starts, and decide what the reading
   * means. Sound proves the whole chain down to the destination is alive, and
   * anything the player still cannot hear is below us: the audio session, the
   * route, or the ringer switch. Silence, from a tap that has proved it can see
   * sound, proves the opposite — the context is rendering nothing — and that is
   * a context worth replacing, which is the one cure iOS responds to.
   */
  private _probeOutputLevel(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || this.voices.size === 0) return;
    const peak = this.measureOutputPeak();
    if (peak === null) return;
    this._lastOutputPeak = peak;
    const silent = peak < SILENT_OUTPUT_PEAK;
    if (!silent) this._outputTapProven = true;
    this._silentReadings = silent && this._outputTapProven ? this._silentReadings + 1 : 0;
    const now = nowMs();
    if (silent || now - this._lastOutputLevelLog >= OUTPUT_LEVEL_LOG_INTERVAL_MS) {
      if (!silent) this._lastOutputLevelLog = now;
      diagnostics.record('audio', silent ? 'output tap reads silence' : 'output level', {
        peak: Number(peak.toFixed(5)),
        voices: this.voices.size,
        currentTime: ctx.currentTime,
        proven: this._outputTapProven,
        ...describeRoute(ctx),
      });
    }
    if (this._silentReadings >= SILENT_OUTPUT_READINGS) {
      this._silentReadings = 0;
      diagnostics.record('audio', 'replacing a context that renders silence', {
        voices: this.voices.size,
        currentTime: ctx.currentTime,
      });
      this._rebuildContext();
    }
  }

  /** Queue one reading per burst of notes, rather than one per note. */
  private _scheduleOutputProbe(): void {
    if (!this.outputTap || this._outputProbeTimer !== null) return;
    if (typeof setTimeout !== 'function') return;
    this._outputProbeTimer = setTimeout(() => {
      this._outputProbeTimer = null;
      this._probeOutputLevel();
    }, OUTPUT_PROBE_DELAY_MS);
  }

  private _cancelOutputProbe(): void {
    if (this._outputProbeTimer === null) return;
    clearTimeout(this._outputProbeTimer);
    this._outputProbeTimer = null;
  }

  /**
   * Handle context state changes. When the context reaches 'running',
   * flush any queued notes. When it leaves 'running' (suspended or
   * interrupted), mark the engine as awaiting a gesture.
   */
  private _handleStateChange(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    diagnostics.record('audio', 'context state change', {
      contextState: ctx.state,
      currentTime: ctx.currentTime,
      loaded: this.loaded,
      restorePending: this._restorePending,
    });
    if (ctx.state === 'running') {
      this.state = this.loaded ? 'ready' : 'loading';
      this._observeClock();
      this._restoreHeldVoices();
      this._flushQueuedNotes();
    } else if (ctx.state === 'suspended' || (ctx.state as string) === 'interrupted') {
      this.state = 'awaitingGesture';
    }
  }

  /**
   * Safari can suspend or interrupt a context while fingers are still down,
   * which leaves the voices bound to it dead. Rebuild them from the held-key
   * snapshot, once per resume: whichever of the state-change event or the
   * resume promise arrives first does the work, and iOS delivers only one of
   * the two often enough that both have to be able to.
   */
  private _restoreHeldVoices(): void {
    if (!this._restorePending) return;
    this._restorePending = false;
    diagnostics.record('audio', 'restoring held voices', {
      held: this.heldNotes.size,
      sounding: this.voices.size,
    });
    // oxlint-disable-next-line no-useless-spread -- _stopVoice deletes from this.voices while iterating.
    for (const active of [...this.voices]) this._stopVoice(active);
    for (const note of this.heldNotes.values()) this.queuedNotes.set(note.keyId, note);
  }

  /** Record where the context clock stood, and when we looked. */
  private _observeClock(): void {
    const time = this.ctx?.currentTime;
    this._clockAudioTime = typeof time === 'number' ? time : null;
    this._clockWallTime = nowMs();
  }

  /**
   * Whether a context claiming to run has in fact stopped rendering since the
   * last reading. Only meaningful once enough wall-clock time has passed that a
   * healthy clock would have moved, so a fast second gesture never accuses a
   * working context.
   */
  private _isClockFrozen(ctx: AudioContext): boolean {
    const previous = this._clockAudioTime;
    if (previous === null || typeof ctx.currentTime !== 'number') return false;
    if (nowMs() - this._clockWallTime < STALL_GESTURE_MIN_ELAPSED_MS) return false;
    return ctx.currentTime <= previous;
  }

  /**
   * Replace a context whose audio unit iOS has torn down. The decoded sample
   * survives — an AudioBuffer is not bound to the context that decoded it — so
   * this costs a new output chain and nothing else: no refetch, no redecode.
   * Keys still under a finger are requeued and sound again on the new context.
   */
  private _rebuildContext(): boolean {
    const stale = this.ctx;
    if (!stale) return false;
    // decodeAudioData belongs to the context that started it, so replacing the
    // context mid-load would throw the download away. Wait for the load to
    // finish and rebuild then — nothing is audible until it does anyway.
    if (this.loading) {
      this._rebuildDeferred = true;
      diagnostics.record('audio', 'rebuild deferred until the sample finishes loading');
      return false;
    }
    diagnostics.record('audio', 'rebuilding context', {
      contextState: stale.state,
      currentTime: stale.currentTime,
      held: this.heldNotes.size,
      sounding: this.voices.size,
    });
    stale.onstatechange = null;
    this._cancelOutputProbe();
    // oxlint-disable-next-line no-useless-spread -- _stopVoice deletes from this.voices while iterating.
    for (const note of [...this.voices]) this._stopVoice(note);
    this.activeNotes.clear();
    this.sustainedNotes.clear();
    for (const note of this.heldNotes.values()) this.queuedNotes.set(note.keyId, note);
    this.ctx = null;
    this.masterGain = null;
    this.limiter = null;
    this.outputTap = null;
    try {
      // Never awaited: a torn-down context can leave close() pending forever,
      // and the replacement must not wait on it.
      if (typeof stale.close === 'function') void Promise.resolve(stale.close()).catch(() => {});
    } catch (_) {
      // Already closing, or the context refuses to close. Either way it is
      // unreachable from here now.
    }
    this._resume(this._createContext());
    return true;
  }

  /**
   * Resume the AudioContext. Must be called synchronously from a user
   * gesture handler — iOS Safari ignores resume() calls that cross a
   * microtask/task boundary (e.g. after await).
   */
  ensureRunning(): void {
    // Before the state check, not after: the branch a silent return takes is
    // the one where the context still claims to be running, and that branch
    // used to return without ever reclaiming the session iOS had taken away.
    configurePlaybackAudioSession('gesture');
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'closed') {
      diagnostics.record('audio', 'gesture found no usable context', { contextState: ctx?.state ?? 'none' });
      return;
    }
    if (ctx.state === 'running') {
      // 'running' is not proof of sound on iOS. A frozen clock means the audio
      // unit is gone, and resume() on a context that already claims to run is a
      // no-op, so the only way back is a new context — built and resumed inside
      // this gesture so the tap that found the silence also ends it.
      if (this._isClockFrozen(ctx)) {
        diagnostics.record('audio', 'gesture found a frozen clock', {
          currentTime: ctx.currentTime,
          lastSeen: this._clockAudioTime,
          sinceLastSeenMs: Math.round(nowMs() - this._clockWallTime),
        });
        this._rebuildContext();
        return;
      }
      diagnostics.record('audio', 'gesture on a running context', {
        currentTime: ctx.currentTime,
        lastSeen: this._clockAudioTime,
        sinceLastSeenMs: Math.round(nowMs() - this._clockWallTime),
        loaded: this.loaded,
        ...describeAudioSession(),
      });
      this.state = this.loaded ? 'ready' : 'loading';
      this._observeClock();
      return;
    }
    this._resume(ctx);
  }

  private _resume(ctx: AudioContext): void {
    configurePlaybackAudioSession('resume');
    this._restorePending = true;
    diagnostics.record('audio', 'resume requested', {
      contextState: ctx.state,
      currentTime: ctx.currentTime,
      held: this.heldNotes.size,
    });
    // Call resume() synchronously to stay within the gesture context.
    // Do NOT cache the promise — if resume is ignored by iOS (no gesture),
    // the promise never resolves and would block all future attempts.
    ctx.resume().then(() => {
      if (this.ctx !== ctx) {
        diagnostics.record('audio', 'resume resolved for a replaced context', { contextState: ctx.state });
        return;
      }
      diagnostics.record('audio', 'resume resolved', {
        contextState: ctx.state,
        currentTime: ctx.currentTime,
      });
      if (ctx.state === 'running') {
        this.state = this.loaded ? 'ready' : 'loading';
        this._observeClock();
        this._restoreHeldVoices();
        this._flushQueuedNotes();
      } else {
        this.state = 'awaitingGesture';
      }
    }).catch(error => {
      diagnostics.record('audio', 'resume rejected', {
        contextState: ctx.state,
        current: this.ctx === ctx,
        ...describeError(error),
      });
      if (this.ctx === ctx) this.state = 'awaitingGesture';
    });
  }

  /**
   * Confirm that a context claiming to run is really rendering, and replace it
   * if it is not. Call this on returning to the foreground: iOS restores the
   * page long before it restores audio, so the clock is polled for a while
   * before the context is written off. Safe outside a gesture — a replacement
   * built here may only reach 'suspended', which the next tap resumes.
   *
   * Resolves true when the context was replaced.
   */
  async verifyRunning(): Promise<boolean> {
    // A foreground return is the moment the session is most likely to have been
    // handed to something else, and reclaiming it needs no gesture.
    configurePlaybackAudioSession('foreground');
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || typeof ctx.currentTime !== 'number') {
      diagnostics.record('audio', 'skipped the stall probe', {
        contextState: ctx?.state ?? 'none',
        engineState: this.state,
      });
      return false;
    }
    const before = ctx.currentTime;
    diagnostics.record('audio', 'probing the context clock', {
      currentTime: before,
      loaded: this.loaded,
      ...describeRoute(ctx),
    });
    for (let attempt = 0; attempt < STALL_PROBE_ATTEMPTS; attempt += 1) {
      await delay(STALL_PROBE_INTERVAL_MS);
      // A context swapped out from under us, or one that has admitted to being
      // suspended or interrupted, is the gesture path's problem rather than ours.
      if (this.ctx !== ctx || ctx.state !== 'running') {
        diagnostics.record('audio', 'stall probe abandoned', {
          contextState: ctx.state,
          current: this.ctx === ctx,
          attempt: attempt + 1,
        });
        return false;
      }
      if (ctx.currentTime > before) {
        // The clock says the audio unit is alive. It says nothing about whether
        // the samples reach a speaker, so the output tap picks the question up
        // from here, on the next note the player actually presses.
        diagnostics.record('audio', 'clock is advancing', {
          currentTime: ctx.currentTime,
          attempt: attempt + 1,
          ...describeRoute(ctx),
        });
        this._observeClock();
        this._silentReadings = 0;
        return false;
      }
    }
    diagnostics.record('audio', 'clock frozen while the context claims to run', { currentTime: ctx.currentTime });
    return this._rebuildContext();
  }

  /** Download and natively decode the shared audio sprite. */
  async loadSampleLibrary(
    url: string,
    zones: readonly SampleZone[],
    onProgress?: LoadProgressCallback,
  ): Promise<void> {
    if (this.loaded || this.loading) {
      diagnostics.record('audio', 'load skipped', { loaded: this.loaded, loading: this.loading });
      return;
    }
    this.loading = true;
    const startedAt = nowMs();
    diagnostics.record('audio', 'load started', {
      url,
      online: typeof navigator === 'undefined' ? undefined : navigator.onLine,
    });
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
      const contentLength = Number(response.headers?.get('content-length')) || 0;
      diagnostics.record('audio', 'sample response received', {
        status: response.status,
        contentLength,
        elapsedMs: Math.round(nowMs() - startedAt),
      });
      if (!response.ok) throw new Error(`Audio request failed (${response.status})`);

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

      const decodeStartedAt = nowMs();
      const decoded = await ctx.decodeAudioData(encodedAudio);
      if (decoded.length === 0 || decoded.numberOfChannels === 0) {
        throw new Error('Decoded audio is empty');
      }
      this.sampleBuffer = decoded;
      this.zones = zones;
      this.loaded = true;
      this.state = ctx.state === 'running' ? 'ready' : 'awaitingGesture';
      diagnostics.record('audio', 'sample decoded', {
        bytes: encodedAudio.byteLength,
        channels: decoded.numberOfChannels,
        sampleRate: decoded.sampleRate,
        decodeMs: Math.round(nowMs() - decodeStartedAt),
        totalMs: Math.round(nowMs() - startedAt),
        contextState: ctx.state,
        engineState: this.state,
      });
      onProgress?.(1);
      this._flushQueuedNotes();
    } catch (error) {
      this.sampleBuffer = null;
      this.zones = [];
      this.state = 'error';
      diagnostics.record('audio', 'load failed', {
        elapsedMs: Math.round(nowMs() - startedAt),
        online: typeof navigator === 'undefined' ? undefined : navigator.onLine,
        ...describeError(error),
      });
      throw error;
    } finally {
      this.loading = false;
      if (this._rebuildDeferred) {
        this._rebuildDeferred = false;
        this._rebuildContext();
      }
    }
  }

  /**
   * Select the sample(s) to blend for a note. Returns the two bracketing
   * rootKey zones crossfaded by the note's fractional position between them,
   * so timbre transitions smoothly across semitones instead of jumping
   * between recordings. At an exact rootKey or outside the rootKey range,
   * returns a single zone at weight 1.
   */
  _findZoneMix(midiNote: number): ZoneMix {
    // Built once per zone set: the mix depends only on the note, and this runs
    // on every key press.
    if (this._zoneMixSource !== this.zones) {
      this._zoneMixSource = this.zones;
      this._zoneMixTable = Array.from({ length: 128 }, (_unused, note) => this._computeZoneMix(note));
    }
    return this._zoneMixTable[midiNote] ?? [];
  }

  private _computeZoneMix(midiNote: number): ZoneMix {
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
    if (!this.ctx || !this.sampleBuffer || this.ctx.state !== 'running') {
      // The one symptom a player reports as "no sound": keys arriving at an
      // engine that cannot play them. Which of the three is missing says why.
      diagnostics.record('audio', 'note queued, engine not playable', {
        keyId,
        contextState: this.ctx?.state ?? 'none',
        loaded: this.loaded,
        engineState: this.state,
        queued: this.queuedNotes.size,
      });
      return;
    }
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
    // Consecutive notes fold into one entry, so a whole passage costs a single
    // line that still shows the clock moving and the gain the notes were given.
    // Every value here is one the engine already holds: a log line in the note
    // path must not be able to fail on a node it went looking for.
    diagnostics.record('audio', 'note started', {
      keyId,
      currentTime: this.ctx.currentTime,
      voices: this.voices.size,
      velocityGain: Number(velocityGain.toFixed(3)),
      volume: this._volume,
    });
    // A note that started is the only chance to find out whether anything is
    // coming out, so every burst of them buys one reading of the output.
    this._scheduleOutputProbe();
  }

  _flushQueuedNotes(): void {
    if (!this.ctx || this.ctx.state !== 'running' || !this.sampleBuffer) return;
    if (this.queuedNotes.size > 0) {
      diagnostics.record('audio', 'flushing queued notes', { queued: this.queuedNotes.size });
    }
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
