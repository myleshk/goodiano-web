import { readFileSync, readdirSync } from 'node:fs';
import { extname } from 'node:path';

const files = readdirSync('dist', { recursive: true })
  .filter(file => typeof file === 'string')
  .map(file => file.replaceAll('\\', '/'));
const html = readFileSync('dist/index.html', 'utf8');
const worker = readFileSync('dist/sw.js', 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(`Build verification failed: ${message}`);
}

assert(!html.includes('0-1-0'), 'manual version query remains in index.html');
assert(!html.includes('css/main.css'), 'source CSS URL remains in index.html');
assert(!html.includes('js/app/app.ts'), 'source TypeScript URL remains in index.html');

const immutableAssets = files.filter(file => file.startsWith('assets/') && extname(file) !== '.map');
assert(immutableAssets.length > 0, 'no immutable assets were emitted');
for (const file of immutableAssets) {
  assert(/-[A-Za-z0-9_-]{8,}\.[^.]+$/.test(file), `${file} is not content-hashed`);
}

for (const forbidden of [
  'manifest.en.json', 'manifest.zh-CN.json', 'manifest.zh-TW.json',
  'assets/yamaha-u1.m4a', 'assets/icons/icon-180.png',
  'assets/icons/icon-192.png', 'assets/icons/icon-512.png',
]) {
  assert(!files.includes(forbidden), `stable public asset was copied: ${forbidden}`);
}

for (const locale of ['en', 'zh-CN', 'zh-TW']) {
  const manifestFile = immutableAssets.find(file => file.startsWith(`assets/manifest-${locale}-`));
  assert(manifestFile, `missing hashed ${locale} manifest`);
  const manifest = JSON.parse(readFileSync(`dist/${manifestFile}`, 'utf8'));
  for (const icon of manifest.icons) {
    assert(/icon-(192|512)-[a-f0-9]{10}\.png$/.test(icon.src), `${locale} manifest has an unversioned icon`);
    const iconFile = `assets/${icon.src.replace(/^\.\//, '')}`;
    assert(files.includes(iconFile), `${locale} manifest references missing ${iconFile}`);
  }
}

const audioFile = immutableAssets.find(file => /assets\/yamaha-u1-[a-f0-9]{10}\.m4a$/.test(file));
assert(audioFile, 'missing hashed audio sprite');
assert(!worker.includes(audioFile), 'audio sprite must remain lazy rather than precached');
assert(worker.includes('goodiano-audio-v1'), 'audio runtime cache is missing');
assert(worker.includes("startsWith(`goodiano-`)") || worker.includes('startsWith("goodiano-")'), 'legacy cache cleanup is missing');
assert(!worker.includes('removes every Cache Storage entry'), 'dev cleanup worker leaked into production sw.js');
assert(!files.some(file => file.includes('dev-cleanup-sw')), 'dev cleanup worker artifact leaked into dist');

console.log(`Verified ${immutableAssets.length} content-hashed production assets.`);
