import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SWRConfig } from 'swr';
import type { IMessageText } from '@/common/chat/chatLib';
import { RouterReview } from '@/renderer/components/agent/AutoRouter/RouterDecisionBadge';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  runtime: vi.fn(),
  subscribe: vi.fn(),
  hydrate: vi.fn(),
  conversation: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@/common/adapter/httpBridge', () => ({ httpRequest: mocks.request }));
vi.mock('@/common/utils', () => ({ parseError: (error: Error) => error.message }));
vi.mock('@/renderer/components/agent/AutoRouter/useRouter', () => ({
  useRouterConversation: mocks.conversation,
  useRouterOptions: () => ({ options: [] }),
}));
vi.mock('@/renderer/pages/conversation/runtime/useConversationRuntimeView', () => ({
  useConversationRuntimeView: mocks.hydrate,
}));
vi.mock('@/renderer/pages/conversation/runtime/conversationRuntimeViewStore', () => ({
  getConversationRuntimeViewSnapshot: mocks.runtime,
  subscribeConversationRuntimeView: mocks.subscribe,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@arco-design/web-react', () => ({
  Button: ({
    children,
    loading,
    disabled,
    onClick,
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) => (
    <button disabled={disabled || loading} onClick={onClick}>
      {children}
    </button>
  ),
  Message: { error: mocks.error, success: vi.fn() },
}));

const live: IMessageText = {
  id: 'renderer-uuid',
  msg_id: 'server-message',
  conversation_id: 'owned-chat',
  type: 'text',
  position: 'left',
  content: { content: 'The result' },
};
const persisted: IMessageText = { ...live, id: 'server-message', status: 'finish' };
const idle = { hydrated: true, isProcessing: false, activeTurnId: null };
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>{children}</SWRConfig>
);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.conversation.mockReturnValue({ data: { extra: { routing: { config: {}, decision: { target: {} } } } } });
  mocks.runtime.mockReturnValue(idle);
  mocks.subscribe.mockReturnValue(() => {});
  mocks.request.mockResolvedValue(persisted);
});
afterEach(cleanup);

describe('completed router answer review', () => {
  it.each([
    { extra: {} },
    { extra: { routing: { config: {}, decision: { target: {} } }, subagent: { parentConversationId: 'parent' } } },
  ])('does not observe or hydrate runtime for ordinary chats or child transcripts (%j)', (conversation) => {
    mocks.conversation.mockReturnValue({ data: conversation });
    render(<RouterReview message={live} />, { wrapper });
    expect(screen.queryByTestId('router-review')).not.toBeInTheDocument();
    expect(mocks.runtime).not.toHaveBeenCalled();
    expect(mocks.subscribe).not.toHaveBeenCalled();
    expect(mocks.hydrate).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('only observes existing runtime state for routed historical answers', async () => {
    render(<RouterReview message={persisted} />, { wrapper });
    await screen.findByTestId('router-review');
    expect(mocks.runtime).toHaveBeenCalledWith('owned-chat');
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
    expect(mocks.hydrate).not.toHaveBeenCalled();
  });
  it('reviews a streamed answer immediately after completion using its persisted server ID', async () => {
    mocks.runtime.mockReturnValue({ ...idle, isProcessing: true, activeTurnId: 'turn' });
    const view = render(<RouterReview message={live} />, { wrapper });
    expect(mocks.request).not.toHaveBeenCalled();
    mocks.runtime.mockReturnValue(idle);
    view.rerender(<RouterReview message={live} />);
    fireEvent.click(await screen.findByRole('button', { name: 'settings.autoRouter.accept' }));
    expect(mocks.request).toHaveBeenCalledWith('GET', '/api/conversations/owned-chat/messages/server-message');
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith('POST', '/api/conversations/owned-chat/routing/outcome', {
        accepted: true,
        message_id: 'server-message',
      })
    );
  });
  it.each([
    { ...persisted, status: 'pending' },
    { ...persisted, hidden: true },
    { ...persisted, position: 'right' },
    { ...persisted, conversation_id: 'other-chat' },
  ])('does not offer review for an ineligible persisted answer (%j)', async (message) => {
    mocks.request.mockResolvedValue(message);
    render(<RouterReview message={live} />, { wrapper });
    await waitFor(() => expect(mocks.request).toHaveBeenCalled());
    expect(screen.queryByTestId('router-review')).not.toBeInTheDocument();
  });
  it('waits for authoritative idle hydration and hides cached review while another turn is running', async () => {
    mocks.runtime.mockReturnValue({ ...idle, hydrated: false });
    const view = render(<RouterReview message={live} />, { wrapper });
    expect(mocks.request).not.toHaveBeenCalled();
    mocks.runtime.mockReturnValue(idle);
    view.rerender(<RouterReview message={live} />);
    await screen.findByTestId('router-review');
    mocks.runtime.mockReturnValue({ ...idle, isProcessing: true, activeTurnId: 'new-turn' });
    view.rerender(<RouterReview message={live} />);
    expect(screen.queryByTestId('router-review')).not.toBeInTheDocument();
  });
  it('keeps review retryable when the server rejects an outcome', async () => {
    mocks.request.mockImplementation((method: string) =>
      method === 'GET' ? Promise.resolve(persisted) : Promise.reject(new Error('Rejected'))
    );
    render(<RouterReview message={live} />, { wrapper });
    const button = await screen.findByRole('button', { name: 'settings.autoRouter.reject' });
    fireEvent.click(button);
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('Rejected'));
    expect(button).not.toBeDisabled();
  });
});
