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
});
