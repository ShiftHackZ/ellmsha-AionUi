import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
vi.mock('@/common', () => ({ ipcBridge: {} }));
vi.mock('electron', () => ({ app: {}, shell: {} }));
import { ReleaseInstaller } from '@process/bridge/updateBridge';
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

describe('published release check', () => {
  it('chooses numeric newest stable release, not list order or prerelease status encoded in tag', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          json([
            release({ tag_name: 'v2026.10.13-patch.8' }),
            release(),
            release({ tag_name: 'v2026.10.13-patch.11', prerelease: true }),
          ])
        )
    );
    expect((await installer.check()).latest?.version).toBe(version);
  });
  it('follows bounded pagination and deduplicates simultaneous checks', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(Array.from({ length: 100 }, () => release({ tag_name: 'v2026.10.13-patch.8' }))))
      .mockResolvedValueOnce(json([release()]));
    vi.stubGlobal('fetch', fetcher);
    const results = await Promise.all([installer.check(), installer.check()]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(results[0]).toEqual(results[1]);
    expect(fetcher.mock.calls[1][0]).toBe(
      'https://api.github.com/repos/ShiftHackZ/ellmsha/releases?per_page=100&page=2'
    );
  });
  it('reports unavailable platform as a newer release, not up to date', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json([release({ assets: [] })])));
    const result = await installer.check();
    expect(result.updateAvailable).toBe(true);
    expect(result.latest?.installUnavailable).toBe('missingInstaller');
  });
  it('does not claim up to date on an exhausted catalog or failed check', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => json(Array.from({ length: 100 }, () => release())))
    );
    await expect(installer.check()).rejects.toThrow('checkFailed');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));
    await expect(installer.check()).rejects.toThrow('checkFailed');
  });
  it('invalidates the previous check after a failed recheck', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json([release()]))
      .mockRejectedValueOnce(new Error('owned network failure'));
    vi.stubGlobal('fetch', fetcher);
    await installer.check();
    await expect(installer.check()).rejects.toThrow();
    await expect(installer.download(request())).rejects.toThrow('invalidRelease');
    expect(openPath).not.toHaveBeenCalled();
  });
  it('rejects arbitrary renderer URLs even after successful checking', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json([release()])));
    await installer.check();
    await expect(
      installer.download({ ...request(), url: 'https://github.com/other/repo/releases/download/a/file.dmg' })
    ).rejects.toThrow('invalidRelease');
    await expect(installer.download({ ...request(), file_name: '../evil.dmg' })).rejects.toThrow('invalidRelease');
    await expect(installer.download({ ...request(), fallbackUrl: baseUrl + name })).rejects.toThrow('invalidRelease');
  });
});
