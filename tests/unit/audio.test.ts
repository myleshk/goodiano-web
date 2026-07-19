import { afterEach, describe, expect, it, vi } from 'vitest';
import { PianoAudioEngine } from '../../js/app/audio';

class FakeAudioContext {
  state: AudioContextState = 'suspended';
  destination = {};
  createGain() {
    return { gain: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() };
  }
  async resume() { this.state = 'running'; }
}

function readyEngine() {
  const engine = new PianoAudioEngine();
  const source = () => ({
    buffer: null,
    playbackRate: { value: 0 },
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    onended: null as (() => void) | null,
  });
  const sources = [source(), source()];
  const gains = [
    { gain: { value: 0, cancelScheduledValues: vi.fn(), setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() },
    { gain: { value: 0, cancelScheduledValues: vi.fn(), setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() },
  ];
  engine.ctx = {
    state: 'running',
    currentTime: 12,
    createBufferSource: vi.fn(() => sources.shift()!),
    createGain: vi.fn(() => gains.shift()!),
  } as unknown as AudioContext;
  engine.masterGain = { } as GainNode;
  engine.samples = new Map([[0, {} as AudioBuffer]]);
  engine.zones = [{ loKey: 0, hiKey: 127, sampleIndex: 0, rootKey: 60, sampleRate: 44100, sampleStart: 0, sampleEnd: 1 }];
  return { engine, sources, gains };
}

afterEach(() => vi.unstubAllGlobals());

describe('PianoAudioEngine lifecycle', () => {
  it('reports fetch failures and remains retryable', async () => {
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    vi.stubGlobal('document', { baseURI: 'https://example.test/app/' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const engine = new PianoAudioEngine();

    await expect(engine.loadSoundFont('./assets/piano.sf2')).rejects.toThrow('(503)');
    expect(engine.state).toBe('error');
    expect(engine.loading).toBe(false);
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
