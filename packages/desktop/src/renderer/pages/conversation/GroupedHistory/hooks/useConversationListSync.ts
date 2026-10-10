/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { TChatConversation } from '@/common/config/storage';
import { addEventListener } from '@/renderer/utils/emitter';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { isConversationRuntimeActive } from '../types';

/**
 * Whitelist of message types that indicate content generation is in progress.
 * Only these types should trigger the sidebar loading spinner.
 * Using a whitelist (instead of a blacklist) prevents unknown/internal message
 * types (e.g. slash_commands_updated, acp_context_usage) from falsely
 * triggering the generating state.
 */
const isGeneratingStreamMessage = (type: string): boolean => {
  return (
    type === 'content' ||
    type === 'start' ||
    type === 'thought' ||
    type === 'thinking' ||
    type === 'tool_group' ||
    type === 'acp_tool_call' ||
    type === 'acp_permission' ||
    type === 'permission' ||
    type === 'plan'
  );
};

const isTerminalAgentStatus = (data: unknown): boolean => {
  if (!data || typeof data !== 'object') {
    return false;
  }

  const { status } = data as { status?: string };
  return status === 'error' || status === 'disconnected';
};

export const isTerminalSidebarStreamMessage = (message: { type: string; data: unknown }): boolean => {
  return (
    message.type === 'finish' ||
    message.type === 'error' ||
    (message.type === 'agent_status' && isTerminalAgentStatus(message.data))
  );
};

const isTerminalTurnState = (state: string): boolean => {
  return state === 'ai_waiting_input' || state === 'error' || state === 'stopped';
};

export type SidebarStreamGuardDecision = {
  markGenerating: boolean;
  clearCompleted: boolean;
  lateIgnored: boolean;
};

export const getSidebarStreamGuardDecision = ({
  type,
  completed,
}: {
  type: string;
  completed: boolean;
}): SidebarStreamGuardDecision => {
  if (!isGeneratingStreamMessage(type)) {
    return {
      markGenerating: false,
      clearCompleted: false,
      lateIgnored: false,
    };
  }

  if (type === 'start') {
    return {
      markGenerating: true,
      clearCompleted: true,
      lateIgnored: false,
    };
  }

  if (completed) {
    return {
      markGenerating: false,
      clearCompleted: false,
      lateIgnored: true,
    };
  }

  return {
    markGenerating: true,
    clearCompleted: false,
    lateIgnored: false,
  };
};

type ConversationListSyncSnapshot = {
  conversations: TChatConversation[];
  generatingConversationIds: Set<string>;
  completionUnreadConversationIds: Set<string>;
  completedConversationIds: Set<string>;
};

const listeners = new Set<() => void>();

let isStoreInitialized = false;
let conversationsState: TChatConversation[] = [];
let generatingConversationIdsState = new Set<string>();
let completionUnreadConversationIdsState = new Set<string>();
let completedConversationIdsState = new Set<string>();
let conversation_idsState = new Set<string>();
let activeConversationIdState: string | null = null;
let storeGenerationState = 0;
let activityEventVersionState = 0;
let nextRefreshSequenceState = 0;
let latestRefreshSequenceState = 0;
let storeUnsubscribers: Array<() => void> = [];
let snapshotState: ConversationListSyncSnapshot = {
  conversations: conversationsState,
  generatingConversationIds: generatingConversationIdsState,
  completionUnreadConversationIds: completionUnreadConversationIdsState,
  completedConversationIds: completedConversationIdsState,
};

const emitStoreChange = () => {
  snapshotState = {
    conversations: conversationsState,
    generatingConversationIds: generatingConversationIdsState,
    completionUnreadConversationIds: completionUnreadConversationIdsState,
    completedConversationIds: completedConversationIdsState,
  };
  listeners.forEach((listener) => listener());
};

const subscribeConversationListSync = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getConversationListSyncSnapshot = (): ConversationListSyncSnapshot => snapshotState;

const refreshConversations = () => {
  const storeGeneration = storeGenerationState;
  const eventVersion = activityEventVersionState;
  const requestSequence = ++nextRefreshSequenceState;
  latestRefreshSequenceState = requestSequence;

  void ipcBridge.database.getUserConversations
    .invoke({ limit: 10000 })
    .then((result) => {
      if (storeGeneration !== storeGenerationState || requestSequence !== latestRefreshSequenceState) {
        return;
      }
      if (eventVersion !== activityEventVersionState) {
        refreshConversations();
        return;
      }

      const items = result?.items;
      if (items && Array.isArray(items)) {
        const filteredData = items.filter((conv) => {
          // Legacy rows from the pre-provider-probe health check flow are hidden
          // from normal history. New health checks must not create conversations.
          const extra = conv.extra as { is_health_check?: boolean; team_id?: string; teamId?: string } | undefined;
          return extra?.is_health_check !== true && !extra?.team_id && !extra?.teamId;
        });
        conversationsState = filteredData;
        const nextGenerating = new Set(generatingConversationIdsState);
        const nextCompleted = new Set(completedConversationIdsState);
        for (const conversation of filteredData) {
          if (!conversation.runtime) continue;
          if (isConversationRuntimeActive(conversation)) {
            nextGenerating.add(conversation.id);
            nextCompleted.delete(conversation.id);
          } else {
            nextGenerating.delete(conversation.id);
            nextCompleted.add(conversation.id);
          }
        }
        generatingConversationIdsState = nextGenerating;
        completedConversationIdsState = nextCompleted;
        // Use ALL conversation IDs (including team/legacy health-check rows) so the
        // responseStream listener recognises them as known and doesn't
        // trigger an infinite refreshConversations loop.
        conversation_idsState = new Set(items.map((conversation) => conversation.id));
        emitStoreChange();
        return;
      }

      conversationsState = [];
      conversation_idsState = new Set();
      emitStoreChange();
    })
    .catch((error) => {
      if (storeGeneration !== storeGenerationState || requestSequence !== latestRefreshSequenceState) {
        return;
      }
      console.error('[WorkspaceGroupedHistory] Failed to load conversations:', error);
    });
};

const markGenerating = (conversation_id: string): boolean => {
  if (generatingConversationIdsState.has(conversation_id)) {
    return false;
  }

  generatingConversationIdsState = new Set(generatingConversationIdsState).add(conversation_id);
  emitStoreChange();
  return true;
};

const clearGenerating = (conversation_id: string): boolean => {
  if (!generatingConversationIdsState.has(conversation_id)) {
    return false;
  }

  const next = new Set(generatingConversationIdsState);
  next.delete(conversation_id);
  generatingConversationIdsState = next;
  emitStoreChange();
  return true;
};

const markCompletionUnread = (conversation_id: string) => {
  if (completionUnreadConversationIdsState.has(conversation_id)) {
    return;
  }

  completionUnreadConversationIdsState = new Set(completionUnreadConversationIdsState).add(conversation_id);
  emitStoreChange();
};

const clearCompletionUnreadState = (conversation_id: string) => {
  if (!completionUnreadConversationIdsState.has(conversation_id)) {
    return;
  }

  const next = new Set(completionUnreadConversationIdsState);
  next.delete(conversation_id);
  completionUnreadConversationIdsState = next;
  emitStoreChange();
};

const markCompleted = (conversation_id: string): boolean => {
  if (completedConversationIdsState.has(conversation_id)) {
    return false;
  }
  completedConversationIdsState = new Set(completedConversationIdsState).add(conversation_id);
  emitStoreChange();
  return true;
};

const clearCompleted = (conversation_id: string): boolean => {
  if (!completedConversationIdsState.has(conversation_id)) {
    return false;
  }

  const next = new Set(completedConversationIdsState);
  next.delete(conversation_id);
  completedConversationIdsState = next;
  emitStoreChange();
  return true;
};

const logLateStreamIgnored = (conversation_id: string, type: string) => {
  void ipcBridge.application.writeRendererLog
    .invoke({
      level: 'warn',
      tag: 'conversationRuntimeView',
      message: 'late_stream_ignored_for_runtime',
      data: {
        conversation_id,
        stream_type: type,
      },
    })
    .catch(() => {});
};

const setActiveConversationState = (conversation_id: string | null) => {
  activeConversationIdState = conversation_id;
};

const initializeConversationListSyncStore = () => {
  if (isStoreInitialized) {
    return;
  }

  isStoreInitialized = true;
  refreshConversations();

  storeUnsubscribers = [
    addEventListener('chat.history.refresh', refreshConversations),
    ipcBridge.conversation.listChanged.on((event) => {
      activityEventVersionState += 1;
      if (event.action === 'deleted') {
        clearGenerating(event.conversation_id);
        clearCompletionUnreadState(event.conversation_id);
        clearCompleted(event.conversation_id);
      }
      refreshConversations();
    }),
    ipcBridge.conversation.userCreated.on((event) => {
      const completionChanged = clearCompleted(event.conversation_id);
      const generationChanged = markGenerating(event.conversation_id);
      if (completionChanged || generationChanged) activityEventVersionState += 1;
    }),
    ipcBridge.conversation.responseStream.on((message) => {
      const conversation_id = message.conversation_id;
      if (!conversation_id) {
        return;
      }

      if (!conversation_idsState.has(conversation_id)) {
        refreshConversations();
      }

      if (isTerminalSidebarStreamMessage(message)) {
        const wasGenerating = generatingConversationIdsState.has(conversation_id);
        if (wasGenerating && activeConversationIdState !== conversation_id) {
          markCompletionUnread(conversation_id);
        }
        const completionChanged = markCompleted(conversation_id);
        const generationChanged = clearGenerating(conversation_id);
        if (completionChanged || generationChanged) activityEventVersionState += 1;
        return;
      }

      const decision = getSidebarStreamGuardDecision({
        type: message.type,
        completed: completedConversationIdsState.has(conversation_id),
      });
      const completionChanged = decision.clearCompleted ? clearCompleted(conversation_id) : false;
      if (decision.lateIgnored) {
        logLateStreamIgnored(conversation_id, message.type);
        return;
      }
      if (decision.markGenerating) {
        const generationChanged = markGenerating(conversation_id);
        if (completionChanged || generationChanged) activityEventVersionState += 1;
      }
    }),
    ipcBridge.conversation.turnCompleted.on((event) => {
      if (isTerminalTurnState(event.state) && activeConversationIdState !== event.session_id) {
        markCompletionUnread(event.session_id);
      }
      const completionChanged = markCompleted(event.session_id);
      const generationChanged = clearGenerating(event.session_id);
      if (completionChanged || generationChanged) activityEventVersionState += 1;
      refreshConversations();
    }),
    ipcBridge.realtime.reconnected.on(refreshConversations),
  ];
};

export const resetConversationListSyncStoreForTest = () => {
  storeUnsubscribers.forEach((unsubscribe) => unsubscribe());
  storeUnsubscribers = [];
  storeGenerationState += 1;
  activityEventVersionState = 0;
  nextRefreshSequenceState = 0;
  latestRefreshSequenceState = 0;
  isStoreInitialized = false;
  conversationsState = [];
  generatingConversationIdsState = new Set();
  completionUnreadConversationIdsState = new Set();
  completedConversationIdsState = new Set();
  conversation_idsState = new Set();
  activeConversationIdState = null;
  emitStoreChange();
};

export const useConversationListSync = () => {
  useEffect(() => {
    initializeConversationListSyncStore();
  }, []);

  const { conversations, generatingConversationIds, completionUnreadConversationIds, completedConversationIds } =
    useSyncExternalStore(
      subscribeConversationListSync,
      getConversationListSyncSnapshot,
      getConversationListSyncSnapshot
    );

  const clearCompletionUnread = useCallback((conversation_id: string) => {
    clearCompletionUnreadState(conversation_id);
  }, []);

  const setActiveConversation = useCallback((conversation_id: string | null) => {
    setActiveConversationState(conversation_id);
  }, []);

  const isConversationGenerating = useCallback(
    (conversation_id: string) => {
      if (completedConversationIds.has(conversation_id)) {
        return false;
      }
      if (generatingConversationIds.has(conversation_id)) {
        return true;
      }
      return isConversationRuntimeActive(conversations.find((conversation) => conversation.id === conversation_id));
    },
    [completedConversationIds, conversations, generatingConversationIds]
  );

  const hasCompletionUnread = useCallback(
    (conversation_id: string) => {
      return completionUnreadConversationIds.has(conversation_id);
    },
    [completionUnreadConversationIds]
  );

  return {
    conversations,
    isConversationGenerating,
    hasCompletionUnread,
    clearCompletionUnread,
    setActiveConversation,
  };
};
