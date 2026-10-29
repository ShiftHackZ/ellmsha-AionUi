import type { SecurityKeyRequest, SecurityKeyResponse } from '@/common/types/browserWebAuthn';

/** Serialized into the website's MAIN world; intentionally captures no module state. */
export function installSecurityKeyPage() {
  const bridge = (
    window as unknown as {
      __ellmshaSecurityKey?: {
        begin: (request: SecurityKeyRequest) => Promise<SecurityKeyResponse>;
        cancel: (id: string) => void;
      };
    }
  ).__ellmshaSecurityKey;
  if (!bridge || !navigator.credentials || window !== window.top || location.protocol !== 'https:') return;
  const native = navigator.credentials.get.bind(navigator.credentials);
  const encode = (value: BufferSource): string => {
    // ArrayBuffer's intrinsic getter accepts cross-realm buffers while rejecting
    // numbers, arrays, array-likes and spoofed Symbol.toStringTag objects.
    let bytes: Uint8Array;
    try {
      if (ArrayBuffer.isView(value)) {
        Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!.call(value.buffer);
        bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      } else {
        const length = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!.call(value);
        bytes = new Uint8Array(value as ArrayBuffer, 0, length);
      }
    } catch {
      throw new TypeError('Security-key input must be a BufferSource');
    }
    if (!bytes.length || bytes.length > 1024) throw new TypeError('Invalid security-key binary input');
    return btoa(Array.from(bytes, (v) => String.fromCharCode(v)).join(''))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  };
  const decode = (value: string): ArrayBuffer =>
    Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)).buffer;
  Object.defineProperty(navigator.credentials, 'get', {
    configurable: true,
    value: async (options?: CredentialRequestOptions): Promise<Credential | null> => {
      if (!options?.publicKey) return native(options);
      if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const key = options.publicKey;
      const requestId = crypto.randomUUID();
      const signal = options.signal;
      let rejectAbort: ((reason: DOMException) => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = reject;
      });
      // Attach a handler immediately: a serialization getter may abort before
      // bridge.begin exists, or throw before Promise.race is reached.
      void aborted.catch(() => {});
      const abort = () => {
        rejectAbort?.(new DOMException('Aborted', 'AbortError'));
        bridge.cancel(requestId);
      };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        const request: SecurityKeyRequest = {
          requestId,
          mediation: options.mediation,
          publicKey: {
            ...key,
            challenge: encode(key.challenge),
            allowCredentials: key.allowCredentials?.map((c) => ({ ...c, id: encode(c.id) })),
            extensions: key.extensions as Record<string, unknown> | undefined,
          },
        };
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const result = await Promise.race([bridge.begin(request), aborted]);
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        if (result.ok === false) {
          if (result.error === 'TypeError') throw new TypeError('Invalid security-key request');
          throw new DOMException('Security-key authentication did not complete', result.error);
        }
        const a = result.assertion;
        const response = Object.create(AuthenticatorAssertionResponse.prototype) as AuthenticatorAssertionResponse;
        Object.defineProperties(response, {
          clientDataJSON: { value: decode(result.clientDataJSON), enumerable: true },
          authenticatorData: { value: decode(a.authenticatorData), enumerable: true },
          signature: { value: decode(a.signature), enumerable: true },
          userHandle: { value: a.userHandle ? decode(a.userHandle) : null, enumerable: true },
          toJSON: {
            value: () => ({
              clientDataJSON: result.clientDataJSON,
              authenticatorData: a.authenticatorData,
              signature: a.signature,
              userHandle: a.userHandle,
            }),
          },
        });
        const extensions = result.appid === undefined ? {} : { appid: result.appid };
        const credential = Object.create(PublicKeyCredential.prototype) as PublicKeyCredential;
        Object.defineProperties(credential, {
          id: { value: a.id, enumerable: true },
          rawId: { value: decode(a.id), enumerable: true },
          type: { value: 'public-key', enumerable: true },
          authenticatorAttachment: { value: 'cross-platform', enumerable: true },
          response: { value: response, enumerable: true },
          getClientExtensionResults: { value: () => ({ ...extensions }) },
          toJSON: {
            value: () => ({
              id: a.id,
              rawId: a.id,
              type: 'public-key',
              authenticatorAttachment: 'cross-platform',
              response: {
                clientDataJSON: result.clientDataJSON,
                authenticatorData: a.authenticatorData,
                signature: a.signature,
                userHandle: a.userHandle,
              },
              clientExtensionResults: { ...extensions },
            }),
          },
        });
        return credential;
      } finally {
        signal?.removeEventListener('abort', abort);
      }
    },
  });
}
