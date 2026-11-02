import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';

const fixture = vi.hoisted(() => ({ fetch: vi.fn(), cookies: vi.fn(), owner: 'owner-a' }));
vi.mock('electron', () => ({
  session: { defaultSession: { fetch: fixture.fetch, cookies: { get: fixture.cookies } } },
}));
vi.mock('@process/services/browser/profiles', () => ({
  browserProfileFromToken: () => ({ claims: { user_id: fixture.owner } }),
}));
import { figmaTokenExpression, importFigmaAccountFromTab, isFigmaOrigin } from '@process/services/browser/figma';

const secret = 'figd_disposable_fixture_secret_not_for_chat';
const connection = {
  id: '11111111-1111-4111-8111-111111111111',
  namespace: 'figma-one',
  label: 'Account one',
  status: 'connected',
  identity: { account_id: 'one', account_name: 'One' },
  created_at: 1,
  updated_at: 1,
};
const tab = (url = 'https://www.figma.com/files/123') => ({
  getURL: vi.fn(() => url),
  isDestroyed: vi.fn(() => false),
  debugger: { sendCommand: vi.fn(async () => ({ result: { value: secret } })) },
});
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { __backendPort: 43123 });
  fixture.cookies.mockResolvedValue([{ name: 'aionui-csrf-token', value: 'fixture-csrf' }]);
  fixture.fetch.mockResolvedValue({
    ok: true,
    json: async () => ({ data: { ...connection, unexpected_token: secret } }),
  });
});
describe('private Figma browser import', () => {
  it('uses the exact native tab and sends the token only to the authenticated local service', async () => {
    const contents = tab();
    const authorize = vi.fn(async () => {});
    const publicResult = await importFigmaAccountFromTab(contents as never, '#new-token', 'scope-token', authorize);
    expect(publicResult).toEqual(connection);
    expect(JSON.stringify(publicResult)).not.toContain(secret);
    expect(authorize).toHaveBeenCalledTimes(3);
    expect(contents.debugger.sendCommand).toHaveBeenCalledWith(
      'Runtime.evaluate',
      expect.objectContaining({ returnByValue: true, expression: expect.stringContaining('#new-token') })
    );
    expect(fixture.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:43123/api/plugins/figma/connections',
      expect.objectContaining({
        credentials: 'include',
        redirect: 'error',
        headers: { 'content-type': 'application/json', 'x-csrf-token': 'fixture-csrf' },
        body: JSON.stringify({ personal_access_token: secret, expected_user_id: 'owner-a' }),
      })
    );
  });
  it('rejects untrusted origins, changed native targets, revoked scope and ambiguous fields before saving', async () => {
    for (const url of [
      'http://www.figma.com',
      'https://www.figma.com.evil.test',
      'https://user:pass@www.figma.com',
      'file:///private/token',
    ]) {
      expect(isFigmaOrigin(url)).toBe(false);
      const contents = tab(url);
      await expect(importFigmaAccountFromTab(contents as never, '#token', 'scope', async () => {})).rejects.toThrow(
        'exact signed-in Figma tab'
      );
      expect(contents.debugger.sendCommand).not.toHaveBeenCalled();
    }
    const changed = tab();
    changed.getURL
      .mockReturnValueOnce('https://www.figma.com/files/1')
      .mockReturnValue('https://www.figma.com/files/2');
    await expect(importFigmaAccountFromTab(changed as never, '#token', 'scope', async () => {})).rejects.toThrow(
      'changed during token import'
    );
    await expect(
      importFigmaAccountFromTab(tab() as never, '#token', 'scope', async () => {
        throw new Error('scope revoked');
      })
    ).rejects.toThrow('scope revoked');
    const missing = tab();
    missing.debugger.sendCommand.mockResolvedValueOnce({ result: { value: null } } as never);
    await expect(importFigmaAccountFromTab(missing as never, '#token', 'scope', async () => {})).rejects.toThrow(
      'unavailable or ambiguous'
    );
    expect(fixture.fetch).not.toHaveBeenCalled();
  });
  it('withholds provider bodies, malformed replies, and tokens echoed in public labels', async () => {
    fixture.fetch.mockResolvedValueOnce({ ok: false, json: async () => ({ error: secret }) });
    const error = await importFigmaAccountFromTab(tab() as never, '#token', 'scope', async () => {}).catch(
      (error: Error) => error
    );
    expect(String(error)).not.toContain(secret);
    fixture.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: { ...connection, label: secret } }) });
    await expect(importFigmaAccountFromTab(tab() as never, '#token', 'scope', async () => {})).rejects.toThrow(
      'Private Figma response withheld'
    );
    fixture.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => {
        throw new Error(secret);
      },
    });
    const malformed = await importFigmaAccountFromTab(tab() as never, '#token', 'scope', async () => {}).catch(
      (error: Error) => error
    );
    expect(String(malformed)).not.toContain(secret);
  });
  it('extracts one exact leaf or token input, never passwords or large containers', () => {
    class Input {
      constructor(
        public value: string,
        public type = 'text'
      ) {}
    }
    class Textarea {
      constructor(public value: string) {}
    }
    const evaluate = (matches: unknown[], origin = 'https://www.figma.com') =>
      runInNewContext(figmaTokenExpression('#token'), {
        location: { origin },
        document: { querySelectorAll: () => matches },
        HTMLInputElement: Input,
        HTMLTextAreaElement: Textarea,
      });
    expect(evaluate([new Input(secret)])).toBe(secret);
    expect(evaluate([{ children: [], textContent: secret }])).toBe(secret);
    expect(evaluate([new Input(secret, 'password')])).toBeNull();
    expect(evaluate([new Input(secret), new Input(secret)])).toBeNull();
    expect(evaluate([{ children: [{}], textContent: secret }])).toBeNull();
    expect(evaluate([new Input(secret)], 'https://evil.test')).toBeNull();
    expect(evaluate([new Input('short')])).toBeNull();
    expect(evaluate([new Input(secret + '\nother')])).toBeNull();
  });
});
