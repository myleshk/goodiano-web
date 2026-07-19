/**
 * Goodiano Audio Engine
 * Lightweight SF2 parser + Web Audio API polyphonic playback.
 * Port of PianoAudioEngine.swift
 */

const MIDI_CHANNEL = 0;
const DEFAULT_VELOCITY = 100;
const MASTER_GAIN = 10; // Amplified to match iOS engine volume

type AudioEngineState = 'loading' | 'awaitingGesture' | 'ready' | 'error';
interface NoteRequest { keyId: string; midiNote: number; velocity: number }
interface ActiveNote { source: AudioBufferSourceNode; gain: GainNode; midiNote: number }
interface SoundFontZone {
  loKey: number; hiKey: number; sampleIndex: number; rootKey: number;
  sampleRate: number; sampleStart: number; sampleEnd: number;
}
interface SampleHeader {
  name: string; start: number; end: number; startLoop: number; endLoop: number;
  sampleRate: number; originalPitch: number; pitchCorrection: number;
}
interface KeyRange { lo: number; hi: number }
interface InstrumentZone { keyRange: KeyRange; sampleID: number; rootKey: number | null }
interface DraftZone { keyRange: KeyRange | null; sampleID: number | null; rootKey: number | null }
interface RawChunk { base: number; size: number }
interface InstrumentBag { name: string; bagIdx: number }
interface BagEntry { genIdx: number; modIdx: number }
interface GeneratorEntry { oper: number; amount: number }
interface WebKitAudioWindow extends Window { webkitAudioContext?: typeof AudioContext }

class PianoAudioEngine {
  ctx: AudioContext | null = null;
  masterGain: GainNode | null = null;
  samples: Map<number, AudioBuffer> | null = null;
  zones: SoundFontZone[] = [];
  activeNotes = new Map<string, ActiveNote>();
  queuedNotes = new Map<string, NoteRequest>();
  heldNotes = new Map<string, NoteRequest>();
  loaded = false;
  loading = false;
  state: AudioEngineState = 'loading';

  constructor() {
  }

  /**
   * Initialize AudioContext (must be called from user gesture on iOS)
   */
  async init(): Promise<AudioContext> {
    if (this.ctx) return this.ctx;
    const AudioContextClass = window.AudioContext || (window as WebKitAudioWindow).webkitAudioContext;
    if (!AudioContextClass) {
      this.state = 'error';
      throw new Error('Web Audio is unavailable in this browser');
    }
    this.ctx = new AudioContextClass();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = MASTER_GAIN;
    this.masterGain.connect(this.ctx.destination);
    this.state = this.ctx.state === 'running' ? 'ready' : 'awaitingGesture';
    return this.ctx;
  }

  async ensureRunning(): Promise<boolean> {
    const ctx = await this.init();
    if (ctx.state === 'closed') throw new Error('AudioContext is closed');
    const wasRunning = ctx.state === 'running';
    if (ctx.state !== 'running') await ctx.resume();
    if (ctx.state === 'running') {
      this.state = this.loaded ? 'ready' : 'loading';
      // Safari can suspend a context while fingers are still down. Rebuild
      // those voices from the held-key snapshot after resuming.
      if (!wasRunning) {
        for (const [keyId, active] of this.activeNotes) this._stopNote(keyId, active);
        for (const note of this.heldNotes.values()) this.queuedNotes.set(note.keyId, note);
        this._flushQueuedNotes();
      }
    } else {
      this.state = 'awaitingGesture';
    }
    return ctx.state === 'running';
  }

  /**
   * Load and parse SF2 file
   * @param {string} url - path to .sf2 file
   * @returns {Promise<void>}
   */
  async loadSoundFont(url: string): Promise<void> {
    if (this.loaded || this.loading) return;
    this.loading = true;
    try {
      const ctx = await this.init();
      const response = await fetch(new URL(url, document.baseURI));
      if (!response.ok) throw new Error(`SoundFont request failed (${response.status})`);
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength < 12) throw new Error('SoundFont response is empty or truncated');
      this._parseSF2(new DataView(buffer));
      this.loaded = true;
      this.state = ctx.state === 'running' ? 'ready' : 'awaitingGesture';
      this._flushQueuedNotes();
    } catch (error) {
      this.state = 'error';
      throw error;
    } finally {
      this.loading = false;
    }
  }

  /**
   * Parse SF2 binary format to extract sample data and zone mappings.
   * SF2 is a RIFF container; we need sdta (sample data) and pdta (instrument defs).
   */
  _parseSF2(data: DataView): void {
    const textDecoder = new TextDecoder('ascii');

    // --- Read RIFF structure into a chunk map ---
    let offset = 0;

    function readFourCC() {
      const s = textDecoder.decode(new Uint8Array(data.buffer, data.byteOffset + offset, 4));
      offset += 4;
      return s;
    }

    function readU32() {
      const v = data.getUint32(offset, true);
      offset += 4;
      return v;
    }

    function readU16() {
      const v = data.getUint16(offset, true);
      offset += 4; // igen/ibag use 4-byte records with 2-byte payload
      return v;
    }

    function readU8() {
      return data.getUint8(offset++);
    }

    function readI8() {
      return data.getInt8(offset++);
    }

    // Verify RIFF header
    const riff = readFourCC();
    if (riff !== 'RIFF') throw new Error('Not a RIFF file');
    readU32(); // file size
    const sfbk = readFourCC();
    if (sfbk !== 'sfbk') throw new Error('Not a SoundFont file');

    let sampleData: Int16Array<ArrayBufferLike> | null = null;
    const sampleHeaders: SampleHeader[] = [];
    const instrumentZones: InstrumentZone[] = [];

    // Walk top-level chunks
    while (offset < data.byteLength) {
      const ckID = readFourCC();
      const ckSize = readU32();

      if (ckID === 'LIST') {
        const listType = readFourCC();
        const listEnd = offset + ckSize - 4;

        if (listType === 'sdta') {
          // Parse sdta sub-chunks
          while (offset < listEnd) {
            const subID = readFourCC();
            const subSize = readU32();
            if (subID === 'smpl') {
              sampleData = new Int16Array(data.buffer, data.byteOffset + offset, subSize / 2);
            }
            offset += subSize;
          }
        } else if (listType === 'pdta') {
          // Parse pdta: collect all sub-chunks into raw arrays first,
          // then build zones by walking instrument → bag → generator chains.
          const pdtaStart = offset - 4; // rewind past 'pdta' FOURCC for raw access
          const pdtaRaw: Record<string, RawChunk | null> = { shdr: null, inst: null, ibag: null, igen: null };

          while (offset < listEnd) {
            const subID = readFourCC();
            const subSize = readU32();
            pdtaRaw[subID] = { base: offset, size: subSize };
            offset += subSize;
          }

          // --- Parse shdr (sample headers): 46 bytes each, last is terminal EOS ---
          if (pdtaRaw.shdr) {
            const { base, size } = pdtaRaw.shdr;
            const count = Math.floor(size / 46) - 1;
            for (let i = 0; i < count; i++) {
              const b = base + i * 46;
              const nameBytes = new Uint8Array(data.buffer, data.byteOffset + b, 20);
              sampleHeaders.push({
                name: textDecoder.decode(nameBytes).replace(/\0/g, ''),
                start: data.getUint32(b + 20, true),
                end: data.getUint32(b + 24, true),
                startLoop: data.getUint32(b + 28, true),
                endLoop: data.getUint32(b + 32, true),
                sampleRate: data.getUint32(b + 36, true),
                originalPitch: data.getUint8(b + 40),
                pitchCorrection: data.getInt8(b + 41),
              });
            }
          }

          // --- Parse inst (instrument headers): 22 bytes each ---
          const instBags: InstrumentBag[] = [];
          if (pdtaRaw.inst) {
            const { base, size } = pdtaRaw.inst;
            const count = Math.floor(size / 22);
            for (let i = 0; i < count; i++) {
              const b = base + i * 22;
              const nameBytes = new Uint8Array(data.buffer, data.byteOffset + b, 20);
              instBags.push({
                name: textDecoder.decode(nameBytes).replace(/\0/g, ''),
                bagIdx: data.getUint16(b + 20, true),
              });
            }
          }

          // --- Parse ibag (instrument bags): 4 bytes each ---
          const bagEntries: BagEntry[] = [];
          if (pdtaRaw.ibag) {
            const { base, size } = pdtaRaw.ibag;
            const count = Math.floor(size / 4);
            for (let i = 0; i < count; i++) {
              const b = base + i * 4;
              bagEntries.push({
                genIdx: data.getUint16(b, true),
                modIdx: data.getUint16(b + 2, true),
              });
            }
          }

          // --- Parse igen (instrument generators): 4 bytes each ---
          const genEntries: GeneratorEntry[] = [];
          if (pdtaRaw.igen) {
            const { base, size } = pdtaRaw.igen;
            const count = Math.floor(size / 4);
            for (let i = 0; i < count; i++) {
              const b = base + i * 4;
              genEntries.push({
                oper: data.getUint16(b, true),
                amount: data.getUint16(b + 2, true),
              });
            }
          }

          // --- Build zones: for each instrument, iterate its bags & generators ---
          for (let iIdx = 0; iIdx < instBags.length; iIdx++) {
            const inst = instBags[iIdx];
            const nextBagIdx = (iIdx + 1 < instBags.length) ? instBags[iIdx + 1].bagIdx : bagEntries.length;
            if (inst.bagIdx >= nextBagIdx) continue; // skip empty/terminal instruments

            const globalGen: Record<number, number> = {}; // accumulated global generators

            for (let bIdx = inst.bagIdx; bIdx < nextBagIdx; bIdx++) {
              const bag = bagEntries[bIdx];
              if (!bag || bag.genIdx >= genEntries.length) continue;

              const zone: DraftZone = { keyRange: null, sampleID: null, rootKey: null };
              const genEnd = (bIdx + 1 < nextBagIdx) ? bagEntries[bIdx + 1].genIdx : genEntries.length;
              let isGlobal = true;

              for (let gIdx = bag.genIdx; gIdx < genEnd; gIdx++) {
                const gen = genEntries[gIdx];
                if (gen.oper === 0) break;
                if (gen.oper === 43) {
                  zone.keyRange = { lo: gen.amount & 0xFF, hi: (gen.amount >> 8) & 0xFF };
                  isGlobal = false;
                } else if (gen.oper === 53) {
                  zone.sampleID = gen.amount;
                  isGlobal = false;
                } else if (gen.oper === 58) {
                  zone.rootKey = gen.amount;
                  isGlobal = false;
                } else {
                  // Global-ish generator (e.g., volume, pan, reverb)
                  globalGen[gen.oper] = gen.amount;
                }
                if (gIdx - bag.genIdx > 30) break;
              }

              if (isGlobal) continue; // global zone, skip

              // Merge global generators into zone fallbacks
              if (!zone.keyRange && globalGen[43]) {
                const a = globalGen[43];
                zone.keyRange = { lo: a & 0xFF, hi: (a >> 8) & 0xFF };
              }
              if (zone.sampleID == null && globalGen[53] != null) {
                zone.sampleID = globalGen[53];
              }
              if (!zone.rootKey && globalGen[58]) {
                zone.rootKey = globalGen[58];
              }

              if (zone.keyRange && zone.sampleID != null) {
                instrumentZones.push({ keyRange: zone.keyRange, sampleID: zone.sampleID, rootKey: zone.rootKey });
              }
            }
          }
        } else {
          offset = listEnd;
        }
      } else {
        offset += ckSize;
      }
    }

    if (!sampleData) throw new Error('No sample data found in SF2');

    // Filter zones that have valid keyRange and sampleID
    this.zones = instrumentZones
      .filter(z => z.sampleID < sampleHeaders.length)
      .map(z => ({
        loKey: z.keyRange.lo,
        hiKey: z.keyRange.hi,
        sampleIndex: z.sampleID,
        rootKey: z.rootKey || sampleHeaders[z.sampleID].originalPitch,
        sampleRate: sampleHeaders[z.sampleID].sampleRate,
        sampleStart: sampleHeaders[z.sampleID].start,
        sampleEnd: sampleHeaders[z.sampleID].end,
      }));

    // If no zones found (parsing failed), create fallback: one zone per sample
    if (this.zones.length === 0 && sampleHeaders.length > 20) {
      let midiStart = 21; // A0
      for (let i = 0; i < sampleHeaders.length; i++) {
        const sh = sampleHeaders[i];
        if (sh.end <= sh.start || sh.sampleRate === 0) continue;
        const range = Math.max(1, Math.floor(88 / sampleHeaders.length));
        this.zones.push({
          loKey: midiStart,
          hiKey: Math.min(midiStart + range - 1, 108),
          sampleIndex: i,
          rootKey: sh.originalPitch || midiStart + Math.floor(range / 2),
          sampleRate: sh.sampleRate,
          sampleStart: sh.start,
          sampleEnd: sh.end,
        });
      }
    }

    // Create AudioBuffers for each unique sample
    this._createBuffers(sampleData, sampleHeaders);
  }

  /**
   * Create AudioBuffer for each sample from raw 16-bit PCM data
   */
  _createBuffers(sampleData: Int16Array<ArrayBufferLike>, sampleHeaders: SampleHeader[]): void {
    const uniqueSampleIndices = new Set(this.zones.map(z => z.sampleIndex));
    this.samples = new Map();

    for (const idx of uniqueSampleIndices) {
      const sh = sampleHeaders[idx];
      if (!sh || sh.end <= sh.start || sh.sampleRate === 0) continue;

      const length = sh.end - sh.start;
      if (length <= 0) continue;

      if (!this.ctx) throw new Error('AudioContext is not initialized');
      const buffer = this.ctx.createBuffer(1, length, sh.sampleRate);
      const channel = buffer.getChannelData(0);

      // Convert Int16 PCM to Float32 [-1, 1]
      for (let i = 0; i < length; i++) {
        channel[i] = sampleData[sh.start + i] / 32768.0;
      }

      this.samples.set(idx, buffer);
    }
  }

  /**
   * Find the SF2 zone matching a MIDI note
   */
  _findZone(midiNote: number): SoundFontZone | undefined {
    // Exact match first
    for (const zone of this.zones) {
      if (midiNote >= zone.loKey && midiNote <= zone.hiKey) {
        return zone;
      }
    }
    // Nearest zone fallback
    let nearest = this.zones[0];
    let minDist = Infinity;
    for (const zone of this.zones) {
      const dist = Math.min(
        Math.abs(midiNote - zone.loKey),
        Math.abs(midiNote - zone.hiKey)
      );
      if (dist < minDist) {
        minDist = dist;
        nearest = zone;
      }
    }
    return nearest;
  }

  /**
   * Start playing a note
   * @param {string} keyId - unique key identifier (e.g., "C4")
   * @param {number} midiNote - MIDI note number (0-127)
   */
  noteOn(keyId: string, midiNote: number, velocity = DEFAULT_VELOCITY): void {
    const note = { keyId, midiNote, velocity };
    this.heldNotes.set(keyId, note);
    this.queuedNotes.set(keyId, note);
    if (!this.ctx || !this.samples || this.ctx.state !== 'running') return;
    this._startNote(note);
  }

  _startNote({ keyId, midiNote, velocity = DEFAULT_VELOCITY }: NoteRequest): void {
    if (!this.ctx || !this.samples) return;
    const existing = this.activeNotes.get(keyId);
    if (existing) this._stopNote(keyId, existing);

    const clampedNote = Math.max(0, Math.min(127, midiNote));
    const zone = this._findZone(clampedNote);
    if (!zone) return;

    const buffer = this.samples.get(zone.sampleIndex);
    if (!buffer) return;

    // Calculate playback rate for pitch shifting
    const semitoneDiff = clampedNote - zone.rootKey;
    const playbackRate = Math.pow(2, semitoneDiff / 12);

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = playbackRate;

    // Per-note gain for future velocity support
    const gainNode = this.ctx.createGain();
    gainNode.gain.value = Math.max(0, Math.min(127, velocity)) / 127;
    if (!this.masterGain) return;
    gainNode.connect(this.masterGain);

    source.connect(gainNode);
    source.start(0);

    // Store for noteOff
    this.activeNotes.set(keyId, { source, gain: gainNode, midiNote: clampedNote });
    this.queuedNotes.delete(keyId);
  }

  _flushQueuedNotes(): void {
    if (!this.ctx || this.ctx.state !== 'running' || !this.samples) return;
    for (const note of this.queuedNotes.values()) this._startNote(note);
  }

  /**
   * Stop playing a note
   * @param {string} keyId
   */
  noteOff(keyId: string): void {
    this.heldNotes.delete(keyId);
    this.queuedNotes.delete(keyId);
    const note = this.activeNotes.get(keyId);
    if (!note) return;
    this._stopNote(keyId, note);
  }

  _stopNote(keyId: string, note: ActiveNote): void {
    try {
      note.source.stop(0);
    } catch (e) {
      // Already stopped — ignore
    }
    note.source.disconnect();
    note.gain.disconnect();
    this.activeNotes.delete(keyId);
  }

  /**
   * Force stop all active notes (for cleanup)
   */
  allNotesOff(): void {
    this.heldNotes.clear();
    this.queuedNotes.clear();
    for (const [keyId, note] of this.activeNotes) this._stopNote(keyId, note);
  }

  /**
   * Check if engine is ready to play
   */
  isReady(): boolean {
    return this.state === 'ready' && this.loaded && this.ctx !== null && this.ctx.state !== 'closed';
  }
}

export { PianoAudioEngine };
export type { AudioEngineState };
