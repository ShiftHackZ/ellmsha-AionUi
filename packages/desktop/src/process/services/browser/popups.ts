import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { clearBrowserHistory, readBrowserHistory, saveBrowserHistory } from './history';
import { bindBrowserAuthHost, browserSession, getActiveBrowserProfile, requireBrowserProfile } from './profiles';
import { WebContentsView, type BrowserWindow, type WebContents, type WebPreferences } from 'electron';
import { ipcBridge } from '@/common';
import type { BrowserPopupCommand, BrowserPopupState, BrowserTabInventory } from '@/common/adapter/ipcBridge';
import { MAX_BROWSER_TABS } from '@/common/config/constants';

type NativeTab = {
  tabId: string;
  profileId: string;
  view: WebContentsView;
  window: BrowserWindow;
  active: boolean;
  mountId?: string;
  pendingUrl?: string;
  pendingExplicitNavigation?: boolean;
  favicon?: string;
  error?: string;
  notifyClose: boolean;
  onHostClosed?: () => void;
  disposal?: ReturnType<typeof setTimeout>;
};
const openers = new Map<number, { tabId: string; window: BrowserWindow; profileId: string }>();
// Ordinary tabs and not-yet-adopted popups share ownership and capacity.
const tabs = new Map<string, NativeTab>();
/** Authentication listens to real tab visibility changes, not dialog focus. */
export const browserTabLifecycle = new EventEmitter();
const inventories = new WeakMap<BrowserWindow, Map<string, Set<string>>>();
const ID_PATTERN = /^[a-zA-Z0-9._:-]{1,200}$/;
const validId = (value: unknown): value is string => typeof value === 'string' && ID_PATTERN.test(value);
export const canOpenBrowserUrl = (url: string): boolean => {
  if (typeof url !== 'string') return false;
  if (url === 'about:blank') return true;
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
};
const browserPreferences = (profileId: string): WebPreferences => ({
  session: browserSession(profileId),
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  webviewTag: false,
  preload:
    process.platform === 'darwin'
      ? path.join(
          path.basename(__dirname) === 'chunks' ? path.dirname(__dirname) : __dirname,
          '../preload/browserWebAuthnPreload.js'
        )
      : undefined,
});

export function getBrowserPopupForContents(contentsId: number) {
  const opener = openers.get(contentsId);
  return opener ? getBrowserPopup(opener.tabId, contentsId) : undefined;
}

/** Only exact, main-owned native tab contents may join the browser CDP registry. */
export function getBrowserPopup(tabId: string, contentsId?: number) {
  const tab = tabs.get(tabId);
  return tab &&
    !tab.window.isDestroyed() &&
    !tab.view.webContents.isDestroyed() &&
    (contentsId === undefined || tab.view.webContents.id === contentsId)
    ? tab
    : undefined;
}

export function registerBrowserPopupOpener(window: BrowserWindow, tabId: string, contents: WebContents): void {
  const native = getBrowserPopup(tabId, contents.id);
  const profileId = native?.profileId ?? getActiveBrowserProfile()?.profileId;
  if (!profileId || contents.session !== browserSession(profileId)) return;
  if (native ? native.window !== window : contents.hostWebContents !== window.webContents) return;
  openers.set(contents.id, { tabId, window, profileId });
}

const popupState = (tabId: string): BrowserPopupState => {
  const tab = getBrowserPopup(tabId);
  if (!tab) throw new Error('No such live browser tab.');
  const contents = tab.view.webContents;
  return {
    tabId,
    webContentsId: contents.id,
    url: tab.pendingUrl ?? (contents.getURL() || 'about:blank'),
    title: contents.getTitle(),
    loading: !tab.error && (tab.pendingUrl !== undefined || contents.isLoading()),
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
    mountId: tab.mountId,
    favicon: tab.favicon,
    error: tab.error,
  };
};

const emitState = (tabId: string, tab: NativeTab): void => {
  if (getBrowserPopup(tabId) === tab) ipcBridge.application.browserPopupState.emit(popupState(tabId));
};
const closeTab = (tab: NativeTab): void => {
  saveBrowserHistory(tab.profileId, tab.tabId, tab.view.webContents);
  if (tab.onHostClosed) tab.window.removeListener('closed', tab.onHostClosed);
  if (tab.disposal) clearTimeout(tab.disposal);
  tab.disposal = undefined;
  tab.notifyClose = false;
  tab.active = false;
  browserTabLifecycle.emit('changed');
  if (tabs.get(tab.tabId) === tab) tabs.delete(tab.tabId);
  openers.delete(tab.view.webContents.id);
  tab.view.setVisible(false);
  if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
};

/** Release obsolete scope contents before a new scope claims the same bounded capacity. */
export function reconcileBrowserTabs(window: BrowserWindow, inventory: BrowserTabInventory): void {
  if (!inventory || typeof inventory.ready !== 'boolean' || !Array.isArray(inventory.tabIds))
    throw new Error('Invalid browser tab inventory.');
  const profile = requireBrowserProfile(inventory.profileToken);
  if (inventory.generation !== profile.generation) throw new Error('Stale browser inventory generation.');
  const retained = new Set(inventory.tabIds);
  if (
    retained.size !== inventory.tabIds.length ||
    retained.size > MAX_BROWSER_TABS ||
    [...retained].some((id) => !validId(id))
  )
    throw new Error('Invalid browser tab inventory.');
  let profiles = inventories.get(window);
  if (!profiles) {
    profiles = new Map();
    inventories.set(window, profiles);
  }
  const previous = profiles.get(profile.profileId);
  for (const [id, tab] of tabs) {
    if (tab.window !== window) continue;
    if (!inventory.ready || tab.profileId !== profile.profileId) {
      // Suspension is not a navigation. Keep POST bodies, opener and form state live.
      tab.active = false;
      tab.view.setVisible(false);
    } else if (previous?.has(id) && !retained.has(id)) closeTab(tab);
  }
  if (inventory.ready) profiles.set(profile.profileId, retained);
  browserTabLifecycle.emit('changed');
}

const reserveCapacity = (): void => {
  // Removed viewers may still have a deferred StrictMode cleanup pending.
  for (const tab of tabs.values()) if (tab.disposal) closeTab(tab);
  if (tabs.size >= MAX_BROWSER_TABS)
    throw new Error(
      `The in-app browser already has its maximum of ${MAX_BROWSER_TABS} tabs. Close suspended tabs in Settings > System > In-app browser to free space.`
    );
};

const attachView = (
  window: BrowserWindow,
  tabId: string,
  view: WebContentsView,
  url: string,
  profileId: string
): NativeTab => {
  bindBrowserAuthHost(profileId, window);
  const child = view.webContents;
  const tab: NativeTab = {
    tabId,
    profileId,
    view,
    window,
    active: false,
    pendingUrl: url,
    notifyClose: true,
  };
  tabs.set(tabId, tab);
  openers.set(child.id, { tabId, window, profileId });
  // Browser pages own their styling; transparent documents get a normal opaque canvas.
  view.setBackgroundColor('#ffffff');
  view.setVisible(false);
  window.contentView.addChildView(view);
  const guard = (event: Electron.Event, nextUrl: string) => {
    if (!canOpenBrowserUrl(nextUrl)) event.preventDefault();
  };
  child.on('will-navigate', guard);
  child.on('will-redirect', guard);
  configureBrowserPopups(child, window);
  const update = () => emitState(tabId, tab);
  const remember = () => saveBrowserHistory(profileId, tabId, child);
  child.on('did-stop-loading', remember);
  child.on('did-navigate-in-page', remember);
  window.on('close', remember);
  child.once('destroyed', () => window.removeListener('close', remember));
  const navigated = () => {
    tab.pendingUrl = undefined;
    tab.pendingExplicitNavigation = false;
    tab.error = undefined;
    update();
  };
  child.on('did-navigate', navigated);
  child.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
    if (isMainFrame) navigated();
  });
  child.on('page-title-updated', update);
  child.on('page-favicon-updated', (_event, favicons: string[]) => {
    tab.favicon = favicons[0] ?? '';
    update();
  });
  child.on('did-start-loading', () => {
    tab.error = undefined;
    update();
  });
  child.on('did-stop-loading', () => {
    if (!tab.error) {
      tab.pendingUrl = undefined;
      tab.pendingExplicitNavigation = false;
    }
    update();
  });
  child.on('did-fail-load', (_event, code: number, description: string, _url: string, isMainFrame: boolean) => {
    if (!isMainFrame || code === -3) return; // ERR_ABORTED is normal during replacement navigation.
    tab.error = description;
    update();
  });
  const close = () => closeTab(tab);
  tab.onHostClosed = close;
  window.once('closed', close);
  child.once('destroyed', () => {
    window.removeListener('closed', close);
    if (tab.disposal) clearTimeout(tab.disposal);
    openers.delete(child.id);
    const owned = tabs.get(tabId) === tab;
    if (owned) tabs.delete(tabId);
    if (!window.isDestroyed()) window.contentView.removeChildView(view);
    if (owned && tab.notifyClose)
      ipcBridge.application.browserTabCommand.emit({
        action: 'close',
        tabId,
        profileId: tab.profileId,
        generation: getActiveBrowserProfile()?.generation,
      });
  });
  return tab;
};

const navigate = (tabId: string, tab: NativeTab, url: string): void => {
  if (!canOpenBrowserUrl(url)) throw new Error('Unsupported browser URL.');
  tab.pendingUrl = url;
  tab.pendingExplicitNavigation = true;
  tab.error = undefined;
  void tab.view.webContents.loadURL(url).catch((error: Error & { errno?: number }) => {
    if (error.errno === -3 || getBrowserPopup(tabId) !== tab || tab.pendingUrl !== url) return;
    tab.error = error.message;
    emitState(tabId, tab);
  });
};

/** Native child pages are adopted without changing their POST body or WindowProxy. */
export function configureBrowserPopups(contents: WebContents, window: BrowserWindow): void {
  contents.setWindowOpenHandler(({ url, disposition }) => {
    const opener = openers.get(contents.id);
    const nativeParent = opener && getBrowserPopup(opener.tabId, contents.id);
    const parent = nativeParent ?? opener;
    if (
      !parent ||
      parent.profileId !== getActiveBrowserProfile()?.profileId ||
      !opener ||
      opener.window !== window ||
      window.isDestroyed() ||
      !canOpenBrowserUrl(url)
    )
      return { action: 'deny' };
    try {
      reserveCapacity();
    } catch {
      return { action: 'deny' };
    }
    return {
      action: 'allow',
      outlivesOpener: true,
      overrideBrowserWindowOptions: { webPreferences: browserPreferences(parent.profileId) },
      createWindow: (options) => {
        if (
          getActiveBrowserProfile()?.profileId !== parent.profileId ||
          openers.get(contents.id) !== opener ||
          (nativeParent !== undefined && getBrowserPopup(parent.tabId) !== nativeParent)
        )
          throw new Error('Stale browser opener.');
        reserveCapacity();
        const view = new WebContentsView({
          ...options,
          webPreferences: browserPreferences(parent.profileId),
        });
        const tabId = `browser-popup-${randomUUID()}`;
        attachView(window, tabId, view, url, parent.profileId);
        ipcBridge.application.browserTabCommand.emit({
          action: 'adopt',
          profileId: parent.profileId,
          generation: getActiveBrowserProfile()?.generation,
          tabId,
          openerTabId: opener.tabId,
          url,
          activate: disposition !== 'background-tab',
        });
        return view.webContents;
      },
    };
  });
  contents.once('destroyed', () => openers.delete(contents.id));
}

/** Renderer commands are confined to an exact host, stable tab and viewer attachment. */
export function controlBrowserPopup(
  window: BrowserWindow,
  command: BrowserPopupCommand
): BrowserPopupState | undefined {
  if (window.isDestroyed() || !command || !validId(command.tabId)) throw new Error('Invalid browser host or tab id.');
  if (command.mountId !== undefined && !validId(command.mountId)) throw new Error('Invalid browser viewer attachment.');
  const profile = requireBrowserProfile(command.profileToken);
  if (command.generation !== profile.generation) throw new Error('Stale browser command generation.');
  let tab = getBrowserPopup(command.tabId);
  if (tab && tab.profileId !== profile.profileId) throw new Error('Browser tab belongs to another profile.');
  if (command.action === 'ensure') {
    if (!validId(command.mountId) || typeof command.requireExisting !== 'boolean' || !canOpenBrowserUrl(command.url))
      throw new Error('Invalid browser tab request.');
    if (tab && tab.window !== window) throw new Error('No such live browser tab.');
    if (!tab) {
      if (command.requireExisting) throw new Error('The original browser popup is no longer available.');
      reserveCapacity();
      tab = attachView(
        window,
        command.tabId,
        new WebContentsView({ webPreferences: browserPreferences(profile.profileId) }),
        command.url,
        profile.profileId
      );
      const history = readBrowserHistory(profile.profileId, command.tabId);
      if (history) {
        const restored = tab;
        void tab.view.webContents.navigationHistory.restore(history).catch(() => {
          if (getBrowserPopup(command.tabId) === restored) navigate(command.tabId, restored, command.url);
        });
      } else navigate(command.tabId, tab, command.url);
    }
    if (tab.disposal) clearTimeout(tab.disposal);
    tab.disposal = undefined;
    tab.mountId = command.mountId;
    tab.active = false;
    tab.view.setVisible(false);
    browserTabLifecycle.emit('changed');
    return popupState(command.tabId);
  }
  if (!tab || tab.window !== window) {
    if (command.action === 'dispose') return;
    throw new Error('No such live browser tab.');
  }
  if (command.mountId !== tab.mountId) throw new Error('Stale browser viewer attachment.');
  const { view } = tab;
  const contents = view.webContents;
  if (tab.disposal) clearTimeout(tab.disposal);
  tab.disposal = undefined;
  if (command.action === 'dispose') {
    view.setVisible(false);
    tab.active = false;
    browserTabLifecycle.emit('changed');
    // A layout remount may cross multiple IPC turns. Inventory, not that timing,
    // decides whether an acknowledged page still belongs to the current scope.
    if (!inventories.get(window)?.get(tab.profileId)?.has(command.tabId)) {
      const owned = tab;
      tab.disposal = setTimeout(() => closeTab(owned), 0);
    }
    return;
  }
  if (command.action === 'sync') {
    const b = command.bounds;
    if (
      typeof command.active !== 'boolean' ||
      !b ||
      ![b.x, b.y, b.width, b.height].every(Number.isFinite) ||
      b.width < 0 ||
      b.height < 0
    )
      throw new Error('Invalid browser tab bounds.');
    const [width, height] = window.getContentSize();
    const scale = window.webContents.getZoomFactor();
    const x = Math.max(0, Math.min(width, Math.round(b.x * scale)));
    const y = Math.max(0, Math.min(height, Math.round(b.y * scale)));
    const w = Math.max(0, Math.min(width, Math.round((b.x + b.width) * scale)) - x);
    const h = Math.max(0, Math.min(height, Math.round((b.y + b.height) * scale)) - y);
    view.setBounds({ x, y, width: w, height: h });
    tab.active = command.active && w > 0 && h > 0;
    view.setVisible(tab.active);
    browserTabLifecycle.emit('changed');
  } else if (command.action === 'focus') {
    if (!tab.active) throw new Error('The browser tab is not visible.');
    contents.focus();
  } else if (command.action === 'navigate') navigate(command.tabId, tab, command.url);
  else if (command.action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
  else if (command.action === 'forward' && contents.navigationHistory.canGoForward())
    contents.navigationHistory.goForward();
  else if (command.action === 'reload') {
    // Only our own loadURL can be retried as a GET. Chromium owns adopted
    // navigations (including POST bodies) and must retain their reload semantics.
    if (tab.error && tab.pendingUrl && tab.pendingExplicitNavigation) navigate(command.tabId, tab, tab.pendingUrl);
    else contents.reload();
  }
  return popupState(command.tabId);
}

export function bindBrowserPopups(window: BrowserWindow): void {
  window.webContents.on('did-attach-webview', (_event, guest) => {
    const profile = getActiveBrowserProfile();
    if (profile && guest.session === browserSession(profile.profileId)) configureBrowserPopups(guest, window);
  });
}

/** Close live pages before clearing their data, preventing repopulation races. */
export function closeBrowserProfile(profileId: string): void {
  for (const tab of tabs.values()) if (tab.profileId === profileId) closeTab(tab);
  clearBrowserHistory(profileId);
}

/** Hide during async identity resolution without destroying same-profile forms/history. */
export function hideBrowserTabs(window: BrowserWindow): void {
  for (const tab of tabs.values())
    if (tab.window === window) {
      tab.active = false;
      tab.view.setVisible(false);
    }
  browserTabLifecycle.emit('changed');
}
export function hideForeignBrowserProfiles(profileId: string): void {
  for (const tab of tabs.values())
    if (tab.profileId !== profileId) {
      tab.active = false;
      tab.view.setVisible(false);
    }
  browserTabLifecycle.emit('changed');
}

/** Explicit local resource recovery only; never clear sign-ins or evict live pages automatically. */
export function closeSuspendedBrowserTabs(): Map<string, number> {
  const visible = getActiveBrowserProfile()?.profileId;
  const closed = new Map<string, number>();
  for (const tab of tabs.values()) {
    if (tab.profileId === visible) continue;
    closed.set(tab.profileId, (closed.get(tab.profileId) ?? 0) + 1);
    closeTab(tab);
  }
  return closed;
}
export function countBrowserProfileTabs(profileId: string): number {
  return [...tabs.values()].filter((tab) => tab.profileId === profileId).length;
}
