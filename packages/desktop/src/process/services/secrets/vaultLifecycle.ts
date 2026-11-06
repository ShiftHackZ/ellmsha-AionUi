import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app, powerMonitor, safeStorage } from 'electron';
import { secrets } from '@/common/adapter/ipcBridge';
import { SECRET_OPERATIONS, type SecretBridgeRequest } from '@/common/types/secrets';
import { canWrapVaultKey, wrapVaultKey, unwrapVaultKey } from './vaultKeyStore';

// Supplied only to the backend spawn environment, which consumes/removes it before starting threads.
const humanCapability = randomBytes(32).toString('hex');
export const getSecretsHumanCapability = (): string => humanCapability;
const keyPath = (): string => path.join(app.getPath('userData'), 'secrets-device.key');
const safeErrors = new Set([
  'VAULT_LOCKED',
  'VAULT_NOT_INITIALIZED',
  'REVISION_CONFLICT',
  'FORBIDDEN',
  'AUTHENTICATION_FAILED',
  'INVALID_INPUT',
  'CONTEXT_REQUIRED',
  'PROJECT_SCOPE_REQUIRED',
  'PLUGIN_DISABLED',
  'MESSAGE_BUSY',
]);

async function backend(operation: string, body?: unknown): Promise<unknown> {
  const port = (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort;
  if (!port) throw new Error('SECRETS_BACKEND_UNAVAILABLE');
  const response = await fetch(`http://127.0.0.1:${port}/api/secrets/${operation}`, {
    method: operation === 'status' ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'x-ellmsha-secrets-human': humanCapability },
    body: operation === 'status' ? undefined : JSON.stringify(body ?? {}),
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(30000),
  });
  const value = (await response.json()) as {
    success?: boolean;
    data?: unknown;
    code?: string;
    error?: { code?: string };
  };
  if (!response.ok || !value.success) {
    const code = value.code ?? value.error?.code;
    throw new Error(code && safeErrors.has(code) ? code : 'SECRETS_REQUEST_REJECTED');
  }
  return value.data;
}
async function forget(): Promise<void> {
  await fs.rm(keyPath(), { force: true });
}
async function performRequest({ operation, body }: SecretBridgeRequest): Promise<unknown> {
  if (!SECRET_OPERATIONS.includes(operation)) throw new Error('SECRETS_INVALID_OPERATION');
  if (operation === 'device/status')
    return {
      available: canWrapVaultKey(safeStorage),
      remembered: await fs.stat(keyPath()).then(
        () => true,
        () => false
      ),
    };
  if (operation === 'device/forget') {
    await forget();
    return {};
  }
  if (operation === 'device/remember') {
    if (!canWrapVaultKey(safeStorage)) throw new Error('SECRETS_OS_WRAPPING_UNAVAILABLE');
    const key = await backend('vault/desktop-export');
    const ciphertext = wrapVaultKey(safeStorage, JSON.stringify(key));
    const temporary = `${keyPath()}.${randomBytes(8).toString('hex')}`;
    try {
      await fs.writeFile(temporary, ciphertext, { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, keyPath());
    } finally {
      ciphertext.fill(0);
      await fs.rm(temporary, { force: true });
    }
    return {};
  }
  if (operation === 'device/unlock') {
    if (!canWrapVaultKey(safeStorage)) throw new Error('SECRETS_OS_WRAPPING_UNAVAILABLE');
    const ciphertext = await fs.readFile(keyPath());
    try {
      // OS decryption may fail transiently (for example, a locked keychain).
      // Preserve the wrapper unless its plaintext shape or backend identity is invalid.
      const plaintext = unwrapVaultKey(safeStorage, ciphertext);
      let key: unknown;
      try {
        key = JSON.parse(plaintext) as unknown;
      } catch {
        await forget();
        throw new Error('SECRETS_INVALID_DEVICE_WRAPPER');
      }
      try {
        return await backend('vault/desktop-unlock', key);
      } catch (error) {
        if (error instanceof Error && ['AUTHENTICATION_FAILED', 'INVALID_INPUT'].includes(error.message))
          await forget();
        throw error;
      }
    } finally {
      ciphertext.fill(0);
    }
  }
  const result = await backend(operation, body);
  if (operation === 'vault/change-passphrase' || operation === 'vault/restore') {
    await forget();
    secrets.locked.emit();
  }
  if (operation === 'vault/lock') secrets.locked.emit();
  return result;
}

// Device writes and lifecycle mutations share one queue. A later forget cannot be
// overtaken by an older remember waiting on backend/OS encryption.
let lifecycle: Promise<unknown> = Promise.resolve();
function request(input: SecretBridgeRequest): Promise<unknown> {
  if (!input.operation.startsWith('device/') && !input.operation.startsWith('vault/')) return performRequest(input);
  const result = lifecycle.then(() => performRequest(input));
  lifecycle = result.catch((): undefined => undefined);
  return result;
}

export function initSecretsBridge(): void {
  secrets.request.provider(request);
  powerMonitor.on('lock-screen', () => {
    secrets.locked.emit();
    void request({ operation: 'vault/lock' }).catch((): void => {
      /* Backend expiry independently locks idle keys. */
    });
  });
  app.on('before-quit', () => {
    secrets.locked.emit();
  });
}
