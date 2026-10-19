import React from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { SWRConfig } from 'swr';
import type { RouterConfig, RouterSnapshot } from '@/common/types/agent/routerTypes';
import { DEFAULT_ROUTER_CONFIG } from '@/common/types/agent/routerTypes';
import { useRouterOptions } from '@/renderer/components/agent/AutoRouter/useRouter';
import { RouterDecisionBadge } from '@/renderer/components/agent/AutoRouter/RouterDecisionBadge';

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/common/adapter/httpBridge', () => ({ httpRequest: mocks.request }));
vi.mock('@/renderer/hooks/agent/useModelProviderList', () => ({ useProvidersQuery: () => ({ data: [] }) }));
vi.mock('@/renderer/services/clientBusinessSettings', () => ({
  getClientBusinessSetting: vi.fn(),
  setClientBusinessSetting: vi.fn(),
}));
vi.mock('@/renderer/pages/conversation/utils/conversationCache', () => ({ getConversationOrNull: vi.fn() }));
vi.mock('react-i18next', async () => {
  const settings = (await import('@/renderer/services/i18n/locales/en-US/settings.json')).default;
  return {
    useTranslation: () => ({
      t: (key: string, values: Record<string, unknown> = {}) => {
        let value: unknown = { settings };
        for (const part of key.split('.'))
          value = value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined;
        return String(value ?? values.defaultValue ?? key).replace(/{{(\w+)}}/g, (_, name: string) =>
          String(values[name] ?? name)
        );
      },
    }),
  };
});
const target = { kind: 'provider', provider_id: 'local', model: 'small' } as const;
const config: RouterConfig = {
  ...DEFAULT_ROUTER_CONFIG,
  classifier_target: target,
  classes: [{ id: 'review', name: 'Review', description: 'Review changes', target }],
  hints: [{ target, strengths: [], local_inference: false }],
};
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>{children}</SWRConfig>
);
beforeEach(() => {
  mocks.request.mockReset();
  mocks.request.mockResolvedValue({ entries: [] });
});

it('keeps the catalog stable while editing class prose and ranking metadata, but refreshes role capabilities and target references', async () => {
  const { rerender } = renderHook(({ policy }) => useRouterOptions(policy), {
    wrapper,
    initialProps: { policy: config },
  });
  await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
  let edited: RouterConfig = {
    ...config,
    profile: 'quality',
    classes: [{ ...config.classes![0], name: 'Revised', description: 'A longer task explanation' }],
    hints: [{ ...config.hints[0], expected_latency_ms: 50, quality_tier: 5 }],
  };
  await act(async () => rerender({ policy: edited }));
  expect(mocks.request).toHaveBeenCalledTimes(1);
  edited = { ...edited, hints: [{ ...edited.hints[0], local_inference: true }] };
  await act(async () => rerender({ policy: edited }));
  await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2));
  edited = { ...edited, classes: [{ ...edited.classes![0], target: { ...target, model: 'other' } }] };
  await act(async () => rerender({ policy: edited }));
  await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(3));
  const request = mocks.request.mock.calls[2][2].config as RouterConfig;
  expect(request.classes![0].target.model).toBe('other');
  expect(JSON.stringify(request)).not.toContain('A longer task explanation');
});

it('explains V2 routing outcomes and resolves custom classes to their saved names rather than technical reason codes', async () => {
  const reasons = [
    'default_child_no_custom_classes',
    'root_policy_custom_classes_not_applied',
    'classification_no_match_default',
    'classification_failed_default',
    'classifier_unavailable_default',
    'custom_class:review',
  ];
  const snapshot: RouterSnapshot = {
    config,
    decision: {
      id: 'route',
      target,
      requirements: { task: 'general', complex: false, vision: false, minimum_context_tokens: 0 },
      reasons,
      evidence_count: 0,
      elapsed_ms: 1,
      managed_children: true,
      scope_workspace: '',
    },
  };
  render(<RouterDecisionBadge snapshot={snapshot} />, { wrapper });
  fireEvent.click(screen.getByTestId('router-decision-badge'));
  await screen.findByText('Matched task class: Review');
  expect(screen.getByText('Classifier unavailable; default subagent policy applied')).toBeInTheDocument();
  expect(screen.getByText('Root policy applied; custom classes only route subagents')).toBeInTheDocument();
  for (const reason of reasons) expect(screen.queryByText(reason)).not.toBeInTheDocument();
});
