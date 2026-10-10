import { createRequire } from 'node:module';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

type MobileMcpPreparation = {
  MOBILE_MCP_COMMIT: string;
  MOBILE_MCP_ORIGIN: string;
  MOBILE_MCP_SOURCE_DIGEST: string;
  MOBILE_MCP_SOURCE_VERSION: string;
  MOBILE_MCP_UPSTREAM: string;
  inspectMobileMcpCheckout(options: {
    checkout: string;
    runGit(args: string[]): string;
    expectedPatchFiles?: Record<string, string>;
    expectedSourceDigest?: string;
  }): {
    commit: string;
    releaseVersion: string;
    sourceVersion: string;
    version: string;
  };
  hashBuildInputs(checkout: string): string;
  mobileCliTarget(platform: NodeJS.Platform, arch: string): string;
  normalizeRemote(value: string): string;
  prepareMobileMcpRuntime(options: { repositoryRoot: string; targetArch: string; targetPlatform: string }): unknown;
  verifyMobileMcpRuntime(options: {
    runtimeRoot: string;
    sourceCommit?: string;
    sourceDigest?: string;
    targetArch?: string;
    targetPlatform?: NodeJS.Platform;
  }): { checked: string[] };
};

const require = createRequire(import.meta.url);
const repoRoot = resolve(__dirname, '../../..');
const preparation = require(resolve(repoRoot, '../scripts/prepare-mobile-mcp.js')) as MobileMcpPreparation;
const tempDirs: string[] = [];

function checkout(version = '0.0.1'): string {
  const directory = mkdtempSync(join(tmpdir(), 'ellmsha-mobile-mcp-test-'));
  tempDirs.push(directory);
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ version }));
  writeFileSync(join(directory, 'package-lock.json'), JSON.stringify({ packages: { '': { version } } }));
  return directory;
}

function inspectExact(directory: string, runGit = pinnedGit) {
  return preparation.inspectMobileMcpCheckout({
    checkout: directory,
    runGit,
    expectedPatchFiles: {},
    expectedSourceDigest: preparation.hashBuildInputs(directory),
  });
}

function pinnedGit(args: string[]): string {
  const command = args.join(' ');
  if (command === 'rev-parse HEAD') return preparation.MOBILE_MCP_COMMIT;
  if (command === 'rev-parse 1.0.8^{commit}') return preparation.MOBILE_MCP_COMMIT;
  if (command === 'remote get-url origin') return preparation.MOBILE_MCP_ORIGIN;
  if (command === 'remote get-url upstream') return preparation.MOBILE_MCP_UPSTREAM;
  throw new Error(`Unexpected git command: ${command}`);
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Mobile MCP runtime preparation', () => {
  it('accepts the exact 1.0.8 tag while checking its real 0.0.1 source metadata', () => {
    expect(inspectExact(checkout())).toMatchObject({
      commit: preparation.MOBILE_MCP_COMMIT,
      releaseVersion: '1.0.8',
      sourceVersion: preparation.MOBILE_MCP_SOURCE_VERSION,
      version: '1.0.8',
    });
    expect(preparation.normalizeRemote('git@github.com:ShiftHackZ/ellmsha-mobile-mcp.git')).toBe(
      'https://github.com/ShiftHackZ/ellmsha-mobile-mcp'
    );
  });

  it('rejects an implicit upstream version upgrade', () => {
    const directory = checkout('1.0.9');
    expect(() => inspectExact(directory)).toThrow('source package version 1.0.9; expected 0.0.1');
  });

  it('accepts approved content in a clean descendant checkout and rejects unexpected content', () => {
    const directory = checkout();
    const releaseCommit = '2222222222222222222222222222222222222222';
    const releaseGit = (args: string[]): string => {
      const command = args.join(' ');
      if (command === 'rev-parse HEAD') return releaseCommit;
      if (command === `merge-base --is-ancestor ${preparation.MOBILE_MCP_COMMIT} ${releaseCommit}`) return '';
      return pinnedGit(args);
    };
    const expectedSourceDigest = preparation.hashBuildInputs(directory);
    expect(inspectExact(directory, releaseGit)).toMatchObject({ commit: releaseCommit, releaseVersion: '1.0.8' });

    const unrelatedGit = (args: string[]): string => {
      if (args.join(' ') === 'rev-parse HEAD') return releaseCommit;
      if (args[0] === 'merge-base') throw new Error('not an ancestor');
      return pinnedGit(args);
    };
    expect(() => inspectExact(directory, unrelatedGit)).toThrow('does not descend from pinned release');

    writeFileSync(join(directory, 'source.ts'), 'unexpected\n');
    expect(() =>
      preparation.inspectMobileMcpCheckout({
        checkout: directory,
        runGit: releaseGit,
        expectedPatchFiles: {},
        expectedSourceDigest,
      })
    ).toThrow('source digest');
  });

  it('accepts a clean recursive clone without an upstream remote or release tag', () => {
    const directory = checkout();
    const sourceDigest = preparation.hashBuildInputs(directory);
    writeFileSync(join(directory, '.git'), 'gitdir: ../.git/modules/mobile-mcp\n');
    const commands: string[] = [];
    const runGit = (args: string[]): string => {
      const command = args.join(' ');
      commands.push(command);
      if (command === 'rev-parse HEAD') return preparation.MOBILE_MCP_COMMIT;
      if (command === 'remote get-url origin') return preparation.MOBILE_MCP_ORIGIN;
      if (command === 'remote get-url upstream' || command === 'rev-parse 1.0.8^{commit}') {
        throw new Error('missing local metadata');
      }
      if (command === `rev-parse ${preparation.MOBILE_MCP_COMMIT}^{commit}`) return preparation.MOBILE_MCP_COMMIT;
      throw new Error(`Unexpected git command: ${command}`);
    };

    expect(preparation.hashBuildInputs(directory)).toBe(sourceDigest);
    expect(inspectExact(directory, runGit)).toMatchObject({ commit: preparation.MOBILE_MCP_COMMIT });
    expect(commands).toContain(`rev-parse ${preparation.MOBILE_MCP_COMMIT}^{commit}`);
  });

  it('rejects a runtime build for a different platform or architecture', () => {
    const targetPlatform = process.platform === 'darwin' ? 'linux' : 'darwin';
    expect(() =>
      preparation.prepareMobileMcpRuntime({ repositoryRoot: repoRoot, targetArch: process.arch, targetPlatform })
    ).toThrow('Mobile MCP runtime must be built on its target host');
  });

  it('changes the cache identity when a fork build input changes', () => {
    const directory = checkout();
    const before = preparation.hashBuildInputs(directory);
    writeFileSync(join(directory, 'source.ts'), 'export const patch = 1;\n');
    expect(preparation.hashBuildInputs(directory)).not.toBe(before);
  });

  it('rejects a cached runtime built from another approved-content commit', () => {
    const runtimeRoot = checkout();
    const target = preparation.mobileCliTarget(process.platform, process.arch);
    const binary = join(
      runtimeRoot,
      'node_modules',
      `@mobilenext/mobilecli-${target}`,
      `mobilecli-${target}${process.platform === 'win32' ? '.exe' : ''}`
    );
    for (const relativePath of [
      'lib/index.js',
      'LICENSE',
      'node_modules/mobilewright/package.json',
      `node_modules/@mobilenext/mobilecli-${target}/package.json`,
    ]) {
      const file = join(runtimeRoot, relativePath);
      mkdirSync(resolve(file, '..'), { recursive: true });
      writeFileSync(file, relativePath.endsWith('.json') ? '{}' : 'fixture\n');
    }
    writeFileSync(binary, 'fixture\n');
    if (process.platform !== 'win32') chmodSync(binary, 0o755);
    writeFileSync(
      join(runtimeRoot, '.ellmsha-mobile-mcp-pin.json'),
      JSON.stringify({
        arch: process.arch,
        pinnedCommit: preparation.MOBILE_MCP_COMMIT,
        platform: process.platform,
        releaseVersion: '1.0.8',
        sourceCommit: preparation.MOBILE_MCP_COMMIT,
        sourceDigest: preparation.MOBILE_MCP_SOURCE_DIGEST,
        sourceVersion: '0.0.1',
      })
    );

    expect(
      preparation.verifyMobileMcpRuntime({
        runtimeRoot,
        sourceCommit: preparation.MOBILE_MCP_COMMIT,
      }).checked
    ).toHaveLength(8);
    expect(() =>
      preparation.verifyMobileMcpRuntime({
        runtimeRoot,
        sourceCommit: '2222222222222222222222222222222222222222',
      })
    ).toThrow('different source commit');

    if (process.platform !== 'win32') {
      const link = join(runtimeRoot, 'portable-bin');
      symlinkSync('lib/index.js', link);
      const relocated = checkout();
      cpSync(runtimeRoot, relocated, { recursive: true, verbatimSymlinks: true });
      expect(preparation.verifyMobileMcpRuntime({ runtimeRoot: relocated }).checked).toHaveLength(8);
      unlinkSync(link);
      symlinkSync(join(checkout(), 'package.json'), link);
      expect(() => preparation.verifyMobileMcpRuntime({ runtimeRoot })).toThrow('link escapes its bundle');
      unlinkSync(link);
    }

    const markerPath = join(runtimeRoot, '.ellmsha-mobile-mcp-pin.json');
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(markerPath, JSON.stringify({ ...marker, sourceDigest: 'unexpected' }));
    expect(() => preparation.verifyMobileMcpRuntime({ runtimeRoot })).toThrow('stale checkout contents');
  });
});
