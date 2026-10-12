import { createRequire } from 'node:module';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

type Preparation = {
  OPEN_COMPUTER_USE_COMMIT: string;
  OPEN_COMPUTER_USE_SOURCE_DIGEST: string;
  OPEN_COMPUTER_USE_MARKER: string;
  OPEN_COMPUTER_USE_ORIGIN: string;
  OPEN_COMPUTER_USE_UPSTREAM: string;
  OPEN_COMPUTER_USE_UPSTREAM_COMMIT: string;
  OPEN_COMPUTER_USE_VERSION: string;
  assertMacOSVersion: (run: (command: string, args: string[]) => string) => void;
  hashBuildInputs(checkout: string): string;
  inspectOpenComputerUseCheckout(options: {
    checkout: string;
    expectedSourceDigest?: string;
    runGit(args: string[]): string;
  }): {
    commit: string;
    sourceDigest: string;
    upstreamCommit: string;
    version: string;
  };
  prepareOpenComputerUseRuntime(options: {
    repositoryRoot: string;
    targetArch: string;
    targetPlatform: string;
  }): unknown;
  verifyOpenComputerUseRuntime(options: { runtimeRoot: string; targetArch: string; targetPlatform: string }): {
    entryPath: string;
  };
};

const require = createRequire(import.meta.url);
const repoRoot = resolve(__dirname, '../../..');
const preparation = require(resolve(repoRoot, '../scripts/prepare-open-computer-use.js')) as Preparation;
const tempDirs: string[] = [];

function checkout(version = '0.3.6'): string {
  const directory = mkdtempSync(join(tmpdir(), 'ellmsha-open-computer-use-test-'));
  tempDirs.push(directory);
  mkdirSync(join(directory, 'plugins/open-computer-use/.codex-plugin'), { recursive: true });
  writeFileSync(join(directory, 'plugins/open-computer-use/.codex-plugin/plugin.json'), JSON.stringify({ version }));
  writeFileSync(join(directory, 'LICENSE'), 'MIT License\n');
  return directory;
}

function pinnedGit(args: string[]): string {
  const command = args.join(' ');
  if (command === 'rev-parse HEAD') return preparation.OPEN_COMPUTER_USE_COMMIT;
  if (command === 'remote get-url origin') return preparation.OPEN_COMPUTER_USE_ORIGIN;
  if (command === 'remote get-url upstream') return preparation.OPEN_COMPUTER_USE_UPSTREAM;
  if (
    command ===
    `merge-base --is-ancestor ${preparation.OPEN_COMPUTER_USE_UPSTREAM_COMMIT} ${preparation.OPEN_COMPUTER_USE_COMMIT}`
  ) {
    return '';
  }
  if (command === 'status --porcelain --untracked-files=all') return '';
  throw new Error(`Unexpected git command: ${command}`);
}

function inspectFixture(directory: string, runGit = pinnedGit) {
  return preparation.inspectOpenComputerUseCheckout({
    checkout: directory,
    expectedSourceDigest: preparation.hashBuildInputs(directory),
    runGit,
  });
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Open Computer Use runtime preparation', () => {
  it('accepts only the exact fork baseline and MIT license', () => {
    expect(inspectFixture(checkout())).toMatchObject({
      commit: preparation.OPEN_COMPUTER_USE_COMMIT,
      upstreamCommit: preparation.OPEN_COMPUTER_USE_UPSTREAM_COMMIT,
      version: preparation.OPEN_COMPUTER_USE_VERSION,
    });
    expect(() => inspectFixture(checkout('0.3.7'))).toThrow('source version 0.3.7; expected 0.3.6');
    const invalidLicense = checkout();
    writeFileSync(join(invalidLicense, 'LICENSE'), 'Not the MIT license');
    expect(() => inspectFixture(invalidLicense)).toThrow('MIT LICENSE is missing or unexpected');
  });

  it('accepts approved local patches only when their complete source digest matches', () => {
    const directory = checkout();
    writeFileSync(join(directory, 'reviewed.swift'), '// approved isolated patch\n');
    const expectedSourceDigest = preparation.hashBuildInputs(directory);
    expect(
      preparation.inspectOpenComputerUseCheckout({
        checkout: directory,
        expectedSourceDigest,
        runGit: (args) =>
          args.join(' ') === 'status --porcelain --untracked-files=all' ? '?? reviewed.swift' : pinnedGit(args),
      })
    ).toMatchObject({ sourceDigest: expectedSourceDigest });
  });

  it.each(['injected.swift', 'README.md'])('rejects unexpected bytes in %s despite pinned git metadata', (file) => {
    const directory = checkout();
    writeFileSync(join(directory, 'README.md'), '# Reviewed documentation\n');
    const expectedSourceDigest = preparation.hashBuildInputs(directory);
    writeFileSync(join(directory, file), 'Unexpected source contents\n');
    expect(() =>
      preparation.inspectOpenComputerUseCheckout({
        checkout: directory,
        expectedSourceDigest,
        runGit: pinnedGit,
      })
    ).toThrow('source digest');
  });

  it.each([
    ['rev-parse HEAD', '0000000000000000000000000000000000000000', 'commit'],
    ['remote get-url origin', 'https://github.com/unexpected/fork.git', 'origin'],
    ['remote get-url upstream', 'https://github.com/unexpected/upstream.git', 'upstream'],
  ])('preserves %s validation even for approved source bytes', (command, value, message) => {
    expect(() => inspectFixture(checkout(), (args) => (args.join(' ') === command ? value : pinnedGit(args)))).toThrow(
      message
    );
  });

  it('preserves the upstream ancestry requirement for approved source bytes', () => {
    expect(() =>
      inspectFixture(checkout(), (args) => {
        if (args[0] === 'merge-base') throw new Error('Not an ancestor');
        return pinnedGit(args);
      })
    ).toThrow('does not descend from pinned upstream');
  });

  it('accepts a clean recursive clone without an upstream remote', () => {
    const directory = checkout();
    const sourceDigest = preparation.hashBuildInputs(directory);
    writeFileSync(join(directory, '.git'), 'gitdir: ../.git/modules/open-codex-computer-use\n');

    expect(preparation.hashBuildInputs(directory)).toBe(sourceDigest);
    expect(
      preparation.inspectOpenComputerUseCheckout({
        checkout: directory,
        expectedSourceDigest: sourceDigest,
        runGit: (args) => {
          if (args.join(' ') === 'remote get-url upstream') throw new Error('No such remote');
          return pinnedGit(args);
        },
      })
    ).toMatchObject({
      commit: preparation.OPEN_COMPUTER_USE_COMMIT,
      upstreamCommit: preparation.OPEN_COMPUTER_USE_UPSTREAM_COMMIT,
    });
  });

  it('rejects non-native build targets and macOS versions below 14', () => {
    const targetPlatform = process.platform === 'darwin' ? 'linux' : 'darwin';
    expect(() =>
      preparation.prepareOpenComputerUseRuntime({
        repositoryRoot: repoRoot,
        targetArch: process.arch,
        targetPlatform,
      })
    ).toThrow('must be built on its target host');
    expect(() => preparation.assertMacOSVersion(() => '13.6.9')).toThrow('requires macOS 14.0 or later');
  });

  it('verifies the platform-specific runtime entry and pin marker', () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'ellmsha-open-computer-use-runtime-test-'));
    tempDirs.push(runtimeRoot);
    const entry = join(runtimeRoot, 'open-computer-use');
    writeFileSync(entry, '#!/bin/sh\n');
    chmodSync(entry, 0o755);
    writeFileSync(join(runtimeRoot, 'LICENSE'), 'MIT License\n');
    writeFileSync(
      join(runtimeRoot, preparation.OPEN_COMPUTER_USE_MARKER),
      JSON.stringify({
        commit: preparation.OPEN_COMPUTER_USE_COMMIT,
        upstreamCommit: preparation.OPEN_COMPUTER_USE_UPSTREAM_COMMIT,
        version: preparation.OPEN_COMPUTER_USE_VERSION,
        sourceDigest: preparation.OPEN_COMPUTER_USE_SOURCE_DIGEST,
        platform: 'linux',
        arch: 'x64',
      })
    );
    expect(
      preparation.verifyOpenComputerUseRuntime({ runtimeRoot, targetPlatform: 'linux', targetArch: 'x64' }).entryPath
    ).toBe(entry);
    expect(() =>
      preparation.verifyOpenComputerUseRuntime({ runtimeRoot, targetPlatform: 'freebsd', targetArch: 'x64' })
    ).toThrow('does not support target freebsd-x64');
    writeFileSync(
      join(runtimeRoot, preparation.OPEN_COMPUTER_USE_MARKER),
      JSON.stringify({
        commit: preparation.OPEN_COMPUTER_USE_COMMIT,
        upstreamCommit: preparation.OPEN_COMPUTER_USE_UPSTREAM_COMMIT,
        version: preparation.OPEN_COMPUTER_USE_VERSION,
        sourceDigest: 'stale-approved-commit-contents',
        platform: 'linux',
        arch: 'x64',
      })
    );
    expect(() =>
      preparation.verifyOpenComputerUseRuntime({ runtimeRoot, targetPlatform: 'linux', targetArch: 'x64' })
    ).toThrow('stale checkout contents');
  });
});
