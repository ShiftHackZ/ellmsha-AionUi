import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { copilotPaths } from '../../../packages/desktop/src/process/services/copilot/paths';

const load = createRequire(import.meta.url);
const { CopilotRuntime } = load('../../../packages/desktop/src/process/resources/copilot-ide/runtime.cjs');

async function fixture(run: (state: string) => Promise<void>) {
  const state = await mkdtemp(path.join(tmpdir(), 'copilot-lazy-'));
  try {
    await run(state);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
}

describe('embedded Copilot lifecycle', () => {
  it('restores settings and cached models without spawning or deleting authentication', async () =>
    fixture(async (state) => {
      await writeFile(
        path.join(state, 'settings.json'),
        JSON.stringify({ enabled: true, models: [{ id: 'test-model' }] })
      );
      let spawned = 0;
      const runtime = new CopilotRuntime({
        state,
        spawnProcess: () => {
          spawned++;
          throw new Error('must not start');
        },
      });
      await runtime.initialize();
      expect(runtime.status()).toMatchObject({ enabled: true, running: false, models: ['test-model'] });
      expect(spawned).toBe(0);
      await runtime.setEnabled(false);
      await expect(runtime.ensure()).rejects.toThrow('copilot_disabled');
      await runtime.dispose();
    }));

  it('authenticates the lightweight endpoint and cached discovery does not wake Code OSS', async () =>
    fixture(async (state) => {
      const runtime = new CopilotRuntime({ state });
      await runtime.initialize();
      await runtime.setEnabled(true);
      const endpoint = runtime.endpoint();
      expect((await fetch(`${endpoint.baseUrl}/models`)).status).toBe(401);
      const response = await fetch(`${endpoint.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${endpoint.apiKey}` },
      });
      expect(await response.json()).toEqual({ object: 'list', data: [] });
      expect(runtime.status().running).toBe(false);
      await runtime.dispose();
    }));

  it('coalesces simultaneous first use and stops only its owning main process', async () =>
    fixture(async (state) => {
      const source = path.join(state, 'source');
      await mkdir(path.join(source, 'src'), { recursive: true });
      await writeFile(path.join(source, 'src/main.ts'), 'ELLMSHA_IDE_BACKGROUND');
      await writeFile(
        path.join(source, 'product.json'),
        JSON.stringify({ nameShort: 'Code - OSS', nameLong: 'Code - OSS', applicationName: 'code-oss' })
      );
      const executable =
        process.platform === 'darwin'
          ? '.build/electron/Code - OSS.app/Contents/MacOS/Code - OSS'
          : process.platform === 'win32'
            ? '.build/electron/Code - OSS.exe'
            : '.build/electron/code-oss';
      await mkdir(path.dirname(path.join(source, executable)), { recursive: true });
      await writeFile(path.join(source, executable), '');
      let spawned = 0;
      const signals: string[] = [];
      const runtime = new CopilotRuntime({
        state,
        source,
        log: () => {},
        spawnProcess: (_file: string, _args: string[], options: { env: Record<string, string> }) => {
          spawned++;
          const child = Object.assign(new EventEmitter(), {
            exitCode: null as number | null,
            kill: (signal: string) => {
              signals.push(signal);
              queueMicrotask(() => child.emit('exit', 0));
            },
          });
          void writeFile(
            options.env.ELLMSHA_COPILOT_READY_FILE,
            JSON.stringify({ instance: options.env.ELLMSHA_COPILOT_INSTANCE, port: 43123 })
          );
          return child;
        },
      });
      await runtime.initialize();
      await runtime.setEnabled(true);
      await Promise.all([runtime.ensure(), runtime.ensure(), runtime.ensure()]);
      expect(spawned).toBe(1);
      runtime.active = 1;
      await expect(runtime.setEnabled(false)).rejects.toThrow('copilot_requests_active');
      runtime.active = 0;
      const disabling = runtime.setEnabled(false);
      expect(runtime.status().enabled).toBe(false);
      await disabling;
      await runtime.dispose();
      expect(signals).toEqual(['SIGTERM']);
    }));

  it('packaged resource lookup cannot be redirected to an environment checkout', () => {
    const result = copilotPaths({
      appPath: '/app',
      resourcesPath: '/resources',
      packaged: true,
      developmentSource: '/foreign',
    });
    expect(result.source).toBe(path.join('/resources', 'copilot-ide', 'runtime'));
  });
});
