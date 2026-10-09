import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  configureEmbeddingRuntime,
  embeddingStatus,
  probeEmbedding,
} from '../../../packages/desktop/src/process/memory/native/embedding';
import { nativeConfig, savePrivate } from '../../../packages/desktop/src/process/memory/native/config';
let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'embedding-settings-'));
  const config = nativeConfig(root);
  savePrivate(path.join(config.root, 'runtime-settings.json'), {
    ...config.settings,
    embedding: { ...config.settings.embedding, apiKey: 'private-fixture-key' },
  });
  configureEmbeddingRuntime('/unused-runtime', root);
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});
it('detects actual dimensions without exposing the stored key to the renderer', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] })))
  );
  expect(await probeEmbedding({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'test' })).toEqual({
    dimensions: 3,
  });
  expect(JSON.stringify(embeddingStatus())).not.toContain('private-fixture-key');
});
it('does not forward the saved credential to a different endpoint', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ embedding: [0.1] }] })));
  vi.stubGlobal('fetch', fetcher);
  await probeEmbedding({ baseUrl: 'https://example.com/v1', model: 'test' });
  expect(fetcher.mock.calls[0][1].headers.Authorization).not.toContain('private-fixture-key');
});
it('rejects malformed embeddings before settings or the active index are changed', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ embedding: ['invalid'] }] })))
  );
  await expect(probeEmbedding({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'broken' })).rejects.toThrow(
    'valid embedding'
  );
  expect(embeddingStatus().current?.model).toBe('bge-m3');
});
