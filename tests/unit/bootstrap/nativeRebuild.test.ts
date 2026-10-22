import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);

function loadRebuilder(fail = false) {
  const execFileSync = vi.fn(() => {
    if (fail) throw new Error('compiler failed');
  });
  const localRequire = Object.assign(
    (id: string) => (id === 'child_process' ? { execFileSync, spawnSync: () => ({ status: 1 }) } : require(id)),
    { resolve: () => path.resolve('locked tools/@electron/rebuild/lib/main.js') }
  );
  const module = { exports: {} };
  runInNewContext(readFileSync('scripts/rebuildNativeModules.js', 'utf8'), {
    require: localRequire,
    module,
    process,
    console: { log: vi.fn(), error: vi.fn() },
    __dirname: path.resolve('scripts'),
  });
  const rebuild = module.exports as {
    rebuildSingleModule: (options: Record<string, unknown>) => boolean;
  };
  return { rebuild, execFileSync };
}

const options = {
  moduleName: 'better-sqlite3',
  moduleRoot: path.resolve('packaged app/resources/app.asar.unpacked/node_modules/better-sqlite3'),
  platform: 'win32',
  arch: 'x64',
  buildArch: 'x64',
  electronVersion: '44.9.2',
  forceRebuild: true,
};

describe('packaged native rebuild', () => {
  it('runs the locked CLI against the packaged module with the explicit Electron version', () => {
    const { rebuild, execFileSync } = loadRebuilder();
    expect(rebuild.rebuildSingleModule(options)).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith(
      process.execPath,
      [
        path.resolve('locked tools/@electron/rebuild/lib/cli.js'),
        '--only',
        'better-sqlite3',
        '--force',
        '--arch',
        'x64',
        '--version',
        '44.9.2',
        '--module-dir',
        options.moduleRoot,
      ],
      expect.objectContaining({
        cwd: options.moduleRoot,
        env: expect.objectContaining({ npm_config_target: '44.9.2' }),
      })
    );
  });

  it('reports compiler failures without falling back to a downloaded package', () => {
    const { rebuild, execFileSync } = loadRebuilder(true);
    expect(rebuild.rebuildSingleModule(options)).toBe(false);
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });
});
