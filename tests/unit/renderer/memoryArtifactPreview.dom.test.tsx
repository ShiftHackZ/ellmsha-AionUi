import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMemoryArtifactPreview } from '@/renderer/pages/conversation/Preview/hooks/useMemoryArtifactPreview';
const mocks = vi.hoisted(() => ({ read: vi.fn(), open: vi.fn(), error: vi.fn() }));
vi.mock('@/common', () => ({ ipcBridge: { conversation: { readMemoryArtifact: { invoke: mocks.read } } } }));
vi.mock('@/renderer/pages/conversation/Preview/context/PreviewContext', () => ({
  usePreviewContext: () => ({ openPreview: mocks.open }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@arco-design/web-react', () => ({ Message: { error: mocks.error } }));
beforeEach(() => vi.resetAllMocks());
describe('conversation-bound artifact preview', () => {
  it('opens fetched markdown read-only without a fabricated filesystem path', async () => {
    mocks.read.mockResolvedValue({ path: 'bmad/fixture/spec.md', title: 'Fixture spec', content: '# Spec' });
    const { result } = renderHook(() => useMemoryArtifactPreview('chat-1'));
    await act(async () => {
      await result.current('bmad/fixture/spec.md');
    });
    expect(mocks.read).toHaveBeenCalledWith({ conversation_id: 'chat-1', path: 'bmad/fixture/spec.md' });
    expect(mocks.open).toHaveBeenCalledWith(
      '# Spec',
      'markdown',
      {
        title: 'Fixture spec',
        editable: false,
        memoryArtifact: { conversationId: 'chat-1', path: 'bmad/fixture/spec.md' },
      },
      { replace: true }
    );
  });
  it('does not open a stale result after switching conversation and never falls back to filesystem on failure', async () => {
    let complete!: (value: unknown) => void;
    mocks.read.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      })
    );
    const { result, rerender } = renderHook(({ id }) => useMemoryArtifactPreview(id), {
      initialProps: { id: 'chat-1' },
    });
    const pending = result.current('bmad/fixture/spec.md');
    rerender({ id: 'chat-2' });
    await act(async () => {
      complete({ path: 'bmad/fixture/spec.md', title: 'Spec', content: '# Old' });
      await pending;
    });
    expect(mocks.open).not.toHaveBeenCalled();
    mocks.read.mockRejectedValueOnce(new Error('denied'));
    await act(async () => {
      await result.current('bmad/other/spec.md');
    });
    expect(mocks.error).toHaveBeenCalledOnce();
    expect(mocks.open).not.toHaveBeenCalled();
  });
});
