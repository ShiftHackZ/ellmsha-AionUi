/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type {
  GitHubReleaseAsset,
  UpdateCheckResult,
  UpdateDownloadProgressEvent,
  UpdateDownloadRequest,
  UpdateDownloadResult,
  UpdateReleaseInfo,
} from '@/common/update/updateTypes';
import { app, shell } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, mkdirSync, mkdtempSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { consumeInstallerLastFailure } from '../services/installerLastFailure';

const REPOSITORY = 'ShiftHackZ/ellmsha';
const RELEASES_API = `https://api.github.com/repos/${REPOSITORY}/releases`;
const RELEASES_URL = `https://github.com/${REPOSITORY}/releases`;
const REDIRECT_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);
const MAX_INSTALLER_BYTES = 16 * 1024 ** 3;
const REQUEST_TIMEOUT_MS = 60_000;

type RuntimePlatform = { platform: NodeJS.Platform; arch: string };
type InstallerFailure =
  | 'checkFailed'
  | 'invalidRelease'
  | 'downloadFailed'
  | 'verificationFailed'
  | 'unverifiedInstaller'
  | 'openFailed';
class InstallerError extends Error {
  constructor(readonly code: InstallerFailure) {
    super(code);
  }
}
const fail = (code: InstallerFailure): never => {
  throw new InstallerError(code);
};

/** Strict numeric release-date/patch ordering, including patch 9 -> 10. */
export const parseReleaseVersion = (value: string): number[] | null => {
  const match = /^v?(\d{4})\.(\d{1,2})\.(\d{1,2})-patch\.([1-9]\d*)$/.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  const [year, month, day] = parts;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    parts.some((n) => !Number.isSafeInteger(n)) ||
    year < 2000 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  return parts;
};
export const compareReleaseVersions = (left: string, right: string): number => {
  const a = parseReleaseVersion(left);
  const b = parseReleaseVersion(right);
  if (!a || !b) return fail('invalidRelease');
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
};
const releaseAssetUrl = (tag: string, name: string) => `${RELEASES_URL}/download/${tag}/${name}`;

/** Exact naming prevents selecting a different OS/architecture or source archive. */
export const installerNames = (version: string, runtime: RuntimePlatform) => {
  if (!['arm64', 'x64'].includes(runtime.arch)) return null;
  const os =
    runtime.platform === 'darwin'
      ? 'mac'
      : runtime.platform === 'win32'
        ? 'win'
        : runtime.platform === 'linux'
          ? 'linux'
          : null;
  if (!os) return null;
  const extension = os === 'mac' ? 'dmg' : os === 'win' ? 'exe' : 'deb';
  return {
    installer: `eLLMsha-${version}-${os}-${runtime.arch}.${extension}`,
    checksums: `SHA256SUMS-${os}-${runtime.arch}.txt`,
  };
};

type CheckedRelease = { info: UpdateReleaseInfo; checksum?: GitHubReleaseAsset };
export const parseRelease = (raw: unknown, runtime: RuntimePlatform): CheckedRelease | null => {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  if (
    item.draft !== false ||
    item.prerelease !== false ||
    typeof item.tag_name !== 'string' ||
    !item.tag_name.startsWith('v') ||
    !parseReleaseVersion(item.tag_name)
  )
    return null;
  const tagName = item.tag_name;
  const version = tagName.slice(1);
  const assets: GitHubReleaseAsset[] = [];
  if (Array.isArray(item.assets))
    for (const rawAsset of item.assets) {
      if (!rawAsset || typeof rawAsset !== 'object') continue;
      const asset = rawAsset as Record<string, unknown>;
      if (
        typeof asset.name !== 'string' ||
        typeof asset.size !== 'number' ||
        !Number.isSafeInteger(asset.size) ||
        asset.size <= 0 ||
        asset.size > MAX_INSTALLER_BYTES
      )
        continue;
      if (!/^[A-Za-z0-9._-]+$/.test(asset.name) || asset.browser_download_url !== releaseAssetUrl(tagName, asset.name))
        continue;
      assets.push({ name: asset.name, size: asset.size, url: asset.browser_download_url as string });
    }
  const names = installerNames(version, runtime);
  const exact = (name?: string) => {
    const matches = assets.filter((a) => a.name === name);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const installer = exact(names?.installer);
  const checksum = exact(names?.checksums);
  return {
    info: {
      tagName,
      version,
      name: typeof item.name === 'string' ? item.name : tagName,
      body: typeof item.body === 'string' ? item.body.slice(0, 100_000) : '',
      htmlUrl: `${RELEASES_URL}/tag/${tagName}`,
      publishedAt: typeof item.published_at === 'string' ? item.published_at : undefined,
      prerelease: false,
      draft: false,
      assets,
      recommendedAsset: checksum ? installer : undefined,
      installUnavailable: !names
        ? 'unsupportedPlatform'
        : !installer
          ? 'missingInstaller'
          : !checksum
            ? 'missingChecksum'
            : undefined,
    },
    checksum,
  };
};

export const parseInstallerChecksum = (text: string, name: string): string => {
  const matches = text
    .split(/\r?\n/)
    .map((line) => /^([a-fA-F0-9]{64})[ \t]+\*?([^\r\n]+)$/.exec(line))
    .filter((match) => match?.[2] === name);
  if (matches.length !== 1) return fail('verificationFailed');
  return matches[0]![1].toLowerCase();
};

const assertDownloadUrl = (value: string) => {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !REDIRECT_HOSTS.has(url.hostname)
  )
    fail('invalidRelease');
  if (url.hostname === 'github.com' && !url.pathname.startsWith(`/${REPOSITORY}/releases/download/`))
    fail('invalidRelease');
};
const fetchAsset = async (url: string, signal: AbortSignal): Promise<Response> => {
  for (let redirects = 0; redirects <= 5; redirects++) {
    assertDownloadUrl(url);
    const response = await fetch(url, { redirect: 'manual', signal, credentials: 'omit' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) return fail('downloadFailed');
      url = new URL(location, url).href;
      continue;
    }
    if (!response.ok) return fail('downloadFailed');
    return response;
  }
  return fail('downloadFailed');
};
const readBounded = async (response: Response, limit: number): Promise<string> => {
  if (!response.body) return fail('downloadFailed');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) return fail('invalidRelease');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8');
};

/** Main-owned release registry: renderer URLs and paths cannot authorize downloads or launches. */
export class ReleaseInstaller {
  private checked?: CheckedRelease;
  private checkInFlight?: Promise<UpdateCheckResult>;
  private active?: { id: string; controller: AbortController; result: UpdateDownloadResult; done: Promise<void> };
  private verified = new Map<string, { filePath: string; size: number; sha256: string }>();
  constructor(
    private readonly directory: string,
    private readonly runtime: RuntimePlatform,
    private readonly currentVersion: string,
    private readonly emit: (event: UpdateDownloadProgressEvent) => void,
    private readonly openPath: (filePath: string) => Promise<string>
  ) {}

  check(): Promise<UpdateCheckResult> {
    if (this.checkInFlight) return this.checkInFlight;
    this.checkInFlight = this.checkRelease().finally(() => {
      this.checkInFlight = undefined;
    });
    return this.checkInFlight;
  }
  private async checkRelease(): Promise<UpdateCheckResult> {
    this.checked = undefined;
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let latest: CheckedRelease | undefined;
    // Bounded pagination; never call a truncated catalog "up to date".
    for (let page = 1; page <= 3; page++) {
      const response = await fetch(`${RELEASES_API}?per_page=100&page=${page}`, {
        signal,
        redirect: 'error',
        credentials: 'omit',
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'eLLMsha' },
      });
      if (!response.ok) return fail('checkFailed');
      const rows: unknown = JSON.parse(await readBounded(response, 4 * 1024 ** 2));
      if (!Array.isArray(rows)) return fail('invalidRelease');
      for (const row of rows) {
        const release = parseRelease(row, this.runtime);
        if (release && (!latest || compareReleaseVersions(release.info.version, latest.info.version) > 0))
          latest = release;
      }
      if (rows.length < 100) break;
      if (page === 3) return fail('checkFailed');
    }
    if (!latest) return fail('invalidRelease');
    const updateAvailable = compareReleaseVersions(latest.info.version, this.currentVersion) > 0;
    this.checked = latest;
    return { currentVersion: this.currentVersion, updateAvailable, latest: latest.info };
  }

  async download(request: UpdateDownloadRequest): Promise<UpdateDownloadResult> {
    const release = this.checked;
    const asset = release?.info.recommendedAsset;
    if (
      !release ||
      !asset ||
      !release.checksum ||
      request.url !== asset.url ||
      request.file_name !== asset.name ||
      request.fallbackUrl ||
      compareReleaseVersions(release.info.version, this.currentVersion) <= 0
    )
      return fail('invalidRelease');
    if (this.active?.controller.signal.aborted) {
      await this.active.done;
      return this.download(request);
    }
    if (this.active) {
      if (path.basename(this.active.result.file_path) !== asset.name) return fail('invalidRelease');
      return this.active.result;
    }
    const id = request.downloadId || randomUUID();
    if (!/^[A-Za-z0-9-]{1,100}$/.test(id) || this.verified.has(id)) return fail('invalidRelease');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const directory = mkdtempSync(path.join(this.directory, 'installer-'));
    const filePath = path.join(directory, asset.name);
    const controller = new AbortController();
    const result = { downloadId: id, file_path: filePath };
    // Set active before the async worker starts; the result is not launchable until verified.
    const active = { id, controller, result, done: Promise.resolve() };
    this.active = active;
    active.done = this.transfer(active, asset, release.checksum).finally(() => {
      if (this.active === active) this.active = undefined;
    });
    return result;
  }
  private async transfer(
    active: NonNullable<ReleaseInstaller['active']>,
    asset: GitHubReleaseAsset,
    checksum: GitHubReleaseAsset
  ): Promise<void> {
    const { id, controller, result } = active;
    const partial = `${result.file_path}.part`;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60_000)]);
    let received = 0;
    const started = Date.now();
    let lastProgress = 0;
    this.emit({ downloadId: id, status: 'starting', receivedBytes: 0, totalBytes: asset.size });
    try {
      const checksumSignal = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
      const expected = parseInstallerChecksum(
        await readBounded(await fetchAsset(checksum.url, checksumSignal), 64 * 1024),
        asset.name
      );
      const response = await fetchAsset(asset.url, signal);
      const length = response.headers.get('content-length');
      if (!response.body || (length !== null && Number(length) !== asset.size)) {
        await response.body?.cancel();
        return fail('verificationFailed');
      }
      const file = await fs.open(partial, 'wx', 0o600);
      const reader = response.body.getReader();
      const hash = createHash('sha256');
      try {
        for (;;) {
          const part = await reader.read();
          signal.throwIfAborted();
          if (part.done) break;
          received += part.value.byteLength;
          if (received > asset.size) return fail('verificationFailed');
          hash.update(part.value);
          // FileHandle.writeFile handles partial writes for this chunk at the current offset.
          await file.writeFile(part.value);
          const now = Date.now();
          if (now - lastProgress > 150) {
            this.emit({
              downloadId: id,
              status: 'downloading',
              receivedBytes: received,
              totalBytes: asset.size,
              percent: Math.min(99, (received / asset.size) * 100),
              bytesPerSecond: received / Math.max(1, (now - started) / 1000),
            });
            lastProgress = now;
          }
        }
        if (received !== asset.size || hash.digest('hex') !== expected) return fail('verificationFailed');
        await file.sync();
      } finally {
        await file.close();
        await reader.cancel().catch(() => {});
      }
      signal.throwIfAborted();
      await fs.rename(partial, result.file_path);
      signal.throwIfAborted();
      this.verified.set(id, { filePath: result.file_path, size: asset.size, sha256: expected });
      this.emit({
        downloadId: id,
        status: 'completed',
        receivedBytes: received,
        totalBytes: asset.size,
        percent: 100,
        file_path: result.file_path,
      });
    } catch (error) {
      await fs.rm(path.dirname(result.file_path), { recursive: true, force: true }).catch(() => {});
      this.emit({
        downloadId: id,
        status: controller.signal.aborted ? 'cancelled' : 'error',
        receivedBytes: received,
        error: error instanceof InstallerError ? error.code : 'downloadFailed',
      });
    }
  }
  async cancel(id: string): Promise<void> {
    const active = this.active;
    if (!active || active.id !== id) return;
    active.controller.abort();
    await active.done;
  }
  async open(id: string): Promise<void> {
    const record = this.verified.get(id);
    if (!record) return fail('unverifiedInstaller');
    const stat = await fs.lstat(record.filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== record.size) return fail('verificationFailed');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(record.filePath)) hash.update(chunk);
    if (hash.digest('hex') !== record.sha256) return fail('verificationFailed');
    const error = await this.openPath(record.filePath);
    if (error) return fail('openFailed');
  }
}

export function initUpdateBridge(): void {
  const installer = new ReleaseInstaller(
    path.join(app.getPath('userData'), 'installers'),
    { platform: process.platform, arch: process.arch },
    app.getVersion(),
    (event) => ipcBridge.update.downloadProgress.emit(event),
    (filePath) => shell.openPath(filePath)
  );
  const reply = async <T>(operation: () => Promise<T>, fallback: InstallerFailure = 'downloadFailed') => {
    try {
      return { success: true, data: await operation() };
    } catch (error) {
      return { success: false, msg: error instanceof InstallerError ? error.code : fallback };
    }
  };
  ipcBridge.update.check.provider(() => reply(() => installer.check(), 'checkFailed'));
  ipcBridge.update.download.provider((request) => reply(() => installer.download(request)));
  ipcBridge.update.cancelDownload.provider(({ downloadId }) =>
    reply(async () => {
      await installer.cancel(downloadId);
      return {};
    })
  );
  ipcBridge.update.openInstaller.provider(({ downloadId }) =>
    reply(async () => {
      await installer.open(downloadId);
      return {};
    })
  );
  ipcBridge.update.consumeInstallerLastFailure.provider(() =>
    reply(() => consumeInstallerLastFailure({ appDataDir: app.getPath('appData') }))
  );
  // Retired IPCs explicitly fail closed, including calls from an older renderer.
  ipcBridge.autoUpdate.check.provider(async () => ({ success: false, msg: 'manualInstallerOnly' }));
  ipcBridge.autoUpdate.download.provider(async () => ({ success: false, msg: 'manualInstallerOnly' }));
  ipcBridge.autoUpdate.cancelDownload.provider(async () => ({ success: true }));
  ipcBridge.autoUpdate.restoreDownloaded.provider(async () => ({ success: true, data: { ready: false } }));
  ipcBridge.autoUpdate.quitAndInstall.provider(async () => {
    throw new Error('manualInstallerOnly');
  });
}
