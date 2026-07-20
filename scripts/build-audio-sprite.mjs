#!/usr/bin/env node

import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SAMPLE_RATE = 44_100;
const AAC_FRAME_LENGTH = 1_024;
const GUARD_FRAMES = 2_048;
const PIANO_LO_KEY = 21;
const PIANO_HI_KEY = 108;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(scriptDir, '..');
const inputPath = process.argv[2] && resolve(process.argv[2]);
const audioPath = resolve(projectDir, 'public/assets/yamaha-u1.m4a');
const metadataPath = resolve(projectDir, 'js/app/sample-zones.ts');

if (!inputPath) {
  console.error('Usage: npm run audio:generate -- /path/to/yamaha-u1.sf2');
  process.exit(2);
}

function fourCC(buffer, offset) {
  return buffer.toString('ascii', offset, offset + 4);
}

function listChunks(buffer, start, end) {
  const chunks = [];
  for (let offset = start; offset + 8 <= end;) {
    const id = fourCC(buffer, offset);
    const size = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > end) throw new Error(`Truncated ${id} chunk`);
    chunks.push({ id, start: dataStart, end: dataEnd, size });
    offset = dataEnd + (size & 1);
  }
  return chunks;
}

function parseSoundFont(buffer) {
  if (fourCC(buffer, 0) !== 'RIFF' || fourCC(buffer, 8) !== 'sfbk') {
    throw new Error('Input is not a SoundFont RIFF file');
  }

  let sampleData = null;
  const pdta = new Map();
  for (const chunk of listChunks(buffer, 12, Math.min(buffer.length, buffer.readUInt32LE(4) + 8))) {
    if (chunk.id !== 'LIST' || chunk.size < 4) continue;
    const type = fourCC(buffer, chunk.start);
    const children = listChunks(buffer, chunk.start + 4, chunk.end);
    if (type === 'sdta') {
      const samples = children.find(child => child.id === 'smpl');
      if (samples) sampleData = buffer.subarray(samples.start, samples.end);
    } else if (type === 'pdta') {
      for (const child of children) pdta.set(child.id, child);
    }
  }
  if (!sampleData) throw new Error('SoundFont has no PCM sample data');

  const shdr = pdta.get('shdr');
  const inst = pdta.get('inst');
  const ibag = pdta.get('ibag');
  const igen = pdta.get('igen');
  if (!shdr || !inst || !ibag || !igen) throw new Error('SoundFont is missing instrument tables');

  const samples = [];
  for (let offset = shdr.start; offset + 46 <= shdr.end - 46; offset += 46) {
    samples.push({
      name: buffer.toString('ascii', offset, offset + 20).replace(/\0.*$/, ''),
      start: buffer.readUInt32LE(offset + 20),
      end: buffer.readUInt32LE(offset + 24),
      sampleRate: buffer.readUInt32LE(offset + 36),
      originalPitch: buffer.readUInt8(offset + 40),
      sampleType: buffer.readUInt16LE(offset + 44),
    });
  }

  const instruments = [];
  for (let offset = inst.start; offset + 22 <= inst.end; offset += 22) {
    instruments.push({ bagIndex: buffer.readUInt16LE(offset + 20) });
  }
  const bags = [];
  for (let offset = ibag.start; offset + 4 <= ibag.end; offset += 4) {
    bags.push({ generatorIndex: buffer.readUInt16LE(offset) });
  }
  const generators = [];
  for (let offset = igen.start; offset + 4 <= igen.end; offset += 4) {
    generators.push({ operator: buffer.readUInt16LE(offset), amount: buffer.readUInt16LE(offset + 2) });
  }

  // Match the web player's historic ordered instrument-zone traversal. Stereo
  // pairs are adjacent, so its first-match lookup reaches the left zone only.
  const zones = [];
  for (let instrumentIndex = 0; instrumentIndex + 1 < instruments.length; instrumentIndex++) {
    const firstBag = instruments[instrumentIndex].bagIndex;
    const lastBag = instruments[instrumentIndex + 1].bagIndex;
    const globalGenerators = new Map();
    for (let bagIndex = firstBag; bagIndex < lastBag; bagIndex++) {
      const firstGenerator = bags[bagIndex]?.generatorIndex;
      const lastGenerator = bags[bagIndex + 1]?.generatorIndex ?? generators.length;
      if (firstGenerator == null) continue;
      let keyRange = null;
      let sampleIndex = null;
      let rootKey = null;
      let isGlobal = true;
      for (let generatorIndex = firstGenerator; generatorIndex < lastGenerator; generatorIndex++) {
        const generator = generators[generatorIndex];
        if (!generator || generator.operator === 0) break;
        if (generator.operator === 43) {
          keyRange = { loKey: generator.amount & 0xff, hiKey: generator.amount >>> 8 };
          isGlobal = false;
        } else if (generator.operator === 53) {
          sampleIndex = generator.amount;
          isGlobal = false;
        } else if (generator.operator === 58) {
          rootKey = generator.amount;
          isGlobal = false;
        } else {
          globalGenerators.set(generator.operator, generator.amount);
        }
      }
      if (isGlobal) continue;
      if (!keyRange && globalGenerators.has(43)) {
        const amount = globalGenerators.get(43);
        keyRange = { loKey: amount & 0xff, hiKey: amount >>> 8 };
      }
      if (sampleIndex == null && globalGenerators.has(53)) sampleIndex = globalGenerators.get(53);
      if (rootKey == null && globalGenerators.has(58)) rootKey = globalGenerators.get(58);
      if (!keyRange || sampleIndex == null || !samples[sampleIndex]) continue;
      zones.push({ ...keyRange, sampleIndex, rootKey: rootKey ?? samples[sampleIndex].originalPitch });
    }
  }
  return { sampleData, samples, zones };
}

function firstMatchZones(zones) {
  const selected = [];
  for (const zone of zones) {
    const reachable = Array.from(
      { length: PIANO_HI_KEY - PIANO_LO_KEY + 1 },
      (_, index) => PIANO_LO_KEY + index,
    ).some(note => note >= zone.loKey && note <= zone.hiKey &&
      zones.find(candidate => note >= candidate.loKey && note <= candidate.hiKey) === zone);
    if (reachable) selected.push(zone);
  }
  return selected;
}

function alignUp(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

function writeWave(path, pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  writeFileSync(path, Buffer.concat([header, pcm]));
}

const source = readFileSync(inputPath);
const { sampleData, samples, zones } = parseSoundFont(source);
const selected = firstMatchZones(zones);
if (selected.length !== 14) {
  throw new Error(`Expected 14 first-match zones, found ${selected.length}`);
}

let cursor = 0;
const parts = [];
const generatedZones = [];
for (const zone of selected) {
  const sample = samples[zone.sampleIndex];
  if (sample.sampleRate !== SAMPLE_RATE) {
    throw new Error(`${sample.name} uses ${sample.sampleRate} Hz; expected ${SAMPLE_RATE} Hz`);
  }
  if ((sample.sampleType & 0x7fff) !== 4 && (sample.sampleType & 0x7fff) !== 1) {
    throw new Error(`${sample.name} is not a left-channel or mono sample`);
  }
  const startFrame = alignUp(cursor, AAC_FRAME_LENGTH);
  if (startFrame > cursor) parts.push(Buffer.alloc((startFrame - cursor) * 2));
  const length = sample.end - sample.start;
  const pcm = sampleData.subarray(sample.start * 2, sample.end * 2);
  if (pcm.length !== length * 2 || length <= 0) throw new Error(`Invalid sample range for ${sample.name}`);
  parts.push(pcm);
  generatedZones.push({
    loKey: zone.loKey,
    hiKey: zone.hiKey,
    rootKey: zone.rootKey,
    offsetSeconds: startFrame / SAMPLE_RATE,
    durationSeconds: length / SAMPLE_RATE,
  });
  cursor = startFrame + length + GUARD_FRAMES;
  parts.push(Buffer.alloc(GUARD_FRAMES * 2));
}

const pcm = Buffer.concat(parts);
const tempDir = mkdtempSync(resolve(tmpdir(), 'goodiano-audio-'));
const wavePath = resolve(tempDir, 'yamaha-u1.wav');
const encodedPath = resolve(tempDir, 'yamaha-u1.m4a');
try {
  writeWave(wavePath, pcm);
  const ffmpeg = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', wavePath,
    '-map_metadata', '-1', '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE),
    '-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '128k',
    '-movflags', '+faststart', encodedPath,
  ], { stdio: 'inherit' });
  if (ffmpeg.error) throw ffmpeg.error;
  if (ffmpeg.status !== 0) throw new Error(`FFmpeg exited with status ${ffmpeg.status}`);
  const encodedSize = statSync(encodedPath).size;
  if (encodedSize > 1_500_000) throw new Error(`Encoded sprite is too large (${encodedSize} bytes)`);
  copyFileSync(encodedPath, audioPath);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

const metadata = `// Generated by scripts/build-audio-sprite.mjs. Do not edit by hand.\n` +
  `import type { SampleZone } from './audio';\n\n` +
  `export const YAMAHA_U1_ZONES = ${JSON.stringify(generatedZones, null, 2)} as const satisfies readonly SampleZone[];\n`;
writeFileSync(metadataPath, metadata);

console.log(`Wrote ${audioPath}`);
console.log(`Wrote ${metadataPath}`);
console.log(`${generatedZones.length} zones, ${(pcm.length / 2 / SAMPLE_RATE).toFixed(3)} seconds of PCM`);
