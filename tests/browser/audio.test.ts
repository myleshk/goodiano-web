import { describe, expect, it } from 'vitest';
import { YAMAHA_U1_ZONES } from '../../js/app/sample-zones';

describe('committed audio sprite', () => {
  it('decodes in WebKit with the expected layout and audible sample regions', async ({ skip }) => {
    const response = await fetch('/assets/yamaha-u1.m4a');
    expect(response.ok).toBe(true);
    const encoded = await response.arrayBuffer();
    expect(encoded.byteLength).toBeGreaterThan(1_000_000);
    expect(new TextDecoder().decode(encoded.slice(4, 8))).toBe('ftyp');
    const context = new AudioContext();
    try {
      let audio: AudioBuffer;
      try {
        audio = await context.decodeAudioData(encoded);
      } catch (error) {
        // Playwright's patched WebKit can be built without a usable AAC
        // decoder even on macOS. Real Safari uses the system codec verified by
        // the media validation step; keep all decode assertions active when
        // the browser runner exposes AAC.
        if (error instanceof DOMException && error.name === 'EncodingError') {
          skip('This Playwright WebKit build has no AAC decoder');
          return;
        }
        throw error;
      }
      expect(audio.numberOfChannels).toBe(1);
      expect(audio.sampleRate).toBe(44_100);
      expect(audio.duration).toBeCloseTo(81.885, 2);

      const channel = audio.getChannelData(0);
      for (const zoneIndex of [0, 6, 13]) {
        const zone = YAMAHA_U1_ZONES[zoneIndex];
        const start = Math.round((zone.offsetSeconds + 0.05) * audio.sampleRate);
        const end = Math.min(start + Math.round(0.1 * audio.sampleRate), channel.length);
        let peak = 0;
        for (let index = start; index < end; index++) peak = Math.max(peak, Math.abs(channel[index]));
        expect(peak).toBeGreaterThan(0.001);
      }
    } finally {
      await context.close();
    }
  });
});
