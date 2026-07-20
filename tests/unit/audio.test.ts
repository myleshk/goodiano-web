import { afterEach, describe, expect, it, vi } from 'vitest';
import { PianoAudioEngine } from '../../js/app/audio';
import type { SampleZone } from '../../js/app/audio';
import { YAMAHA_U1_ZONES } from '../../js/app/sample-zones';

class FakeAudioContext {
  state: AudioContextState = 'suspended';
  destination = {};
  createGain() {
    return { gain: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() };
  }
  async resume() { this.state = 'running'; }
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

  it('uses the first zone for the intentional MIDI 102 overlap', () => {
    const { engine, createdSources } = readyEngine(YAMAHA_U1_ZONES);
    engine.noteOn('F#7', 102);
    expect(createdSources[0].start).toHaveBeenCalledWith(
      0,
      YAMAHA_U1_ZONES[12].offsetSeconds,
      YAMAHA_U1_ZONES[12].durationSeconds,
    );
  });

  it('applies velocity to each note gain', () => {
    const { engine, createdGains } = readyEngine();
    engine.noteOn('C4', 60, 64);
    expect(createdGains[0].gain.value).toBeCloseTo(64 / 127);
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
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    const engine = new PianoAudioEngine();
    expect(await engine.ensureRunning()).toBe(true);
    expect(engine.ctx?.state).toBe('running');
  });

  it('fades and stops a released voice before cleaning up on ended', () => {
    const { engine } = readyEngine();
    engine.noteOn('C4', 60);
    const voice = engine.activeNotes.get('C4')!;
    engine.noteOff('C4');

    expect(voice.gain.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, 12.2);
    expect(voice.source.stop).toHaveBeenCalledWith(12.2);
    expect(engine.activeNotes.has('C4')).toBe(false);
    expect(engine.voices.has(voice)).toBe(true);

    voice.source.onended!({} as Event);
    expect(engine.voices.has(voice)).toBe(false);
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
    expect(first.source.stop).toHaveBeenCalledWith(12.2);
    first.source.onended!({} as Event);
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

    engine.allNotesOff();
    expect(released.source.stop).toHaveBeenLastCalledWith(0);
    expect(held.source.stop).toHaveBeenLastCalledWith(0);
    expect(engine.voices.size).toBe(0);
    expect(engine.activeNotes.size).toBe(0);
  });
});
