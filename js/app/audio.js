/**
 * Goodiano Audio Engine
 * Lightweight SF2 parser + Web Audio API polyphonic playback.
 * Port of PianoAudioEngine.swift
 */

const MIDI_CHANNEL = 0;
const DEFAULT_VELOCITY = 100;
const MASTER_GAIN = 10; // Amplified to match iOS engine volume

class PianoAudioEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.samples = null;      // Map: sampleIndex -> AudioBuffer
    this.zones = [];          // [{ loKey, hiKey, sampleIndex, rootKey, sampleRate }]
    this.activeNotes = new Map(); // keyId -> { source, gain, midiNote }
    this.loaded = false;
    this.loading = false;
  }

  /**
   * Initialize AudioContext (must be called from user gesture on iOS)
   */
  async init() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = MASTER_GAIN;
    this.masterGain.connect(this.ctx.destination);
  }

  /**
   * Load and parse SF2 file
   * @param {string} url - path to .sf2 file
   * @returns {Promise<void>}
   */
  async loadSoundFont(url) {
    if (this.loaded || this.loading) return;
    this.loading = true;

    await this.init();
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();
    const data = new DataView(buffer);

    this._parseSF2(data);
    this.loaded = true;
    this.loading = false;
  }

  /**
   * Parse SF2 binary format to extract sample data and zone mappings.
   * SF2 is a RIFF container; we need sdta (sample data) and pdta (instrument defs).
   */
  _parseSF2(data) {
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

    let sampleData = null;
    let sampleHeaders = [];
    let instrumentZones = [];

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
          // Parse pdta sub-chunks
          while (offset < listEnd) {
            const subID = readFourCC();
            const subSize = readU32();
            const subEnd = offset + subSize;

            if (subID === 'shdr') {
              // Sample headers: 46 bytes each (last is terminal EOS record)
              const count = Math.floor(subSize / 46) - 1;
              for (let i = 0; i < count; i++) {
                const base = offset;
                const nameBytes = new Uint8Array(data.buffer, data.byteOffset + base, 20);
                const name = textDecoder.decode(nameBytes).replace(/\0/g, '');
                sampleHeaders.push({
                  name,
                  start: data.getUint32(base + 20, true),
                  end: data.getUint32(base + 24, true),
                  startLoop: data.getUint32(base + 28, true),
                  endLoop: data.getUint32(base + 32, true),
                  sampleRate: data.getUint32(base + 36, true),
                  originalPitch: data.getUint8(base + 40),
                  pitchCorrection: data.getInt8(base + 41),
                });
                offset += 46;
              }
              offset += 46; // skip terminal record
            } else if (subID === 'inst') {
              // Instrument headers: we need to find the first instrument's bag index
              // Format: achInstName(20) + wInstBagNdx(2) = 22 bytes
              const count = Math.floor(subSize / 22);
              const base = offset;
              const nameBytes = new Uint8Array(data.buffer, data.byteOffset + base, 20);
              const bagIdx = data.getUint16(base + 20, true);
              // Just read first instrument
              if (count > 0) {
                this._firstInstBagIdx = bagIdx;
              }
              offset = subEnd;
            } else if (subID === 'ibag') {
              // Instrument bags: 4 bytes each
              const base = offset;
              const count = Math.floor(subSize / 4);
              // Parse generator indices for the first instrument's bags
              const instBagStart = this._firstInstBagIdx || 0;
              for (let i = instBagStart; i < count; i++) {
                const genIdx = data.getUint16(base + i * 4, true);
                // modIdx = data.getUint16(base + i * 4 + 2, true);
                instrumentZones.push({ genIdx, keyRange: null, sampleID: null, rootKey: null });
                // Stop when next bag has a different zone (terminator bag has genIdx pointing to end)
                if (i > instBagStart && genIdx === 0) break;
              }
              offset = subEnd;
            } else if (subID === 'igen') {
              // Instrument generators: 4 bytes each (sfGenOper:2 + genAmount:2)
              const base = offset;
              // Fill in generator values for each zone
              for (const zone of instrumentZones) {
                let idx = zone.genIdx;
                while (true) {
                  const genOper = data.getUint16(base + idx * 4, true);
                  const amount = data.getUint16(base + idx * 4 + 2, true);
                  idx++;

                  // 43 = keyRange: loKey | (hiKey << 8)
                  if (genOper === 43) {
                    zone.keyRange = {
                      lo: amount & 0xFF,
                      hi: (amount >> 8) & 0xFF,
                    };
                  }
                  // 53 = sampleID
                  else if (genOper === 53) {
                    zone.sampleID = amount;
                  }
                  // 58 = overridingRootKey
                  else if (genOper === 58) {
                    zone.rootKey = amount;
                  }

                  // Generator terminator: genOper = 0 (but for instrument zones, this is often
                  // indicated by the next zone's genIdx or an explicit 0 genOper)
                  if (genOper === 0) break;
                  // Safety: don't run forever
                  if ((idx - zone.genIdx) > 20) break;
                }
              }
              offset = subEnd;
            } else {
              offset = subEnd;
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
      .filter(z => z.keyRange && z.sampleID != null && z.sampleID < sampleHeaders.length)
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
  _createBuffers(sampleData, sampleHeaders) {
    const uniqueSampleIndices = new Set(this.zones.map(z => z.sampleIndex));
    this.samples = new Map();

    for (const idx of uniqueSampleIndices) {
      const sh = sampleHeaders[idx];
      if (!sh || sh.end <= sh.start || sh.sampleRate === 0) continue;

      const length = sh.end - sh.start;
      if (length <= 0) continue;

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
  _findZone(midiNote) {
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
  noteOn(keyId, midiNote) {
    if (!this.ctx || !this.samples) return;

    // Resume context if suspended (iOS requires user gesture)
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }

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
    gainNode.gain.value = 1.0;
    gainNode.connect(this.masterGain);

    source.connect(gainNode);
    source.start(0);

    // Store for noteOff
    this.activeNotes.set(keyId, { source, gain: gainNode, midiNote: clampedNote });
  }

  /**
   * Stop playing a note
   * @param {string} keyId
   */
  noteOff(keyId) {
    const note = this.activeNotes.get(keyId);
    if (!note) return;

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
  allNotesOff() {
    for (const [keyId] of this.activeNotes) {
      this.noteOff(keyId);
    }
  }

  /**
   * Check if engine is ready to play
   */
  isReady() {
    return this.loaded && this.ctx && this.ctx.state !== 'closed';
  }
}

export { PianoAudioEngine };
