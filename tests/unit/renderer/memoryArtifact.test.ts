import { describe, expect, it } from 'vitest';
import { resolveMemoryArtifactPath } from '@/renderer/components/Markdown/memoryArtifact';
describe('memory artifact references', () => {
  it('accepts only an explicit virtual markdown reference, preserving its scope for server validation', () => {
    expect(resolveMemoryArtifactPath('ellmsha-memory://artifact?path=bmad%2Ffixture%2Fspec.md')).toBe(
      'bmad/fixture/spec.md'
    );
    for (const path of [
      'bmad/../spec.md',
      '/tmp/fixture.md',
      'bmad/fixture/../spec.md',
      'bmad//spec.md',
      'bmad/fixture/spec.exe',
      'bmad/fixture/a\\b.md',
      'bmad/fixture/a\u0000.md',
    ]) {
      expect(resolveMemoryArtifactPath(`ellmsha-memory://artifact?path=${encodeURIComponent(path)}`)).toBeUndefined();
    }
    for (const url of [
      'https://artifact?path=bmad/fixture/spec.md',
      'ellmsha-memory://artifact/path?path=bmad/fixture/spec.md',
      'ellmsha-memory://user@artifact?path=bmad/fixture/spec.md',
      'ellmsha-memory://artifact?path=bmad/fixture/spec.md&path=bmad/other/spec.md',
    ])
      expect(resolveMemoryArtifactPath(url)).toBeUndefined();
  });
});
