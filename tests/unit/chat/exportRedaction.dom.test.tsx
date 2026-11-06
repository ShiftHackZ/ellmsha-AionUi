import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  reconnect: new Set<() => void>(),
  listeners: new Set<(v: { conversation_ids: string[] }) => void>(),
  load: vi.fn(),
  copy: vi.fn(),
  write: vi.fn(),
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
    conversation: {
      historyChanged: {
        on: (fn: (v: { conversation_ids: string[] }) => void) => {
          fixture.listeners.add(fn);
          return () => fixture.listeners.delete(fn);
        },
      },
    },
    fs: { writeFile: { invoke: fixture.write } },
  },
}));
vi.mock('@/renderer/pages/conversation/utils/conversationCache', () => ({
  getConversationOrNull: async () => ({ id: 'chat', name: 'Synthetic', type: 'acp' }),
}));
vi.mock('@/renderer/utils/chat/messagePagination', () => ({ loadAllConversationMessagesPaged: fixture.load }));
vi.mock('@/renderer/utils/ui/clipboard', () => ({ copyText: fixture.copy }));
import { useConversationExport } from '@/renderer/hooks/file/useConversationExport';
describe('canonical export after redaction', () => {
  it.each(['mask', 'reconnect'])(
    'closes stale open exports and rejects old in-flight response after %s',
    async (event) => {
      fixture.load.mockReset();
      fixture.copy.mockReset();
      fixture.load.mockResolvedValue([
        { id: 'm', type: 'text', position: 'right', content: { content: 'SYNTHETIC_OLD' }, createdAt: 1 },
      ]);
      const { result } = renderHook(() =>
        useConversationExport({ conversation_id: 'chat', workspace: '/synthetic', t: (key) => key, messageApi: {} })
      );
      await act(async () => result.current.openExportFlow());
      expect(result.current.isOpen).toBe(true);
      let finish!: (v: unknown) => void;
      fixture.load.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      );
      act(() => result.current.onSelectMenuItem('copy'));
      await waitFor(() => expect(fixture.load).toHaveBeenCalledTimes(2));
      act(() => {
        if (event === 'mask') for (const listener of fixture.listeners) listener({ conversation_ids: ['chat'] });
        else for (const listener of fixture.reconnect) listener();
      });
      await act(async () =>
        finish([{ id: 'm', type: 'text', position: 'right', content: { content: 'SYNTHETIC_OLD' } }])
      );
      expect(fixture.copy).not.toHaveBeenCalled();
      expect(result.current.isOpen).toBe(false);
      fixture.load.mockResolvedValue([
        { id: 'm', type: 'text', position: 'right', content: { content: '<masked>' }, createdAt: 1 },
      ]);
      await act(async () => result.current.openExportFlow());
      act(() => result.current.onSelectMenuItem('copy'));
      await waitFor(() => expect(fixture.copy).toHaveBeenCalledOnce());
      expect(fixture.copy.mock.calls[0][0]).not.toContain('SYNTHETIC_OLD');
    }
  );
});
