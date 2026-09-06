import { afterEach, describe, expect, it, vi } from 'vitest';
import { PianoAudioEngine } from '../../js/app/audio';
import type { SampleZone } from '../../js/app/audio';
import { YAMAHA_U1_ZONES } from '../../js/app/sample-zones';

class FakeAudioContext {
  state: AudioContextState = 'suspended';
  destination = {};
  onstatechange: ((event: Event) => void) | null = null;
  createGain() {
    return { gain: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() };
  }
  async resume() {
    this.state = 'running';
    this.onstatechange?.({} as Event);
  }
}

/**
 * Stands in for navigator.audioSession: readable as well as writable, the way
 * Safari's is, so a claim that is already held reads as a no-op rather than as
 * another assignment. `events` records only the assignments that really happen.
 */
function fakeAudioSession(initialType = 'auto', events: string[] = []) {
  let type = initialType;
  return {
    events,
    state: 'active',
    get type() { return type; },
    set type(value: string) { type = value; events.push(`session:${value}`); },
  };
}

/** A context that also offers the limiter node, so routing can be asserted. */
class LimiterAudioContext extends FakeAudioContext {
  compressor = {
    threshold: { value: 0 },
    knee: { value: -1 },
    ratio: { value: 0 },
    attack: { value: 0 },
    release: { value: 0 },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };

  createDynamicsCompressor() {
    return this.compressor;
  }
}

/**
 * A context whose clock only moves when the test moves it, standing in for the
 * iOS context that keeps reporting 'running' after its audio unit is gone.
 */
class StallableAudioContext extends FakeAudioContext {
  static instances: StallableAudioContext[] = [];
  currentTime = 0;
  sources: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
  close = vi.fn(async () => { this.state = 'closed'; });
  decodeAudioData = vi.fn(async () => ({ length: 44_100, numberOfChannels: 1 } as AudioBuffer));
  /** What the output tap will read: the peak this context is "rendering". */
  tapPeak = 0;

  createAnalyser() {
    return {
      fftSize: 32,
      connect: vi.fn(),
      disconnect: vi.fn(),
      getFloatTimeDomainData: (samples: Float32Array) => {
        samples.fill(0);
        samples[0] = this.tapPeak;
      },
    };
  }

  constructor() {
    super();
    StallableAudioContext.instances.push(this);
  }

  createBufferSource() {
    const source = {
      buffer: null, playbackRate: { value: 0 },
      connect: vi.fn(), disconnect: vi.fn(),
      start: vi.fn(), stop: vi.fn(), onended: null,
    };
    this.sources.push(source);
    return source;
  }

  override createGain() {
    return {
      gain: {
        value: 0,
        cancelScheduledValues: vi.fn(),
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
        setTargetAtTime: vi.fn(),
      },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
  }
}

/** A loaded engine on a running StallableAudioContext, with C4 held down. */
async function stalledEngine() {
  StallableAudioContext.instances = [];
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('window', { AudioContext: StallableAudioContext });
  const engine = new PianoAudioEngine();
  await engine.init();
  const first = engine.ctx as unknown as StallableAudioContext;
  first.state = 'running';
  engine.sampleBuffer = {} as AudioBuffer;
  engine.zones = [{ loKey: 0, hiKey: 127, rootKey: 60, offsetSeconds: 0, durationSeconds: 1 }];
  engine.loaded = true;
  engine.ensureRunning();
  engine.noteOn('C4', 60);
  return { engine, first };
}

function responseWith(bytes = new Uint8Array([1, 2, 3, 4])) {
  return {
    ok: true,
    status: 200,
    headers: { get: vi.fn(() => String(bytes.byteLength)) },
    body: null,
    arrayBuffer: vi.fn(async () => bytes.buffer),
  };
}

function loaderEngine(decodeAudioData: ReturnType<typeof vi.fn>) {
  const engine = new PianoAudioEngine();
  engine.ctx = {
    state: 'running',
    decodeAudioData,
  } as unknown as AudioContext;
  engine.masterGain = {} as GainNode;
  return engine;
}

function readyEngine(zones: readonly SampleZone[] = [{
  loKey: 0, hiKey: 127, rootKey: 60, offsetSeconds: 1.5, durationSeconds: 6.25,
}]) {
  const engine = new PianoAudioEngine();
  const createdSources: Array<{
    buffer: AudioBuffer | null;
    playbackRate: { value: number };
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    onended: ((event: Event) => void) | null;
  }> = [];
  const createdGains: Array<{
    gain: {
      value: number;
      cancelScheduledValues: ReturnType<typeof vi.fn>;
      setValueAtTime: ReturnType<typeof vi.fn>;
      linearRampToValueAtTime: ReturnType<typeof vi.fn>;
    };
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }> = [];
  const createdFilters: Array<{
    type: string;
    frequency: { value: number };
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }> = [];
  engine.ctx = {
    state: 'running',
    currentTime: 12,
    createBiquadFilter: vi.fn(() => {
      const filter = {
        type: '',
        frequency: { value: 0 },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      createdFilters.push(filter);
      return filter;
    }),
    createBufferSource: vi.fn(() => {
      const source = {
        buffer: null,
        playbackRate: { value: 0 },
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: null,
      };
      createdSources.push(source);
      return source;
    }),
    createGain: vi.fn(() => {
      const gain = {
        gain: {
          value: 0,
          cancelScheduledValues: vi.fn(),
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      createdGains.push(gain);
      return gain;
    }),
  } as unknown as AudioContext;
  engine.masterGain = {} as GainNode;
  engine.sampleBuffer = {} as AudioBuffer;
  engine.zones = zones;
  return { engine, createdSources, createdGains, createdFilters };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('PianoAudioEngine loading', () => {
  it('streams download progress through 90%, then reports decoded completion', async () => {
    vi.stubGlobal('document', { baseURI: 'https://example.test/app/' });
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => '4' },
      body: new ReadableStream({ start(controller) { chunks.forEach(chunk => controller.enqueue(chunk)); controller.close(); } }),
    }));
    const decoded = { length: 44_100, numberOfChannels: 1 } as AudioBuffer;
    const decode = vi.fn().mockResolvedValue(decoded);
    const engine = loaderEngine(decode);
    const progress: number[] = [];

    await engine.loadSampleLibrary('./assets/piano.m4a', YAMAHA_U1_ZONES, value => progress.push(value));

    expect(progress).toEqual([0.45, 0.9, 1]);
    expect(decode).toHaveBeenCalledOnce();
    expect(engine.sampleBuffer).toBe(decoded);
    expect(engine.zones).toBe(YAMAHA_U1_ZONES);
    expect(engine.loaded).toBe(true);
    expect(engine.loading).toBe(false);
  });

  it('reports fetch failures and remains retryable', async () => {
    vi.stubGlobal('document', { baseURI: 'https://example.test/app/' });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce(responseWith());
    vi.stubGlobal('fetch', fetchMock);
    const decoded = { length: 1, numberOfChannels: 1 } as AudioBuffer;
    const engine = loaderEngine(vi.fn().mockResolvedValue(decoded));

    await expect(engine.loadSampleLibrary('./assets/piano.m4a', YAMAHA_U1_ZONES)).rejects.toThrow('(503)');
    expect(engine.state).toBe('error');
    expect(engine.loading).toBe(false);
    await expect(engine.loadSampleLibrary('./assets/piano.m4a', YAMAHA_U1_ZONES)).resolves.toBeUndefined();
    expect(engine.loaded).toBe(true);
  });

  it('cleans up after decode failures and can retry', async () => {
    vi.stubGlobal('document', { baseURI: 'https://example.test/' });
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(responseWith())));
    const decoded = { length: 1, numberOfChannels: 1 } as AudioBuffer;
    const decode = vi.fn().mockRejectedValueOnce(new Error('bad AAC')).mockResolvedValueOnce(decoded);
    const engine = loaderEngine(decode);

    await expect(engine.loadSampleLibrary('piano.m4a', YAMAHA_U1_ZONES)).rejects.toThrow('bad AAC');
    expect(engine.sampleBuffer).toBeNull();
    expect(engine.loading).toBe(false);
    await expect(engine.loadSampleLibrary('piano.m4a', YAMAHA_U1_ZONES)).resolves.toBeUndefined();
    expect(engine.sampleBuffer).toBe(decoded);
  });
});

describe('PianoAudioEngine playback', () => {
  it('selects playback mode before constructing the AudioContext', async () => {
    const events: string[] = [];
    const audioSession = fakeAudioSession('auto', events);
    class OrderedAudioContext extends FakeAudioContext {
      constructor() {
        super();
        events.push('context');
      }
    }
    vi.stubGlobal('navigator', { audioSession });
    vi.stubGlobal('window', { AudioContext: OrderedAudioContext });

    await new PianoAudioEngine().init();

    expect(events).toEqual(['session:playback', 'context']);
  });

  it('initializes when the Audio Session API is unavailable', async () => {
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });

    const engine = new PianoAudioEngine();
    await expect(engine.init()).resolves.toBe(engine.ctx);
  });

  it('initializes when assigning playback mode throws', async () => {
    const audioSession = {
      get type() { return 'auto'; },
      set type(_value: string) { throw new Error('unsupported session type'); },
    };
    vi.stubGlobal('navigator', { audioSession });
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });

    const engine = new PianoAudioEngine();
    await expect(engine.init()).resolves.toBe(engine.ctx);
  });

  it('starts low, middle, and high notes from the shared buffer at zone boundaries', () => {
    const { engine, createdSources } = readyEngine(YAMAHA_U1_ZONES);
    for (const midiNote of [21, 60, 108]) engine.noteOn(String(midiNote), midiNote);

    for (const [index, midiNote] of [21, 60, 108].entries()) {
      const zone = YAMAHA_U1_ZONES.find(candidate => midiNote >= candidate.loKey && midiNote <= candidate.hiKey)!;
      expect(createdSources[index].buffer).toBe(engine.sampleBuffer);
      expect(createdSources[index].start).toHaveBeenCalledWith(0, zone.offsetSeconds, zone.durationSeconds);
      expect(createdSources[index].playbackRate.value).toBeCloseTo(2 ** ((midiNote - zone.rootKey) / 12));
    }
  });

  it('crossfades the two bracketing rootKey samples for an in-range note', () => {
    const { engine, createdSources, createdGains } = readyEngine(YAMAHA_U1_ZONES);
    // MIDI 50 sits between rootKey 48 (zone 4) and rootKey 55 (zone 5).
    // t = (50 - 48) / (55 - 48) = 2/7 -> below weight 5/7, above weight 2/7.
    // Use full velocity (127) so gain equals the crossfade weight directly.
    engine.noteOn('D3', 50, 127);

    expect(createdSources).toHaveLength(2);
    const below = YAMAHA_U1_ZONES[4];
    const above = YAMAHA_U1_ZONES[5];
    const t = (50 - below.rootKey) / (above.rootKey - below.rootKey);

    expect(createdSources[0].start).toHaveBeenCalledWith(0, below.offsetSeconds, below.durationSeconds);
    expect(createdSources[0].playbackRate.value).toBeCloseTo(2 ** ((50 - below.rootKey) / 12));
    expect(createdGains[0].gain.value).toBeCloseTo(1 - t);

    expect(createdSources[1].start).toHaveBeenCalledWith(0, above.offsetSeconds, above.durationSeconds);
    expect(createdSources[1].playbackRate.value).toBeCloseTo(2 ** ((50 - above.rootKey) / 12));
    expect(createdGains[1].gain.value).toBeCloseTo(t);
  });

  it('uses a single un-shifted voice at a rootKey and outside the rootKey range', () => {
    const { engine, createdSources, createdGains } = readyEngine(YAMAHA_U1_ZONES);
    // MIDI 60 is an exact rootKey; 21 is below the lowest rootKey; 108 above the highest.
    for (const [id, midiNote] of [['C4', 60], ['A0', 21], ['C8', 108]] as const) {
      engine.noteOn(id, midiNote, 127);
    }

    expect(createdSources).toHaveLength(3);
    for (const gain of createdGains) expect(gain.gain.value).toBeCloseTo(1);
    expect(createdSources[0].playbackRate.value).toBeCloseTo(1); // MIDI 60 == rootKey 60
  });

  it('applies a perceptual velocity curve to each note gain', () => {
    const { engine, createdGains } = readyEngine();
    engine.noteOn('C4', 60, 64);
    // Squared, not linear: half velocity is a quarter of the amplitude.
    expect(createdGains[0].gain.value).toBeCloseTo((64 / 127) ** 2);
  });

  it('spreads velocity over a wider dynamic range than a linear map', () => {
    const { engine, createdGains } = readyEngine();
    engine.noteOn('soft', 60, 40);
    engine.noteOn('loud', 60, 120);

    const ratio = createdGains[1].gain.value / createdGains[0].gain.value;
    expect(ratio).toBeGreaterThan(120 / 40);
  });

  it('darkens soft notes and leaves the default velocity fully open', () => {
    const { engine, createdFilters, createdGains } = readyEngine();

    engine.noteOn('soft', 60, 40);
    engine.noteOn('default', 62, 100);
    engine.noteOn('loud', 64, 127);

    expect(createdFilters.map(filter => filter.type)).toEqual(['lowpass', 'lowpass', 'lowpass']);
    expect(createdFilters[0].frequency.value).toBeLessThan(createdFilters[1].frequency.value);
    // At and above the default velocity the filter is open, so players without
    // pressure or motion sensing hear an unchanged timbre.
    expect(createdFilters[1].frequency.value).toBeCloseTo(18000);
    expect(createdFilters[2].frequency.value).toBeCloseTo(18000);
    // Voices feed their note's filter, which feeds the master bus.
    expect(createdGains[0].connect).toHaveBeenCalledWith(createdFilters[0]);
    expect(createdFilters[0].connect).toHaveBeenCalledWith(engine.masterGain);
  });

  it('disconnects the tone filter once every voice of a note has ended', () => {
    const { engine, createdSources, createdFilters } = readyEngine();
    engine.noteOn('C4', 60, 80);
    engine.noteOff('C4');

    createdSources[0].onended?.({} as Event);

    expect(createdFilters[0].disconnect).toHaveBeenCalledOnce();
    expect(engine.voices.size).toBe(0);
  });

  it('still plays when the filter node is unavailable', () => {
    const { engine, createdGains } = readyEngine();
    (engine.ctx as unknown as { createBiquadFilter?: unknown }).createBiquadFilter = undefined;

    engine.noteOn('C4', 60, 80);

    expect(createdGains[0].connect).toHaveBeenCalledWith(engine.masterGain);
    expect(engine.activeNotes.has('C4')).toBe(true);
  });

  it('routes the master gain through a peak limiter into the destination', async () => {
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('window', { AudioContext: LimiterAudioContext });

    const engine = new PianoAudioEngine();
    await engine.init();
    const ctx = engine.ctx as unknown as LimiterAudioContext;

    // Chords sum well past full scale, so the pre-limiter stage keeps headroom.
    expect(engine.masterGain!.gain.value).toBeLessThan(1);
    expect(engine.limiter).toBe(ctx.compressor);
    expect(engine.masterGain!.connect).toHaveBeenCalledWith(ctx.compressor);
    expect(ctx.compressor.connect).toHaveBeenCalledWith(ctx.destination);
    // A high ratio over a hard knee is what makes it limit rather than compress.
    expect(ctx.compressor.ratio.value).toBeGreaterThanOrEqual(20);
    expect(ctx.compressor.knee.value).toBe(0);
    expect(ctx.compressor.threshold.value).toBeLessThan(0);
  });

  it('connects straight to the destination when the limiter node is missing', async () => {
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });

    const engine = new PianoAudioEngine();
    await engine.init();

    expect(engine.limiter).toBeNull();
    expect(engine.masterGain!.connect).toHaveBeenCalledWith(engine.ctx!.destination);
  });

  it('steals a releasing voice before a held one at the polyphony cap', () => {
    const { engine, createdGains, createdSources } = readyEngine();
    for (let index = 0; index < 32; index += 1) engine.noteOn(`k${index}`, 40 + index);
    expect(engine.voices.size).toBe(32);

    engine.noteOff('k1');
    engine.noteOn('fresh', 90);

    // k1 was already fading; it loses its voice rather than the held k0.
    expect(createdGains[1].gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, 12.06);
    expect(createdGains[0].gain.linearRampToValueAtTime).not.toHaveBeenCalled();
    expect(engine.activeNotes.has('k0')).toBe(true);
    expect(engine.activeNotes.has('fresh')).toBe(true);
    expect(createdSources).toHaveLength(33);
  });

  it('steals the oldest held voice when nothing is releasing', () => {
    const { engine, createdGains } = readyEngine();
    for (let index = 0; index < 32; index += 1) engine.noteOn(`k${index}`, 40 + index);

    engine.noteOn('fresh', 90);

    expect(engine.activeNotes.has('k0')).toBe(false);
    expect(engine.activeNotes.has('k1')).toBe(true);
    expect(createdGains[0].gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, 12.06);
  });

  it('bounds sounding voices through a long glissando', () => {
    const { engine } = readyEngine();
    for (let index = 0; index < 200; index += 1) engine.noteOn(`g${index}`, 30 + (index % 50));

    let sounding = 0;
    for (const note of engine.voices) if (!note.stolen) sounding += 1;
    expect(sounding).toBeLessThanOrEqual(32);
  });

  it('holds released notes open while the pedal is down', () => {
    const { engine, createdGains } = readyEngine();
    engine.setSustain(true);
    engine.noteOn('C4', 60, 100);

    engine.noteOff('C4');

    // No release ramp yet: the damper is still off the string.
    expect(createdGains[0].gain.linearRampToValueAtTime).not.toHaveBeenCalled();
    expect(engine.voices.size).toBe(1);
    expect(engine.sustainedNotes.has('C4')).toBe(true);
    expect(engine.activeNotes.has('C4')).toBe(false);

    engine.setSustain(false);

    expect(createdGains[0].gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, 12.2);
    expect(engine.sustainedNotes.size).toBe(0);
  });

  it('leaves keys that are still down sounding when the pedal lifts', () => {
    const { engine, createdGains } = readyEngine();
    engine.setSustain(true);
    engine.noteOn('C4', 60, 100);
    engine.noteOn('E4', 64, 100);
    engine.noteOff('C4');

    engine.setSustain(false);

    expect(createdGains[0].gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, 12.2);
    expect(createdGains[1].gain.linearRampToValueAtTime).not.toHaveBeenCalled();
    expect(engine.activeNotes.has('E4')).toBe(true);
  });

  it('retires the earlier voice when one key is struck twice under the pedal', () => {
    const { engine, createdGains } = readyEngine();
    engine.setSustain(true);

    engine.noteOn('C4', 60, 100);
    engine.noteOff('C4');
    engine.noteOn('C4', 60, 100);
    engine.noteOff('C4');

    expect(createdGains[0].gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, 12.2);
    expect(createdGains[1].gain.linearRampToValueAtTime).not.toHaveBeenCalled();
    expect(engine.sustainedNotes.get('C4')).toBeDefined();
    expect(engine.sustainedNotes.size).toBe(1);
  });

  it('steals a pedal-held voice before one still under a finger', () => {
    const { engine, createdGains } = readyEngine();
    engine.setSustain(true);
    for (let index = 0; index < 32; index += 1) engine.noteOn(`k${index}`, 40 + index);
    // k5 is now held by the pedal alone; k0 is still down.
    engine.noteOff('k5');

    engine.noteOn('fresh', 90);

    expect(createdGains[5].gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, 12.06);
    expect(createdGains[0].gain.linearRampToValueAtTime).not.toHaveBeenCalled();
    expect(engine.sustainedNotes.has('k5')).toBe(false);
  });

  it('queues only held notes while loading and clears them safely', () => {
    const engine = new PianoAudioEngine();
    engine.noteOn('C4', 60, 127);
    engine.noteOn('E4', 64, 64);
    engine.noteOff('C4');

    expect([...engine.queuedNotes.keys()]).toEqual(['E4']);
    expect([...engine.heldNotes.keys()]).toEqual(['E4']);
    engine.allNotesOff();
    expect(engine.queuedNotes.size).toBe(0);
    expect(engine.heldNotes.size).toBe(0);
  });

  it('resumes a suspended context from a gesture', async () => {
    const events: string[] = [];
    const audioSession = fakeAudioSession('auto', events);
    class OrderedAudioContext extends FakeAudioContext {
      async resume() {
        events.push('resume');
        await super.resume();
      }
    }
    vi.stubGlobal('navigator', { audioSession });
    vi.stubGlobal('window', { AudioContext: OrderedAudioContext });
    const engine = new PianoAudioEngine();
    await engine.init();
    engine.ensureRunning();
    // Wait for the resume promise to settle.
    await vi.waitFor(() => expect(engine.ctx?.state).toBe('running'));
    // Claimed once, at creation; the gesture and the resume find it already held.
    expect(events).toEqual(['session:playback', 'resume']);
  });

  it('reclaims the playback session when a gesture finds a running context', async () => {
    const audioSession = fakeAudioSession();
    vi.stubGlobal('navigator', { audioSession });
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    const engine = new PianoAudioEngine();
    await engine.init();
    (engine.ctx as unknown as FakeAudioContext).state = 'running';
    // An interrupting app takes the session and iOS never hands it back. The
    // context still says 'running', so nothing else on this path would notice.
    audioSession.type = 'auto';
    audioSession.events.length = 0;

    engine.ensureRunning();

    expect(audioSession.type).toBe('playback');
    expect(audioSession.events).toEqual(['session:playback']);
  });

  it('reclaims the playback session on returning to the foreground', async () => {
    const audioSession = fakeAudioSession();
    vi.stubGlobal('navigator', { audioSession });
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    const engine = new PianoAudioEngine();
    await engine.init();
    audioSession.type = 'auto';
    audioSession.events.length = 0;

    // Still suspended, so the clock probe declines — the session is reclaimed
    // regardless, because that needs no gesture and no running context.
    await expect(engine.verifyRunning()).resolves.toBe(false);

    expect(audioSession.events).toEqual(['session:playback']);
  });

  it('fades and stops a released voice before cleaning up on ended', () => {
    const { engine } = readyEngine();
    engine.noteOn('C4', 60);
    const note = engine.activeNotes.get('C4')!;
    const voice = note.voices[0];
    engine.noteOff('C4');

    expect(voice.gain.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, 12.2);
    expect(voice.source.stop).toHaveBeenCalledWith(12.2);
    expect(engine.activeNotes.has('C4')).toBe(false);
    expect(engine.voices.has(note)).toBe(true);

    voice.source.onended!({} as Event);
    expect(engine.voices.has(note)).toBe(false);
    expect(voice.source.disconnect).toHaveBeenCalledOnce();
    expect(voice.gain.disconnect).toHaveBeenCalledOnce();
  });

  it('allows a re-pressed key to overlap its releasing voice', () => {
    const { engine } = readyEngine();
    engine.noteOn('C4', 60);
    const first = engine.activeNotes.get('C4')!;
    engine.noteOff('C4');
    engine.noteOn('C4', 60);
    const second = engine.activeNotes.get('C4')!;

    expect(second).not.toBe(first);
    expect(first.voices[0].source.stop).toHaveBeenCalledWith(12.2);
    first.voices[0].source.onended!({} as Event);
    expect(engine.activeNotes.get('C4')).toBe(second);
    expect(engine.voices.has(second)).toBe(true);
  });

  it('hard-stops both held and released voices for all-notes-off cleanup', () => {
    const { engine } = readyEngine();
    engine.noteOn('C4', 60);
    const released = engine.activeNotes.get('C4')!;
    engine.noteOff('C4');
    engine.noteOn('E4', 64);
    const held = engine.activeNotes.get('E4')!;
    const releasedSource = released.voices[0].source;
    const heldSource = held.voices[0].source;

    engine.allNotesOff();
    expect(releasedSource.stop).toHaveBeenLastCalledWith(0);
    expect(heldSource.stop).toHaveBeenLastCalledWith(0);
    expect(engine.voices.size).toBe(0);
    expect(engine.activeNotes.size).toBe(0);
  });

  it('calls resume on each ensureRunning when suspended (no promise caching)', async () => {
    let resumeCalls = 0;
    class DeferredAudioContext extends FakeAudioContext {
      async resume() {
        resumeCalls += 1;
        // Defer the state change so both ensureRunning calls see 'suspended'.
        await new Promise(resolve => setTimeout(resolve, 10));
        this.state = 'running';
        this.onstatechange?.({} as Event);
      }
    }
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('window', { AudioContext: DeferredAudioContext });
    const engine = new PianoAudioEngine();
    await engine.init();

    // Each call should attempt resume — no caching that could get stuck.
    engine.ensureRunning();
    engine.ensureRunning();

    expect(resumeCalls).toBe(2);
    await vi.waitFor(() => expect(engine.ctx?.state).toBe('running'));
  });

  it('flushes queued notes when the context transitions to running', async () => {
    const { engine, createdSources } = readyEngine();
    const ctx = engine.ctx as unknown as FakeAudioContext;
    ctx.onstatechange = () => (engine as unknown as { _handleStateChange(): void })._handleStateChange();
    ctx.state = 'suspended';
    engine.noteOn('C4', 60);
    expect(createdSources).toHaveLength(0);

    ctx.state = 'running';
    ctx.onstatechange?.({} as Event);

    expect(createdSources).toHaveLength(1);
    expect(engine.queuedNotes.size).toBe(0);
  });

  it('rebuilds held voices on resume without double-starting notes', async () => {
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    const engine = new PianoAudioEngine();
    await engine.init();
    const ctx = engine.ctx as unknown as FakeAudioContext;
    // Simulate a loaded engine with playing notes.
    engine.sampleBuffer = {} as AudioBuffer;
    engine.zones = [{ loKey: 0, hiKey: 127, rootKey: 60, offsetSeconds: 0, durationSeconds: 1 }];
    engine.loaded = true;
    const createdSources: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
    (ctx as unknown as Record<string, unknown>).createBufferSource = vi.fn(() => {
      const source = {
        buffer: null, playbackRate: { value: 0 },
        connect: vi.fn(), disconnect: vi.fn(),
        start: vi.fn(), stop: vi.fn(), onended: null,
      };
      createdSources.push(source);
      return source;
    });
    (ctx as unknown as Record<string, unknown>).createGain = vi.fn(() => ({
      gain: { value: 0, cancelScheduledValues: vi.fn(), setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
      connect: vi.fn(), disconnect: vi.fn(),
    }));
    engine.masterGain = {} as GainNode;

    // Start two notes while running.
    ctx.state = 'running';
    engine.noteOn('C4', 60);
    engine.noteOn('E4', 64);
    expect(createdSources).toHaveLength(2);

    // Simulate iOS suspending the context.
    ctx.state = 'suspended';

    // Resume via ensureRunning — should stop old voices and rebuild from held.
    engine.ensureRunning();
    await vi.waitFor(() => expect(engine.ctx?.state).toBe('running'));
    // Wait for the rebuild + flush microtask.
    await vi.waitFor(() => expect(createdSources.length).toBe(4));

    // Two original voices stopped, two rebuilt from held snapshot.
    expect(engine.voices.size).toBe(2);
    expect(engine.queuedNotes.size).toBe(0);
  });

  it('replaces a context that claims to run after its clock has frozen', async () => {
    vi.useFakeTimers();
    const { engine, first } = await stalledEngine();
    expect(first.sources).toHaveLength(1);

    // The phone locks: iOS keeps saying 'running' but stops rendering.
    vi.advanceTimersByTime(60_000);
    engine.ensureRunning();

    const replacement = StallableAudioContext.instances[1];
    expect(StallableAudioContext.instances).toHaveLength(2);
    expect(engine.ctx).toBe(replacement as unknown as AudioContext);
    expect(first.close).toHaveBeenCalledOnce();
    // The key still under a finger sounds again on the new context, and the
    // decoded sample is reused rather than fetched a second time.
    expect(replacement.sources).toHaveLength(1);
    expect(engine.sampleBuffer).not.toBeNull();
    expect(engine.queuedNotes.size).toBe(0);
    expect(engine.activeNotes.has('C4')).toBe(true);
    expect(engine.state).toBe('ready');
  });

  it('leaves a context alone when its clock is still advancing', async () => {
    vi.useFakeTimers();
    const { engine, first } = await stalledEngine();

    vi.advanceTimersByTime(60_000);
    first.currentTime = 60;
    engine.ensureRunning();

    expect(engine.ctx).toBe(first as unknown as AudioContext);
    expect(first.close).not.toHaveBeenCalled();
  });

  it('does not accuse a working context on two gestures in quick succession', async () => {
    vi.useFakeTimers();
    const { engine, first } = await stalledEngine();

    // Well inside one render quantum, so a healthy clock has not moved either.
    vi.advanceTimersByTime(10);
    engine.ensureRunning();

    expect(engine.ctx).toBe(first as unknown as AudioContext);
    expect(first.close).not.toHaveBeenCalled();
  });

  it('clears a stalled context on returning to the foreground', async () => {
    vi.useFakeTimers();
    const { engine, first } = await stalledEngine();

    const verified = engine.verifyRunning();
    await vi.advanceTimersByTimeAsync(750);

    await expect(verified).resolves.toBe(true);
    expect(engine.ctx).not.toBe(first as unknown as AudioContext);
    expect(first.close).toHaveBeenCalledOnce();
    expect(engine.activeNotes.has('C4')).toBe(true);
  });

  it('keeps the context when audio restarts partway through the probe', async () => {
    vi.useFakeTimers();
    const { engine, first } = await stalledEngine();

    const verified = engine.verifyRunning();
    // iOS takes its time restoring the audio unit, but it does restore it.
    await vi.advanceTimersByTimeAsync(250);
    first.currentTime = 0.5;
    await vi.advanceTimersByTimeAsync(500);

    await expect(verified).resolves.toBe(false);
    expect(engine.ctx).toBe(first as unknown as AudioContext);
    expect(first.close).not.toHaveBeenCalled();
  });

  it('waits for the sample to finish loading before replacing a stalled context', async () => {
    vi.useFakeTimers();
    const { engine, first } = await stalledEngine();
    engine.loading = true;

    vi.advanceTimersByTime(60_000);
    engine.ensureRunning();

    // Replacing the context here would abort the in-flight decode.
    expect(engine.ctx).toBe(first as unknown as AudioContext);
    expect(first.close).not.toHaveBeenCalled();

    // Once the load settles, the deferred replacement happens on its own.
    vi.stubGlobal('document', { baseURI: 'https://example.test/app/' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(responseWith()));
    engine.loaded = false;
    engine.loading = false;
    await engine.loadSampleLibrary('./piano.m4a', engine.zones);

    expect(first.decodeAudioData).toHaveBeenCalledOnce();
    expect(engine.sampleBuffer).not.toBeNull();
    expect(engine.ctx).not.toBe(first as unknown as AudioContext);
    expect(first.close).toHaveBeenCalledOnce();
  });

  it('leaves a suspended context to the next gesture instead of replacing it', async () => {
    vi.useFakeTimers();
    const { engine, first } = await stalledEngine();
    first.state = 'suspended';

    await expect(engine.verifyRunning()).resolves.toBe(false);
    expect(engine.ctx).toBe(first as unknown as AudioContext);
    expect(first.close).not.toHaveBeenCalled();
  });

  it('marks awaitingGesture when the context is interrupted', () => {
    const { engine } = readyEngine();
    const ctx = engine.ctx as unknown as FakeAudioContext;
    ctx.state = 'interrupted' as AudioContextState;
    (engine as unknown as { _handleStateChange(): void })._handleStateChange();
    expect(engine.state).toBe('awaitingGesture');
  });
});

describe('PianoAudioEngine output tap', () => {
  /** One press, then far enough past the probe delay for the reading to land. */
  function playAndProbe(engine: PianoAudioEngine, keyId: string) {
    engine.noteOn(keyId, 60);
    vi.advanceTimersByTime(500);
  }

  it('measures the peak the graph is really rendering', async () => {
    vi.useFakeTimers();
    const { engine, first } = await stalledEngine();
    first.tapPeak = 0.42;

    expect(engine.measureOutputPeak()).toBeCloseTo(0.42);
    expect(engine.describeOutput().outputTap).toBe('unproven');

    playAndProbe(engine, 'D4');
    const measured = engine.describeOutput();
    expect(measured.outputTap).toBe('proven');
    // Read back through a Float32 buffer, so exact equality is not on offer.
    expect(measured.outputPeak).toBeCloseTo(0.42);
  });

  it('replaces a context that keeps rendering silence once the tap has proved itself', async () => {
    vi.useFakeTimers();
    const { engine, first } = await stalledEngine();
    // The tap sees sound, so a later zero is a claim about the audio and not
    // about a browser that never renders the tap.
    first.tapPeak = 0.5;
    playAndProbe(engine, 'D4');

    first.tapPeak = 0;
    for (const keyId of ['E4', 'F4', 'G4']) playAndProbe(engine, keyId);

    expect(StallableAudioContext.instances).toHaveLength(2);
    expect(engine.ctx).toBe(StallableAudioContext.instances[1] as unknown as AudioContext);
    expect(first.close).toHaveBeenCalledOnce();
  });

  it('leaves a context alone while the tap still reads signal', async () => {
    vi.useFakeTimers();
    const { engine, first } = await stalledEngine();
    first.tapPeak = 0.3;

    for (const keyId of ['D4', 'E4', 'F4', 'G4']) playAndProbe(engine, keyId);

    expect(StallableAudioContext.instances).toHaveLength(1);
    expect(first.close).not.toHaveBeenCalled();
  });

  it('never accuses a context on readings from a tap that has never seen sound', async () => {
    vi.useFakeTimers();
    const { engine, first } = await stalledEngine();
    // A browser that does not render a side-tapped analyser reads zero forever.
    first.tapPeak = 0;

    for (const keyId of ['D4', 'E4', 'F4', 'G4', 'A4']) playAndProbe(engine, keyId);

    expect(StallableAudioContext.instances).toHaveLength(1);
    expect(first.close).not.toHaveBeenCalled();
    expect(engine.describeOutput()).toMatchObject({ outputTap: 'unproven', silentReadings: 0 });
  });

  it('reports the tap as unavailable when the analyser node is missing', () => {
    const { engine } = readyEngine();

    expect(engine.outputTap).toBeNull();
    expect(engine.measureOutputPeak()).toBeNull();
    expect(engine.describeOutput().outputTap).toBe('unavailable');
  });
});
