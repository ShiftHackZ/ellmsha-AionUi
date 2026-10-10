/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, vi } from 'vitest';
import {
  shouldShowNotification,
  createBrowserNotificationController,
  type NotificationGate,
} from '@/renderer/hooks/system/notification/browserNotificationCore';

const openGate: NotificationGate = {
  isElectron: false,
  hasNotificationApi: true,
  isSecureContext: true,
  permission: 'granted',
  settingEnabled: true,
  documentHidden: true,
};

describe('shouldShowNotification', () => {
  it('returns true when all gates pass', () => {
    expect(shouldShowNotification(openGate)).toBe(true);
  });

  it.each([
    ['isElectron', { isElectron: true }],
    ['no api', { hasNotificationApi: false }],
    ['insecure', { isSecureContext: false }],
    ['not granted', { permission: 'default' as const }],
    ['setting off', { settingEnabled: false }],
    ['tab visible', { documentHidden: false }],
  ])('returns false when %s', (_label, override) => {
    expect(shouldShowNotification({ ...openGate, ...override })).toBe(false);
  });
});

describe('createBrowserNotificationController.onStreamMessage', () => {
  const makeDeps = (gate: NotificationGate = openGate) => {
    const show = vi.fn();
    const controller = createBrowserNotificationController({
      shouldShow: () => shouldShowNotification(gate),
      show,
      bodyFor: (kind) => kind,
    });
    return { show, controller };
  };

  it('shows a turn-completed notification on a finish stream message', () => {
    const { show, controller } = makeDeps();
    controller.onStreamMessage({ type: 'finish', conversation_id: 'c1', turn_id: 't1' });
    expect(show).toHaveBeenCalledWith({ body: 'turnCompleted', conversationId: 'c1', kind: 'turnCompleted' });
  });

  it('shows a confirmation notification on an acp_permission stream message', () => {
    const { show, controller } = makeDeps();
    controller.onStreamMessage({
      type: 'acp_permission',
      conversation_id: 'c2',
      data: { tool_call: { tool_call_id: 'request-2' }, options: [] },
    });
    expect(show).toHaveBeenCalledWith({
      body: 'confirmation',
      conversationId: 'c2',
      kind: 'confirmation',
      notificationId: '["c2","request-2"]',
    });
  });

  it('shows a confirmation notification on a permission stream message (aionrs)', () => {
    const { show, controller } = makeDeps();
    controller.onStreamMessage({
      type: 'permission',
      conversation_id: 'c3',
      data: { id: 'confirmation-3', call_id: 'call-3' },
    });
    expect(show).toHaveBeenCalledWith({
      body: 'confirmation',
      conversationId: 'c3',
      kind: 'confirmation',
      notificationId: '["c3","confirmation-3"]',
    });
  });

  it('ignores non-terminal stream message types', () => {
    const { show, controller } = makeDeps();
    controller.onStreamMessage({ type: 'thinking', conversation_id: 'c1', turn_id: 't1' });
    controller.onStreamMessage({ type: 'text', conversation_id: 'c1', turn_id: 't1' });
    controller.onStreamMessage({ type: 'start', conversation_id: 'c1', turn_id: 't1' });
    expect(show).not.toHaveBeenCalled();
  });

  it('does not show when the gate is closed', () => {
    const { show, controller } = makeDeps({ ...openGate, documentHidden: false });
    controller.onStreamMessage({ type: 'finish', conversation_id: 'c1', turn_id: 't1' });
    controller.onStreamMessage({
      type: 'acp_permission',
      conversation_id: 'c1',
      data: { tool_call: { tool_call_id: 'request-1' } },
    });
    expect(show).not.toHaveBeenCalled();
  });

  it('dedups repeated finish for the same turn_id', () => {
    const { show, controller } = makeDeps();
    controller.onStreamMessage({ type: 'finish', conversation_id: 'c1', turn_id: 't1' });
    controller.onStreamMessage({ type: 'finish', conversation_id: 'c1', turn_id: 't1' });
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('dedups a pending confirmation until its removal event arrives', () => {
    const { show, controller } = makeDeps();
    const permission = {
      type: 'permission',
      conversation_id: 'c1',
      data: { id: 'confirmation-1' },
    };
    controller.onStreamMessage(permission);
    controller.onStreamMessage(permission);
    controller.onConfirmationRemoved({ conversation_id: 'c1', id: 'confirmation-1' });
    controller.onStreamMessage(permission);
    expect(show).toHaveBeenCalledTimes(2);
  });

  it('ignores a permission frame without a backend request ID', () => {
    const { show, controller } = makeDeps();
    controller.onStreamMessage({ type: 'acp_permission', conversation_id: 'c1', msg_id: 'turn-message' });
    expect(show).not.toHaveBeenCalled();
  });

  it('ignores messages without a type', () => {
    const { show, controller } = makeDeps();
    controller.onStreamMessage({ conversation_id: 'c1' });
    expect(show).not.toHaveBeenCalled();
  });
});
