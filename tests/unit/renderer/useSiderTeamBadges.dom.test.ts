import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcBridge } from '@/common';
import type { TTeam } from '@/common/types/team/teamTypes';
import { useTeamPendingPermissions } from '@/renderer/pages/team/hooks/useTeamPendingPermissions';
import { useSiderTeamBadges } from '@/renderer/pages/team/hooks/useSiderTeamBadges';

vi.mock('@/common', () => ({
  ipcBridge: {
    realtime: { reconnected: { on: vi.fn() } },
    conversation: {
      responseStream: { on: vi.fn() },
      confirmation: {
        list: { invoke: vi.fn() },
        add: { on: vi.fn() },
        remove: { on: vi.fn() },
      },
    },
  },
}));

const team = {
  id: 'team-1',
  user_id: 'user-1',
  name: 'Alpha',
  workspace: '/tmp/workspace',
  workspace_mode: 'shared',
  leader_assistant_id: 'slot-1',
  leader_agent_id: 'slot-1',
  session_mode: undefined,
  created_at: 1,
  updated_at: 1,
  assistants: [
    {
      slot_id: 'slot-1',
      conversation_id: 'conv-1',
      role: 'leader',
      assistant_backend: 'claude',
      assistant_name: 'Lead',
      status: 'idle',
      pending_confirmations: 2,
    },
    {
      slot_id: 'slot-2',
      conversation_id: 'conv-2',
      role: 'teammate',
      assistant_backend: 'claude',
      assistant_name: 'Worker',
      status: 'idle',
      pending_confirmations: 1,
    },
  ],
  agents: [],
} as TTeam;

const confirmation = (id: string) => ({ id, call_id: id, description: 'Fixture', options: [] });

describe('useSiderTeamBadges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(ipcBridge.realtime.reconnected.on).mockReturnValue(() => {});
    vi.mocked(ipcBridge.conversation.responseStream.on).mockReturnValue(() => {});
    vi.mocked(ipcBridge.conversation.confirmation.add.on).mockReturnValue(() => {});
    vi.mocked(ipcBridge.conversation.confirmation.remove.on).mockReturnValue(() => {});
    vi.mocked(ipcBridge.conversation.confirmation.list.invoke).mockResolvedValue([]);
  });

  it('uses backend-provided pending counts without listing every conversation confirmation', async () => {
    const { result } = renderHook(() => useSiderTeamBadges([team]));

    expect(result.current.get('team-1')).toBe(3);
    await waitFor(() => {
      expect(ipcBridge.conversation.confirmation.add.on).toHaveBeenCalled();
      expect(ipcBridge.conversation.confirmation.remove.on).toHaveBeenCalled();
    });
    expect(ipcBridge.conversation.confirmation.list.invoke).not.toHaveBeenCalled();
  });

  it('updates the inactive teammate from the live question stream and keeps other pending approvals on duplicate removal', async () => {
    let rows = [confirmation('approval'), confirmation('question')];
    vi.mocked(ipcBridge.conversation.confirmation.list.invoke).mockImplementation(async ({ conversation_id }) =>
      conversation_id === 'conv-2' ? rows : []
    );
    const { result } = renderHook(() => useSiderTeamBadges([team]));
    const stream = vi.mocked(ipcBridge.conversation.responseStream.on).mock.calls.at(-1)![0];
    const remove = vi.mocked(ipcBridge.conversation.confirmation.remove.on).mock.calls.at(-1)![0];
    act(() =>
      stream({
        type: 'acp_permission',
        msg_id: 'q-msg',
        conversation_id: 'conv-2',
        data: { tool_call: { tool_call_id: 'question', questions: [{ id: 'q' }] } },
      })
    );
    await waitFor(() => expect(result.current.get('team-1')).toBe(4));
    rows = [confirmation('approval')];
    act(() => {
      remove({ conversation_id: 'conv-2', id: 'question' });
      remove({ conversation_id: 'conv-2', id: 'question' });
    });
    await waitFor(() => expect(result.current.get('team-1')).toBe(3));
    expect(
      vi
        .mocked(ipcBridge.conversation.confirmation.list.invoke)
        .mock.calls.every(([request]) => request.conversation_id === 'conv-2')
    ).toBe(true);
  });

  it('discards a stale tab snapshot when the answer arrives while the initial list is loading', async () => {
    let resolveInitial!: (rows: ReturnType<typeof confirmation>[]) => void;
    vi.mocked(ipcBridge.conversation.confirmation.list.invoke)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInitial = resolve;
          })
      )
      .mockResolvedValueOnce([confirmation('approval')]);
    const { result } = renderHook(() => useTeamPendingPermissions('team-1', ['conv-2']));
    const remove = vi.mocked(ipcBridge.conversation.confirmation.remove.on).mock.calls.at(-1)![0];
    act(() => remove({ conversation_id: 'conv-2', id: 'answered' }));
    await waitFor(() => expect(result.current.pendingCounts['conv-2']).toBe(1));
    await act(async () => {
      resolveInitial([confirmation('approval'), confirmation('answered')]);
    });
    expect(result.current.pendingCounts['conv-2']).toBe(1);
  });
});
