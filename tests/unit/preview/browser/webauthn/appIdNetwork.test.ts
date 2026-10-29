import { afterEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ resolve: vi.fn(), get: vi.fn() }));
vi.mock('node:dns/promises', () => ({
  Resolver: class {
    resolve4 = f.resolve;
  },
}));
vi.mock('node:https', () => ({ default: { get: f.get } }));
import { authorizeAppId, WebAuthnError } from '@process/services/browser/webauthn/policy';
afterEach(() => vi.clearAllMocks());
describe('network-free same-site AppID authorization', () => {
  it.each([
    ['https://eu-north-1.signin.aws.amazon.com', 'https://signin.aws.amazon.com'],
    ['https://us-east-1.signin.aws.amazon.com', 'https://SIGNIN.aws.amazon.com:443/fido%2f?version=1'],
    ['https://login.example.co.uk', 'https://keys.example.co.uk/facets'],
    ['https://login.tenant.github.io', 'https://keys.tenant.github.io/facets'],
  ])('authorizes sibling AppID for %s without DNS or HTTP', async (origin, appid) => {
    expect(await authorizeAppId(appid, origin)).toBe(appid);
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
  });
  it('honors an already aborted ceremony before authorizing', async () => {
    const control = new AbortController();
    control.abort(new WebAuthnError('AbortError'));
    await expect(
      authorizeAppId('https://amazon.com', 'https://signin.aws.amazon.com', control.signal)
    ).rejects.toMatchObject({ code: 'AbortError' });
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
  });
});
