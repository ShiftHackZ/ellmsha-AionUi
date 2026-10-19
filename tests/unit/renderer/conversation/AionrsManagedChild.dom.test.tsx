import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AionrsChat from '@/renderer/pages/conversation/platforms/aionrs/AionrsChat';
import type { AionrsModelSelection } from '@/renderer/pages/conversation/platforms/aionrs/useAionrsModelSelection';
const passive = vi.hoisted(() => vi.fn());
const confirmations = vi.hoisted(() => vi.fn());
vi.mock('@/renderer/pages/conversation/platforms/aionrs/useAionrsMessage', () => ({ useAionrsMessage: passive }));
vi.mock('@/renderer/pages/conversation/Messages/usePendingConfirmationsRecovery', () => ({
  usePendingConfirmationsRecovery: confirmations,
}));
vi.mock('@/renderer/pages/conversation/platforms/aionrs/AionrsSendBox', () => ({
  default: () => <div data-testid='composer' />,
}));
vi.mock('@/renderer/pages/conversation/Messages/hooks', () => ({
  MessageListLoadingProvider: ({ children }: { children: React.ReactNode }) => children,
  MessageListProvider: ({ children }: { children: React.ReactNode }) => children,
  MessagePaginationProvider: ({ children }: { children: React.ReactNode }) => children,
  useMessageLstCache: vi.fn(),
}));
vi.mock('@/renderer/pages/conversation/Messages/artifacts', () => ({
  ConversationArtifactProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/renderer/pages/conversation/Messages/MessageList', () => ({ default: () => <div>messages</div> }));
vi.mock('@/renderer/components/media/LocalImageView', () => ({
  default: { Provider: ({ children }: { children: React.ReactNode }) => children, useUpdateLocalImage: () => vi.fn() },
}));
const modelSelection = {
  providers: [],
  getAvailableModels: () => [],
  handleSelectModel: async () => {},
  getDisplayModelName: () => '',
} as AionrsModelSelection;

describe('native managed-child chat', () => {
  it('recovers real confirmation controls and subscribes passively without mounting the warmup/composer path', () => {
    render(
      <AionrsChat
        conversation_id='managed-child'
        workspace='/tmp/fixture'
        modelSelection={modelSelection}
        hideSendBox
      />
    );
    expect(screen.getByText('messages')).toBeInTheDocument();
    expect(screen.queryByTestId('composer')).toBeNull();
    expect(confirmations).toHaveBeenCalledWith('managed-child');
    expect(passive).toHaveBeenCalledWith('managed-child', { passive: true });
  });
  it('leaves an ordinary native chat on its existing composer path', () => {
    passive.mockClear();
    render(<AionrsChat conversation_id='ordinary' workspace='/tmp/fixture' modelSelection={modelSelection} />);
    expect(screen.getByTestId('composer')).toBeInTheDocument();
    expect(passive).not.toHaveBeenCalled();
  });
});
