import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(
  new URL('../../resources/ellmsha-skills/community/impeccable/scripts/impeccable', import.meta.url)
);

function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ellmsha-engine-guard-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin');
  mkdirSync(bin);
  const marker = path.join(directory, 'network-called');
  // Even a broken guard cannot make a network request during this test.
  writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\nprintf called >> "$TEST_NETWORK_MARKER"\nexit 97\n', {
    mode: 0o755,
  });
  const cache = path.join(directory, 'cache');
  const env = { PATH: `${bin}:/usr/bin:/bin`, IMPECCABLE_HOME: cache, TEST_NETWORK_MARKER: marker };
  return { directory, marker, cache, env };
}

test(
  'missing Impeccable engine neither downloads nor creates cache by default',
  { skip: process.platform === 'win32' },
  (t) => {
    const f = fixture(t);
    const result = spawnSync('/bin/sh', [launcher, 'context'], { env: f.env, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 127, result.stderr);
    assert.match(result.stderr, /IMPECCABLE_ALLOW_DOWNLOAD=1/);
    assert.equal(existsSync(f.marker), false);
    assert.equal(existsSync(f.cache), false);
  }
);

test(
  'an explicitly configured existing engine still runs without download opt-in',
  { skip: process.platform === 'win32' },
  (t) => {
    const f = fixture(t);
    const engine = path.join(f.directory, 'known-engine');
    writeFileSync(engine, '#!/bin/sh\nprintf "engine:%s\\n" "$1"\n', { mode: 0o755 });
    const result = spawnSync('/bin/sh', [launcher, 'context'], {
      env: { ...f.env, IMPECCABLE_BIN: engine },
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'engine:context');
    assert.equal(existsSync(f.marker), false);
  }
);

test(
  'authorized engine setup can reach the downloader, simulated without network',
  { skip: process.platform === 'win32' },
  (t) => {
    const f = fixture(t);
    const result = spawnSync('/bin/sh', [launcher, 'context'], {
      env: { ...f.env, IMPECCABLE_ALLOW_DOWNLOAD: '1' },
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(result.status, 127, result.stderr);
    assert.match(readFileSync(f.marker, 'utf8'), /called/);
  }
);
