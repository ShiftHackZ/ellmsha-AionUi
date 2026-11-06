/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Framework-free core for WebUI browser notifications: pure gating and a
 * controller that turns conversation events into notification payloads.
 * Kept free of React / DOM globals so it is unit-testable in the node project.
 */

export type NotificationPermissionState = 'default' | 'granted' | 'denied';

export type NotificationGate = {
  isElectron: boolean;
  hasNotificationApi: boolean;
  isSecureContext: boolean;
  permission: NotificationPermissionState;
  settingEnabled: boolean;
  documentHidden: boolean;
};

export const shouldShowNotification = (gate: NotificationGate): boolean =>
  !gate.isElectron &&
  gate.hasNotificationApi &&
  gate.isSecureContext &&
  gate.permission === 'granted' &&
  gate.settingEnabled &&
  gate.documentHidden;

export type NotificationKind = 'confirmation' | 'turnCompleted';

export type NotificationPayload = {
  body: string;
  conversationId?: string;
  kind: NotificationKind;
  notificationId?: string;
};

export type BrowserNotificationDeps = {
  /**
   * Whether a notification may be shown right now. The WebUI path derives this
   * from the browser gate (`shouldShowNotification`); the desktop path uses its
   * own condition (window focus is checked in the main process). Injecting the
   * predicate keeps this controller — and its turn-finish detection / dedup —
   * shared across both paths.
   */
  shouldShow: () => boolean;
  show: (payload: NotificationPayload) => void;
  bodyFor: (kind: NotificationKind | 'question') => string;
};

/**
 * Shape of a conversation response-stream message (`message.stream`). Both the
 * turn-finish and permission-request signals ride this single channel, keyed
 * by `type` — there is no separate `confirmation.add` / `turn.completed`
 * channel in a real conversation.
 */
export type StreamMessage = {
  type?: string;
  data?: unknown;
  msg_id?: string;
  conversation_id?: string;
  turn_id?: string;
};

// Stream `type` values that represent an agent asking the user to confirm a
// permission. ACP emits `acp_permission`; aionrs emits both `acp_permission`
// and `permission`.
const PERMISSION_TYPES = new Set(['acp_permission', 'permission']);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/** Return the backend confirmation ID carried by a real permission stream frame. */
export const getPermissionRequestId = (message: StreamMessage): string | undefined => {
  if (!message.type || !PERMISSION_TYPES.has(message.type)) return undefined;

  const data = asRecord(message.data);
  const toolCall = asRecord(data?.tool_call);
  return nonEmptyString(toolCall?.tool_call_id) ?? nonEmptyString(data?.id) ?? nonEmptyString(data?.call_id);
};

const isQuestionMessage = (message: StreamMessage): boolean => {
  const data = asRecord(message.data);
  const questions = data?.questions ?? asRecord(data?.tool_call)?.questions;
  return Array.isArray(questions) && questions.length > 0;
};

export const getConfirmationNotificationId = (conversationId: string, requestId: string): string =>
  JSON.stringify([conversationId, requestId]);

export const createBrowserNotificationController = (deps: BrowserNotificationDeps) => {
  // Track the last turn we actually notified for, so repeated finish events
  // for the same turn don't fire duplicate notifications.
  let lastNotifiedTurnId: string | null = null;
  const notifiedConfirmationIds = new Set<string>();
  const pendingQuestions = new Map<string, string>();

  const onStreamMessage = (message: StreamMessage): void => {
    if (!message?.type) return;

    if (PERMISSION_TYPES.has(message.type)) {
      const conversationId = message.conversation_id;
      const requestId = getPermissionRequestId(message);
      if (!conversationId || !requestId) return;

      const notificationId = getConfirmationNotificationId(conversationId, requestId);
      const question = isQuestionMessage(message);
      // Track pending input even while notifications are disabled or the tab is visible.
      if (question) pendingQuestions.set(notificationId, conversationId);
      if (notifiedConfirmationIds.has(notificationId)) return;
      if (!deps.shouldShow()) return;
      notifiedConfirmationIds.add(notificationId);
      deps.show({
        body: deps.bodyFor(question ? 'question' : 'confirmation'),
        conversationId,
        kind: 'confirmation',
        notificationId,
      });
      return;
    }

    if (message.type === 'finish') {
      const turnKey = message.turn_id ? JSON.stringify([message.conversation_id, message.turn_id]) : null;
      if (turnKey && turnKey === lastNotifiedTurnId) return;
      // An asynchronous question can outlive its provider turn. It still needs
      // an answer; a completion notification would contradict the question.
      if ([...pendingQuestions.values()].includes(message.conversation_id ?? '')) {
        lastNotifiedTurnId = turnKey;
        return;
      }
      if (!deps.shouldShow()) return;
      lastNotifiedTurnId = turnKey;
      deps.show({
        body: deps.bodyFor('turnCompleted'),
        conversationId: message.conversation_id,
        kind: 'turnCompleted',
      });
    }
  };

  const onConfirmationRemoved = (confirmation: { conversation_id: string; id: string }): string => {
    const notificationId = getConfirmationNotificationId(confirmation.conversation_id, confirmation.id);
    notifiedConfirmationIds.delete(notificationId);
    pendingQuestions.delete(notificationId);
    return notificationId;
  };

  return { onStreamMessage, onConfirmationRemoved };
};
