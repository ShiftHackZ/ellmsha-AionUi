import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { authorizeAppId, validateRequest } from '@process/services/browser/webauthn/policy';
const request = () => ({
  requestId: '12345678-1234-1234-1234-123456789abc',
  publicKey: {
    challenge: Buffer.from('challenge').toString('base64url'),
    rpId: 'amazon.com',
    allowCredentials: [{ type: 'public-key', id: 'a2V5' }],
  },
});

describe('security-key RP policy', () => {
  it('binds signed clientData to the actual origin and challenge', () => {
    const result = validateRequest(request(), 'https://signin.aws.amazon.com');
    expect(JSON.parse(Buffer.from(result.clientDataJSON, 'base64url').toString())).toEqual({
      type: 'webauthn.get',
      challenge: 'Y2hhbGxlbmdl',
      origin: 'https://signin.aws.amazon.com',
      crossOrigin: false,
    });
    expect(result.hash).toBe(
      createHash('sha256').update(Buffer.from(result.clientDataJSON, 'base64url')).digest('base64url')
    );
  });
  it.each(['https://evilamazon.com', 'http://signin.aws.amazon.com', 'https://127.0.0.1', 'https://com'])(
    'rejects an unauthorized origin %s',
    (origin) => expect(() => validateRequest(request(), origin)).toThrow()
  );
  it.each(['com', 'evil.test', 'amazon.com.evil.test'])('rejects RP escape %s', (rpId) => {
    const input = request();
    input.publicKey.rpId = rpId;
    expect(() => validateRequest(input, 'https://signin.aws.amazon.com')).toThrow();
  });
  it('keeps a credential discovered over NFC eligible when its key now uses USB', () => {
    const input = request();
    Object.assign(input.publicKey.allowCredentials[0], { transports: ['nfc'] });
    expect(validateRequest(input, 'https://signin.aws.amazon.com').allowCredentials).toEqual(['a2V5']);
  });
  it('rejects unsupported mediation, extensions and platform requests before IO', () => {
    for (const input of [
      { ...request(), mediation: 'conditional' },
      { ...request(), publicKey: { ...request().publicKey, extensions: { prf: {} } } },
      { ...request(), publicKey: { ...request().publicKey, authenticatorAttachment: 'platform' } },
    ])
      expect(() => validateRequest(input, 'https://signin.aws.amazon.com')).toThrow();
  });
  it('caps timeout and preserves required UV', () => {
    const result = validateRequest(
      {
        ...request(),
        publicKey: { ...request().publicKey, timeout: 999999, userVerification: 'required' },
      },
      'https://signin.aws.amazon.com'
    );
    expect([result.timeout, result.uv]).toEqual([120000, 'required']);
  });
  it('rejects oversized and noncanonical binary inputs', () => {
    for (const challenge of ['YQ==', '!', 'a'.repeat(2000)])
      expect(() =>
        validateRequest(
          { ...request(), publicKey: { ...request().publicKey, challenge } },
          'https://signin.aws.amazon.com'
        )
      ).toThrow();
  });
});
describe('legacy AppID authorization', () => {
  it('preserves an exact authorized AppID without adding a slash', async () =>
    expect(await authorizeAppId('https://amazon.com', 'https://amazon.com')).toBe('https://amazon.com'));
  it('rejects cross-registrable-domain and non-HTTPS AppIDs before network IO', async () => {
    for (const appid of [
      'https://evil.test/facets',
      'http://amazon.com',
      'https://127.0.0.1',
      'https://u:p@amazon.com',
      'https://amazon.com:8443/facets',
      'https://amazon.com/facets#fragment',
      'https://amazon.com/facets#',
      'https://amazon.com.evil.test/facets',
      'https://evilamazon.com/facets',
      'https://com',
      'not a URL',
    ])
      await expect(authorizeAppId(appid, 'https://signin.aws.amazon.com')).rejects.toThrow();
  });
});
describe('AppID caller boundary', () => {
  it.each([
    ['https://other.github.io/facets', 'https://tenant.github.io'],
    ['https://other.blogspot.com/facets', 'https://tenant.blogspot.com'],
    ['https://github.io/facets', 'https://tenant.github.io'],
    ['https://example.test/facets', 'http://example.test'],
    ['https://example.test/facets', 'https://u:p@example.test'],
    ['https://example.test/facets', 'https://example.test/path'],
    ['https://example.test/facets', 'not a URL'],
    ['https://com', 'https://com'],
  ])('rejects AppID %s for invalid or unrelated caller %s', async (appid, origin) => {
    await expect(authorizeAppId(appid, origin)).rejects.toThrow();
  });
  it('uses the exact caller origin for an empty AppID', async () => {
    expect(await authorizeAppId('', 'https://signin.aws.amazon.com')).toBe('https://signin.aws.amazon.com');
  });
});
