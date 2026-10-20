import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Usage from '@/renderer/components/Usage';
const { snapshot } = vi.hoisted(() => ({
  snapshot: { data: undefined as unknown, error: undefined as unknown, keys: [] as string[] },
}));
vi.mock('swr', () => ({
  default: (key: string) => {
    snapshot.keys.push(key);
    return { ...snapshot, isLoading: false, isValidating: false, mutate: vi.fn() };
  },
}));
vi.mock('@/common/adapter/httpBridge', () => ({ httpRequest: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));

describe('Usage data states', () => {
  beforeEach(() => {
    snapshot.data = undefined;
    snapshot.error = undefined;
    snapshot.keys = [];
  });
  it('shows missing history as unavailable rather than measured zero spend', () => {
    render(<Usage conversationId='chat-one' />);
    expect(screen.getByText('settings.usage.empty')).toBeInTheDocument();
    expect(screen.getAllByText('—')).toHaveLength(6);
    expect(screen.getByText('settings.usage.chatCoverage')).toBeInTheDocument();
  });
  it('requests exact chat lifetime and omits global filters and breakdown', () => {
    render(<Usage conversationId='chat-one' />);
    expect(snapshot.keys.every((key) => key === '/api/usage?conversation_id=chat-one')).toBe(true);
    expect(screen.queryByLabelText('settings.usage.period')).not.toBeInTheDocument();
    expect(screen.queryByText('settings.usage.breakdown')).not.toBeInTheDocument();
  });
  it('keeps period and provider filtering on the global settings view', () => {
    render(<Usage />);
    expect(snapshot.keys[0]).toBe('/api/usage?days=30');
    expect(screen.getByLabelText('settings.usage.period')).toBeInTheDocument();
    expect(screen.getByLabelText('settings.usage.providers')).toBeInTheDocument();
  });
  it('shows a recoverable error instead of a misleading empty history', () => {
    snapshot.error = new Error('offline');
    render(<Usage />);
    expect(screen.getByText('settings.usage.error')).toBeInTheDocument();
    expect(screen.queryByText('settings.usage.empty')).not.toBeInTheDocument();
  });
  it('renders reported input and output separately from the estimated context', () => {
    snapshot.data = {
      totals: {},
      series: [
        {
          period: '2026-10-19',
          provider: 'local',
          model: 'qwen',
          input_tokens: 100,
          output_tokens: 20,
          cache_read_tokens: 40,
          cache_creation_tokens: 0,
          requests: 1,
        },
      ],
      contexts: [
        {
          conversation_id: 'chat-one',
          conversation_name: 'Chat',
          context_tokens: 120,
          context_window: 8192,
          created_at: 1,
          breakdown: { tools: 30, messages: 90 },
        },
      ],
    };
    render(<Usage conversationId='chat-one' />);
    expect(screen.getAllByRole('img', { name: 'settings.usage.tokens: 120' })).toHaveLength(1);
    expect(screen.getByText('settings.usage.latestContext')).toBeInTheDocument();
  });
  it('never substitutes another chat context when this chat has no measurement', () => {
    snapshot.data = {
      series: [],
      contexts: [
        {
          conversation_id: 'other',
          conversation_name: 'Other',
          context_tokens: 999999,
          breakdown: { unattributed: 999999 },
        },
      ],
    };
    render(<Usage conversationId='chat-one' />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('settings.usage.empty')).toBeInTheDocument();
  });
  it('keeps ACP context visible without inventing input/output billing', () => {
    snapshot.data = {
      totals: {},
      series: [],
      contexts: [
        {
          conversation_id: 'chat-acp',
          conversation_name: 'ACP chat',
          provider: 'agent-acp',
          provider_name: 'ACP Agent',
          model: 'worker',
          context_tokens: 4096,
          context_window: 0,
          created_at: 1,
          breakdown: { unattributed: 4096 },
        },
      ],
    };
    render(<Usage conversationId='chat-acp' />);
    expect(screen.getByRole('img', { name: 'settings.usage.tokens: 4,096' })).toBeInTheDocument();
    expect(screen.queryByText('settings.usage.flow')).not.toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(4);
  });
});
