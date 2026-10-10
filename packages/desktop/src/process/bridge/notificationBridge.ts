/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * System Notification Module
 *
 * Provides showNotification() for direct use in main process,
 * and registers an IPC provider so renderer can invoke it cross-process.
 */

import { getPlatformServices } from '@/common/platform';
import { ipcBridge } from '@/common';
import { electronNotification } from '@/common/electronSafe';
import type { BrowserWindow, Notification as ElectronNotification } from 'electron';
import path from 'path';
import fs from 'fs';

// Main window reference, used to gate on focus and to focus + navigate on click.
let mainWindowRef: BrowserWindow | null = null;
const activeNotifications = new Map<string, ElectronNotification>();

export const setNotificationMainWindow = (win: BrowserWindow): void => {
  mainWindowRef = win;
};

/**
 * Get app icon path for notifications
 */
const getNotificationIcon = (): string | undefined => {
  try {
    const resourcesPath = getPlatformServices().paths.isPackaged()
      ? process.resourcesPath
      : path.join(process.cwd(), 'resources');
    const iconPath = path.join(resourcesPath, 'app.png');
    if (fs.existsSync(iconPath)) {
      return iconPath;
    }
  } catch {
    // Ignore icon error, notification will still show
  }
  return undefined;
};

/**
 * Show a system notification.
 * Can be called directly from main process or via IPC from renderer.
 *
 * Turn-completed notifications are skipped when the main window is already
 * focused, while confirmation requests still notify because they can belong
 * to an inactive conversation. The renderer applies the authoritative backend
 * notification setting before invoking this bridge.
 * When a real Electron notification is available, clicking it focuses the main
 * window and emits `notification.clicked` so the renderer can navigate to the
 * originating conversation.
 *
 * In non-Electron mode this falls back to the platform service, which is a no-op.
 */
export async function showNotification({
  title,
  body,
  conversation_id,
  kind,
  notification_id,
}: {
  title: string;
  body: string;
  conversation_id?: string;
  kind?: 'confirmation' | 'turnCompleted';
  notification_id?: string;
}): Promise<void> {
  // Permission requests need attention even when another chat is focused.
  if (kind !== 'confirmation' && mainWindowRef && !mainWindowRef.isDestroyed() && mainWindowRef.isFocused()) {
    return;
  }

  const iconPath = getNotificationIcon();

  // Prefer a real Electron notification so the click can focus + navigate.
  if (electronNotification) {
    try {
      const notification = new electronNotification({ title, body, ...(iconPath ? { icon: iconPath } : {}) });
      if (notification_id) {
        activeNotifications.get(notification_id)?.close();
        activeNotifications.set(notification_id, notification);
        notification.on('close', () => {
          if (activeNotifications.get(notification_id) === notification) {
            activeNotifications.delete(notification_id);
          }
        });
      }
      notification.on('click', () => {
        const win = mainWindowRef;
        if (win && !win.isDestroyed()) {
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
        }
        ipcBridge.notification.clicked.emit({ conversation_id });
      });
      notification.show();
    } catch (error) {
      console.error('[Notification] Error creating notification:', error);
    }
    return;
  }

  // Non-Electron fallback (no-op in node mode).
  try {
    getPlatformServices().notification.send({ title, body, icon: iconPath });
  } catch (error) {
    console.error('[Notification] Error creating notification:', error);
  }
}

export function closeNotification(notification_id: string): void {
  const notification = activeNotifications.get(notification_id);
  if (!notification) return;
  activeNotifications.delete(notification_id);
  notification.close();
}

/**
 * Register IPC provider so renderer can trigger notifications cross-process.
 */
export function initNotificationBridge(): void {
  ipcBridge.notification.show.provider(async (options) => {
    await showNotification(options);
  });
  ipcBridge.notification.close.provider(({ notification_id }) => {
    closeNotification(notification_id);
  });
}
