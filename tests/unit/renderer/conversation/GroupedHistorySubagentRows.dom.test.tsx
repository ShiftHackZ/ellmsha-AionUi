/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TChatConversation } from '@/common/config/storage';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

const conversations = vi.hoisted(() => {
  const root = (id: string): TChatConversation =>
    ({ id, name: id, type: 'acp', created_at: 1, modified_at: 1, extra: {} }) as TChatConversation;
  const child = (id: string, status: string): TChatConversation =>
    ({
      id,
      name: id,
      type: 'acp',
      created_at: 2,
      modified_at: 2,
      extra: { subagent: { parent_conversation_id: 'parent', ref: id, label: id, status } },
    }) as TChatConversation;
  return {
    parent: root('parent'),
    sibling: root('sibling'),
    running: child('running-child', 'running'),
    errored: child('errored-child', 'errored'),
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      ({
        'conversation.history.subagentStatus.running': 'Running',
        'conversation.history.subagentStatus.errored': 'Failed',
        'conversation.history.subagentStatus.waiting_for_user': 'Waiting for input',
        'conversation.history.subagentStatus.completed': 'Completed',
      })[key] ??
      options?.defaultValue ??
      key,
  }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ id: conversations.running.id }),
}));

vi.mock('@/renderer/components/base/AionModal', () => ({ default: () => null }));
vi.mock('@/renderer/hooks/context/LayoutContext', () => ({ useLayoutContext: () => ({ isMobile: false }) }));
vi.mock('@/renderer/pages/cron', () => ({
  useCronJobsMap: () => ({ getJobStatus: () => 'none', markAsRead: vi.fn(), setActiveConversation: vi.fn() }),
}));
vi.mock('@/renderer/pages/conversation/GroupedHistory/ConversationRow', () => ({
  default: ({ conversation, isGenerating }: { conversation: TChatConversation; isGenerating: boolean }) => (
    <div className='conversation-item' data-testid={`root-${conversation.id}`} data-generating={String(isGenerating)} />
  ),
}));
vi.mock('@/renderer/pages/conversation/GroupedHistory/SortableConversationRow', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/components/WorkspaceCollapse', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/GroupedHistory/hooks/useBatchSelection', () => ({
  useBatchSelection: () => ({
    selectedConversationIds: new Set(),
    setSelectedConversationIds: vi.fn(),
    selectedCount: 0,
    allSelected: false,
    toggleSelectedConversation: vi.fn(),
    handleToggleSelectAll: vi.fn(),
  }),
}));
vi.mock('@/renderer/pages/conversation/GroupedHistory/hooks/useConversationActions', () => ({
  useConversationActions: () => ({
    renameModalVisible: false,
    renameModalName: '',
    setRenameModalName: vi.fn(),
    renameLoading: false,
    dropdownVisibleId: null,
    handleConversationClick: vi.fn(),
    handleDeleteClick: vi.fn(),
    handleBatchDelete: vi.fn(),
    handleEditStart: vi.fn(),
    handleRenameConfirm: vi.fn(),
    handleRenameCancel: vi.fn(),
    handleTogglePin: vi.fn(),
    handleMenuVisibleChange: vi.fn(),
    handleOpenMenu: vi.fn(),
    handleCreateCronTask: vi.fn(),
    handleRemoveProject: vi.fn(),
    removeProjectTarget: null,
    removeProjectLoading: false,
    handleRemoveProjectCancel: vi.fn(),
    handleRemoveProjectConfirm: vi.fn(),
  }),
}));
vi.mock('@/renderer/pages/conversation/GroupedHistory/hooks/useDragAndDrop', () => ({
  useDragAndDrop: () => ({ sensors: [], handleDragEnd: vi.fn(), isDragEnabled: false }),
}));
vi.mock('@/renderer/pages/conversation/GroupedHistory/hooks/useConversations', () => ({
  useConversations: () => ({
    conversations: [conversations.parent, conversations.sibling, conversations.running, conversations.errored],
    isConversationGenerating: () => false,
    hasCompletionUnread: () => false,
    expandedWorkspaces: [],
    pinnedConversations: [],
    timelineSections: [
      {
        timeline: 'Today',
        items: [
          { type: 'conversation', time: 2, conversation: conversations.parent },
          { type: 'conversation', time: 1, conversation: conversations.sibling },
        ],
      },
    ],
    handleToggleWorkspace: vi.fn(),
    collapsedSections: new Set(),
    toggleSection: vi.fn(),
  }),
}));

import WorkspaceGroupedHistory from '@/renderer/pages/conversation/GroupedHistory';

describe('grouped history subagent indicators', () => {
  it('clears the child loader while waiting and after completion without moving its indicator slot', () => {
    const metadata = (conversations.running.extra as { subagent: { status: string } }).subagent;
    const view = render(<WorkspaceGroupedHistory />);
    const slot = screen.getByRole('button', { name: 'running-child · Running' }).firstElementChild;
    try {
      metadata.status = 'waiting_for_user';
      view.rerender(<WorkspaceGroupedHistory />);
      expect(screen.getByRole('button', { name: 'running-child · Waiting for input' }).firstElementChild).toBe(slot);
      expect(slot?.querySelector('.arco-spin')).toBeNull();
      metadata.status = 'completed';
      view.rerender(<WorkspaceGroupedHistory />);
      expect(screen.getByRole('button', { name: 'running-child · Completed' }).querySelector('.arco-spin')).toBeNull();
    } finally {
      metadata.status = 'running';
    }
  });

  it('keeps roots idle independently and reserves identical gutters for mixed child states', async () => {
    render(<WorkspaceGroupedHistory />);

    const running = await screen.findByRole('button', { name: 'running-child · Running' });
    const errored = screen.getByRole('button', { name: 'errored-child · Failed' });
    expect(screen.getByTestId('root-parent')).toHaveAttribute('data-generating', 'false');

    const runningSlot = running.firstElementChild;
    const erroredSlot = errored.firstElementChild;
    expect(runningSlot).toHaveClass('w-16px', 'h-16px', 'shrink-0');
    expect(erroredSlot).toHaveClass('w-16px', 'h-16px', 'shrink-0');
    expect(runningSlot?.querySelector('.arco-spin')).not.toBeNull();
    expect(erroredSlot?.querySelector('.rounded-full')).not.toBeNull();

    await waitFor(() => {
      expect(screen.getByTestId('root-parent').parentElement).toHaveClass('[&_.conversation-item]:!pl-30px');
      expect(screen.getByTestId('root-sibling').parentElement).toHaveClass('[&_.conversation-item]:!pl-30px');
    });
  });
});
