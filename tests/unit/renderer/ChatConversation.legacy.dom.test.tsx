import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import type { TChatConversation } from '@/common/config/storage';
import ChatConversation from '@/renderer/pages/conversation/components/ChatConversation';
import SubagentAvatars from '@/renderer/pages/conversation/components/SubagentAvatars';
import avatarStyles from '@/renderer/pages/conversation/components/SubagentAvatars/SubagentAvatars.module.css';

const usePresetAssistantInfoMock = vi.fn();
const conversationHistoryMock = vi.fn();
const acpChatMock = vi.fn(() => <div data-testid='mock-acp-chat'>acp chat</div>);
const acpModelSelectorMock = vi.fn(() => <div data-testid='mock-acp-model-selector'>model selector</div>);
const mergeLiveMessageMock = vi.fn();
const responseStreamMock = vi.hoisted(() => ({
  listeners: [] as Array<(message: unknown) => void>,
  on: vi.fn((callback: (message: unknown) => void) => {
    responseStreamMock.listeners.push(callback);
    return () => {
      responseStreamMock.listeners = responseStreamMock.listeners.filter((candidate) => candidate !== callback);
    };
  }),
}));

vi.mock('@/common', async () => {
  const actual = await vi.importActual<typeof import('@/common')>('@/common');
  return {
    ...actual,
    ipcBridge: {
      ...actual.ipcBridge,
      conversation: {
        ...actual.ipcBridge.conversation,
        responseStream: { on: responseStreamMock.on },
      },
    },
  };
});

vi.mock('@/renderer/pages/conversation/Messages/MessageList', () => ({
  default: ({ className }: { className?: string }) => <div className={className}>message history</div>,
}));

vi.mock('@/renderer/pages/conversation/Messages/hooks', () => ({
  MessageListLoadingProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  MessageListProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  MessagePaginationProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useMergeLiveMessage: () => mergeLiveMessageMock,
  useMessageLstCache: vi.fn(),
}));

vi.mock('@/renderer/pages/conversation/Messages/artifacts', () => ({
  ConversationArtifactProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/renderer/pages/conversation/components/ChatLayout', () => ({
  default: ({ children, headerExtra }: { children: React.ReactNode; headerExtra?: React.ReactNode }) => (
    <div>
      {headerExtra}
      {children}
    </div>
  ),
}));

vi.mock('@/renderer/pages/conversation/platforms/acp/AcpChat', () => ({
  __esModule: true,
  default: (props: unknown) => acpChatMock(props),
}));

vi.mock('@/renderer/components/agent/AcpModelSelector', () => ({
  __esModule: true,
  default: (props: unknown) => acpModelSelectorMock(props),
}));

vi.mock('@/renderer/pages/conversation/components/ChatSlider.tsx', () => ({
  default: () => <div>slider</div>,
}));

vi.mock('@/renderer/pages/cron', () => ({
  CronJobManager: () => <div>cron</div>,
}));

vi.mock('@/renderer/hooks/agent/usePresetAssistantInfo', () => ({
  resolveAssistantConfigId: () => undefined,
  usePresetAssistantInfo: (...args: unknown[]) => usePresetAssistantInfoMock(...args),
}));

vi.mock('@/renderer/hooks/context/LayoutContext', () => ({
  useLayoutContext: () => ({ isMobile: false }),
}));

vi.mock('@/renderer/hooks/context/ConversationHistoryContext', () => ({
  useOptionalConversationHistoryContext: () => conversationHistoryMock(),
}));

vi.mock('@/renderer/pages/conversation/Preview', () => ({
  usePreviewContext: () => ({ openPreview: vi.fn() }),
}));

function legacyConversation(type: 'gemini' | 'codex' | 'openclaw-gateway' | 'nanobot' | 'remote'): TChatConversation {
  return {
    id: `conv-${type}`,
    user_id: 'user-1',
    name: `${type} history`,
    type,
    model: {},
    extra: { workspace: '/tmp/aionui-history' },
    status: 'finished',
    source: 'aionui',
    created_at: 1,
    modified_at: 1,
    pinned: false,
  } as TChatConversation;
}

describe('ChatConversation legacy runtime rendering', () => {
  beforeEach(() => {
    usePresetAssistantInfoMock.mockReset();
    acpChatMock.mockClear();
    acpModelSelectorMock.mockClear();
    mergeLiveMessageMock.mockClear();
    responseStreamMock.listeners = [];
    responseStreamMock.on.mockClear();
    conversationHistoryMock.mockReset();
    conversationHistoryMock.mockReturnValue(null);
    usePresetAssistantInfoMock.mockReturnValue({ info: undefined, isLoading: false });
  });

  it.each(['gemini', 'codex', 'openclaw-gateway', 'nanobot', 'remote'] as const)(
    'renders %s history without the old runtime chat',
    (type) => {
      render(<ChatConversation conversation={legacyConversation(type)} />);

      expect(screen.getByText('message history')).toBeInTheDocument();
      expect(screen.queryByTestId('legacy-openclaw-chat')).not.toBeInTheDocument();
      expect(screen.queryByTestId('legacy-nanobot-chat')).not.toBeInTheDocument();
      expect(screen.queryByTestId('legacy-remote-chat')).not.toBeInTheDocument();
    }
  );

  it('prefers preset assistant backend over legacy extra backend for ACP conversations', () => {
    usePresetAssistantInfoMock.mockReturnValue({
      info: {
        name: 'Research Assistant',
        logo: '📚',
        isEmoji: true,
        backend: 'codex',
        assistantId: 'assistant-research',
      },
      isLoading: false,
    });

    render(
      <ChatConversation
        conversation={
          {
            id: 'conv-acp',
            user_id: 'user-1',
            name: 'ACP history',
            type: 'acp',
            model: {},
            extra: { workspace: '/tmp/aionui-history', backend: 'claude' },
            status: 'finished',
            source: 'aionui',
            created_at: 1,
            modified_at: 1,
            pinned: false,
          } as TChatConversation
        }
      />
    );

    expect(screen.getByTestId('mock-acp-chat')).toBeInTheDocument();
    expect(acpChatMock).toHaveBeenCalled();
    expect(acpChatMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        backend: 'codex',
        assistantId: 'assistant-research',
      })
    );
  });

  it('passes the resolved assistant backend to the ACP model selector for ACP conversations', () => {
    usePresetAssistantInfoMock.mockReturnValue({
      info: {
        name: 'Research Assistant',
        logo: '📚',
        isEmoji: true,
        backend: 'codex',
        assistantId: 'assistant-research',
      },
      isLoading: false,
    });

    render(
      <ChatConversation
        conversation={
          {
            id: 'conv-acp',
            user_id: 'user-1',
            name: 'ACP history',
            type: 'acp',
            model: {},
            extra: { workspace: '/tmp/aionui-history', backend: 'claude', current_model_id: 'model-1' },
            status: 'finished',
            source: 'aionui',
            created_at: 1,
            modified_at: 1,
            pinned: false,
          } as TChatConversation
        }
      />
    );

    expect(screen.getByTestId('mock-acp-model-selector')).toBeInTheDocument();
    expect(acpModelSelectorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation_id: 'conv-acp',
        backend: 'codex',
        initialModelId: 'model-1',
        waitForWarmup: true,
      })
    );
  });

  it('uses approval-capable ACP for host-managed children while keeping composer and model controls hidden', () => {
    const child = {
      ...legacyConversation('codex'),
      type: 'acp',
      extra: {
        workspace: '/tmp/router-child',
        backend: 'codex',
        router_child: {
          version: 1,
          root_conversation_id: 'parent',
          parent_conversation_id: 'parent',
          parent_turn_id: 'turn',
          task_id: 'task',
        },
        subagent: { parent_conversation_id: 'parent', ref: 'task', status: 'running' },
      },
    } as unknown as TChatConversation;
    render(
      <MemoryRouter>
        <ChatConversation conversation={child} />
      </MemoryRouter>
    );
    expect(acpChatMock).toHaveBeenCalledWith(
      expect.objectContaining({ managedChild: true, hideSendBox: true, conversation_id: child.id })
    );
    expect(screen.queryByTestId('mock-acp-model-selector')).not.toBeInTheDocument();
    expect(screen.queryByText('cron')).not.toBeInTheDocument();
  });

  it('renders persisted subagent history through the read-only surface', () => {
    const child = {
      id: 'subagent:parent:child-thread',
      user_id: 'user-1',
      name: 'reviewer',
      type: 'acp',
      model: {},
      extra: {
        workspace: '/tmp/aionui-history',
        backend: 'codex',
        subagent: {
          parent_conversation_id: 'parent',
          ref: 'child-thread',
          label: 'reviewer',
          status: 'completed',
        },
      },
      status: 'finished',
      source: 'aionui',
      created_at: 1,
      modified_at: 1,
      pinned: false,
    } as TChatConversation;

    render(
      <MemoryRouter>
        <ChatConversation conversation={child} />
      </MemoryRouter>
    );

    expect(screen.getByText('message history')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-acp-chat')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mock-acp-model-selector')).not.toBeInTheDocument();
    expect(screen.queryByText('cron')).not.toBeInTheDocument();
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('merges live output for the selected read-only subagent only', async () => {
    const child = {
      id: 'subagent:parent:child-thread',
      name: 'reviewer',
      type: 'acp',
      model: {},
      extra: {
        subagent: {
          parent_conversation_id: 'parent',
          ref: 'child-thread',
          status: 'running',
        },
      },
      created_at: 1,
      modified_at: 1,
    } as TChatConversation;
    render(
      <MemoryRouter>
        <ChatConversation conversation={child} />
      </MemoryRouter>
    );

    const listener = responseStreamMock.listeners.at(-1);
    expect(listener).toBeDefined();
    listener?.({
      conversation_id: 'another-child',
      msg_id: 'ignored',
      turn_id: 'turn-1',
      type: 'text',
      data: { content: 'ignore me' },
    });
    listener?.({
      conversation_id: child.id,
      msg_id: 'child-message',
      turn_id: 'child-thread',
      type: 'text',
      data: { content: 'live child output' },
    });

    await waitFor(() => expect(mergeLiveMessageMock).toHaveBeenCalledTimes(1));
    expect(mergeLiveMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ msg_id: 'child-message', type: 'text' })
    );
  });

  it('shows a round status indicator for each real child conversation', () => {
    const parent = {
      id: 'parent',
      name: 'Parent task',
      type: 'acp',
      model: {},
      extra: { backend: 'codex' },
      created_at: 1,
      modified_at: 1,
    } as TChatConversation;
    const child = {
      ...parent,
      id: 'subagent:parent:child-thread',
      name: 'reviewer',
      extra: {
        backend: 'codex',
        subagent: {
          parent_conversation_id: 'parent',
          ref: 'child-thread',
          label: 'reviewer',
          status: 'running',
        },
      },
    } as TChatConversation;
    conversationHistoryMock.mockReturnValue({ conversations: [parent, child] });

    render(
      <MemoryRouter>
        <ChatConversation conversation={parent} />
      </MemoryRouter>
    );

    const indicator = screen.getByRole('button', { name: /reviewer/i });
    expect(indicator).toHaveTextContent('RE');
    expect(indicator).toHaveClass(avatarStyles.avatar);
  });
});

describe('subagent avatar capacity and activity', () => {
  let resize: ResizeObserverCallback;
  const children = ['running', 'completed', 'waiting_for_user', 'waiting_for_approval', 'errored'].map((status, i) => ({
    ...legacyConversation('codex'),
    id: `child-${i}`,
    name: `Child ${i}`,
    extra: { subagent: { parent_conversation_id: 'parent', ref: `child-${i}`, status } },
  })) as TChatConversation[];
  const resizeTo = (width: number) =>
    act(() => resize([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver));

  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resize = callback;
        }
        observe() {}
        disconnect() {}
      }
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reserves ellipsis space, lists hidden agents, and refits when resized', async () => {
    render(
      <MemoryRouter>
        <SubagentAvatars conversations={children} />
      </MemoryRouter>
    );
    resizeTo(100);
    expect(screen.getAllByRole('button')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: /Child 2/ })).not.toBeInTheDocument();
    fireEvent.focus(screen.getAllByRole('button')[2]);
    expect(await screen.findByText(/Child 2 ·/)).toBeVisible();
    resizeTo(172);
    expect(screen.getAllByRole('button')).toHaveLength(5);
    expect(screen.getByRole('button', { name: /Child 4/ })).toBeVisible();
    resizeTo(28);
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('animates only active children and clears the ring on a live completion', () => {
    const view = render(
      <MemoryRouter>
        <SubagentAvatars conversations={children} />
      </MemoryRouter>
    );
    resizeTo(172);
    expect(screen.getByRole('button', { name: /Child 0/ })).toHaveClass(avatarStyles.running);
    for (const index of [1, 2, 3, 4]) {
      expect(screen.getByRole('button', { name: new RegExp(`Child ${index}`) })).not.toHaveClass(avatarStyles.running);
    }
    const settled = [
      {
        ...children[0],
        extra: { subagent: { parent_conversation_id: 'parent', ref: 'child-0', status: 'completed' } },
      },
      ...children.slice(1),
    ] as TChatConversation[];
    view.rerender(
      <MemoryRouter>
        <SubagentAvatars conversations={settled} />
      </MemoryRouter>
    );
    expect(screen.getByRole('button', { name: /Child 0/ })).not.toHaveClass(avatarStyles.running);
  });
});
