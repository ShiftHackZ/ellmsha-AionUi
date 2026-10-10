/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { type PropsWithChildren } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcBridge } from '@/common';
import type { IMessageAcpToolCall, IMessageText, IMessageThinking } from '@/common/chat/chatLib';
import {
  MessageListLoadingProvider,
  MessageListProvider,
  MessagePaginationProvider,
  useAddOrUpdateMessage,
  useMessageLstCache,
  useMessageList,
  useReplaceWithAnchorWindow,
} from '@/renderer/pages/conversation/Messages/hooks';

const realtimeMocks = vi.hoisted(() => ({
  handler: null as null | (() => void),
  on: vi.fn((handler: () => void) => {
    realtimeMocks.handler = handler;
    return vi.fn();
  }),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      userCreated: {
        on: vi.fn().mockReturnValue(() => {}),
      },
    },
    database: {
      getConversationMessages: {
        invoke: vi.fn(),
      },
    },
    realtime: {
      reconnected: {
        on: realtimeMocks.on,
      },
    },
  },
}));

const CONVERSATION_ID = 'conversation-1';

function createTextMessage(msgId: string, content: string, conversationId = CONVERSATION_ID): IMessageText {
  return {
    id: `text-${msgId}-${content}`,
    type: 'text',
    msg_id: msgId,
    conversation_id: conversationId,
    position: 'left',
    content: {
      content,
    },
  };
}

function createThinkingMessage(msgId: string, content: string): IMessageThinking {
  return {
    id: `thinking-${msgId}-${content}`,
    type: 'thinking',
    msg_id: msgId,
    conversation_id: CONVERSATION_ID,
    position: 'left',
    content: {
      content,
      status: 'thinking',
    },
  };
}

function createThinkingDoneMessage(msgId: string, duration: number): IMessageThinking {
  return {
    id: `thinking-done-${msgId}`,
    type: 'thinking',
    msg_id: msgId,
    conversation_id: CONVERSATION_ID,
    position: 'left',
    content: {
      content: '',
      duration,
      status: 'done',
    },
  };
}

function createToolCallMessage(toolCallId: string): IMessageAcpToolCall {
  return {
    id: toolCallId,
    type: 'acp_tool_call',
    msg_id: toolCallId,
    conversation_id: CONVERSATION_ID,
    position: 'left',
    content: {
      session_id: 'session-1',
      update: {
        sessionUpdate: 'tool_call',
        tool_call_id: toolCallId,
        status: 'completed',
        title: 'Read file',
        kind: 'read',
      },
    },
  };
}

function TestWrapper({ children }: PropsWithChildren): JSX.Element {
  return <MessageListProvider value={[]}>{children}</MessageListProvider>;
}

function CacheWrapper({ children }: PropsWithChildren): JSX.Element {
  return (
    <MessageListLoadingProvider value={false}>
      <MessagePaginationProvider
        value={{ hasMoreBefore: false, hasMoreAfter: false, isLoadingBefore: false, isLoadingAnchor: false }}
      >
        <MessageListProvider value={[]}>{children}</MessageListProvider>
      </MessagePaginationProvider>
    </MessageListLoadingProvider>
  );
}

function useMessageHarness() {
  return {
    addOrUpdateMessage: useAddOrUpdateMessage(),
    messages: useMessageList(),
  };
}

function useAnchorMessageHarness() {
  return {
    addOrUpdateMessage: useAddOrUpdateMessage(),
    replaceWithAnchorWindow: useReplaceWithAnchorWindow(),
    messages: useMessageList(),
  };
}

async function flushMessageQueue(): Promise<void> {
  await act(async () => {
    vi.runAllTimers();
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

describe('message merging', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('keeps text segments split when tool calls interrupt the same msg_id stream', async () => {
    const { result } = renderHook(() => useMessageHarness(), {
      wrapper: TestWrapper,
    });

    act(() => {
      result.current.addOrUpdateMessage(createTextMessage('msg-1', 'hello'));
      result.current.addOrUpdateMessage(createTextMessage('msg-1', ' world'));
    });
    await flushMessageQueue();

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].type).toBe('text');
    expect((result.current.messages[0] as IMessageText).content.content).toBe('hello world');

    act(() => {
      result.current.addOrUpdateMessage(createToolCallMessage('tool-1'));
      result.current.addOrUpdateMessage(createTextMessage('msg-1', 'again'));
    });
    await flushMessageQueue();

    expect(result.current.messages.map((message) => message.type)).toEqual(['text', 'acp_tool_call', 'text']);
    expect((result.current.messages[0] as IMessageText).content.content).toBe('hello world');
    expect((result.current.messages[2] as IMessageText).content.content).toBe('again');
  });

  it('keeps thinking segments split when tool calls interrupt the same msg_id stream', async () => {
    const { result } = renderHook(() => useMessageHarness(), {
      wrapper: TestWrapper,
    });

    act(() => {
      result.current.addOrUpdateMessage(createThinkingMessage('msg-1', 'alpha'));
      result.current.addOrUpdateMessage(createThinkingMessage('msg-1', 'beta'));
    });
    await flushMessageQueue();

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].type).toBe('thinking');
    expect((result.current.messages[0] as IMessageThinking).content.content).toBe('alphabeta');

    act(() => {
      result.current.addOrUpdateMessage(createToolCallMessage('tool-1'));
      result.current.addOrUpdateMessage(createThinkingMessage('msg-1', 'gamma'));
    });
    await flushMessageQueue();

    expect(result.current.messages.map((message) => message.type)).toEqual(['thinking', 'acp_tool_call', 'thinking']);
    expect((result.current.messages[0] as IMessageThinking).content.content).toBe('alphabeta');
    expect((result.current.messages[2] as IMessageThinking).content.content).toBe('gamma');
  });

  it('merges thinking done updates into the existing thinking message instead of appending a completion message', async () => {
    const { result } = renderHook(() => useMessageHarness(), {
      wrapper: TestWrapper,
    });

    act(() => {
      result.current.addOrUpdateMessage(createThinkingMessage('msg-1', 'alpha'));
      result.current.addOrUpdateMessage(createToolCallMessage('tool-1'));
      result.current.addOrUpdateMessage(createThinkingDoneMessage('msg-1', 4200));
    });
    await flushMessageQueue();

    expect(result.current.messages.map((message) => message.type)).toEqual(['thinking', 'acp_tool_call']);
    expect((result.current.messages[0] as IMessageThinking).content.status).toBe('done');
    expect((result.current.messages[0] as IMessageThinking).content.duration).toBe(4200);
  });

  it('ignores non-renderable transformed stream messages', async () => {
    const { result } = renderHook(() => useMessageHarness(), {
      wrapper: TestWrapper,
    });

    act(() => {
      result.current.addOrUpdateMessage(undefined);
    });
    await flushMessageQueue();

    expect(result.current.messages).toEqual([]);
  });

  it('keeps live-only and richer streaming messages when replacing with an anchor window', async () => {
    const { result } = renderHook(() => useAnchorMessageHarness(), {
      wrapper: TestWrapper,
    });

    act(() => {
      result.current.addOrUpdateMessage(createTextMessage('agent-1', 'partial streaming response'));
      result.current.addOrUpdateMessage(createTextMessage('agent-2', 'live tail'));
    });
    await flushMessageQueue();

    act(() => {
      result.current.replaceWithAnchorWindow(CONVERSATION_ID, [
        createTextMessage('user-anchor', 'anchor'),
        createTextMessage('agent-1', 'partial'),
      ]);
    });

    expect(result.current.messages.map((message) => message.msg_id)).toEqual(['user-anchor', 'agent-1', 'agent-2']);
    expect((result.current.messages[1] as IMessageText).content.content).toBe('partial streaming response');
    expect((result.current.messages[2] as IMessageText).content.content).toBe('live tail');
  });

  it('requests compact tool content when hydrating historical messages', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    invoke.mockClear();
    invoke.mockResolvedValue({
      items: [],
      oldest_cursor: null,
      newest_cursor: null,
      has_more_before: false,
      has_more_after: false,
    });

    renderHook(() => useMessageLstCache(CONVERSATION_ID), {
      wrapper: CacheWrapper,
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith({
      conversation_id: CONVERSATION_ID,
      limit: 50,
      content_mode: 'compact',
    });
  });

  it('reloads persisted messages after realtime reconnect', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    invoke.mockReset();
    realtimeMocks.handler = null;
    invoke
      .mockResolvedValueOnce({
        items: [],
        oldest_cursor: null,
        newest_cursor: null,
        has_more_before: false,
        has_more_after: false,
      })
      .mockResolvedValueOnce({
        items: [createTextMessage('missed-user-message', 'persisted while disconnected')],
        oldest_cursor: null,
        newest_cursor: null,
        has_more_before: false,
        has_more_after: false,
      });

    const { result } = renderHook(
      () => {
        useMessageLstCache(CONVERSATION_ID);
        return useMessageList();
      },
      { wrapper: CacheWrapper }
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(realtimeMocks.handler).toBeTypeOf('function');

    await act(async () => {
      realtimeMocks.handler?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(result.current.map((message) => message.msg_id)).toContain('missed-user-message');
  });

  it('ignores a late hydration response from the previous conversation', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    const first = deferred<Awaited<ReturnType<typeof invoke>>>();
    const second = deferred<Awaited<ReturnType<typeof invoke>>>();
    invoke.mockReset().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const { result, rerender } = renderHook(
      ({ conversationId }) => {
        useMessageLstCache(conversationId);
        return useMessageList();
      },
      {
        initialProps: { conversationId: 'conversation-a' },
        wrapper: CacheWrapper,
      }
    );

    rerender({ conversationId: 'conversation-b' });
    await act(async () => {
      second.resolve({
        items: [createTextMessage('message-b', 'new conversation', 'conversation-b')],
        oldest_cursor: null,
        newest_cursor: null,
        has_more_before: false,
        has_more_after: false,
      });
      await second.promise;
    });
    await act(async () => {
      first.resolve({
        items: [createTextMessage('message-a', 'old conversation', 'conversation-a')],
        oldest_cursor: null,
        newest_cursor: null,
        has_more_before: false,
        has_more_after: false,
      });
      await first.promise;
    });

    expect(result.current.map((message) => message.msg_id)).toEqual(['message-b']);
  });

  it('ignores an older reconnect hydration that resolves last', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    const older = deferred<Awaited<ReturnType<typeof invoke>>>();
    const newer = deferred<Awaited<ReturnType<typeof invoke>>>();
    invoke
      .mockReset()
      .mockResolvedValueOnce({
        items: [],
        oldest_cursor: null,
        newest_cursor: null,
        has_more_before: false,
        has_more_after: false,
      })
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);

    const { result } = renderHook(
      () => {
        useMessageLstCache(CONVERSATION_ID);
        return useMessageList();
      },
      { wrapper: CacheWrapper }
    );
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      realtimeMocks.handler?.();
      realtimeMocks.handler?.();
    });
    await act(async () => {
      newer.resolve({
        items: [createTextMessage('newer-message', 'newest persisted state')],
        oldest_cursor: null,
        newest_cursor: null,
        has_more_before: false,
        has_more_after: false,
      });
      await newer.promise;
    });
    await act(async () => {
      older.resolve({
        items: [createTextMessage('older-message', 'stale persisted state')],
        oldest_cursor: null,
        newest_cursor: null,
        has_more_before: false,
        has_more_after: false,
      });
      await older.promise;
    });

    expect(result.current.map((message) => message.msg_id)).toEqual(['newer-message']);
  });
});
