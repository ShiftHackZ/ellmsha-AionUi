import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, WebContents } from 'electron';
import {
  bindBrowserPopups,
  configureBrowserPopups,
  controlBrowserPopup,
  getBrowserPopup,
  registerBrowserPopupOpener,
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
    expect(() => controlBrowserPopup({} as BrowserWindow, { action: 'reload', tabId })).toThrow('No such');
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
