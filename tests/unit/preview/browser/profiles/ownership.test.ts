import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getBrowserScopeKey,
  initializeBrowserProfiles,
  bindBrowserProfile,
  browserProfileFromToken,
  browserSession,
  getActiveBrowserProfile,
  requireBrowserProfile,
  validateBrowserToken,
} from '@process/services/browser/profiles';
const fixtures = vi.hoisted(() => ({ sessions: new Map<string, object>(), requested: [] as string[] }));
vi.mock('electron', () => ({
  session: {
    defaultSession: { fetch: (...args: Parameters<typeof fetch>) => fetch(...args) },
    fromPartition: (partition: string) => {
      fixtures.requested.push(partition);
      let value = fixtures.sessions.get(partition);
      if (!value) {
        value = {};
        fixtures.sessions.set(partition, value);
      }
      return value;
    },
  },
}));
vi.mock('@process/services/i18n', () => ({ default: { t: (key: string) => key } }));
let key = '';
const token = (conversation: string, project: string | null, user = 'owner') => {
  const body = Buffer.from(
    JSON.stringify({ user_id: user, conversation_id: conversation, project_id: project })
  ).toString('base64url');
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
};
const response = (conversation: string, project: string | null) =>
  new Response(
    JSON.stringify({
      data: {
        conversation_id: conversation,
        project_id: project,
        project_name: project,
        token: token(conversation, project),
      },
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
beforeEach(async () => {
  vi.stubEnv('AIONUI_BROWSER_SCOPE_KEY', undefined);
  initializeBrowserProfiles();
  key = getBrowserScopeKey()!;
  (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort = 12345;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response('a', 'project-a'))
  );
  await bindBrowserProfile(null);
  fixtures.requested.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('canonical browser ownership', () => {
  it('shares one project profile across chats and one Default across unrelated chats', () => {
    expect(browserProfileFromToken(token('a', 'project-a')).id).toBe(
      browserProfileFromToken(token('b', 'project-a')).id
    );
    expect(browserProfileFromToken(token('a', null)).id).toBe(browserProfileFromToken(token('b', null)).id);
    expect(browserProfileFromToken(token('a', 'project-a')).id).not.toBe(
      browserProfileFromToken(token('a', 'project-b')).id
    );
  });
  it('keeps account owners separate and rejects unsigned or malformed identities', () => {
    expect(browserProfileFromToken(token('a', null, 'owner-a')).id).not.toBe(
      browserProfileFromToken(token('a', null, 'owner-b')).id
    );
    expect(() => browserProfileFromToken('old-global-token')).toThrow('Invalid browser identity');
    expect(() => browserProfileFromToken(token('a', null) + 'tampered')).toThrow('Invalid browser identity');
  });
  it('uses separate persistent Chromium sessions without touching the legacy partition', () => {
    const a = browserProfileFromToken(token('a', 'project-a')).id;
    const b = browserProfileFromToken(token('b', 'project-b')).id;
    expect(browserSession(a)).toBe(browserSession(a));
    expect(browserSession(a)).not.toBe(browserSession(b));
    expect(fixtures.requested.every((value) => /^persist:ellmsha-browser-v2-[a-f0-9]{64}$/.test(value))).toBe(true);
  });
  it('rechecks the canonical binding and rejects an existing capability after reassignment or deletion', async () => {
    await bindBrowserProfile('a');
    vi.mocked(fetch).mockResolvedValueOnce(response('a', 'project-b'));
    await expect(validateBrowserToken(token('a', 'project-a'))).rejects.toThrow('ownership changed');
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(validateBrowserToken(token('a', 'project-a'))).rejects.toThrow('binding unavailable');
  });
  it('invalidates old visible access immediately and refuses late resolver completion', async () => {
    await bindBrowserProfile('a');
    let complete!: (value: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    const pending = bindBrowserProfile('b');
    expect(() => requireBrowserProfile(token('a', 'project-a'))).toThrow('not visible');
    await bindBrowserProfile(null);
    complete(response('b', 'project-b'));
    await expect(pending).rejects.toThrow('Stale browser context');
    expect(getActiveBrowserProfile()).toBeUndefined();
  });
});
