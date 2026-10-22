/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BrowserWindow } from 'electron';
import { app, webContents } from 'electron';
import {
  hideBrowserTabs,
  hideForeignBrowserProfiles,
  closeSuspendedBrowserTabs,
  countBrowserProfileTabs,
  closeBrowserProfile,
  controlBrowserPopup,
  reconcileBrowserTabs,
  registerBrowserPopupOpener,
} from '../services/browser/popups';
import { ipcBridge } from '@/common';
import {
  setBrowserProfileClearing,
  listBrowserProfiles,
  bindBrowserProfile,
  browserSession,
  requireBrowserProfile,
  validateBrowserToken,
} from '../services/browser/profiles';
import { ProcessConfig } from '@process/utils/initStorage';
import { getZoomFactor, setZoomFactor } from '@process/utils/zoom';
import { getCdpStatus, updateCdpConfig } from '@process/utils/configureChromium';
import { getCdpBridgeHandle } from '@process/utils/cdpBridgeRegistry';
import { getGpuStatus, setGpuUserOverride } from '@process/utils/gpuRecovery';
import { initApplicationBridgeCore } from './applicationBridgeCore';
import type { IStartOnBootStatus } from '@/common/adapter/ipcBridge';
import { restartApplication } from './restartApplication';
import { runComputerUsePermissionDoctor } from '@process/backend/computerUsePermissions';

let mainWindowRef: BrowserWindow | null = null;

const START_ON_BOOT_UNSUPPORTED_MESSAGE = 'Start on boot is only available in packaged macOS and Windows apps.';
export const START_ON_BOOT_WINDOWS_ARG = '--start-on-boot';

const isStartOnBootSupported = (): boolean => {
  return app.isPackaged && (process.platform === 'darwin' || process.platform === 'win32');
};

const getStartOnBootWindowsArgs = (): string[] => [START_ON_BOOT_WINDOWS_ARG];

const getLoginItemSettings = () => {
  return process.platform === 'win32'
    ? app.getLoginItemSettings({ args: getStartOnBootWindowsArgs() })
    : app.getLoginItemSettings();
};

export function wasLaunchedAtLogin(): boolean {
  if (!app.isPackaged) {
    return false;
  }

  if (process.platform === 'darwin') {
    return Boolean(getLoginItemSettings().wasOpenedAtLogin);
  }

  if (process.platform === 'win32') {
    return process.argv.includes(START_ON_BOOT_WINDOWS_ARG);
  }

  return false;
}

export function getStartOnBootStatus(): IStartOnBootStatus {
  if (!isStartOnBootSupported()) {
    return {
      supported: false,
      enabled: false,
      isPackaged: app.isPackaged,
      platform: process.platform,
    };
  }

  const settings = getLoginItemSettings();
  const enabled =
    process.platform === 'win32'
      ? Boolean(settings.openAtLogin || settings.executableWillLaunchAtLogin)
      : Boolean(settings.openAtLogin);

  return {
    supported: true,
    enabled,
    isPackaged: app.isPackaged,
    platform: process.platform,
  };
}

export function setStartOnBootEnabled(enabled: boolean): IStartOnBootStatus {
  const currentStatus = getStartOnBootStatus();
  if (!currentStatus.supported) {
    return currentStatus;
  }

  app.setLoginItemSettings({
    openAtLogin: enabled,
    ...(process.platform === 'win32'
      ? {
          args: getStartOnBootWindowsArgs(),
          enabled: true,
        }
      : {}),
  });

  return getStartOnBootStatus();
}

export function setApplicationMainWindow(win: BrowserWindow): void {
  mainWindowRef = win;
}

export function initApplicationBridge(): void {
  // Platform-agnostic handlers: systemInfo, updateSystemInfo, getPath
  initApplicationBridgeCore();

  ipcBridge.application.restart.provider(async () => {
    // Backend subprocess shutdown is handled by backendManager.stop() in the
    // main window's before-quit hook; agent children are killed transitively
    // when backend exits.
    return restartApplication(app);
  });

  ipcBridge.application.isDevToolsOpened.provider(() => {
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      return Promise.resolve(mainWindowRef.webContents.isDevToolsOpened());
    }
    return Promise.resolve(false);
  });

  ipcBridge.application.openDevTools.provider(() => {
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      const win = mainWindowRef;
      const wasOpen = win.webContents.isDevToolsOpened();

      if (wasOpen) {
        win.webContents.closeDevTools();
        return Promise.resolve(false);
      } else {
        return new Promise((resolve) => {
          const onOpened = () => {
            win.webContents.off('devtools-opened', onOpened);
            resolve(true);
          };

          win.webContents.once('devtools-opened', onOpened);
          win.webContents.openDevTools();

          setTimeout(() => {
            win.webContents.off('devtools-opened', onOpened);
            if (win.isDestroyed()) {
              resolve(false);
              return;
            }
            resolve(win.webContents.isDevToolsOpened());
          }, 500);
        });
      }
    }
    return Promise.resolve(false);
  });

  ipcBridge.application.getZoomFactor.provider(() => Promise.resolve(getZoomFactor()));

  ipcBridge.application.setZoomFactor.provider(async ({ factor }) => {
    const updatedFactor = setZoomFactor(factor);
    try {
      await ProcessConfig.set('ui.zoomFactor', updatedFactor);
    } catch (error) {
      console.error('[ApplicationBridge] Failed to persist zoom factor:', error);
    }
    return updatedFactor;
  });

  ipcBridge.application.writeRendererLog.provider(async ({ level, tag, message, data }) => {
    const prefix = `[Renderer:${tag}] ${message}`;
    const args = data === undefined ? [prefix] : [prefix, data];
    if (level === 'error') {
      console.error(...args);
    } else if (level === 'warn') {
      console.warn(...args);
    } else if (level === 'debug') {
      console.debug(...args);
    } else {
      console.info(...args);
    }
  });

  // CDP status and configuration
  ipcBridge.application.getCdpStatus.provider(async () => {
    try {
      const status = getCdpStatus();
      // If port is set, CDP is considered enabled (verification is optional)
      return { success: true, data: status };
    } catch (e) {
      return { success: false, msg: e.message || e.toString() };
    }
  });

  ipcBridge.application.updateCdpConfig.provider(async (config) => {
    try {
      const updatedConfig = updateCdpConfig(config);
      return { success: true, data: updatedConfig };
    } catch (e) {
      return { success: false, msg: e.message || e.toString() };
    }
  });

  ipcBridge.application.listBrowserProfiles.provider(async () => ({
    success: true,
    data: (await listBrowserProfiles()).map((profile) => ({
      ...profile,
      openTabCount: countBrowserProfileTabs(profile.profileId),
    })),
  }));

  ipcBridge.application.bindBrowserProfile.provider(async ({ conversationId }) => {
    try {
      // Hide the old native pages before asynchronous ownership resolution.
      if (mainWindowRef && !mainWindowRef.isDestroyed()) hideBrowserTabs(mainWindowRef);
      const data = await bindBrowserProfile(conversationId);
      if (data) hideForeignBrowserProfiles(data.profileId);
      return { success: true, data };
    } catch {
      return { success: false, msg: 'Browser project binding unavailable.' };
    }
  });

  ipcBridge.application.closeSuspendedBrowserTabs.provider(async () => {
    const closed = closeSuspendedBrowserTabs();
    for (const profileId of closed.keys()) ipcBridge.application.browserProfileCleared.emit({ profileId });
    return { success: true, data: { closedTabs: [...closed.values()].reduce((sum, count) => sum + count, 0) } };
  });

  ipcBridge.application.clearBrowserData.provider(async ({ profileToken }) => {
    let clearingProfile: string | undefined;
    try {
      const profileId = await validateBrowserToken(profileToken);
      clearingProfile = profileId;
      setBrowserProfileClearing(profileId, true);
      closeBrowserProfile(profileId);
      const owned = browserSession(profileId);
      await owned.closeAllConnections();
      await owned.clearStorageData();
      await owned.clearCache();
      await owned.clearAuthCache();
      await owned.closeAllConnections();
      ipcBridge.application.browserProfileCleared.emit({ profileId });
      return { success: true };
    } catch {
      return { success: false, msg: 'Browser data could not be cleared.' };
    } finally {
      if (clearingProfile) setBrowserProfileClearing(clearingProfile, false);
    }
  });

  ipcBridge.application.browserPopup.provider(async (command) => {
    try {
      if (!mainWindowRef || mainWindowRef.isDestroyed()) return { success: false, msg: 'Browser host unavailable.' };
      if (!command.profileToken) throw new Error('Browser identity unavailable.');
      if (command.generation !== requireBrowserProfile(command.profileToken).generation)
        throw new Error('Stale browser generation.');
      await validateBrowserToken(command.profileToken);
      return { success: true, data: controlBrowserPopup(mainWindowRef, command) };
    } catch (error) {
      return { success: false, msg: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcBridge.application.reportBrowserWebContentsId.provider(async (registration) => {
    try {
      if (!registration.profileToken) throw new Error('Browser identity unavailable.');
      await validateBrowserToken(registration.profileToken);
      if (registration.generation !== requireBrowserProfile(registration.profileToken).generation)
        throw new Error('Stale browser registration.');
      const contents = webContents.fromId(registration.webContentsId);
      if (contents && mainWindowRef) registerBrowserPopupOpener(mainWindowRef, registration.tabId, contents);
      const handle = getCdpBridgeHandle();
      if (!handle) return { success: false, msg: 'Agent browser control is not enabled.' };
      const result = handle.registerTab(registration);
      if (result.ok === false) return { success: false, msg: result.reason };
      return { success: true };
    } catch (e) {
      return { success: false, msg: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcBridge.application.reportBrowserTabInventory.provider(async (inventory) => {
    try {
      {
        if (!inventory.profileToken) throw new Error('Browser identity unavailable.');
        await validateBrowserToken(inventory.profileToken);
        if (inventory.generation !== requireBrowserProfile(inventory.profileToken).generation)
          throw new Error('Stale browser inventory.');
      }
      if (mainWindowRef && !mainWindowRef.isDestroyed()) reconcileBrowserTabs(mainWindowRef, inventory);
      const handle = getCdpBridgeHandle();
      if (!handle) return { success: false, msg: 'Agent browser control is not enabled.' };
      const result = handle.updateTabInventory(inventory);
      if (result.ok === false) return { success: false, msg: result.reason };
      return { success: true };
    } catch (e) {
      return { success: false, msg: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcBridge.application.reportBrowserTabCommandFailure.provider(async ({ tabId, reason }) => {
    try {
      const handle = getCdpBridgeHandle();
      if (!handle) return { success: false, msg: 'Agent browser control is not enabled.' };
      handle.rejectTabCommand(tabId, reason);
      return { success: true };
    } catch (e) {
      return { success: false, msg: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcBridge.application.getStartOnBootStatus.provider(async () => {
    try {
      return { success: true, data: getStartOnBootStatus() };
    } catch (e) {
      return { success: false, msg: e.message || e.toString() };
    }
  });

  ipcBridge.application.checkComputerUsePermissions.provider(async () => {
    try {
      const status = await runComputerUsePermissionDoctor({
        entryPath: process.env.ELLM_SHA_OPEN_COMPUTER_USE_ENTRY,
      });
      return { success: true, data: status };
    } catch (error) {
      console.error(
        '[ApplicationBridge] Computer Use permission check failed:',
        error instanceof Error ? error.name : 'UnknownError'
      );
      return { success: false, msg: 'COMPUTER_USE_PERMISSION_CHECK_FAILED' };
    }
  });

  ipcBridge.application.setStartOnBoot.provider(async ({ enabled }) => {
    try {
      const status = setStartOnBootEnabled(enabled);
      if (!status.supported) {
        return { success: false, msg: START_ON_BOOT_UNSUPPORTED_MESSAGE, data: status };
      }
      return { success: true, data: status };
    } catch (e) {
      return { success: false, msg: e.message || e.toString() };
    }
  });

  ipcBridge.application.getGpuStatus.provider(async () => {
    try {
      return { success: true, data: getGpuStatus() };
    } catch (e) {
      return { success: false, msg: e.message || e.toString() };
    }
  });

  ipcBridge.application.setGpuOverride.provider(async ({ override }) => {
    try {
      return { success: true, data: setGpuUserOverride(override) };
    } catch (e) {
      return { success: false, msg: e.message || e.toString() };
    }
  });
}
