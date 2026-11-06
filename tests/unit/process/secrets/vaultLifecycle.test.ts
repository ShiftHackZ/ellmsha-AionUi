import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecretBridgeRequest } from '@/common/types/secrets';
const mocks = vi.hoisted(() => ({
  directory: '',
  available: true,
  request: undefined as undefined | ((request: SecretBridgeRequest) => Promise<unknown>),
  listeners: new Map<string, () => void>(),
  emit: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { getPath: () => mocks.directory, on: (event: string, fn: () => void) => mocks.listeners.set(event, fn) },
  powerMonitor: { on: (event: string, fn: () => void) => mocks.listeners.set(event, fn) },
  safeStorage: {
    isEncryptionAvailable: () => mocks.available,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value: string) => Buffer.from(Buffer.from(value).toString('base64')),
    decryptString: (value: Buffer) => Buffer.from(value.toString(), 'base64').toString(),
  },
}));
vi.mock('@/common/adapter/ipcBridge', () => ({
  secrets: {
    request: {
      provider: (fn: typeof mocks.request) => {
        mocks.request = fn;
      },
    },
    locked: { emit: mocks.emit },
  },
}));
import { initSecretsBridge } from '@/process/services/secrets/vaultLifecycle';
beforeEach(async () => {
  mocks.directory = await mkdtemp(path.join(tmpdir(), 'secrets-device-fixture-'));
  mocks.available = true;
  mocks.emit.mockClear();
  mocks.fetch.mockReset();
  mocks.listeners.clear();
  vi.stubGlobal('__backendPort', 45678);
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.fetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      success: true,
      data: { vault_id: 'fixture', envelope_id: 'first', key: 'SYNTHETIC_DEVICE_KEY' },
    }),
  });
  initSecretsBridge();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(mocks.directory, { recursive: true, force: true });
});
const request = (operation: SecretBridgeRequest['operation']) => mocks.request!({ operation });
describe('desktop vault lifecycle', () => {
  it('wraps only in main, restores with private backend operation, and forgets after rotation', async () => {
    await request('device/remember');
    const file = path.join(mocks.directory, 'secrets-device.key');
    expect((await readFile(file)).toString()).not.toContain('SYNTHETIC_DEVICE_KEY');
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    await request('device/unlock');
    const [url, options] = mocks.fetch.mock.calls.at(-1)!;
    expect(url).toContain('/vault/desktop-unlock');
    expect(JSON.parse(options.body).key).toBe('SYNTHETIC_DEVICE_KEY');
    expect(options.headers['x-ellmsha-secrets-human']).toHaveLength(64);
    await request('vault/change-passphrase');
    expect(await request('device/status')).toEqual({ available: true, remembered: false });
    expect(mocks.emit).toHaveBeenCalled();
  });
  it('rejects renderer attempts to export a key and has no unavailable-OS fallback', async () => {
    await expect(
      mocks.request!({ operation: 'vault/desktop-export' as SecretBridgeRequest['operation'] })
    ).rejects.toThrow('SECRETS_INVALID_OPERATION');
    mocks.available = false;
    await expect(request('device/remember')).rejects.toThrow('SECRETS_OS_WRAPPING_UNAVAILABLE');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('clears renderer state immediately on screen lock even when backend lock fails', async () => {
    mocks.fetch.mockRejectedValue(new Error('synthetic offline'));
    mocks.listeners.get('lock-screen')!();
    expect(mocks.emit).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(mocks.fetch.mock.calls[0]?.[0]).toContain('/vault/lock'));
    await Promise.resolve();
    mocks.listeners.get('before-quit')!();
    expect(mocks.emit).toHaveBeenCalledTimes(2);
  });
});

it('serializes a delayed remember before a later forget, preventing stale key resurrection', async () => {
  let release!: (value: unknown) => void;
  mocks.fetch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  const remembering = request('device/remember');
  await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce());
  const forgetting = request('device/forget');
  release({
    ok: true,
    json: async () => ({
      success: true,
      data: { vault_id: 'fixture', envelope_id: 'first', key: 'SYNTHETIC_DEVICE_KEY' },
    }),
  });
  await remembering;
  await forgetting;
  expect(await request('device/status')).toEqual({ available: true, remembered: false });
});

it.each(['offline', 'rejected', 'malformed'] as const)(
  'preserves the OS wrapper after transient %s failure and unlocks later',
  async (failure) => {
    await request('device/remember');
    const file = path.join(mocks.directory, 'secrets-device.key');
    const before = await readFile(file);
    if (failure === 'offline') mocks.fetch.mockRejectedValueOnce(new Error('synthetic transport timeout'));
    if (failure === 'rejected')
      mocks.fetch.mockResolvedValueOnce({ ok: false, json: async () => ({ code: 'STORAGE_UNAVAILABLE' }) });
    if (failure === 'malformed')
      mocks.fetch.mockResolvedValueOnce({
        ok: false,
        json: async () => {
          throw new SyntaxError('synthetic malformed response');
        },
      });
    await expect(request('device/unlock')).rejects.toThrow();
    expect(await readFile(file)).toEqual(before);
    await request('device/unlock');
    expect(await request('device/status')).toEqual({ available: true, remembered: true });
  }
);
it('forgets only a wrapper positively rejected as invalid by the backend', async () => {
  await request('device/remember');
  mocks.fetch.mockResolvedValueOnce({ ok: false, json: async () => ({ code: 'AUTHENTICATION_FAILED' }) });
  await expect(request('device/unlock')).rejects.toThrow('AUTHENTICATION_FAILED');
  expect(await request('device/status')).toEqual({ available: true, remembered: false });
});

it('forgets malformed decrypted wrapper data without echoing plaintext in its error', async () => {
  const raw = 'SYNTHETIC_PRIVATE_WRAPPER';
  await writeFile(path.join(mocks.directory, 'secrets-device.key'), Buffer.from(raw).toString('base64'));
  await expect(request('device/unlock')).rejects.toThrow('SECRETS_INVALID_DEVICE_WRAPPER');
  expect(await request('device/status')).toEqual({ available: true, remembered: false });
  expect(mocks.fetch).not.toHaveBeenCalled();
});
