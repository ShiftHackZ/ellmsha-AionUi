import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
vi.mock('@/common', () => ({ ipcBridge: {} }));
vi.mock('electron', () => ({ app: {}, shell: {} }));
import {
  parseRelease,
  parseReleaseVersion,
  compareReleaseVersions,
  installerNames,
  parseInstallerChecksum,
} from '@process/bridge/updateBridge';
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
describe('release selection', () => {
  it('orders numeric date patches and validates calendar dates', () => {
    expect(compareReleaseVersions(version, '2026.10.13-patch.9')).toBe(1);
    expect(compareReleaseVersions('2026.10.14-patch.1', version)).toBe(1);
    expect(
      ['2026.002.13-patch.1', '2026.2.30-patch.1', '2026.10.13', '2026.10.13-patch.09', '2026.10.13-patch.1+foo'].map(
        parseReleaseVersion
      )
    ).toEqual([null, null, null, null, null]);
  });
  it('accepts padded release dates and legacy unpadded dates with calendar validation', () => {
    expect(compareReleaseVersions('2026.01.09-patch.10', '2026.1.9-patch.9')).toBe(1);
    expect(parseReleaseVersion('2024.02.29-patch.1')).not.toBeNull();
    expect(parseReleaseVersion('2026.02.29-patch.1')).toBeNull();
  });
  it('matches exact OS and architecture, with no zip or wrong-platform fallback', () => {
    expect(parseRelease(release(), runtime)?.info.recommendedAsset?.name).toBe(name);
    expect(parseRelease(release(), { platform: 'win32', arch: 'x64' })?.info.installUnavailable).toBe(
      'missingInstaller'
    );
    expect(installerNames(version, { platform: 'darwin', arch: 'riscv' })).toBeNull();
  });
  it('rejects draft/prerelease tags and ambiguous or foreign asset identities', () => {
    expect(parseRelease(release({ draft: true }), runtime)).toBeNull();
    expect(parseRelease(release({ prerelease: true }), runtime)).toBeNull();
    expect(
      parseRelease(release({ assets: [...release().assets, release().assets[0]] }), runtime)?.info.recommendedAsset
    ).toBeUndefined();
  });
  it('requires exactly one matching checksum line', () => {
    expect(parseInstallerChecksum(checksum, name)).toBe(sha);
    expect(() => parseInstallerChecksum(checksum + checksum, name)).toThrow('verificationFailed');
    expect(() => parseInstallerChecksum(checksum.replace(name, '../' + name), name)).toThrow('verificationFailed');
  });
  it('requires the per-platform checksum asset before offering the installer', () => {
    expect(parseRelease(release({ assets: [release().assets[0]] }), runtime)?.info.installUnavailable).toBe(
      'missingChecksum'
    );
  });
});
