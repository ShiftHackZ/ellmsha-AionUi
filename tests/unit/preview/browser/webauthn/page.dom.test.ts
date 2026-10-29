import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installSecurityKeyPage } from '@/preload/browserWebAuthnPage';

const originalCredentials = Object.getOwnPropertyDescriptor(navigator, 'credentials');
afterEach(() => {
  if (originalCredentials) Object.defineProperty(navigator, 'credentials', originalCredentials);
  else Reflect.deleteProperty(navigator, 'credentials');
  Reflect.deleteProperty(window, '__ellmshaSecurityKey');
  vi.unstubAllGlobals();
});
const setup = (response: unknown) => {
  const native = vi.fn().mockResolvedValue(null);
  const begin = vi.fn().mockResolvedValue(response);
  const cancel = vi.fn();
  Object.defineProperty(navigator, 'credentials', { configurable: true, value: { get: native } });
  Object.assign(window, { __ellmshaSecurityKey: { begin, cancel } });
  vi.stubGlobal('location', { protocol: 'https:' });
  vi.stubGlobal('PublicKeyCredential', class {});
  vi.stubGlobal(
    'AuthenticatorAssertionResponse',
    class {
      toJSON() {
        throw new TypeError('Illegal invocation: native internal slots required');
      }
    }
  );
  installSecurityKeyPage();
  return { native, begin, cancel };
};
describe('public-key page adapter', () => {
  it('keeps native non-public-key behavior', async () => {
    const { native, begin } = setup({});
    await navigator.credentials.get();
    expect(native).toHaveBeenCalledOnce();
    expect(begin).not.toHaveBeenCalled();
  });
  it('reconstructs standard binary fields, prototypes and JSON', async () => {
    setup({
      ok: true,
      assertion: { id: 'a2V5', authenticatorData: 'YXV0aA', signature: 'c2ln', userHandle: null },
      clientDataJSON: 'ZGF0YQ',
      appid: true,
    });
    const result = (await navigator.credentials.get({
      publicKey: { challenge: new Uint8Array([1, 2]) },
    })) as PublicKeyCredential;
    expect(result).toBeInstanceOf(PublicKeyCredential);
    expect(Array.from(new Uint8Array(result.rawId))).toEqual([107, 101, 121]);
    expect(result.getClientExtensionResults()).toEqual({ appid: true });
    expect(JSON.parse(JSON.stringify(result)).response.userHandle).toBe(null);
    expect((result.response as AuthenticatorAssertionResponse & { toJSON(): unknown }).toJSON()).toEqual({
      clientDataJSON: 'ZGF0YQ',
      authenticatorData: 'YXV0aA',
      signature: 'c2ln',
      userHandle: null,
    });
  });
  it('maps a rejected native result to DOMException', async () => {
    setup({ ok: false, error: 'SecurityError' });
    await expect(navigator.credentials.get({ publicKey: { challenge: new Uint8Array([1]) } })).rejects.toMatchObject({
      name: 'SecurityError',
    });
  });
  it('preserves actual TypeError semantics for malformed requests', async () => {
    setup({ ok: false, error: 'TypeError' });
    await expect(navigator.credentials.get({ publicKey: { challenge: new Uint8Array([1]) } })).rejects.toBeInstanceOf(
      TypeError
    );
  });
  it('does not start an already-aborted request', async () => {
    const { begin } = setup({});
    await expect(
      navigator.credentials.get({
        publicKey: { challenge: new Uint8Array([1]) },
        signal: AbortSignal.abort(),
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(begin).not.toHaveBeenCalled();
  });
});

describe('binary and cancellation boundary', () => {
  it.each([3, [1, 2], { 0: 1, length: 1 }, { byteLength: 1 }, { [Symbol.toStringTag]: 'ArrayBuffer' }])(
    'rejects non-BufferSource input %s without native IO',
    async (challenge) => {
      const { begin } = setup({});
      await expect(
        navigator.credentials.get({ publicKey: { challenge: challenge as BufferSource } })
      ).rejects.toBeInstanceOf(TypeError);
      expect(begin).not.toHaveBeenCalled();
    }
  );
  it('accepts DataView and cross-realm ArrayBuffer intrinsic brands', async () => {
    const { begin } = setup({ ok: false, error: 'NotAllowedError' });
    await expect(
      navigator.credentials.get({ publicKey: { challenge: new DataView(new Uint8Array([7]).buffer) } })
    ).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(begin.mock.calls[0][0].publicKey.challenge).toBe('Bw');
    const foreign = runInNewContext('new Uint8Array([9]).buffer') as ArrayBuffer;
    await expect(navigator.credentials.get({ publicKey: { challenge: foreign } })).rejects.toMatchObject({
      name: 'NotAllowedError',
    });
    expect(begin.mock.calls[1][0].publicKey.challenge).toBe('CQ');
  });
  it('does not invoke begin after a serialization getter aborts', async () => {
    const { begin } = setup({});
    const control = new AbortController();
    const key = {
      get challenge() {
        control.abort();
        return new Uint8Array([1]);
      },
    };
    await expect(navigator.credentials.get({ publicKey: key, signal: control.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(begin).not.toHaveBeenCalled();
  });
  it('settles aborted page requests even when the bridge never responds and removes listeners', async () => {
    const { begin, cancel } = setup({});
    begin.mockImplementation(() => new Promise(() => {}));
    const control = new AbortController();
    const removed = vi.spyOn(control.signal, 'removeEventListener');
    const pending = navigator.credentials.get({
      publicKey: { challenge: new Uint8Array([1]) },
      signal: control.signal,
    });
    control.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});
