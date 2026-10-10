/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import { configService } from '@/common/config/configService';
import { isElectronDesktop } from '@/renderer/utils/platform';
import { createBrowserNotificationController } from './browserNotificationCore';

/**
 * Desktop-only: fire a native system notification when an agent turn finishes
 * or a permission request arrives on the conversation response stream. Reuses
 * the same stream controller as the WebUI path and closes pending native
 * notifications from the canonical confirmation removal event.
 *
 * The renderer applies `system.notificationEnabled`; the main-process bridge
 * suppresses turn completion while the main window is focused and always
 * allows pending confirmations. Clicks are handled by
 * `useNotificationClick`, which navigates to the originating conversation.
 *
 * No-op outside the Electron desktop runtime (the WebUI uses
 * `useBrowserNotification` instead).
 */
export const useDesktopTurnNotification = (): void => {
  const { t } = useTranslation();

  useEffect(() => {
    if (!isElectronDesktop()) return;

    const streamEmitter = ipcBridge.conversation?.responseStream;
    const confirmationRemoveEmitter = ipcBridge.conversation?.confirmation?.remove;
    if (!streamEmitter || !confirmationRemoveEmitter) return;

    const show = (
      body: string,
      conversationId: string | undefined,
      kind: 'confirmation' | 'turnCompleted',
      notificationId?: string
    ) => {
      void ipcBridge.notification.show.invoke({
        title: 'eLLMsha',
        body,
        conversation_id: conversationId,
        kind,
        notification_id: notificationId,
      });
    };

    const controller = createBrowserNotificationController({
      // This is the authoritative backend-backed setting gate. The main
      // process applies the window-focus policy after this check.
      shouldShow: () => configService.get('system.notificationEnabled') !== false,
      bodyFor: (kind) =>
        kind === 'confirmation'
          ? t('settings.browserNotification.bodyConfirmation')
          : t('settings.browserNotification.bodyTurnCompleted'),
      show: ({ body, conversationId, kind, notificationId }) => show(body, conversationId, kind, notificationId),
    });

    const disposeStream = streamEmitter.on(controller.onStreamMessage);
    const disposeConfirmationRemove = confirmationRemoveEmitter.on((confirmation) => {
      const notificationId = controller.onConfirmationRemoved(confirmation);
      void ipcBridge.notification.close.invoke({ notification_id: notificationId });
    });

    return () => {
      disposeStream();
      disposeConfirmationRemove();
    };
  }, [t]);
};
