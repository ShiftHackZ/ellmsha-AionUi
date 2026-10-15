import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, WebContents } from 'electron';
import type { BrowserPopupCommand } from '@/common/adapter/ipcBridge';
import { MAX_BROWSER_TABS } from '@/common/config/constants';
import {
  bindBrowserPopups,
  configureBrowserPopups,
  controlBrowserPopup,
  getBrowserPopup,
  registerBrowserPopupOpener,
  reconcileBrowserTabs,
} from '@/process/services/browser/popups';
const mocks = vi.hoisted(() => ({
  session: {},
  events: [] as Array<Record<string, unknown>>,
  views: [] as FakeView[],
}));
let id = 0;
class FakeContents extends EventEmitter {
  id = ++id;
  session = mocks.session;
  hostWebContents?: unknown;
  destroyed = false;
  setWindowOpenHandler = vi.fn();
  navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack: vi.fn(), goForward: vi.fn() };
  isDestroyed = () => this.destroyed;
  getURL = () => 'about:blank';
  getTitle = () => 'Owned child';
  isLoading = () => false;
  loadURL = vi.fn().mockResolvedValue(undefined);
  focus = vi.fn();
  reload = vi.fn();
  close = vi.fn(() => {
    this.destroyed = true;
    this.emit('destroyed');
  });
}
class FakeView {
  webContents = new FakeContents();
  setVisible = vi.fn();
  setBounds = vi.fn();
  setBackgroundColor = vi.fn();
  constructor(readonly options: unknown) {
    mocks.views.push(this);
  }
}
vi.mock('electron', () => ({
  session: { fromPartition: () => mocks.session },
  WebContentsView: function (options: unknown) {
    return new FakeView(options);
  },
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    application: {
      browserTabCommand: { emit: (value: Record<string, unknown>) => mocks.events.push(value) },
      browserPopupState: { emit: vi.fn() },
    },
  },
}));
const setup = () => {
  const host = Object.assign(new EventEmitter(), {
    webContents: Object.assign(new EventEmitter(), { getZoomFactor: () => 1 }),
    isDestroyed: () => false,
    getContentSize: () => [800, 600],
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  });
  const source = new FakeContents();
  source.hostWebContents = host.webContents;
  registerBrowserPopupOpener(host as unknown as BrowserWindow, 'source-tab', source as unknown as WebContents);
  configureBrowserPopups(source as unknown as WebContents, host as unknown as BrowserWindow);
  return { host: host as unknown as BrowserWindow, source, handler: source.setWindowOpenHandler.mock.calls[0][0] };
};
afterEach(() => {
  for (const view of mocks.views) if (!view.webContents.destroyed) view.webContents.close();
  mocks.views.length = 0;
  mocks.events.length = 0;
  vi.useRealTimers();
});
describe('native popup tabs', () => {
  it('adopts the exact native child with options, stable identity and no URL reload', () => {
    const { handler } = setup();
    const decision = handler({
      url: 'https://fixture.test/post',
      disposition: 'foreground-tab',
      postBody: { data: [] },
    });
    const options = { webPreferences: { session: mocks.session, sandbox: true } };
    const child = decision.createWindow(options);
    const created = mocks.events.find((event) => event.action === 'adopt')!;
    expect(created).toMatchObject({ openerTabId: 'source-tab', url: 'https://fixture.test/post', activate: true });
    expect(mocks.views[0].options).toBe(options);
    expect(getBrowserPopup(String(created.tabId), child.id)?.view.webContents).toBe(child);
    expect(child.loadURL).not.toHaveBeenCalled();
  });
  it('rejects unsupported schemes and unmapped guests instead of creating a foreign window', () => {
    const { handler, host } = setup();
    for (const url of ['file:///private/test', 'javascript:alert(1)', 'custom://open'])
      expect(handler({ url }).action).toBe('deny');
    const foreign = new FakeContents();
    configureBrowserPopups(foreign as unknown as WebContents, host);
    expect(foreign.setWindowOpenHandler.mock.calls[0][0]({ url: 'https://fixture.test' }).action).toBe('deny');
  });
  it('keeps background children hidden, clamps bounds, and only focuses active owned views', () => {
    const { handler, host } = setup();
    const child = handler({ url: 'about:blank', disposition: 'background-tab' }).createWindow({});
    const tabId = String(mocks.events.find((event) => event.action === 'adopt')!.tabId);
    expect(mocks.events[0].activate).toBe(false);
    expect(() => controlBrowserPopup(host, { action: 'focus', tabId })).toThrow('not visible');
    controlBrowserPopup(host, {
      action: 'sync',
      tabId,
      active: true,
      bounds: { x: 700, y: 500, width: 300, height: 300 },
    });
    expect(mocks.views[0].setBounds).toHaveBeenLastCalledWith({ x: 700, y: 500, width: 100, height: 100 });
    controlBrowserPopup(host, { action: 'focus', tabId });
    expect(child.focus).toHaveBeenCalledOnce();
    expect(() => controlBrowserPopup(setup().host, { action: 'reload', tabId })).toThrow('No such');
  });
  it('closes tab on child window.close and removes native view and registry', () => {
    const { handler, host } = setup();
    const child = handler({ url: 'about:blank' }).createWindow({});
    const tabId = String(mocks.events.find((event) => event.action === 'adopt')!.tabId);
    child.close();
    expect(getBrowserPopup(tabId)).toBeUndefined();
    expect(host.contentView.removeChildView).toHaveBeenCalledOnce();
    expect(mocks.events.at(-1)).toEqual({ action: 'close', tabId });
  });
  it('keeps independent tabs when opener closes and cancels disposal on immediate remount', () => {
    vi.useFakeTimers();
    const { handler, host, source } = setup();
    const child = handler({ url: 'about:blank' }).createWindow({});
    const tabId = String(mocks.events.find((event) => event.action === 'adopt')!.tabId);
    controlBrowserPopup(host, { action: 'dispose', tabId });
    controlBrowserPopup(host, { action: 'sync', tabId, active: false, bounds: { x: 0, y: 0, width: 10, height: 10 } });
    vi.runAllTimers();
    expect(child.destroyed).toBe(false);
    source.close();
    expect(child.destroyed).toBe(false);
    controlBrowserPopup(host, { action: 'dispose', tabId });
    vi.runAllTimers();
    expect(child.destroyed).toBe(true);
  });
  it('scales CSS bounds to the owning renderer zoom and keeps duplicate URL identities separate', () => {
    const { handler, host } = setup();
    host.webContents.getZoomFactor = () => 1.5;
    handler({ url: 'https://fixture.test/same' }).createWindow({});
    handler({ url: 'https://fixture.test/same' }).createWindow({});
    const ids = mocks.events.filter((event) => event.action === 'adopt').map((event) => String(event.tabId));
    expect(new Set(ids).size).toBe(2);
    controlBrowserPopup(host, {
      action: 'sync',
      tabId: ids[0],
      active: true,
      bounds: { x: 20, y: 30, width: 100, height: 80 },
    });
    expect(mocks.views[0].setBounds).toHaveBeenLastCalledWith({ x: 30, y: 45, width: 150, height: 120 });
    expect(getBrowserPopup(ids[0])?.view).not.toBe(getBrowserPopup(ids[1])?.view);
  });
  it('only binds guests in the browser partition', () => {
    const { host } = setup();
    bindBrowserPopups(host);
    const foreign = new FakeContents();
    foreign.session = {};
    host.webContents.emit('did-attach-webview', {}, foreign);
    expect(foreign.setWindowOpenHandler).not.toHaveBeenCalled();
  });
});

describe('ordinary native browser tabs', () => {
  const ensure = (host: BrowserWindow, tabId = 'ordinary', url = 'https://fixture.test/', mountId = 'mount-one') =>
    controlBrowserPopup(host, { action: 'ensure', tabId, url, mountId, requireExisting: false });

  it('reattaches the same contents without reloading, keeping its initial URL while navigation is pending', () => {
    const { host } = setup();
    const initial = ensure(host)!;
    const again = ensure(host, 'ordinary', 'https://fixture.test/other', 'mount-two')!;
    expect(again.webContentsId).toBe(initial.webContentsId);
    expect(again.url).toBe('https://fixture.test/');
    expect(mocks.views[0].webContents.loadURL).toHaveBeenCalledExactlyOnceWith('https://fixture.test/');
  });

  it('uses a shared isolated session and opaque white canvas without modifying the document', () => {
    const { host } = setup();
    ensure(host);
    expect(mocks.views[0].options).toMatchObject({
      webPreferences: {
        session: mocks.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    expect(mocks.views[0].setBackgroundColor).toHaveBeenCalledExactlyOnceWith('#ffffff');
  });

  it('never recreates or reloads an adopted POST popup on ensure', () => {
    const { host, handler } = setup();
    const child = handler({ url: 'https://fixture.test/post' }).createWindow({});
    const tabId = String(mocks.events.find((event) => event.action === 'adopt')!.tabId);
    controlBrowserPopup(host, {
      action: 'ensure',
      tabId,
      url: 'https://fixture.test/post',
      requireExisting: true,
      mountId: 'popup-mount',
    });
    expect(child.loadURL).not.toHaveBeenCalled();
    expect(() =>
      controlBrowserPopup(host, {
        action: 'ensure',
        tabId: 'missing',
        url: 'about:blank',
        requireExisting: true,
        mountId: 'missing-mount',
      })
    ).toThrow('original');
  });

  it('retries a failed adopted POST using Chromium reload without converting it to a URL load', () => {
    const { host, handler } = setup();
    const url = 'https://fixture.test/post';
    const child = handler({ url, postBody: { data: [{ bytes: Buffer.from('value=original') }] } }).createWindow({});
    const tabId = String(mocks.events.find((event) => event.action === 'adopt')!.tabId);
    controlBrowserPopup(host, { action: 'ensure', tabId, url, requireExisting: true, mountId: 'popup-mount' });
    child.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', url, true);
    child.emit('did-stop-loading');
    controlBrowserPopup(host, { action: 'reload', tabId, mountId: 'popup-mount' });
    expect(child.reload).toHaveBeenCalledOnce();
    expect(child.loadURL).not.toHaveBeenCalled();
  });

  it('ignores iframe hash navigation while a top-level navigation is pending or failed', () => {
    const { host } = setup();
    const url = 'https://fixture.test/';
    ensure(host);
    const child = mocks.views[0].webContents;
    child.emit('did-navigate-in-page', {}, 'https://frame.test/#changed', false);
    expect(ensure(host)).toMatchObject({ url, loading: true });
    child.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', url, true);
    child.emit('did-navigate-in-page', {}, 'https://frame.test/#again', false);
    expect(ensure(host)).toMatchObject({ url, error: 'ERR_NAME_NOT_RESOLVED', loading: false });
    child.getURL = () => `${url}#main`;
    child.emit('did-navigate-in-page', {}, `${url}#main`, true);
    expect(ensure(host)).toMatchObject({ url: `${url}#main`, error: undefined, loading: false });
  });

  it('rejects invalid URLs, IDs and a foreign owning window', () => {
    const { host } = setup();
    expect(() => ensure(host, '../bad')).toThrow('Invalid');
    expect(() => ensure(host, 'ordinary', 'file:///private/secret')).toThrow('Invalid');
    for (const field of ['tabId', 'mountId', 'url']) {
      const command = {
        action: 'ensure',
        tabId: 'ordinary',
        url: 'about:blank',
        mountId: 'valid',
        requireExisting: false,
        [field]: undefined,
      };
      expect(() => controlBrowserPopup(host, command as BrowserPopupCommand)).toThrow('Invalid');
    }
    ensure(host);
    expect(() => ensure(setup().host)).toThrow('No such');
  });

  it('shares capacity across ordinary pages and pending popup adoption', () => {
    const { host, handler } = setup();
    for (let i = 0; i < MAX_BROWSER_TABS - 1; i++) ensure(host, `ordinary-${i}`);
    handler({ url: 'about:blank' }).createWindow({});
    expect(() => ensure(host, 'excess')).toThrow('maximum');
    expect(handler({ url: 'about:blank' })).toEqual({ action: 'deny' });
  });

  it('invalidates stale mount commands and cancels disposal for the newest attachment', () => {
    vi.useFakeTimers();
    const { host } = setup();
    ensure(host);
    controlBrowserPopup(host, { action: 'dispose', tabId: 'ordinary', mountId: 'mount-one' });
    ensure(host, 'ordinary', 'https://fixture.test/', 'mount-two');
    expect(() => controlBrowserPopup(host, { action: 'dispose', tabId: 'ordinary', mountId: 'mount-one' })).toThrow(
      'Stale'
    );
    expect(() => controlBrowserPopup(host, { action: 'dispose', tabId: 'ordinary' })).toThrow('Stale');
    vi.runAllTimers();
    expect(getBrowserPopup('ordinary')?.view.webContents.isDestroyed()).toBe(false);
  });

  it('reclaims obsolete scope capacity without sending close events into the next scope', () => {
    const { host } = setup();
    for (let i = 0; i < MAX_BROWSER_TABS; i++) ensure(host, `old-${i}`);
    reconcileBrowserTabs(host, { ready: false, tabIds: [] });
    expect(() => ensure(host, 'new-scope')).not.toThrow();
    expect(mocks.events.filter((event) => event.action === 'close')).toEqual([]);
  });

  it('retains inventory-owned contents through delayed layout remounts and closes only on removal', () => {
    vi.useFakeTimers();
    const { host } = setup();
    const initial = ensure(host)!;
    reconcileBrowserTabs(host, { ready: true, tabIds: ['ordinary'] });
    controlBrowserPopup(host, { action: 'dispose', tabId: 'ordinary', mountId: 'mount-one' });
    vi.advanceTimersByTime(1000);
    expect(getBrowserPopup('ordinary')?.active).toBe(false);
    const remounted = ensure(host, 'ordinary', 'https://fixture.test/', 'mount-two')!;
    expect(remounted.webContentsId).toBe(initial.webContentsId);
    expect(mocks.views[0].webContents.loadURL).toHaveBeenCalledOnce();
    reconcileBrowserTabs(host, { ready: true, tabIds: [] });
    expect(getBrowserPopup('ordinary')).toBeUndefined();
  });

  it('releases removed inventory capacity before asynchronous web contents destruction finishes', () => {
    const { host } = setup();
    for (let i = 0; i < MAX_BROWSER_TABS; i++) ensure(host, `old-${i}`);
    const old = mocks.views[0].webContents;
    old.close.mockImplementation(() => {});
    reconcileBrowserTabs(host, { ready: false, tabIds: [] });
    expect(getBrowserPopup('old-0')).toBeUndefined();
    for (let i = 0; i < MAX_BROWSER_TABS; i++) expect(() => ensure(host, `new-${i}`)).not.toThrow();
    old.destroyed = true;
    old.emit('destroyed');
    expect(getBrowserPopup('new-0')).toBeDefined();
  });

  it('retains a popup awaiting adoption during ordinary inventory updates', () => {
    const { host, handler } = setup();
    ensure(host);
    reconcileBrowserTabs(host, { ready: true, tabIds: ['ordinary'] });
    const child = handler({ url: 'about:blank' }).createWindow({});
    reconcileBrowserTabs(host, { ready: true, tabIds: ['ordinary'] });
    expect(child.isDestroyed()).toBe(false);
  });

  it('closes removed inventory tabs and host-owned views', () => {
    const { host } = setup();
    ensure(host);
    reconcileBrowserTabs(host, { ready: true, tabIds: ['ordinary'] });
    reconcileBrowserTabs(host, { ready: true, tabIds: [] });
    expect(getBrowserPopup('ordinary')).toBeUndefined();
    ensure(host, 'next');
    host.emit('closed');
    expect(getBrowserPopup('next')).toBeUndefined();
  });

  it('reports page errors with the requested URL so retry reloads the failed destination', () => {
    const { host } = setup();
    ensure(host);
    const child = mocks.views[0].webContents;
    child.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://fixture.test/', true);
    child.emit('did-stop-loading');
    const state = controlBrowserPopup(host, {
      action: 'sync',
      tabId: 'ordinary',
      mountId: 'mount-one',
      active: true,
      bounds: { x: 0, y: 0, width: 400, height: 300 },
    });
    expect(state).toMatchObject({ url: 'https://fixture.test/', error: 'ERR_NAME_NOT_RESOLVED', loading: false });
    controlBrowserPopup(host, { action: 'reload', tabId: 'ordinary', mountId: 'mount-one' });
    expect(child.loadURL).toHaveBeenCalledTimes(2);
  });
});
