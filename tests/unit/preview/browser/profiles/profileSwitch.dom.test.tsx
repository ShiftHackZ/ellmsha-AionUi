import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewProvider, usePreviewContext } from '@/renderer/pages/conversation/Preview/context/PreviewContext';
import {
  resetCurrentConversationForTest,
  setCurrentConversation,
} from '@/renderer/pages/conversation/explorer/currentConversationStore';
const mocks = vi.hoisted(() => ({
  bind: vi.fn(),
  inventory: vi.fn().mockResolvedValue({ success: true }),
  generation: 0,
}));
vi.mock('@/renderer/utils/platform', () => ({ isElectronDesktop: () => true }));
vi.mock('@/common', () => ({
  ipcBridge: {
    application: {
      browserProfileCleared: { on: () => () => {} },
      bindBrowserProfile: { invoke: mocks.bind },
      reportBrowserTabInventory: { invoke: mocks.inventory },
      browserTabCommand: { on: () => () => {} },
      reportBrowserTabCommandFailure: { invoke: vi.fn().mockResolvedValue({ success: true }) },
    },
    conversation: { listChanged: { on: () => () => {} }, responseStream: { on: () => () => {} } },
    fileStream: { contentUpdate: { on: () => () => {} } },
    preview: { open: { on: () => () => {} } },
    fs: { getFileMetadata: { invoke: vi.fn() } },
  },
}));
vi.mock('@/renderer/utils/emitter', () => ({ emitter: { on: vi.fn(), off: vi.fn() } }));
vi.mock('@/renderer/pages/conversation/Preview/browser/firstUseNotice', () => ({
  maybeNotifyFirstAgentBrowserUse: vi.fn(),
}));
beforeEach(() => {
  localStorage.clear();
  resetCurrentConversationForTest();
  mocks.generation = 0;
  mocks.inventory.mockClear();
  mocks.bind.mockReset().mockImplementation(async ({ conversationId }: { conversationId: string | null }) => {
    if (!conversationId) return { success: true };
    const profileId = conversationId.startsWith('ordinary')
      ? 'default-profile'
      : conversationId.startsWith('a')
        ? 'project-a'
        : 'project-b';
    return {
      success: true,
      data: {
        profileId,
        conversationId,
        label: profileId,
        token: `token-${conversationId}`,
        generation: ++mocks.generation,
      },
    };
  });
});
const wrapper = ({ children }: { children: React.ReactNode }) => <PreviewProvider>{children}</PreviewProvider>;

describe('desktop browser profile restoration', () => {
  it('keeps same-project tabs, isolates other projects, and shares Default across unrelated workspaces', async () => {
    setCurrentConversation('a1');
    const { result } = renderHook(() => usePreviewContext(), { wrapper });
    await waitFor(() => expect(result.current.browserProfile?.profileId).toBe('project-a'));
    act(() => result.current.openBrowserTab('https://fixture.test/a'));
    const original = result.current.tabs.find((tab) => tab.content_type === 'browser')!.id;
    act(() => setCurrentConversation('a2'));
    await waitFor(() => expect(result.current.browserProfile?.conversationId).toBe('a2'));
    expect(result.current.tabs.find((tab) => tab.content_type === 'browser')?.id).toBe(original);
    act(() => setCurrentConversation('b1'));
    await waitFor(() => expect(result.current.browserProfile?.profileId).toBe('project-b'));
    expect(result.current.tabs.filter((tab) => tab.content_type === 'browser')).toEqual([]);
    act(() => setCurrentConversation('ordinary-one'));
    await waitFor(() => expect(result.current.browserProfile?.profileId).toBe('default-profile'));
    act(() => {
      result.current.closePreviewIfScopeChanged('/temporary/workspace-one');
      result.current.openBrowserTab('https://fixture.test/default');
    });
    const ordinary = result.current.tabs.find((tab) => tab.content_type === 'browser')!.id;
    act(() => setCurrentConversation('ordinary-two'));
    await waitFor(() => expect(result.current.browserProfile?.conversationId).toBe('ordinary-two'));
    act(() => result.current.closePreviewIfScopeChanged('/temporary/workspace-two'));
    expect(result.current.tabs.find((tab) => tab.content_type === 'browser')?.id).toBe(ordinary);
  });
  it('does not restore legacy shared browser URLs into a newly authenticated project', async () => {
    localStorage.setItem('aionui_preview:last_scope', 'old-workspace');
    localStorage.setItem(
      'aionui_preview:old-workspace',
      JSON.stringify({
        isOpen: true,
        activeTabId: 'legacy',
        tabs: [{ id: 'legacy', content_type: 'browser', content: 'https://legacy-private.test', title: 'Legacy' }],
      })
    );
    setCurrentConversation('a1');
    const { result } = renderHook(() => usePreviewContext(), { wrapper });
    await waitFor(() => expect(result.current.browserProfile?.profileId).toBe('project-a'));
    expect(result.current.tabs.some((tab) => tab.id === 'legacy')).toBe(false);
    expect(localStorage.getItem('aionui_preview:old-workspace')).toContain('legacy-private.test');
  });
  it('keeps browser creation unresolved when Core cannot establish ownership', async () => {
    mocks.bind.mockResolvedValue({ success: false, msg: 'Unresolved project' });
    setCurrentConversation('a1');
    const { result } = renderHook(() => usePreviewContext(), { wrapper });
    await waitFor(() => expect(mocks.bind).toHaveBeenCalledWith({ conversationId: 'a1' }));
    expect(result.current.browserProfile).toBeUndefined();
    expect(mocks.inventory.mock.calls.every(([value]) => value.ready === false)).toBe(true);
  });
});
