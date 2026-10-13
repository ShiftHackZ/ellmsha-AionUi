import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
const bridgeMocks = vi.hoisted(() => ({
  handlers: new Map<string, (value?: unknown) => Promise<unknown>>(),
  open: vi.fn(),
  quit: vi.fn(),
}));
vi.mock('@/common', () => {
  const providers = (names: string[], prefix: string) =>
    Object.fromEntries(
      names.map((name) => [
        name,
        {
          provider: (handler: (value?: unknown) => Promise<unknown>) =>
            bridgeMocks.handlers.set(prefix + name, handler),
          emit: vi.fn(),
        },
      ])
    );
  return {
    ipcBridge: {
      update: providers(
        ['check', 'download', 'cancelDownload', 'openInstaller', 'consumeInstallerLastFailure', 'downloadProgress'],
        'update.'
      ),
      autoUpdate: providers(['check', 'download', 'cancelDownload', 'restoreDownloaded', 'quitAndInstall'], 'auto.'),
    },
  };
});
vi.mock('electron', () => ({
  app: { getPath: () => '/owned-fixture', getVersion: () => '2026.10.13-patch.9', quit: bridgeMocks.quit },
  shell: { openPath: bridgeMocks.open },
}));
import { ReleaseInstaller, initUpdateBridge } from '@process/bridge/updateBridge';
import type { UpdateDownloadProgressEvent } from '@/common/update/updateTypes';
const runtime = { platform: 'darwin' as const, arch: 'arm64' };
const version = '2026.10.13-patch.10';
const name = `eLLMsha-${version}-mac-arm64.dmg`;
const baseUrl = `https://github.com/ShiftHackZ/ellmsha/releases/download/v${version}/`;
const bytes = Buffer.from('owned synthetic installer');
const sha = createHash('sha256').update(bytes).digest('hex');
const checksum = `${sha}  ${name}\n`;
const release = (override: Record<string, unknown> = {}) => ({
  tag_name: `v${version}`,
  draft: false,
  prerelease: false,
  assets: [
    { name, browser_download_url: baseUrl + name, size: bytes.length },
    {
      name: 'SHA256SUMS-mac-arm64.txt',
      browser_download_url: baseUrl + 'SHA256SUMS-mac-arm64.txt',
      size: checksum.length,
    },
  ],
  ...override,
});
let directory: string;
let events: UpdateDownloadProgressEvent[];
let openPath: ReturnType<typeof vi.fn>;
let installer: ReleaseInstaller;
const request = (id = 'owned-id') => ({ downloadId: id, url: baseUrl + name, file_name: name });
const json = (data: unknown) => new Response(JSON.stringify(data));
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(tmpdir(), 'ellmsha-installer-test-'));
  events = [];
  openPath = vi.fn().mockResolvedValue('');
  installer = new ReleaseInstaller(directory, runtime, '2026.10.13-patch.9', (event) => events.push(event), openPath);
});
afterEach(async () => {
  await installer.cancel('owned-id');
  vi.unstubAllGlobals();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('trusted release transport', () => {
  it('disables retired auto-update IPCs without downloading, opening or quitting', async () => {
    initUpdateBridge();
    expect(await bridgeMocks.handlers.get('auto.check')!()).toEqual({ success: false, msg: 'manualInstallerOnly' });
    expect(await bridgeMocks.handlers.get('auto.download')!()).toEqual({ success: false, msg: 'manualInstallerOnly' });
    expect(await bridgeMocks.handlers.get('auto.restoreDownloaded')!()).toEqual({
      success: true,
      data: { ready: false },
    });
    await expect(bridgeMocks.handlers.get('auto.quitAndInstall')!()).rejects.toThrow('manualInstallerOnly');
    expect(bridgeMocks.open).not.toHaveBeenCalled();
    expect(bridgeMocks.quit).not.toHaveBeenCalled();
  });
  it.each([
    'http://release-assets.githubusercontent.com/x',
    'https://evil.invalid/x',
    'https://github.com/other/repo/x',
    'https://github.com:444/ShiftHackZ/ellmsha/releases/download/x',
  ])('rejects an unsafe redirect before requesting %s', async (target) => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json([release()]))
      .mockResolvedValueOnce(new Response('', { status: 302, headers: { location: target } }));
    vi.stubGlobal('fetch', fetcher);
    await installer.check();
    await installer.download(request());
    await expect.poll(() => events.some((e) => e.status === 'error')).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(openPath).not.toHaveBeenCalled();
  });
  it('follows trusted asset redirects and verifies bytes before opening', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(json([release()]))
        .mockResolvedValueOnce(
          new Response('', {
            status: 302,
            headers: { location: 'https://release-assets.githubusercontent.com/owned?signature=public-fixture' },
          })
        )
        .mockResolvedValueOnce(new Response(checksum))
        .mockResolvedValueOnce(new Response(bytes))
    );
    await installer.check();
    const result = await installer.download(request());
    await expect.poll(() => events.some((e) => e.status === 'completed')).toBe(true);
    await installer.open(result.downloadId);
    expect(openPath).toHaveBeenCalledWith(result.file_path);
  });
  it('bounds redirects and never executes a partial download', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json([release()]))
      .mockImplementation(
        async () =>
          new Response('', { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/again' } })
      );
    vi.stubGlobal('fetch', fetcher);
    await installer.check();
    await installer.download(request());
    await expect.poll(() => events.some((e) => e.status === 'error')).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(7);
    await expect(installer.open('owned-id')).rejects.toThrow('unverifiedInstaller');
  });
});
