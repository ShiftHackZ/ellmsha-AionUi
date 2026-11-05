import { ipcBridge } from '@/common';
import { getPermissionRequestId } from '@/renderer/hooks/system/notification/browserNotificationCore';
import { removeStack } from '@/renderer/utils/common';
import { useEffect, useRef, useState } from 'react';

/** Null means the conversation needs an initial fetch; the sidebar already receives counts in team.list. */
export function usePendingConfirmationCounts(seeds: Record<string, number | null>) {
  const snapshot = JSON.stringify(seeds);
  const observed = useRef(new Set<string>());
  const [counts, setCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    const initial = JSON.parse(snapshot) as Record<string, number | null>;
    const members = new Set(Object.keys(initial));
    const version = new Map<string, number>();
    let active = true;
    for (const id of observed.current) if (!members.has(id)) observed.current.delete(id);
    setCounts((previous) => {
      const next: Record<string, number> = {};
      for (const id of members) {
        const count = observed.current.has(id) ? (previous[id] ?? initial[id]) : (initial[id] ?? previous[id]);
        if (count != null) next[id] = count;
      }
      return next;
    });
    const refresh = (id: string) => {
      if (!members.has(id)) return;
      // A late snapshot from an earlier event must not resurrect an answered question.
      const current = (version.get(id) ?? 0) + 1;
      version.set(id, current);
      void ipcBridge.conversation.confirmation.list
        .invoke({ conversation_id: id })
        .then((rows) => {
          if (!active || version.get(id) !== current) return;
          const count = new Set(rows.map((row) => row.call_id || row.id)).size;
          setCounts((previous) => (previous[id] === count ? previous : { ...previous, [id]: count }));
        })
        .catch(() => {}); // Keep the last count on a transient transport error.
    };
    const changed = (id: string) => {
      if (!members.has(id)) return;
      observed.current.add(id);
      refresh(id);
    };
    const unsub = removeStack(
      ipcBridge.conversation.responseStream.on((message) => {
        if (message.conversation_id && getPermissionRequestId(message)) changed(message.conversation_id);
      }),
      ipcBridge.conversation.confirmation.add.on(({ conversation_id }) => changed(conversation_id)),
      ipcBridge.conversation.confirmation.remove.on(({ conversation_id }) => changed(conversation_id)),
      ipcBridge.realtime.reconnected.on(() => members.forEach(changed))
    );
    for (const id of members) if (initial[id] === null || observed.current.has(id)) refresh(id);
    return () => {
      active = false;
      unsub();
    };
  }, [snapshot]);
  return counts;
}
