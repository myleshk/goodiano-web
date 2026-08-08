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
  engine.ctx = {
    state: 'running',
    currentTime: 12,
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
  return { engine, createdSources, createdGains };
}

afterEach(() => vi.unstubAllGlobals());

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
    const audioSession = {
      set type(value: string) { events.push(`session:${value}`); },
    };
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

  it('applies velocity to each note gain', () => {
    const { engine, createdGains } = readyEngine();
    engine.noteOn('C4', 60, 64);
    expect(createdGains[0].gain.value).toBeCloseTo(64 / 127);
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
    const audioSession = {
      set type(value: string) { events.push(`session:${value}`); },
    };
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
    expect(events).toEqual(['session:playback', 'session:playback', 'resume']);
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

  it('marks awaitingGesture when the context is interrupted', () => {
    const { engine } = readyEngine();
    const ctx = engine.ctx as unknown as FakeAudioContext;
    ctx.state = 'interrupted' as AudioContextState;
    (engine as unknown as { _handleStateChange(): void })._handleStateChange();
    expect(engine.state).toBe('awaitingGesture');
  });
});
