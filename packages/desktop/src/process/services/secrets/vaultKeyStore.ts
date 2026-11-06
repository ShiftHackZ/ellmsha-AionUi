import type { SafeStorage } from 'electron';

/** Offer optional OS unlock without probing a keychain, which can prompt or block. */
export function supportsVaultKeyWrapping(
  storage: Pick<SafeStorage, 'getSelectedStorageBackend'>,
  platform: NodeJS.Platform = process.platform
): boolean {
  return (
    platform === 'darwin' ||
    platform === 'win32' ||
    (platform === 'linux' &&
      ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(storage.getSelectedStorageBackend()))
  );
}

/** No plaintext/basic_text fallback. Caller owns persistence of the returned ciphertext. */
export function canWrapVaultKey(
  storage: Pick<SafeStorage, 'isEncryptionAvailable' | 'getSelectedStorageBackend'>,
  platform: NodeJS.Platform = process.platform
): boolean {
  return supportsVaultKeyWrapping(storage, platform) && storage.isEncryptionAvailable();
}

export function wrapVaultKey(storage: SafeStorage, key: string): Buffer {
  if (!canWrapVaultKey(storage)) throw new Error('SECRETS_OS_WRAPPING_UNAVAILABLE');
  return storage.encryptString(key);
}

export function unwrapVaultKey(storage: SafeStorage, ciphertext: Buffer): string {
  if (!canWrapVaultKey(storage)) throw new Error('SECRETS_OS_WRAPPING_UNAVAILABLE');
  return storage.decryptString(ciphertext);
}
