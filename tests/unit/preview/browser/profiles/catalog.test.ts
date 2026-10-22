import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ directory: '' }));
vi.mock('electron', () => ({
  app: { getPath: () => fixture.directory },
  session: { defaultSession: { fetch: (...args: Parameters<typeof fetch>) => fetch(...args) } },
}));
let profiles: typeof import('@process/services/browser/profiles');
let key = '';
const chats = new Map<string, string | null>();
const broken = new Set<string>();
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ data }), { status, headers: { 'content-type': 'application/json' } });
beforeEach(async () => {
  vi.resetModules();
  fixture.directory = mkdtempSync(path.join(os.tmpdir(), 'ellmsha-catalog-'));
  profiles = await import('@process/services/browser/profiles');
  profiles.initializeBrowserProfiles();
  key = profiles.getBrowserScopeKey()!;
  (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort = 12345;
  chats.clear();
  broken.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/conversations')
        return json({ items: [...chats].map(([id, project_id]) => ({ id, project_id })), has_more: false });
      const id = decodeURIComponent(url.pathname.split('/')[3]);
      if (broken.has(id)) return json({}, 500);
      if (!chats.has(id)) return json({}, 404);
      const project = chats.get(id)!;
      const body = Buffer.from(JSON.stringify({ user_id: 'owner', conversation_id: id, project_id: project })).toString(
        'base64url'
      );
      return json({
        conversation_id: id,
        project_id: project,
        project_name: project,
        token: `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`,
      });
    })
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(fixture.directory, { recursive: true, force: true });
});
it('retains a surviving project reference when the latest conversation is deleted', async () => {
  chats.set('a1', 'A');
  chats.set('a2', 'A');
  const first = (await profiles.bindBrowserProfile('a1'))!;
  await profiles.bindBrowserProfile('a2');
  chats.delete('a2');
  const catalog = await profiles.listBrowserProfiles();
  expect(catalog).toHaveLength(1);
  expect(catalog[0]).toMatchObject({ profileId: first.profileId, conversationId: 'a1' });
});
it('finds an actual surviving conversation after every recorded reference was deleted or moved', async () => {
  chats.set('a1', 'A');
  chats.set('a2', 'A');
  chats.set('b', 'B');
  const first = (await profiles.bindBrowserProfile('a1'))!;
  await profiles.bindBrowserProfile('a2');
  await profiles.bindBrowserProfile('b');
  chats.delete('a1');
  chats.set('a2', 'B');
  chats.set('a3', 'A');
  const catalog = await profiles.listBrowserProfiles();
  expect(catalog.find((p) => p.profileId === first.profileId)).toMatchObject({ conversationId: 'a3', label: 'A' });
  const durable = readFileSync(path.join(fixture.directory, 'browser-profiles-v2.json'), 'utf8');
  expect(durable).toContain('a3');
  expect(durable).not.toContain('token');
});
it('isolates a corrupt binding without hiding a later unrelated profile or inventing Default', async () => {
  chats.set('a', 'A');
  chats.set('b', 'B');
  await profiles.bindBrowserProfile('a');
  const second = (await profiles.bindBrowserProfile('b'))!;
  broken.add('a');
  const catalog = await profiles.listBrowserProfiles();
  expect(catalog).toHaveLength(1);
  expect(catalog[0].profileId).toBe(second.profileId);
  expect(catalog[0].label).toBe('B');
});
it('resolves surviving Default chats through fresh owned candidates rather than changing project identity', async () => {
  chats.set('d1', null);
  const first = (await profiles.bindBrowserProfile('d1'))!;
  chats.delete('d1');
  chats.set('d2', null);
  chats.set('a', 'A');
  const catalog = await profiles.listBrowserProfiles();
  expect(catalog).toHaveLength(1);
  expect(catalog[0]).toMatchObject({ profileId: first.profileId, conversationId: 'd2', label: null });
});
