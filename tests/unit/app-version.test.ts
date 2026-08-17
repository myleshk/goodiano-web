import { describe, expect, it } from 'vitest';
import { deriveVersion } from '../../build/versioned-assets';

describe('deriveVersion', () => {
  it('puts the commit count in the patch position', () => {
    expect(deriveVersion('0.4.0', '62')).toBe('0.4.62');
  });

  it('advances on its own as commits land', () => {
    const versions = ['62', '63', '64'].map(count => deriveVersion('0.4.0', count));
    expect(versions).toEqual(['0.4.62', '0.4.63', '0.4.64']);
  });

  it('keeps a hand-picked major and minor', () => {
    expect(deriveVersion('1.2.0', '300')).toBe('1.2.300');
  });

  it('ignores whatever patch digits package.json happens to carry', () => {
    // The field only has to stay valid semver; the build decides the patch.
    expect(deriveVersion('0.4.9', '62')).toBe('0.4.62');
  });

  it('falls back to the package version when git cannot answer', () => {
    // Building from a source archive: no repository to count.
    expect(deriveVersion('0.4.0', null)).toBe('0.4.0');
  });

  it('falls back rather than trusting output that is not a count', () => {
    expect(deriveVersion('0.4.0', 'fatal: not a git repository')).toBe('0.4.0');
    expect(deriveVersion('0.4.0', '')).toBe('0.4.0');
  });

  it('falls back when the package version is not a dotted version', () => {
    expect(deriveVersion('nightly', '62')).toBe('nightly');
  });
});
