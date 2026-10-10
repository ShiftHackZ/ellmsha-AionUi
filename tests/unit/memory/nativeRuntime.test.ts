import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { nativeConfig, savePrivate } from '../../../packages/desktop/src/process/memory/native/config';
import {
  startNativeMemory,
  stopNativeMemory,
  stopOwnedMemoryChild,
} from '../../../packages/desktop/src/process/memory/native';

const temporary: string[] = [];
const temp = () => {
  const p = mkdtempSync(path.join(tmpdir(), 'ellmsha-native-'));
  temporary.push(p);
  return p;
};
afterEach(async () => {
  vi.useRealTimers();
  await stopNativeMemory();
  for (const p of temporary.splice(0)) rmSync(p, { recursive: true, force: true });
});

describe('native memory process shutdown', () => {
  const fakeChild = () => {
    const child = new EventEmitter() as EventEmitter & { exitCode: number | null; pid: number };
    child.exitCode = null;
    child.pid = 42;
    return child;
  };

  it('waits for confirmed child exit after issuing a forced termination', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const signals: NodeJS.Signals[] = [];
    let resolved = false;
    const stopping = stopOwnedMemoryChild(child as unknown as ChildProcess, {
      graceMs: 10,
      forceWaitMs: 20,
      signal: async (signal) => {
        signals.push(signal);
        return 'sent';
      },
    }).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(resolved).toBe(false);
    child.exitCode = 137;
    child.emit('exit', 137, 'SIGKILL');
    await stopping;
    expect(resolved).toBe(true);
  });

  it('rejects when forced termination is not followed by process exit', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const stopping = stopOwnedMemoryChild(child as unknown as ChildProcess, {
      graceMs: 10,
      forceWaitMs: 20,
      signal: async () => 'sent',
    });
    const rejected = expect(stopping).rejects.toThrow('did not exit after forced termination');
    await vi.advanceTimersByTimeAsync(30);
    await rejected;
  });
});
describe('persistent desktop memory', () => {
  it('reuses secrets and encoder settings when the application is replaced', () => {
    const root = temp();
    const first = nativeConfig(root);
    savePrivate(path.join(first.root, 'runtime-settings.json'), {
      ...first.settings,
      embedding: { ...first.settings.embedding, model: 'chosen-encoder' },
    });
    const second = nativeConfig(root);
    expect(second.secrets).toEqual(first.secrets);
    expect(second.settings.embedding.model).toBe('chosen-encoder');
    expect(JSON.parse(readFileSync(second.gatewayFile, 'utf8')).data.baseDir).toBe(path.join(root, 'tencentdb/core'));
  });
  it('rejects invalid ports instead of rewriting a saved configuration', () => {
    const root = temp();
    const file = path.join(root, 'tencentdb/runtime-settings.json');
    savePrivate(file, { corePort: 0, knowledgePort: 8424, panelPort: 8125 });
    expect(() => nativeConfig(root)).toThrow('Invalid local memory port');
    expect(JSON.parse(readFileSync(file, 'utf8')).corePort).toBe(0);
  });
  it('does not provision against a foreign service occupying the chosen port', async () => {
    const root = temp(),
      bundle = temp();
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No test port');
      savePrivate(path.join(bundle, 'runtime.json'), { format: 1 });
      savePrivate(path.join(root, 'tencentdb/runtime-settings.json'), {
        corePort: address.port,
        knowledgePort: 18424,
        panelPort: 18125,
        embedding: { provider: 'none' },
        knowledgeWorkspaces: [],
      });
      await expect(startNativeMemory(bundle, root)).rejects.toThrow('port is occupied');
      expect(server.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

it('restores the previous settings and database after an interrupted index switch', async () => {
  const { recoverEmbeddingChange } = await import('../../../packages/desktop/src/process/memory/native/config');
  const root = temp();
  const memory = path.join(root, 'tencentdb');
  savePrivate(path.join(memory, 'embedding-change/backup/vectors.db'), 'original database');
  savePrivate(path.join(memory, 'embedding-change/previous-settings.json'), {
    embedding: { model: 'original' },
  });
  savePrivate(path.join(memory, 'embedding-change.pending'), true);
  savePrivate(path.join(memory, 'core/vectors.db'), 'incomplete replacement');
  savePrivate(path.join(memory, 'runtime-settings.json'), { embedding: { model: 'replacement' } });
  recoverEmbeddingChange(root);
  expect(readFileSync(path.join(memory, 'core/vectors.db'), 'utf8')).toBe('original database');
  expect(JSON.parse(readFileSync(path.join(memory, 'runtime-settings.json'), 'utf8')).embedding.model).toBe('original');
});

it('keeps an interrupted switch intact if its recovery backup is missing', async () => {
  const { recoverEmbeddingChange } = await import('../../../packages/desktop/src/process/memory/native/config');
  const root = temp();
  savePrivate(path.join(root, 'tencentdb/embedding-change.pending'), true);
  savePrivate(path.join(root, 'tencentdb/core/vectors.db'), 'retained database');
  expect(() => recoverEmbeddingChange(root)).toThrow('backup is missing');
  expect(readFileSync(path.join(root, 'tencentdb/core/vectors.db'), 'utf8')).toBe('retained database');
});
