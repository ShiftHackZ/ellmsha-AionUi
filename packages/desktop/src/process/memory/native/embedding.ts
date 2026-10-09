import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { type nativeConfig, readJson, recoverEmbeddingChange, savePrivate } from './config';
import { startNativeMemory, stopNativeMemory } from './index';

export type EmbeddingInput = { baseUrl: string; model: string; apiKey?: string };
let job: { phase: string; done: number; total: number; layer?: string } = { phase: 'idle', done: 0, total: 0 };
let worker: ChildProcess | undefined;
let quitting = false;
let completion: Promise<void> | undefined;
let runtime: { bundle: string; userData: string } | undefined;
export function configureEmbeddingRuntime(bundle: string, userData: string): void {
  runtime = { bundle, userData };
}
export async function stopEmbeddingJob(): Promise<void> {
  quitting = true;
  worker?.kill('SIGTERM');
  await completion;
}
export function embeddingStatus() {
  if (!runtime) return { available: false, ...job };
  const { embedding } = JSON.parse(
    readFileSync(path.join(runtime.userData, 'tencentdb/runtime-settings.json'), 'utf8')
  ) as ReturnType<typeof nativeConfig>['settings'];
  return {
    available: true,
    ...job,
    current: {
      baseUrl: embedding.baseUrl,
      model: embedding.model,
      dimensions: embedding.dimensions,
      hasApiKey: !!embedding.apiKey,
    },
  };
}
function inputConfig(input: unknown) {
  if (!runtime) throw new Error('Native memory is unavailable');
  const value = input as EmbeddingInput;
  if (
    !value ||
    typeof value.baseUrl !== 'string' ||
    typeof value.model !== 'string' ||
    !value.model.trim() ||
    value.model.length > 200 ||
    (value.apiKey !== undefined && typeof value.apiKey !== 'string')
  )
    throw new Error('Invalid embedding configuration');
  const url = new URL(value.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('Invalid embedding endpoint');
  const previous = (
    JSON.parse(readFileSync(path.join(runtime.userData, 'tencentdb/runtime-settings.json'), 'utf8')) as ReturnType<
      typeof nativeConfig
    >['settings']
  ).embedding;
  const baseUrl = value.baseUrl.replace(/\/+$/, '');
  return {
    ...previous,
    provider: 'openai_compatible',
    baseUrl,
    model: value.model.trim(),
    apiKey: value.apiKey || (baseUrl === previous.baseUrl.replace(/\/+$/, '') ? previous.apiKey : '') || 'ollama',
    sendDimensions: false,
  };
}
export async function probeEmbedding(input: unknown): Promise<{ dimensions: number }> {
  const config = inputConfig(input);
  const response = await fetch(`${config.baseUrl}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({ model: config.model, input: 'Embedding connection test' }),
    signal: AbortSignal.timeout(60000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`Embedding endpoint returned HTTP ${response.status}`);
  const data = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
  const vector = data.data?.[0]?.embedding;
  if (
    !Array.isArray(vector) ||
    vector.length < 1 ||
    vector.length > 65536 ||
    vector.some((n) => typeof n !== 'number' || !Number.isFinite(n))
  )
    throw new Error('Endpoint did not return a valid embedding');
  return { dimensions: vector.length };
}
export function applyEmbedding(input: unknown): void {
  if (completion && !['complete', 'failed'].includes(job.phase)) throw new Error('Embedding change is already running');
  const config = inputConfig(input);
  const active = runtime!;
  job = { phase: 'checking', done: 0, total: 0 };
  completion = (async () => {
    let paused = false;
    const root = path.join(active.userData, 'tencentdb');
    const work = path.join(root, 'embedding-change');
    try {
      const { dimensions } = await probeEmbedding(input);
      if (quitting) return;
      config.dimensions = dimensions;
      job.phase = 'reindexing';
      await stopNativeMemory();
      paused = true;
      rmSync(work, { recursive: true, force: true });
      mkdirSync(path.join(work, 'backup'), { recursive: true, mode: 0o700 });
      mkdirSync(path.join(work, 'stage'), { recursive: true });
      for (const suffix of ['', '-wal', '-shm']) {
        const source = path.join(root, 'core', `vectors.db${suffix}`);
        if (existsSync(source))
          for (const dest of ['backup', 'stage']) copyFileSync(source, path.join(work, dest, `vectors.db${suffix}`));
      }
      const settings = readJson(path.join(root, 'runtime-settings.json'), {});
      savePrivate(path.join(work, 'previous-settings.json'), settings);
      savePrivate(path.join(work, 'embedding.json'), config);
      // Startup rolls back an interrupted switch before any service opens the database.
      savePrivate(path.join(root, 'embedding-change.pending'), true);
      await new Promise<void>((resolve, reject) => {
        worker = spawn(
          path.join(active.bundle, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'),
          [
            '--import',
            'tsx',
            path.join(active.bundle, 'runner.mjs'),
            path.join(active.bundle, 'MemoryCore/src/desktop-reindex.ts'),
            path.join(work, 'embedding.json'),
            path.join(work, 'stage/vectors.db'),
          ],
          {
            cwd: path.join(active.bundle, 'MemoryCore'),
            stdio: ['ignore', 'pipe', 'ignore', 'ipc'],
            detached: process.platform !== 'win32',
            windowsHide: true,
          }
        );
        createInterface({ input: worker.stdout! }).on('line', (line) => {
          try {
            const progress = JSON.parse(line);
            if (Number.isInteger(progress.done) && Number.isInteger(progress.total))
              job = { phase: 'reindexing', done: progress.done, total: progress.total, layer: progress.layer };
          } catch {
            /* Not a progress event. */
          }
        });
        worker.once('error', reject);
        worker.once('exit', (code) => {
          worker = undefined;
          if (code === 0) resolve();
          else reject(new Error('Embedding indexing failed'));
        });
      });
      if (quitting) throw new Error('Application is closing');
      for (const suffix of ['', '-wal', '-shm'])
        rmSync(path.join(root, 'core', `vectors.db${suffix}`), { force: true });
      copyFileSync(path.join(work, 'stage/vectors.db'), path.join(root, 'core/vectors.db'));
      savePrivate(path.join(root, 'runtime-settings.json'), { ...settings, embedding: config });
      await startNativeMemory(active.bundle, active.userData, false);
      rmSync(path.join(root, 'embedding-change.pending'));
      rmSync(path.join(work, 'embedding.json'), { force: true });
      try {
        renameSync(work, path.join(root, `embedding-backup-${Date.now()}`));
      } catch {
        /* Backup remains in embedding-change. */
      }
      job.phase = 'complete';
    } catch (error) {
      console.error('[Memory embeddings] Index switch failed', error);
      if (paused) {
        await stopNativeMemory();
        recoverEmbeddingChange(active.userData);
        if (!quitting) {
          try {
            await startNativeMemory(active.bundle, active.userData);
          } catch (error) {
            console.error('[Memory embeddings] Restart failed', error);
            job.phase = 'unavailable';
            return;
          }
        }
      }
      job.phase = 'failed';
    }
  })();
}
