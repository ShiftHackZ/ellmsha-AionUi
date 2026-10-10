// @vitest-environment jsdom
/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TChatConversation, TConversationRuntimeSummary } from '@/common/config/storage';
import { useConversationRuntimeView } from '@/renderer/pages/conversation/runtime/useConversationRuntimeView';
import { resetConversationRuntimeViewStoreForTest } from '@/renderer/pages/conversation/runtime/conversationRuntimeViewStore';
import { getConversationOrNull } from '@/renderer/pages/conversation/utils/conversationCache';

const bridgeMocks = vi.hoisted(() => {
  const handlers: Record<string, (event: unknown) => void> = {};
  const makeOn = (name: string) =>
    vi.fn((handler: (event: unknown) => void) => {
      handlers[name] = handler;
      return vi.fn();
    });
  return {
    handlers,
    on: {
      turnCompleted: makeOn('turnCompleted'),
      listChanged: makeOn('listChanged'),
      reconnected: makeOn('reconnected'),
    },
  };
});

vi.mock('@/common', () => ({
  ipcBridge: {
    application: { writeRendererLog: { invoke: vi.fn().mockResolvedValue(undefined) } },
    conversation: {
      turnCompleted: { on: bridgeMocks.on.turnCompleted },
      listChanged: { on: bridgeMocks.on.listChanged },
    },
    realtime: { reconnected: { on: bridgeMocks.on.reconnected } },
  },
}));

vi.mock('@/renderer/pages/conversation/utils/conversationCache', () => ({
  getConversationOrNull: vi.fn(),
}));

const runtime = (isProcessing: boolean): TConversationRuntimeSummary => ({
  state: isProcessing ? 'running' : 'idle',
  can_send_message: !isProcessing,
  has_task: isProcessing,
  task_status: isProcessing ? 'running' : 'finished',
  is_processing: isProcessing,
  pending_confirmations: 0,
  turn_id: isProcessing ? 'turn-disconnected' : null,
});

const conversation = (isProcessing: boolean) =>
  ({ id: 'conversation-reconnect', runtime: runtime(isProcessing) }) as TChatConversation;

describe('useConversationRuntimeView reconnect recovery', () => {
  beforeEach(() => {
    resetConversationRuntimeViewStoreForTest();
    vi.clearAllMocks();
    Object.keys(bridgeMocks.handlers).forEach((key) => delete bridgeMocks.handlers[key]);
  });

  afterEach(() => {
    resetConversationRuntimeViewStoreForTest();
  });

  it('rehydrates authoritative runtime after a missed turn completion', async () => {
    const getConversation = vi.mocked(getConversationOrNull);
    getConversation.mockResolvedValueOnce(conversation(true)).mockResolvedValueOnce(conversation(false));

    const { result } = renderHook(() => useConversationRuntimeView('conversation-reconnect'));
    await waitFor(() => expect(result.current.isProcessing).toBe(true));
    expect(bridgeMocks.handlers.reconnected).toBeTypeOf('function');

    act(() => bridgeMocks.handlers.reconnected({ timestamp: Date.now() }));
    await waitFor(() => expect(result.current.isProcessing).toBe(false));
    expect(result.current.canSendMessage).toBe(true);
    expect(getConversation).toHaveBeenCalledTimes(2);
  });
});
