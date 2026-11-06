import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  search: vi.fn(),
  listeners: new Set<() => void>(),
  reconnect: new Set<() => void>(),
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    realtime: {
      reconnected: {
        on: (fn: () => void) => {
          fixture.reconnect.add(fn);
          return () => fixture.reconnect.delete(fn);
        },
      },
    },
    database: { searchConversationMessages: { invoke: fixture.search } },
    conversation: {
      historyChanged: {
        on: (fn: () => void) => {
          fixture.listeners.add(fn);
          return () => fixture.listeners.delete(fn);
        },
      },
    },
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/renderer/hooks/agent/usePresetAssistantInfo', () => ({ usePresetAssistantInfo: () => ({ info: null }) }));
vi.mock('@/renderer/utils/model/agentLogo', () => ({ useAgentLogos: () => ({}) }));
vi.mock('@/renderer/pages/conversation/utils/conversationAssistantIdentity', () => ({
  resolveConversationLeadingMark: () => ({ kind: 'emoji', label: 'fixture', value: 'A' }),
}));
vi.mock('@/renderer/components/base/AionModal', () => ({
  default: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
    visible ? <div>{children}</div> : null,
}));
import ConversationSearchPopover from '@/renderer/pages/conversation/GroupedHistory/ConversationSearchPopover';
afterEach(() => {
  cleanup();
  fixture.listeners.clear();
  fixture.reconnect.clear();
  fixture.search.mockReset();
  localStorage.clear();
});
const result = (text: string) => ({
  items: [
    {
      conversation: { id: 'chat', name: 'Fixture', type: 'acp' },
      message_id: 'row',
      message_type: 'text',
      message_created_at: 1,
      preview_text: text,
    },
  ],
  page: 0,
  total: 1,
  page_size: 20,
  has_more: false,
});
it.each(['mask', 'reconnect'])('invalidates a visible snippet and in-flight response after %s', async (event) => {
  const listeners = event === 'mask' ? fixture.listeners : fixture.reconnect;
  const resolvers: Array<(value: unknown) => void> = [];
  fixture.search.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
  render(<ConversationSearchPopover renderTrigger={({ onClick }) => <button onClick={onClick}>Open search</button>} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open search' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'password' } });
  await waitFor(() => expect(resolvers).toHaveLength(1));
  await act(async () => resolvers[0](result('password=SYNTHETIC_OLD')));
  expect(screen.getByText(/SYNTHETIC_OLD/)).toBeVisible();
  act(() => {
    for (const changed of listeners) changed();
  });
  expect(screen.queryByText(/SYNTHETIC_OLD/)).toBeNull();
  await waitFor(() => expect(resolvers).toHaveLength(2));
  act(() => {
    for (const changed of listeners) changed();
  });
  await waitFor(() => expect(resolvers).toHaveLength(3));
  await act(async () => resolvers[1](result('password=SYNTHETIC_STALE')));
  expect(screen.queryByText(/SYNTHETIC_STALE/)).toBeNull();
  await act(async () => resolvers[2](result('password=<masked>')));
  expect(screen.getByText(/<masked>/)).toBeVisible();
});
