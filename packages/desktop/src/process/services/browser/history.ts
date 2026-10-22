import { app, type WebContents } from 'electron';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

type Snapshot = { entries: Electron.NavigationEntry[]; index: number };
const file = (profileId: string, tabId: string) => {
  if (!/^[a-f0-9]{64}$/.test(profileId) || !/^[a-zA-Z0-9._:-]{1,200}$/.test(tabId)) return undefined;
  return path.join(app.getPath('userData'), 'browser-history-v2', profileId, `${tabId}.json`);
};
/** Never persist opaque pageState: restoring it can silently resubmit POST side effects. */
export function saveBrowserHistory(profileId: string, tabId: string, contents: WebContents): void {
  try {
    const destination = file(profileId, tabId);
    if (!destination || contents.isDestroyed()) return;
    const entries = contents.navigationHistory.getAllEntries().map(({ url, title }) => ({ url, title }));
    if (!entries.length || entries.length > 500) return;
    const snapshot = JSON.stringify({ entries, index: contents.navigationHistory.getActiveIndex() });
    if (Buffer.byteLength(snapshot) > 8 * 1024 * 1024) return;
    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${randomBytes(8).toString('hex')}.tmp`;
    writeFileSync(temporary, snapshot, { mode: 0o600 });
    renameSync(temporary, destination);
  } catch {
    // A failed history write must not break a live browser page or expose its URLs.
  }
}
export function readBrowserHistory(profileId: string, tabId: string): Snapshot | undefined {
  try {
    const source = file(profileId, tabId);
    if (!source) return;
    const raw = readFileSync(source, 'utf8');
    if (Buffer.byteLength(raw) > 8 * 1024 * 1024) return;
    const snapshot = JSON.parse(raw) as Snapshot;
    if (
      !Array.isArray(snapshot.entries) ||
      !snapshot.entries.length ||
      snapshot.entries.length > 500 ||
      !Number.isInteger(snapshot.index) ||
      snapshot.index < 0 ||
      snapshot.index >= snapshot.entries.length
    )
      return;
    if (
      snapshot.entries.some(
        (entry) =>
          !entry ||
          typeof entry.url !== 'string' ||
          !(entry.url === 'about:blank' || /^https?:\/\//.test(entry.url)) ||
          typeof entry.title !== 'string'
      )
    )
      return;
    // Strip old snapshots too; pageState from an earlier build must never be restored.
    return { entries: snapshot.entries.map(({ url, title }) => ({ url, title })), index: snapshot.index };
  } catch {
    return;
  }
}
export function clearBrowserHistory(profileId: string): void {
  if (!/^[a-f0-9]{64}$/.test(profileId)) throw new Error('Invalid browser profile.');
  rmSync(path.join(app.getPath('userData'), 'browser-history-v2', profileId), { recursive: true, force: true });
}
