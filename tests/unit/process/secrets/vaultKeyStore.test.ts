import { describe, expect, it, vi } from 'vitest';
import type { SafeStorage } from 'electron';
import { canWrapVaultKey, wrapVaultKey, unwrapVaultKey } from '@/process/services/secrets/vaultKeyStore';
describe('optional OS vault key wrapping', () => {
  it('rejects unavailable and Linux plaintext/unknown storage without fallback', () => {
    const storage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' as const };
    expect(canWrapVaultKey(storage, 'linux')).toBe(false);
    expect(canWrapVaultKey({ ...storage, getSelectedStorageBackend: () => 'unknown' }, 'linux')).toBe(false);
    expect(canWrapVaultKey({ ...storage, isEncryptionAvailable: () => false }, 'darwin')).toBe(false);
    expect(canWrapVaultKey({ ...storage, getSelectedStorageBackend: () => 'kwallet6' }, 'linux')).toBe(true);
  });
  it('does not invoke a Linux-only API on macOS or Windows', () => {
    const backend = vi.fn(() => {
      throw new Error('Linux only');
    });
    const storage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: backend };
    expect(canWrapVaultKey(storage, 'darwin')).toBe(true);
    expect(canWrapVaultKey(storage, 'win32')).toBe(true);
    expect(backend).not.toHaveBeenCalled();
  });
  it('delegates encryption and decryption exclusively to the OS wrapper', () => {
    const storage = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'gnome_libsecret',
      encryptString: vi.fn(() => Buffer.from('synthetic ciphertext')),
      decryptString: vi.fn(() => 'synthetic vault key'),
    } as unknown as SafeStorage;
    const ciphertext = wrapVaultKey(storage, 'synthetic vault key');
    expect(ciphertext.toString()).not.toContain('synthetic vault key');
    expect(unwrapVaultKey(storage, ciphertext)).toBe('synthetic vault key');
    expect(storage.encryptString).toHaveBeenCalledWith('synthetic vault key');
  });
});
