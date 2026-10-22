import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const sandbox = vi.hoisted(() => ({ directory: '' }));
vi.mock('electron', () => ({ app: { getPath: () => sandbox.directory } }));
import { clearBrowserHistory, readBrowserHistory, saveBrowserHistory } from '@/process/services/browser/history';
sandbox.directory = mkdtempSync(path.join(os.tmpdir(), 'ellmsha-history-test-'));
afterAll(() => rmSync(sandbox.directory, { recursive: true, force: true }));
const a = 'a'.repeat(64),
  b = 'b'.repeat(64);
const snapshot = {
  entries: [
    { url: 'https://example.test/one', title: 'One' },
    { url: 'https://example.test/two', title: 'Two' },
  ],
  index: 1,
};
const contents = {
  isDestroyed: () => false,
  navigationHistory: {
    getAllEntries: () => snapshot.entries.map((entry) => ({ ...entry, pageState: 'opaque-post-body' })),
    getActiveIndex: () => snapshot.index,
  },
};
describe('private browser navigation history', () => {
  it('retains the complete stack in its owning profile only', () => {
    saveBrowserHistory(a, 'tab-1', contents as never);
    expect(readBrowserHistory(a, 'tab-1')).toEqual(snapshot);
    expect(readBrowserHistory(b, 'tab-1')).toBeUndefined();
    expect(statSync(path.join(sandbox.directory, 'browser-history-v2', a, 'tab-1.json')).mode & 0o777).toBe(0o600);
  });
  it('never persists or restores opaque POST pageState, including legacy snapshots', () => {
    saveBrowserHistory(a, 'post-tab', contents as never);
    const filename = path.join(sandbox.directory, 'browser-history-v2', a, 'post-tab.json');
    expect(readFileSync(filename, 'utf8')).not.toContain('pageState');
    writeFileSync(
      filename,
      JSON.stringify({
        entries: [{ url: 'https://example.test/post', title: 'POST', pageState: 'opaque-post-body' }],
        index: 0,
      })
    );
    expect(readBrowserHistory(a, 'post-tab')).toEqual({
      entries: [{ url: 'https://example.test/post', title: 'POST' }],
      index: 0,
    });
  });
  it('clears only the selected profile history and rejects traversal', () => {
    saveBrowserHistory(b, 'tab-1', contents as never);
    clearBrowserHistory(a);
    expect(readBrowserHistory(a, 'tab-1')).toBeUndefined();
    expect(readBrowserHistory(b, 'tab-1')).toEqual(snapshot);
    expect(readBrowserHistory('../x', 'tab-1')).toBeUndefined();
    expect(readBrowserHistory(b, '../x')).toBeUndefined();
    expect(() => clearBrowserHistory('../x')).toThrow();
  });
});
