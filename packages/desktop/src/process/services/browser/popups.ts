import { randomUUID } from 'node:crypto';
import { session, WebContentsView, type BrowserWindow, type WebContents } from 'electron';
import { ipcBridge } from '@/common';
import type { BrowserPopupCommand, BrowserPopupState } from '@/common/adapter/ipcBridge';
import { BROWSER_SESSION_PARTITION, MAX_BROWSER_TABS } from '@/common/config/constants';

const openers = new Map<number, { tabId: string; window: BrowserWindow }>();
const popups = new Map<
  string,
  { view: WebContentsView; window: BrowserWindow; active: boolean; disposal?: ReturnType<typeof setTimeout> }
>();
const canOpenBrowserPopup = (url: string): boolean => {
  if (url === 'about:blank') return true;
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
};

/** Only exact, main-owned popup contents may join the browser CDP registry. */
export function getBrowserPopup(tabId: string, contentsId?: number) {
  const popup = popups.get(tabId);
  return popup &&
    !popup.view.webContents.isDestroyed() &&
    (contentsId === undefined || popup.view.webContents.id === contentsId)
    ? popup
    : undefined;
}

export function registerBrowserPopupOpener(window: BrowserWindow, tabId: string, contents: WebContents): void {
  if (contents.session !== session.fromPartition(BROWSER_SESSION_PARTITION)) return;
  if (contents.hostWebContents !== window.webContents && !getBrowserPopup(tabId, contents.id)) return;
  openers.set(contents.id, { tabId, window });
}

const popupState = (tabId: string): BrowserPopupState => {
  const popup = getBrowserPopup(tabId);
  if (!popup) throw new Error('No such live browser popup tab.');
  const contents = popup.view.webContents;
  return {
    tabId,
    webContentsId: contents.id,
    url: contents.getURL() || 'about:blank',
    title: contents.getTitle(),
    loading: contents.isLoading(),
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
  };
};

/** Native child pages are displayed inside the existing browser tab strip. */
export function configureBrowserPopups(contents: WebContents, window: BrowserWindow): void {
  contents.setWindowOpenHandler(({ url, disposition }) => {
    const opener = openers.get(contents.id);
    if (
      !opener ||
      opener.window !== window ||
      window.isDestroyed() ||
      !canOpenBrowserPopup(url) ||
      popups.size >= MAX_BROWSER_TABS
    )
      return { action: 'deny' };
    return {
      action: 'allow',
      outlivesOpener: true,
      overrideBrowserWindowOptions: {
        webPreferences: {
          session: contents.session,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          webviewTag: false,
          preload: undefined,
        },
      },
      createWindow: (options) => {
        // Electron connects this exact contents to Chromium's new-window pipeline.
        // Never loadURL here: that would discard POST bodies and the WindowProxy.
        const view = new WebContentsView(options);
        const tabId = `browser-popup-${randomUUID()}`;
        const child = view.webContents;
        const popup = { view, window, active: false };
        popups.set(tabId, popup);
        openers.set(child.id, { tabId, window });
        view.setVisible(false);
        window.contentView.addChildView(view);
        const guard = (event: Electron.Event, nextUrl: string) => {
          if (!canOpenBrowserPopup(nextUrl)) event.preventDefault();
        };
        child.on('will-navigate', guard);
        child.on('will-redirect', guard);
        configureBrowserPopups(child, window);
        const update = () => {
          if (!child.isDestroyed()) ipcBridge.application.browserPopupState.emit(popupState(tabId));
        };
        child.on('did-navigate', update);
        child.on('did-navigate-in-page', update);
        child.on('page-title-updated', update);
        child.on('did-start-loading', update);
        child.on('did-stop-loading', update);
        const close = () => {
          if (!child.isDestroyed()) child.close();
        };
        window.once('closed', close);
        child.once('destroyed', () => {
          window.removeListener('closed', close);
          const owned = popups.get(tabId);
          if (owned?.disposal) clearTimeout(owned.disposal);
          popups.delete(tabId);
          openers.delete(child.id);
          if (!window.isDestroyed()) window.contentView.removeChildView(view);
          ipcBridge.application.browserTabCommand.emit({ action: 'close', tabId });
        });
        ipcBridge.application.browserTabCommand.emit({
          action: 'adopt',
          tabId,
          openerTabId: opener.tabId,
          url,
          activate: disposition !== 'background-tab',
        });
        return child;
      },
    };
  });
  contents.once('destroyed', () => openers.delete(contents.id));
}

/** Renderer controls operate only on a previously-created child of this exact host. */
export function controlBrowserPopup(
  window: BrowserWindow,
  command: BrowserPopupCommand
): BrowserPopupState | undefined {
  const popup = getBrowserPopup(command.tabId);
  if (!popup || popup.window !== window) throw new Error('No such live browser popup tab.');
  const { view } = popup;
  const contents = view.webContents;
  if (popup.disposal) {
    clearTimeout(popup.disposal);
    popup.disposal = undefined;
  }
  if (command.action === 'dispose') {
    view.setVisible(false);
    popup.active = false;
    // StrictMode's immediate remount can cancel disposal with its next sync.
    popup.disposal = setTimeout(() => {
      if (!contents.isDestroyed()) contents.close();
    }, 0);
    return;
  }
  if (command.action === 'sync') {
    const b = command.bounds;
    if (![b.x, b.y, b.width, b.height].every(Number.isFinite)) throw new Error('Invalid browser popup bounds.');
    const [width, height] = window.getContentSize();
    const scale = window.webContents.getZoomFactor();
    const x = Math.max(0, Math.min(width, Math.round(b.x * scale)));
    const y = Math.max(0, Math.min(height, Math.round(b.y * scale)));
    const w = Math.max(0, Math.min(width - x, Math.round(b.width * scale)));
    const h = Math.max(0, Math.min(height - y, Math.round(b.height * scale)));
    view.setBounds({ x, y, width: w, height: h });
    popup.active = command.active && w > 0 && h > 0;
    view.setVisible(popup.active);
  } else if (command.action === 'focus') {
    if (!popup.active) throw new Error('The popup tab is not visible.');
    contents.focus();
  } else if (command.action === 'navigate') {
    if (!canOpenBrowserPopup(command.url)) throw new Error('Unsupported browser URL.');
    void contents.loadURL(command.url).catch((): void => undefined);
  } else if (command.action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
  else if (command.action === 'forward' && contents.navigationHistory.canGoForward())
    contents.navigationHistory.goForward();
  else if (command.action === 'reload') contents.reload();
  return popupState(command.tabId);
}

export function bindBrowserPopups(window: BrowserWindow): void {
  window.webContents.on('did-attach-webview', (_event, guest) => {
    if (guest.session === session.fromPartition(BROWSER_SESSION_PARTITION)) configureBrowserPopups(guest, window);
  });
}
