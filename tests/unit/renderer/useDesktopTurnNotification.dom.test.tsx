/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const streamHandlers: Array<(e: unknown) => void> = [];
const confirmationRemoveHandlers: Array<(e: { id: string; conversation_id: string }) => void> = [];
const notificationClickHandlers: Array<(e: { conversation_id?: string }) => void> = [];
const showInvoke = vi.fn();
const closeInvoke = vi.fn();
const navigate = vi.fn();
let isDesktop = true;
let settingEnabled = true;

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      responseStream: {
        on: (h: (e: unknown) => void) => {
          streamHandlers.push(h);
          return () => {};
        },
      },
      confirmation: {
        remove: {
          on: (h: (e: { id: string; conversation_id: string }) => void) => {
            confirmationRemoveHandlers.push(h);
            return () => {};
          },
        },
      },
    },
    notification: {
      show: { invoke: (...args: unknown[]) => showInvoke(...args) },
      close: { invoke: (...args: unknown[]) => closeInvoke(...args) },
      clicked: {
        on: (h: (e: { conversation_id?: string }) => void) => {
          notificationClickHandlers.push(h);
          return () => {};
        },
      },
    },
  },
}));
vi.mock('@/renderer/utils/platform', () => ({ isElectronDesktop: () => isDesktop }));
vi.mock('@/common/config/configService', () => ({ configService: { get: () => settingEnabled } }));
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import { useDesktopTurnNotification } from '@/renderer/hooks/system/notification/useDesktopTurnNotification';
import { useNotificationClick } from '@/renderer/hooks/system/notification/useNotificationClick';

const emitStream = (message: unknown) => streamHandlers.forEach((h) => h(message));
const emitConfirmationRemove = (confirmation: { id: string; conversation_id: string }) =>
  confirmationRemoveHandlers.forEach((h) => h(confirmation));
const emitNotificationClick = (notification: { conversation_id?: string }) =>
  notificationClickHandlers.forEach((h) => h(notification));

beforeEach(() => {
  streamHandlers.length = 0;
  confirmationRemoveHandlers.length = 0;
  notificationClickHandlers.length = 0;
  showInvoke.mockClear();
  closeInvoke.mockClear();
  navigate.mockClear();
  isDesktop = true;
  settingEnabled = true;
});

describe('useDesktopTurnNotification', () => {
  it('invokes the native notification on a finish stream message when unfocused', () => {
    renderHook(() => useDesktopTurnNotification());
    emitStream({ type: 'finish', conversation_id: 's1', turn_id: 't1' });
    expect(showInvoke).toHaveBeenCalledTimes(1);
    expect(showInvoke).toHaveBeenCalledWith({
      title: 'eLLMsha',
      body: 'settings.browserNotification.bodyTurnCompleted',
      conversation_id: 's1',
      kind: 'turnCompleted',
      notification_id: undefined,
    });
  });

  it('notifies from a real ACP permission stream frame and targets its conversation', () => {
    renderHook(() => useDesktopTurnNotification());
    emitStream({
      type: 'acp_permission',
      conversation_id: 'inactive-chat',
      msg_id: 'turn-message',
      data: { tool_call: { tool_call_id: 'request-1' }, options: [] },
    });
    expect(showInvoke).toHaveBeenCalledWith({
      title: 'eLLMsha',
      body: 'settings.browserNotification.bodyConfirmation',
      conversation_id: 'inactive-chat',
      kind: 'confirmation',
      notification_id: '["inactive-chat","request-1"]',
    });
  });

  it('does not duplicate repeated stream frames for one pending confirmation', () => {
    renderHook(() => useDesktopTurnNotification());
    const permission = {
      type: 'permission',
      conversation_id: 's1',
      msg_id: 'turn-message',
      data: { id: 'confirmation-1', call_id: 'call-1' },
    };
    emitStream(permission);
    emitStream(permission);
    expect(showInvoke).toHaveBeenCalledTimes(1);
  });

  it('closes a resolved confirmation and allows the same request ID to become pending again', () => {
    renderHook(() => useDesktopTurnNotification());
    const permission = {
      type: 'permission',
      conversation_id: 's1',
      data: { id: 'confirmation-1', call_id: 'call-1' },
    };
    emitStream(permission);
    emitConfirmationRemove({ id: 'confirmation-1', conversation_id: 's1' });
    emitStream(permission);
    expect(closeInvoke).toHaveBeenCalledWith({ notification_id: '["s1","confirmation-1"]' });
    expect(showInvoke).toHaveBeenCalledTimes(2);
  });

  it('does not notify when the notification setting is disabled', () => {
    settingEnabled = false;
    renderHook(() => useDesktopTurnNotification());
    emitStream({ type: 'finish', conversation_id: 's1', turn_id: 't1' });
    emitStream({ type: 'permission', conversation_id: 's1', data: { id: 'confirmation-1' } });
    expect(showInvoke).not.toHaveBeenCalled();
  });

  it('is a no-op outside the Electron desktop runtime', () => {
    isDesktop = false;
    renderHook(() => useDesktopTurnNotification());
    expect(streamHandlers).toHaveLength(0);
    expect(confirmationRemoveHandlers).toHaveLength(0);
    emitStream({ type: 'finish', conversation_id: 's1', turn_id: 't1' });
    expect(showInvoke).not.toHaveBeenCalled();
  });

  it('navigates to the originating conversation after a native notification click', () => {
    renderHook(() => useNotificationClick());
    emitNotificationClick({ conversation_id: 'inactive-chat' });
    expect(navigate).toHaveBeenCalledWith('/conversation/inactive-chat');
  });
});
