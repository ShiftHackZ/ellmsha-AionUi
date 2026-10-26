import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useGuidModelSelection } from '@/renderer/pages/guid/hooks/useGuidModelSelection';
import { useAionrsModelSelection } from '@/renderer/pages/conversation/platforms/aionrs/useAionrsModelSelection';

const fixture = vi.hoisted(() => ({
  providers: [
    { id: 'other', name: 'Other', platform: 'custom', models: ['other-model'], enabled: true },
    { id: 'ellmsha-copilot-ide', name: 'Copilot IDE', platform: 'custom', models: ['copilot-model'], enabled: true },
  ],
}));
vi.mock('@/renderer/hooks/agent/useGoogleAuthModels', () => ({ useGoogleAuthModels: () => ({ isGoogleAuth: false }) }));
vi.mock('@/renderer/hooks/agent/useModelProviderList', () => ({
  useProvidersQuery: () => ({ data: fixture.providers }),
  useModelProviderList: () => ({
    providers: fixture.providers,
    getAvailableModels: () => [],
    formatModelLabel: () => '',
  }),
}));
vi.mock('@/renderer/pages/guid/utils/modelUtils', () => ({ hasAvailableModels: () => true }));
vi.mock('@/renderer/components/agent/AutoRouter/useRouter', () => ({
  useRouterConversation: () => ({ data: { extra: { agent_id: 'copilot-ide' } } }),
}));

describe('Copilot IDE model scope', () => {
  it('limits the new-chat picker without changing the generic native picker', async () => {
    const { result, rerender } = renderHook(({ providerId }) => useGuidModelSelection('aionrs', providerId), {
      initialProps: { providerId: 'ellmsha-copilot-ide' as string | undefined },
    });
    expect(result.current.modelList.map((provider) => provider.id)).toEqual(['ellmsha-copilot-ide']);
    await waitFor(() => expect(result.current.current_model?.id).toBe('ellmsha-copilot-ide'));
    rerender({ providerId: undefined });
    expect(result.current.modelList).toHaveLength(2);
  });
  it('rejects another provider in an existing Copilot chat before making an update request', async () => {
    const select = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() =>
      useAionrsModelSelection({ initialModel: undefined, conversationId: 'fixture', onSelectModel: select })
    );
    expect(result.current.providers.map((provider) => provider.id)).toEqual(['ellmsha-copilot-ide']);
    await act(() => result.current.handleSelectModel(fixture.providers[0], 'other-model'));
    expect(select).not.toHaveBeenCalled();
    await act(() => result.current.handleSelectModel(fixture.providers[1], 'copilot-model'));
    expect(select).toHaveBeenCalledOnce();
  });
});
