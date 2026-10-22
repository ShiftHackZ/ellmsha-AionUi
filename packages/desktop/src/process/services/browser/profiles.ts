import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { app, dialog, session, webContents, type BrowserWindow } from 'electron';
import type { BrowserProfileContext } from '@/common/adapter/ipcBridge';

type Claims = { user_id: string; conversation_id: string; project_id: string | null };
type CoreContext = { conversation_id: string; project_id: string | null; project_name: string | null; token: string };
let active: BrowserProfileContext | undefined;
let issuerKey: string | undefined;
/** Passed explicitly to the Core launcher, never stored in main process.env. */
export const getBrowserScopeKey = (): string | undefined => issuerKey;
let generation = 0;
const clearingProfiles = new Set<string>();
/** Pause all new browser actions while one profile is being cleared. */
export const setBrowserProfileClearing = (profileId: string, clearing: boolean): void => {
  if (clearing) clearingProfiles.add(profileId);
  else clearingProfiles.delete(profileId);
};
const authHosts = new Map<string, BrowserWindow>();
const pendingAuth = new Set<() => void>();
const configuredSessions = new WeakSet<Electron.Session>();
let registryLoaded = false;
const registryFile = () => path.join(app.getPath('userData'), 'browser-profiles-v2.json');
type RecordedProfile = { conversationIds: string[]; projectId?: string | null };
const recordedProfiles = new Map<string, RecordedProfile>();
const validConversationId = (id: unknown): id is string =>
  typeof id === 'string' && /^[a-zA-Z0-9._:-]{1,200}$/.test(id);
function loadRegistry(): void {
  if (registryLoaded) return;
  registryLoaded = true;
  try {
    const ids = JSON.parse(readFileSync(registryFile(), 'utf8')) as unknown;
    if (Array.isArray(ids))
      for (const entry of ids.slice(0, 1000)) {
        if (!entry || !/^[a-f0-9]{64}$/.test(entry.profileId)) continue;
        const sourceRefs: unknown[] = Array.isArray(entry.conversationIds)
          ? entry.conversationIds
          : [entry.conversationId];
        const refs = sourceRefs.filter(validConversationId).slice(0, 8);
        if (refs.length)
          recordedProfiles.set(entry.profileId, {
            conversationIds: [...new Set(refs)],
            projectId: entry.projectId === null || typeof entry.projectId === 'string' ? entry.projectId : undefined,
          });
      }
  } catch {
    /* Missing/corrupt catalog never establishes identity. */
  }
}
function persistRegistry(profileId: string, conversationId: string, projectId: string | null): void {
  loadRegistry();
  const previous = recordedProfiles.get(profileId)?.conversationIds ?? [];
  recordedProfiles.set(profileId, {
    conversationIds: [conversationId, ...previous.filter((id) => id !== conversationId)].slice(0, 8),
    projectId,
  });
  try {
    const file = registryFile();
    const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    writeFileSync(
      temporary,
      JSON.stringify([...recordedProfiles].slice(-1000).map(([profileId, refs]) => ({ profileId, ...refs }))),
      { mode: 0o600 }
    );
    renameSync(temporary, file);
  } catch {
    console.warn('[BrowserProfiles] Profile catalog could not be saved.');
  }
}
type Candidate = { id: string; project_id?: string };
async function ownedConversationCandidates(signal: AbortSignal): Promise<Candidate[]> {
  const port = (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort;
  if (!Number.isInteger(port)) return [];
  const rows: Candidate[] = [];
  let cursor = '';
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(1000)]);
  for (let page = 0; page < 4 && !bounded.aborted; page++) {
    const response = await session.defaultSession.fetch(
      `http://127.0.0.1:${port}/api/conversations?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      { credentials: 'include', signal: bounded }
    );
    if (!response.ok) break;
    const payload = (await response.json()) as { data?: { items?: Candidate[]; has_more?: boolean } };
    const items = payload.data?.items?.filter((row) => validConversationId(row.id)) ?? [];
    rows.push(...items);
    if (!payload.data?.has_more || !items.length || items.at(-1)!.id === cursor) break;
    cursor = items.at(-1)!.id;
  }
  return rows;
}
/** Fresh owner validation with bounded alternate refs; one corrupt binding cannot hide other profiles. */
export const listBrowserProfiles = async (): Promise<BrowserProfileContext[]> => {
  loadRegistry();
  const entries = [...recordedProfiles];
  const refreshed = new Map<string, BrowserProfileContext>();
  const budget = AbortSignal.timeout(8000);
  let candidates: Promise<Candidate[]> | undefined;
  let next = 0;
  const refresh = async ([profileId, record]: [string, RecordedProfile]) => {
    const attempt = AbortSignal.any([budget, AbortSignal.timeout(1200)]);
    const checked = new Set<string>();
    const accept = async (conversationId: string): Promise<boolean> => {
      if (attempt.aborted || checked.has(conversationId)) return false;
      checked.add(conversationId);
      try {
        const context = await readContext(conversationId, attempt);
        const verified = browserProfileFromToken(context.token);
        if (verified.id !== profileId) return false; // Moved/foreign is never a replacement or Default.
        refreshed.set(profileId, {
          profileId,
          conversationId,
          label: context.project_name,
          token: context.token,
          generation,
        });
        persistRegistry(profileId, conversationId, verified.claims.project_id);
        return true;
      } catch {
        return false;
      } // Isolate missing, moved, invalid and unavailable individual bindings.
    };
    for (const id of record.conversationIds) if (await accept(id)) return;
    candidates ??= ownedConversationCandidates(budget).catch((): Candidate[] => []);
    for (const row of await candidates) {
      if (attempt.aborted) break;
      if (typeof record.projectId === 'string' && row.project_id !== record.projectId) continue;
      if (await accept(row.id)) return;
    }
  };
  // Four bounded workers prevent a slow/deleted representative from starving later profiles.
  await Promise.all(
    Array.from({ length: Math.min(4, entries.length) }, async () => {
      while (!budget.aborted && next < entries.length) await refresh(entries[next++]);
    })
  );
  return entries.flatMap(([id]) => (refreshed.has(id) ? [refreshed.get(id)!] : []));
};

/** Issuer secret is inherited only by Core, never by agent subprocesses. */
export const initializeBrowserProfiles = (): void => {
  issuerKey = randomBytes(32).toString('hex');
};

/** Verify a Core-authored identity; profile names never come from renderer URLs or workspaces. */
export function browserProfileFromToken(token: string): { id: string; claims: Claims } {
  const key = issuerKey;
  if (!key || typeof token !== 'string' || token.length > 4096) throw new Error('Browser identity unavailable.');
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra) throw new Error('Invalid browser identity.');
  const expected = createHmac('sha256', key).update(body).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new Error('Invalid browser identity.');
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as Claims;
  if (
    !claims ||
    typeof claims.user_id !== 'string' ||
    !claims.user_id ||
    typeof claims.conversation_id !== 'string' ||
    !claims.conversation_id ||
    !(claims.project_id === null || (typeof claims.project_id === 'string' && claims.project_id))
  )
    throw new Error('Invalid browser ownership.');
  const id = createHash('sha256')
    .update(JSON.stringify([claims.user_id, claims.project_id]))
    .digest('hex');
  return { id, claims };
}

/** Recheck the canonical binding, including deletion/reassignment, before an operation. */
export async function validateBrowserToken(token: string): Promise<string> {
  const { id, claims } = browserProfileFromToken(token);
  if (clearingProfiles.has(id)) throw new Error('Browser profile data is being cleared.');
  const current = await readContext(claims.conversation_id);
  if (current.token !== token) throw new Error('Browser ownership changed. Reopen the conversation.');
  return id;
}

async function readContext(conversationId: string, signal?: AbortSignal): Promise<CoreContext> {
  const port = (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort;
  if (!Number.isInteger(port) || !conversationId) throw new Error('Browser project binding unavailable.');
  if (!issuerKey) throw new Error('Browser issuer unavailable.');
  const proof = createHmac('sha256', issuerKey)
    .update(`ellmsha-browser-context-v1:${conversationId}`)
    .digest('base64url');
  // Only the application's auth session participates; website partitions are never consulted.
  const response = await session.defaultSession.fetch(
    `http://127.0.0.1:${port}/api/conversations/${encodeURIComponent(conversationId)}/browser-context`,
    {
      credentials: 'include',
      headers: { 'x-ellmsha-browser-proof': proof },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
    }
  );
  if (!response.ok) throw new Error('Browser project binding unavailable.', { cause: { status: response.status } });
  const payload = (await response.json()) as { data?: CoreContext };
  if (!payload.data || payload.data.conversation_id !== conversationId)
    throw new Error('Browser project binding unavailable.');
  browserProfileFromToken(payload.data.token);
  return payload.data;
}

/** Invalidate first so delayed work cannot use the previous chat during resolution. */
export async function bindBrowserProfile(conversationId: string | null): Promise<BrowserProfileContext | undefined> {
  for (const cancel of pendingAuth) cancel();
  const request = ++generation;
  active = undefined;
  if (!conversationId) return;
  const context = await readContext(conversationId);
  if (request !== generation) throw new Error('Stale browser context request.');
  const profile = browserProfileFromToken(context.token);
  active = {
    profileId: profile.id,
    conversationId,
    label: context.project_name,
    token: context.token,
    generation: request,
  };
  persistRegistry(active.profileId, conversationId, profile.claims.project_id);
  return active;
}

export const getActiveBrowserProfile = (): BrowserProfileContext | undefined => active;
export const requireBrowserProfile = (token: string | undefined): BrowserProfileContext => {
  if (
    !token ||
    !active ||
    clearingProfiles.has(active.profileId) ||
    browserProfileFromToken(token).id !== active.profileId
  )
    throw new Error('This browser profile is not visible. Open its conversation first.');
  return active;
};
/** Bind native WebAuthn account selection to the exact visible profile/frame. */
export const bindBrowserAuthHost = (profileId: string, window: BrowserWindow): void => {
  authHosts.set(profileId, window);
  const owned = browserSession(profileId);
  if (configuredSessions.has(owned)) return;
  configuredSessions.add(owned);
  owned.on('select-webauthn-account', (_event, details, callback) => {
    let completed = false;
    const finish = (credentialId?: string): void => {
      if (!completed) {
        completed = true;
        callback(credentialId);
      }
    };
    const host = authHosts.get(profileId);
    const contents = details.frame ? webContents.fromFrame(details.frame) : undefined;
    const current = () =>
      !!host &&
      !host.isDestroyed() &&
      !!contents &&
      !contents.isDestroyed() &&
      contents.session === owned &&
      getActiveBrowserProfile()?.profileId === profileId &&
      details.frame !== null &&
      !details.frame.isDestroyed();
    if (!current() || !details.accounts.length) {
      finish();
      return;
    }
    const controller = new AbortController();
    const abort = () => {
      controller.abort();
      finish();
    };
    pendingAuth.add(abort);
    const timer = setTimeout(abort, 60_000);
    host!.once('closed', abort);
    contents!.once('did-start-navigation', abort);
    contents!.once('destroyed', abort);
    void import('@process/services/i18n')
      .then(({ default: i18n }) => {
        if (completed || !current()) throw new Error('Browser authentication context changed.');
        return dialog.showMessageBox(host!, {
          type: 'question',
          signal: controller.signal,
          title: i18n.t('settings.browserData.webauthnTitle'),
          message: details.relyingPartyId,
          buttons: [...details.accounts.map((account) => account.displayName || account.name), i18n.t('common.cancel')],
          cancelId: details.accounts.length,
          defaultId: details.accounts.length,
          noLink: true,
        });
      })
      .then(({ response }) => {
        if (current() && response < details.accounts.length) finish(details.accounts[response].credentialId);
      })
      .catch(() => {})
      .finally(() => {
        clearTimeout(timer);
        host?.removeListener('closed', abort);
        contents?.removeListener('did-start-navigation', abort);
        contents?.removeListener('destroyed', abort);
        pendingAuth.delete(abort);
        finish();
      });
  });
};

export const browserSession = (profileId: string) => {
  if (!/^[a-f0-9]{64}$/.test(profileId)) throw new Error('Invalid browser profile.');
  // Legacy persist:aionui-browser is intentionally never opened or migrated.
  return session.fromPartition(`persist:ellmsha-browser-v2-${profileId}`);
};
