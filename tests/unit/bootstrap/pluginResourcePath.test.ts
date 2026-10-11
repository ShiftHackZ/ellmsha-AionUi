import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import {
  resolveBuiltinPluginsPath,
  resolveMobileMcpEntryPath,
  resolveOpenComputerUseEntryPath,
} from '../../../packages/desktop/src/process/backend/pluginResourcePath';

const require = createRequire(import.meta.url);
const { MOBILE_MCP_SOURCE_DIGEST } = require('../../../../scripts/prepare-mobile-mcp.js') as {
  MOBILE_MCP_SOURCE_DIGEST: string;
};
const { CHROME_DEVTOOLS_MCP_SOURCE_DIGEST } = require('../../../../scripts/prepare-chrome-devtools-mcp.js') as {
  CHROME_DEVTOOLS_MCP_SOURCE_DIGEST: string;
};

describe('resolveBuiltinPluginsPath', () => {
  it('records the maintained AionRS fork in root provenance', () => {
    const gitmodules = readFileSync('../.gitmodules', 'utf8');
    expect(gitmodules).toContain('[submodule "aionrs"]');
    expect(gitmodules).toContain('url = https://github.com/ShiftHackZ/ellmsha-aionrs.git');
  });

  it('packages the repository plugins directory as an extra resource', () => {
    const config = load(readFileSync('packages/desktop/electron-builder.yml', 'utf8')) as {
      extraResources?: Array<{ from: string; to: string }>;
    };
    expect(config.extraResources).toContainEqual({ from: '../plugins', to: 'plugins' });
    expect(config.extraResources).toContainEqual({ from: '../.data/mobile-mcp-runtime', to: 'mobile-mcp' });
    expect(config.extraResources).toContainEqual({
      from: '../.data/open-computer-use-runtime',
      to: 'open-computer-use',
    });
    expect(existsSync('../plugins/mobile/aion-extension.json')).toBe(true);
    expect(existsSync('../plugins/computer-use/aion-extension.json')).toBe(true);
    const linear = JSON.parse(readFileSync('../plugins/linear/aion-extension.json', 'utf8')) as {
      name: string;
      version: string;
      contributes?: { skills?: Array<{ path: string }> };
    };
    expect(linear.name).toBe('linear');
    expect(linear.version).toBe('1.0.1');
    expect(linear.contributes?.skills?.[0]?.path).toBe('skills/linear-project-work/SKILL.md');
    expect(existsSync('../plugins/linear/skills/linear-project-work/SKILL.md')).toBe(true);
    expect(existsSync('../plugins/linear/skills/linear-project-work/scripts/normalize-linear-images.mjs')).toBe(true);
    expect(existsSync('../plugins/sd05-fixture')).toBe(false);
  });

  it('uses the packaged extraResources directory', () => {
    expect(
      resolveBuiltinPluginsPath({
        isPackaged: true,
        resourcesPath: '/app/resources',
      })
    ).toBe(join('/app/resources', 'plugins'));
  });

  it('preserves an explicit override', () => {
    expect(
      resolveBuiltinPluginsPath({
        configuredPath: '/custom/plugins',
        isPackaged: true,
        resourcesPath: '/app/resources',
      })
    ).toBe('/custom/plugins');
  });

  it('leaves development path resolution to aioncore', () => {
    expect(
      resolveBuiltinPluginsPath({
        isPackaged: false,
        rendererUrl: 'http://localhost:5173',
        resourcesPath: '/app/resources',
      })
    ).toBeUndefined();
  });

  it('resolves the pinned Mobile MCP runtime for development and packaged builds', () => {
    expect(
      resolveMobileMcpEntryPath({
        isPackaged: false,
        repositoryRoot: '/repo',
        resourcesPath: '/app/resources',
      })
    ).toBe(join('/repo', '.data/mobile-mcp-runtime/lib/index.js'));
    expect(
      resolveMobileMcpEntryPath({
        isPackaged: true,
        repositoryRoot: '/repo',
        resourcesPath: '/app/resources',
      })
    ).toBe(join('/app/resources', 'mobile-mcp/lib/index.js'));
    expect(
      resolveMobileMcpEntryPath({
        configuredPath: '/custom/mobile-mcp.js',
        isPackaged: true,
        repositoryRoot: '/repo',
        resourcesPath: '/app/resources',
      })
    ).toBe('/custom/mobile-mcp.js');
  });

  it('includes the pinned Mobile MCP runtime in VPS build surfaces', () => {
    const dockerfile = readFileSync('../docker/aionui.Dockerfile', 'utf8');
    const launcher = readFileSync('../scripts/v3.sh', 'utf8');
    const desktopBuilder = readFileSync('scripts/build-with-builder.js', 'utf8');
    const afterPack = readFileSync('scripts/afterPack.js', 'utf8');
    const webPackager = readFileSync('scripts/pack-web-cli.js', 'utf8');
    expect(dockerfile).toContain('COPY scripts/prepare-mobile-mcp.js /tmp/prepare-mobile-mcp.js');
    expect(dockerfile).toContain(MOBILE_MCP_SOURCE_DIGEST);
    expect(dockerfile).toContain("require('/tmp/prepare-mobile-mcp.js')");
    expect(dockerfile).toContain('ELLM_SHA_MOBILE_MCP_ENTRY=/opt/ellmsha/mobile-mcp/lib/index.js');
    expect(launcher).toContain('prepare_mobile_mcp --verify-only');
    expect(desktopBuilder).toContain('prepareMobileMcpRuntime({ repositoryRoot:');
    expect(afterPack).toContain('verifyMobileMcpRuntime({');
    expect(webPackager).toContain("path.join(tarballContentDir, 'mobile-mcp')");
    expect(webPackager).toContain("path.join(tarballContentDir, 'plugins')");
  });

  it('resolves Open Computer Use entries and rejects unsupported platforms', () => {
    const base = { repositoryRoot: '/repo', resourcesPath: '/app/resources' };
    expect(resolveOpenComputerUseEntryPath({ ...base, isPackaged: false, platform: 'darwin' })).toBe(
      join('/repo', '.data/open-computer-use-runtime/Open Computer Use.app/Contents/MacOS/OpenComputerUse')
    );
    expect(resolveOpenComputerUseEntryPath({ ...base, isPackaged: true, platform: 'linux' })).toBe(
      join('/app/resources', 'open-computer-use/open-computer-use')
    );
    expect(resolveOpenComputerUseEntryPath({ ...base, isPackaged: true, platform: 'win32' })).toBe(
      join('/app/resources', 'open-computer-use/open-computer-use.exe')
    );
    expect(
      resolveOpenComputerUseEntryPath({
        ...base,
        configuredPath: '/custom/open-computer-use',
        isPackaged: true,
        platform: 'freebsd',
      })
    ).toBe('/custom/open-computer-use');
    expect(() =>
      resolveOpenComputerUseEntryPath({ ...base, isPackaged: true, platform: 'freebsd' as NodeJS.Platform })
    ).toThrow('does not support target platform freebsd');
  });

  it('builds and packages Open Computer Use from the exact fork checkout', () => {
    const dockerfile = readFileSync('../docker/aionui.Dockerfile', 'utf8');
    const gitmodules = readFileSync('../.gitmodules', 'utf8');
    const launcher = readFileSync('../scripts/v3.sh', 'utf8');
    const desktopBuilder = readFileSync('scripts/build-with-builder.js', 'utf8');
    const afterPack = readFileSync('scripts/afterPack.js', 'utf8');
    const webPackager = readFileSync('scripts/pack-web-cli.js', 'utf8');
    expect(gitmodules).toContain('url = https://github.com/ShiftHackZ/ellmsha-open-codex-computer-use.git');
    expect(dockerfile).toContain('FROM golang:1.22-bookworm AS open-computer-use');
    expect(dockerfile).toContain('83a521e546102564efd002f61a6763912081e5c7');
    expect(dockerfile).toContain('python3-gi gir1.2-atspi-2.0 gir1.2-gtk-3.0');
    expect(dockerfile).toContain('ELLM_SHA_OPEN_COMPUTER_USE_ENTRY=/opt/ellmsha/open-computer-use/open-computer-use');
    expect(launcher).toContain('prepare_open_computer_use --verify-only');
    expect(launcher).toContain('prepare_open_computer_use --doctor');
    expect(desktopBuilder).toContain('prepareOpenComputerUseRuntime({ repositoryRoot:');
    expect(afterPack).toContain('verifyOpenComputerUseRuntime({');
    expect(webPackager).toContain("path.join(tarballContentDir, 'open-computer-use')");
  });

  it('builds and packages Chrome DevTools MCP from the exact fork checkout', () => {
    const dockerfile = readFileSync('../docker/aionui.Dockerfile', 'utf8');
    const gitmodules = readFileSync('../.gitmodules', 'utf8');
    const launcher = readFileSync('../scripts/v3.sh', 'utf8');
    const desktopBuilder = readFileSync('scripts/build-with-builder.js', 'utf8');
    const afterPack = readFileSync('scripts/afterPack.js', 'utf8');
    const webPackager = readFileSync('scripts/pack-web-cli.js', 'utf8');
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies?: Record<string, string> };
    const migrations = readFileSync('packages/desktop/src/process/utils/runBackendMigrations.ts', 'utf8');
    expect(gitmodules).toContain('url = https://github.com/ShiftHackZ/ellmsha-chrome-devtools-mcp.git');
    expect(packageJson.dependencies?.['chrome-devtools-mcp']).toBeUndefined();
    expect(migrations).not.toContain("command: 'npx'");
    expect(migrations).toContain('isObsoleteBuiltinChromeDevtools');
    expect(dockerfile).toContain('FROM node:22-bookworm-slim AS chrome-devtools-mcp');
    expect(dockerfile).toContain('4f7b06898327ab5be42c85bd98bd176f33d55d89');
    expect(dockerfile).toContain(CHROME_DEVTOOLS_MCP_SOURCE_DIGEST);
    expect(dockerfile).toContain('hashBuildInputs(process.cwd())');
    const chromeMarker = dockerfile.split('\n').find((line) => line.includes('.ellmsha-chrome-devtools-mcp-pin.json'));
    expect(chromeMarker).toContain('"upstreamCommit":"4f7b06898327ab5be42c85bd98bd176f33d55d89"');
    expect(chromeMarker).not.toContain('"commit"');
    expect(dockerfile).toContain('COPY --from=frontend /src/aionui/out/main/chrome-devtools-mcp');
    expect(launcher).toContain('prepare_chrome_devtools_mcp --verify-only');
    expect(desktopBuilder).toContain('prepareChromeDevtoolsMcpRuntime({ repositoryRoot:');
    expect(afterPack).toContain('verifyChromeDevtoolsMcpRuntime({');
    expect(webPackager).toContain("path.join(mcpDest, 'chrome-devtools-mcp')");
  });
});
