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
const mockDownload = (payload = bytes) =>
  vi
    .fn()
    .mockResolvedValueOnce(json([release()]))
    .mockResolvedValueOnce(new Response(checksum))
    .mockResolvedValueOnce(new Response(payload));
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

describe('verified full installer download', () => {
  it('deduplicates concurrent requests, writes atomically, and opens only the owned verified id', async () => {
    vi.stubGlobal('fetch', mockDownload());
    await installer.check();
    const [first, second] = await Promise.all([installer.download(request()), installer.download(request('second'))]);
    expect(second).toEqual(first);
    await expect.poll(() => events.some((e) => e.status === 'completed')).toBe(true);
    expect(await fs.readFile(first.file_path)).toEqual(bytes);
    await expect(installer.open('../elsewhere')).rejects.toThrow('unverifiedInstaller');
    await installer.open(first.downloadId);
    expect(openPath).toHaveBeenCalledOnce();
  });
  it.each([Buffer.from('same length wrong content'), Buffer.from('short'), Buffer.alloc(100)])(
    'rejects mismatched checksum or size and removes partial files (%s)',
    async (payload) => {
      vi.stubGlobal('fetch', mockDownload(payload));
      await installer.check();
      const result = await installer.download(request());
      await expect.poll(() => events.some((e) => e.status === 'error')).toBe(true);
      await expect(fs.stat(path.dirname(result.file_path))).rejects.toThrow();
      await expect(installer.open(result.downloadId)).rejects.toThrow('unverifiedInstaller');
    }
  );
  it('verifies multiple streamed chunks and rejects an incorrect Content-Length', async () => {
    const streamed = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 8));
        controller.enqueue(bytes.subarray(8));
        controller.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(json([release()]))
        .mockResolvedValueOnce(new Response(checksum))
        .mockResolvedValueOnce(new Response(streamed))
    );
    await installer.check();
    const result = await installer.download(request());
    await expect.poll(() => events.some((e) => e.status === 'completed')).toBe(true);
    expect(await fs.readFile(result.file_path)).toEqual(bytes);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(checksum))
        .mockResolvedValueOnce(new Response(bytes, { headers: { 'content-length': '999' } }))
    );
    const invalid = await installer.download(request('invalid-length'));
    await expect.poll(() => events.some((e) => e.downloadId === 'invalid-length' && e.status === 'error')).toBe(true);
    await expect(installer.open(invalid.downloadId)).rejects.toThrow('unverifiedInstaller');
  });
  it('rejects a replaced verified installer on opening', async () => {
    vi.stubGlobal('fetch', mockDownload());
    await installer.check();
    const result = await installer.download(request());
    await expect.poll(() => events.some((e) => e.status === 'completed')).toBe(true);
    await fs.writeFile(result.file_path, Buffer.alloc(bytes.length));
    await expect(installer.open(result.downloadId)).rejects.toThrow('verificationFailed');
    expect(openPath).not.toHaveBeenCalled();
  });
  it('cleans up cancellation and permits a fresh retry', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json([release()]))
      .mockImplementation(
        (_url, options) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new Error('aborted')));
          })
      );
    vi.stubGlobal('fetch', fetcher);
    await installer.check();
    const result = await installer.download(request());
    await installer.cancel(result.downloadId);
    expect(events.at(-1)?.status).toBe('cancelled');
    await expect(fs.stat(path.dirname(result.file_path))).rejects.toThrow();
    fetcher.mockReset().mockResolvedValueOnce(new Response(checksum)).mockResolvedValueOnce(new Response(bytes));
    await installer.download(request('retry'));
    await expect.poll(() => events.some((e) => e.status === 'completed')).toBe(true);
  });
  it('waits for aborted-transfer cleanup before starting an immediate retry', async () => {
    let finishAbort!: () => void;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json([release()]))
      .mockImplementationOnce(
        (_url, options) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => {
              finishAbort = () => reject(new Error('aborted'));
            });
          })
      )
      .mockResolvedValueOnce(new Response(checksum))
      .mockResolvedValueOnce(new Response(bytes));
    vi.stubGlobal('fetch', fetcher);
    await installer.check();
    const first = await installer.download(request());
    const cancellation = installer.cancel(first.downloadId);
    const retry = installer.download(request('retry'));
    expect(fetcher).toHaveBeenCalledTimes(2);
    finishAbort();
    await cancellation;
    const second = await retry;
    expect(second.downloadId).toBe('retry');
    expect(second.file_path).not.toBe(first.file_path);
    await expect.poll(() => events.some((e) => e.downloadId === 'retry' && e.status === 'completed')).toBe(true);
  });
  it('propagates OS installer-open failure without quitting anything', async () => {
    vi.stubGlobal('fetch', mockDownload());
    await installer.check();
    const result = await installer.download(request());
    await expect.poll(() => events.some((e) => e.status === 'completed')).toBe(true);
    openPath.mockResolvedValue('OS refused');
    await expect(installer.open(result.downloadId)).rejects.toThrow('openFailed');
  });
});
