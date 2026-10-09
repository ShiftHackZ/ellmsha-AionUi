import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { prepareAioncore } = require('../../../packages/shared-scripts/src/prepare-aioncore');

describe('prepare-aioncore local bundle input', () => {
  it('rejects a missing explicit fork binary before attempting an upstream lookup', () => {
    const previous = process.env.AIONUI_BACKEND_LOCAL_BINARY;
    process.env.AIONUI_BACKEND_LOCAL_BINARY = '/missing/ellmsha-aioncore';
    try {
      expect(() => prepareAioncore({ projectRoot: '/unused', platform: 'darwin', arch: 'arm64' })).toThrow(
        'Local aioncore binary not found'
      );
    } finally {
      if (previous === undefined) delete process.env.AIONUI_BACKEND_LOCAL_BINARY;
      else process.env.AIONUI_BACKEND_LOCAL_BINARY = previous;
    }
  });

  (process.platform === 'win32' ? it.skip : it)('uses the fork binary even when an upstream run is configured', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ellmsha-local-binary-'));
    const binary = join(tmp, 'aioncore');
    const marker = join(tmp, 'fork-executed');
    writeFileSync(binary, `#!/bin/sh\ntouch '${marker}'\nexit 47\n`);
    chmodSync(binary, 0o755);
    const previousBinary = process.env.AIONUI_BACKEND_LOCAL_BINARY;
    const previousRun = process.env.AIONUI_BACKEND_RUN_ID;
    process.env.AIONUI_BACKEND_LOCAL_BINARY = binary;
    process.env.AIONUI_BACKEND_RUN_ID = 'unused-upstream-run';
    try {
      expect(() => prepareAioncore({ projectRoot: join(tmp, 'project'), platform: 'darwin', arch: 'arm64' })).toThrow();
      expect(existsSync(marker)).toBe(true);
    } finally {
      if (previousBinary === undefined) delete process.env.AIONUI_BACKEND_LOCAL_BINARY;
      else process.env.AIONUI_BACKEND_LOCAL_BINARY = previousBinary;
      if (previousRun === undefined) delete process.env.AIONUI_BACKEND_RUN_ID;
      else process.env.AIONUI_BACKEND_RUN_ID = previousRun;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('hard fails local bundle input that lacks managed-resources manifest', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'aionui-local-bundle-'));
    const projectRoot = join(tmp, 'project');
    const localBundle = join(tmp, 'bundle');
    mkdirSync(join(localBundle, 'managed-resources'), { recursive: true });
    writeFileSync(join(localBundle, 'aioncore.exe'), '');

    const previous = process.env.AIONUI_BACKEND_LOCAL_BUNDLE_DIR;
    process.env.AIONUI_BACKEND_LOCAL_BUNDLE_DIR = localBundle;
    try {
      expect(() =>
        prepareAioncore({
          projectRoot,
          platform: 'win32',
          arch: 'x64',
          version: 'v0.1.46',
        })
      ).toThrow(/managed-resources\/manifest\.json/);
    } finally {
      if (previous === undefined) delete process.env.AIONUI_BACKEND_LOCAL_BUNDLE_DIR;
      else process.env.AIONUI_BACKEND_LOCAL_BUNDLE_DIR = previous;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
