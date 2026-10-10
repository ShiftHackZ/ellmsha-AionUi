// @vitest-environment jsdom
/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TChatConversation, TConversationRuntimeStateKind } from '@/common/config/storage';
import {
  getSidebarStreamGuardDecision,
  isTerminalSidebarStreamMessage,
  resetConversationListSyncStoreForTest,
  useConversationListSync,
} from '@/renderer/pages/conversation/GroupedHistory/hooks/useConversationListSync';
import { isConversationRuntimeActive, isSubagentRunning } from '@/renderer/pages/conversation/GroupedHistory/types';

const bridgeMocks = vi.hoisted(() => {
  const handlers: Record<string, (event: any) => void> = {};
  const makeOn = (name: string) =>
    vi.fn((handler: (event: any) => void) => {
      handlers[name] = handler;
      return vi.fn();
    });
  return {
    handlers,
    getUserConversations: vi.fn(),
    on: {
      listChanged: makeOn('listChanged'),
      userCreated: makeOn('userCreated'),
      responseStream: makeOn('responseStream'),
      turnCompleted: makeOn('turnCompleted'),
      reconnected: makeOn('reconnected'),
    },
  };
});

vi.mock('@/common', () => ({
  ipcBridge: {
    application: { writeRendererLog: { invoke: vi.fn().mockResolvedValue(undefined) } },
    database: { getUserConversations: { invoke: bridgeMocks.getUserConversations } },
    conversation: {
      listChanged: { on: bridgeMocks.on.listChanged },
      userCreated: { on: bridgeMocks.on.userCreated },
      responseStream: { on: bridgeMocks.on.responseStream },
      turnCompleted: { on: bridgeMocks.on.turnCompleted },
    },
    realtime: { reconnected: { on: bridgeMocks.on.reconnected } },
  },
}));

vi.mock('@/renderer/utils/emitter', () => ({ addEventListener: vi.fn(() => vi.fn()) }));

describe('getSidebarStreamGuardDecision', () => {
  it('marks normal generating stream messages', () => {
    expect(getSidebarStreamGuardDecision({ type: 'content', completed: false })).toEqual({
      markGenerating: true,
      clearCompleted: false,
      lateIgnored: false,
    });
  });

  it('ignores late stream messages after turn completion', () => {
    expect(getSidebarStreamGuardDecision({ type: 'content', completed: true })).toEqual({
      markGenerating: false,
      clearCompleted: false,
      lateIgnored: true,
    });
  });

  it('allows a new start event to clear the completion guard', () => {
    expect(getSidebarStreamGuardDecision({ type: 'start', completed: true })).toEqual({
      markGenerating: true,
      clearCompleted: true,
      lateIgnored: false,
    });
  });

  it('ignores non-generating messages', () => {
    expect(getSidebarStreamGuardDecision({ type: 'slash_commands_updated', completed: true })).toEqual({
      markGenerating: false,
      clearCompleted: false,
      lateIgnored: false,
    });
  });

  it('recognizes finish, error, and disconnected status as terminal', () => {
    expect(isTerminalSidebarStreamMessage({ type: 'finish', data: null })).toBe(true);
    expect(isTerminalSidebarStreamMessage({ type: 'error', data: null })).toBe(true);
    expect(isTerminalSidebarStreamMessage({ type: 'agent_status', data: { status: 'disconnected' } })).toBe(true);
  });
});

const rootConversation = (state: TConversationRuntimeStateKind, is_processing: boolean): TChatConversation =>
  ({
    id: 'root',
    name: 'Root',
    type: 'acp',
    created_at: 1,
    modified_at: 1,
    extra: {},
    runtime: {
      state,
      can_send_message: !is_processing,
      has_task: is_processing,
      task_status: is_processing ? 'running' : 'finished',
      is_processing,
      pending_confirmations: 0,
      turn_id: is_processing ? 'turn-1' : null,
    },
  }) as TChatConversation;

const childConversation = (status: string): TChatConversation =>
  ({
    id: `child-${status}`,
    name: 'Child',
    type: 'acp',
    created_at: 2,
    modified_at: 2,
    extra: {
      subagent: { parent_conversation_id: 'root', ref: 'child', status },
    },
  }) as TChatConversation;

describe('sidebar runtime activity', () => {
  it.each(['starting', 'running', 'cancelling', 'waiting_confirmation'] as const)(
    'keeps a root active while runtime is %s',
    (state) => {
      expect(isConversationRuntimeActive(rootConversation(state, true))).toBe(true);
    }
  );

  it('does not infer root activity from an independently running child', () => {
    expect(isConversationRuntimeActive(rootConversation('idle', false))).toBe(false);
    expect(isSubagentRunning(childConversation('running'))).toBe(true);
  });

  it.each(['completed', 'errored', 'interrupted', 'shutdown'])('stops terminal child loaders for %s', (status) => {
    expect(isSubagentRunning(childConversation(status))).toBe(false);
  });

  it('treats restored idle runtime as authoritative even when a row may have stale persisted status', () => {
    const restored = { ...rootConversation('idle', false), status: 'running' as const };
    expect(isConversationRuntimeActive(restored)).toBe(false);
  });
});

const listSnapshot = (root: TChatConversation, child: TChatConversation) => ({
  items: [root, child],
  total: 2,
  has_more: false,
});

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe('conversation list activity reconciliation', () => {
  beforeEach(() => {
    resetConversationListSyncStoreForTest();
    vi.clearAllMocks();
    Object.keys(bridgeMocks.handlers).forEach((key) => delete bridgeMocks.handlers[key]);
    bridgeMocks.getUserConversations.mockReset();
  });

  afterEach(() => {
    resetConversationListSyncStoreForTest();
  });

  it('rehydrates root waiting, preserves independent child activity, and converges missed terminal/start events', async () => {
    bridgeMocks.getUserConversations.mockResolvedValueOnce(
      listSnapshot(rootConversation('running', true), childConversation('running'))
    );
    const { result } = renderHook(() => useConversationListSync());

    await waitFor(() => expect(result.current.isConversationGenerating('root')).toBe(true));
    expect(isSubagentRunning(result.current.conversations.find((item) => item.id === 'child-running'))).toBe(true);

    act(() =>
      bridgeMocks.handlers.responseStream({
        conversation_id: 'root',
        type: 'error',
        data: { message: 'failed' },
      })
    );
    expect(result.current.isConversationGenerating('root')).toBe(false);
    expect(isSubagentRunning(result.current.conversations.find((item) => item.id === 'child-running'))).toBe(true);

    act(() => bridgeMocks.handlers.userCreated({ conversation_id: 'root' }));
    expect(result.current.isConversationGenerating('root')).toBe(true);

    bridgeMocks.getUserConversations.mockResolvedValueOnce(
      listSnapshot(rootConversation('idle', false), childConversation('running'))
    );
    act(() => {
      bridgeMocks.handlers.turnCompleted({ session_id: 'root', turn_id: 'turn-1', state: 'ai_waiting_input' });
    });
    expect(result.current.isConversationGenerating('root')).toBe(false);
    expect(isSubagentRunning(result.current.conversations.find((item) => item.id === 'child-running'))).toBe(true);

    bridgeMocks.getUserConversations.mockResolvedValueOnce(
      listSnapshot(rootConversation('idle', false), childConversation('errored'))
    );
    act(() => bridgeMocks.handlers.reconnected({ timestamp: Date.now() }));
    await waitFor(() =>
      expect(isSubagentRunning(result.current.conversations.find((item) => item.id === 'child-errored'))).toBe(false)
    );
    act(() =>
      bridgeMocks.handlers.responseStream({
        conversation_id: 'root',
        type: 'content',
        data: { content: 'late' },
      })
    );
    expect(result.current.isConversationGenerating('root')).toBe(false);

    bridgeMocks.getUserConversations.mockResolvedValueOnce(
      listSnapshot(rootConversation('waiting_confirmation', true), childConversation('errored'))
    );
    act(() => bridgeMocks.handlers.reconnected({ timestamp: Date.now() }));
    await waitFor(() => expect(result.current.isConversationGenerating('root')).toBe(true));
  });

  it('retries a reconnect snapshot changed by a newer live event instead of clearing activity', async () => {
    bridgeMocks.getUserConversations.mockResolvedValueOnce(
      listSnapshot(rootConversation('idle', false), childConversation('completed'))
    );
    const { result } = renderHook(() => useConversationListSync());
    await waitFor(() => expect(result.current.conversations).toHaveLength(2));

    const staleReconnect = deferred<ReturnType<typeof listSnapshot>>();
    const authoritativeRetry = deferred<ReturnType<typeof listSnapshot>>();
    bridgeMocks.getUserConversations
      .mockReturnValueOnce(staleReconnect.promise)
      .mockReturnValueOnce(authoritativeRetry.promise);

    act(() => bridgeMocks.handlers.reconnected({ timestamp: Date.now() }));
    act(() => bridgeMocks.handlers.userCreated({ conversation_id: 'root' }));
    expect(result.current.isConversationGenerating('root')).toBe(true);
    act(() =>
      bridgeMocks.handlers.responseStream({
        conversation_id: 'root',
        type: 'content',
        data: { content: 'working' },
      })
    );
    act(() =>
      bridgeMocks.handlers.responseStream({
        conversation_id: 'root',
        type: 'thinking',
        data: { content: 'still working' },
      })
    );
    await act(async () =>
      staleReconnect.resolve(listSnapshot(rootConversation('idle', false), childConversation('completed')))
    );
    await waitFor(() => expect(bridgeMocks.getUserConversations).toHaveBeenCalledTimes(3));
    expect(result.current.isConversationGenerating('root')).toBe(true);
    act(() =>
      bridgeMocks.handlers.responseStream({
        conversation_id: 'root',
        type: 'content',
        data: { content: 'stream continues' },
      })
    );

    await act(async () =>
      authoritativeRetry.resolve(listSnapshot(rootConversation('running', true), childConversation('completed')))
    );
    await waitFor(() => expect(result.current.isConversationGenerating('root')).toBe(true));
    expect(bridgeMocks.getUserConversations).toHaveBeenCalledTimes(3);
  });

  it('preserves event-derived activity when reconnect reconciliation fails', async () => {
    bridgeMocks.getUserConversations.mockResolvedValueOnce(
      listSnapshot(rootConversation('running', true), childConversation('running'))
    );
    const { result } = renderHook(() => useConversationListSync());
    await waitFor(() => expect(result.current.isConversationGenerating('root')).toBe(true));

    bridgeMocks.getUserConversations.mockRejectedValueOnce(new Error('offline'));
    act(() => bridgeMocks.handlers.reconnected({ timestamp: Date.now() }));
    await waitFor(() => expect(bridgeMocks.getUserConversations).toHaveBeenCalledTimes(2));

    expect(result.current.isConversationGenerating('root')).toBe(true);
    expect(isSubagentRunning(result.current.conversations.find((item) => item.id === 'child-running'))).toBe(true);
  });
});
