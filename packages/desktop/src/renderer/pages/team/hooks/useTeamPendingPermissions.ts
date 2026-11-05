import { useCallback, useEffect, useMemo } from 'react';
import { usePendingConfirmationCounts } from './usePendingConfirmationCounts';

export function useTeamPendingPermissions(team_id: string, conversation_ids: string[]) {
  const storageKey = `team-pending-permissions-${team_id}`;
  const cached = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem(storageKey) || '{}') as Record<string, number>;
    } catch {
      return {};
    }
  }, [storageKey]);
  const live = usePendingConfirmationCounts(
    Object.fromEntries(conversation_ids.map((id): [string, null] => [id, null]))
  );
  const pendingCounts = Object.fromEntries(conversation_ids.map((id) => [id, live[id] ?? cached?.[id] ?? 0]));
  const serialized = JSON.stringify(pendingCounts);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, serialized);
    } catch {
      /* Storage is optional. */
    }
  }, [storageKey, serialized]);
  const clearStorage = useCallback(() => {
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* Storage is optional. */
    }
  }, [storageKey]);
  return {
    pendingCounts,
    totalPending: Object.values(pendingCounts).reduce((sum, count) => sum + count, 0),
    clearStorage,
  };
}
