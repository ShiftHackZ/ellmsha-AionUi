import { EventEmitter } from 'node:events';
import { createHmac } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  sessions: new Map<string, object>(),
  contents: undefined as unknown,
  dialog: vi.fn(),
}));
vi.mock('electron', () => ({
  session: {
    defaultSession: { fetch: (...args: Parameters<typeof fetch>) => fetch(...args) },
    fromPartition: (partition: string) => {
      if (!fixture.sessions.has(partition)) fixture.sessions.set(partition, new EventEmitter());
      return fixture.sessions.get(partition);
    },
  },
  webContents: { fromFrame: () => fixture.contents },
  dialog: { showMessageBox: fixture.dialog },
}));
vi.mock('@process/services/i18n', () => ({ default: { t: (key: string) => key } }));
import {
  bindBrowserAuthHost,
  bindBrowserProfile,
  browserSession,
  getBrowserScopeKey,
  initializeBrowserProfiles,
} from '@process/services/browser/profiles';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('cancels a pending WebAuthn chooser on navigation exactly once and rejects foreign profiles', async () => {
  initializeBrowserProfiles();
  (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort = 12345;
  const body = Buffer.from(JSON.stringify({ user_id: 'owner', conversation_id: 'a', project_id: 'A' })).toString(
    'base64url'
  );
  const token = `${body}.${createHmac('sha256', getBrowserScopeKey()!).update(body).digest('base64url')}`;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ data: { conversation_id: 'a', project_id: 'A', project_name: 'A', token } }))
    )
  );
  const profile = (await bindBrowserProfile('a'))!;
  const host = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    session: browserSession(profile.profileId),
  });
  fixture.contents = contents;
  const frame = { isDestroyed: () => false };
  let finishDialog: (value: { response: number }) => void = () => {};
  fixture.dialog.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishDialog = resolve;
      })
  );
  bindBrowserAuthHost(profile.profileId, host as never);
  const callback = vi.fn();
  (browserSession(profile.profileId) as unknown as EventEmitter).emit(
    'select-webauthn-account',
    {},
    {
      frame,
      relyingPartyId: 'example.test',
      accounts: [{ displayName: 'Account', name: 'name', credentialId: 'credential' }],
    },
    callback
  );
  await vi.waitFor(() => expect(fixture.dialog).toHaveBeenCalledTimes(1));
  contents.emit('did-start-navigation');
  expect(callback).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(fixture.dialog.mock.calls[0][1].signal.aborted).toBe(true);
  finishDialog({ response: 0 });
  await Promise.resolve();
  await Promise.resolve();
  expect(callback).toHaveBeenCalledTimes(1);
  await bindBrowserProfile(null);
  const denied = vi.fn();
  (browserSession(profile.profileId) as unknown as EventEmitter).emit(
    'select-webauthn-account',
    {},
    { frame, accounts: [{}] },
    denied
  );
  expect(denied).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(fixture.dialog).toHaveBeenCalledTimes(1);
});
