import { ipcBridge } from '@/common';
import type { BackgroundProcessSnapshot } from '@/common/adapter/ipcBridge';
import { useCallback, useEffect, useRef, useState } from 'react';

export function useBackgroundTerminals(
  conversationId: string | undefined,
  open: (process: BackgroundProcessSnapshot) => void
): void {
  const discovered = useRef(new Map<string, Set<string>>());
  useEffect(() => {
    if (!conversationId || !ipcBridge.backgroundProcess?.list) return;
    let disposed = false;
    let pending = false;
    const seen = discovered.current.get(conversationId) ?? new Set<string>();
    discovered.current.set(conversationId, seen);
    const poll = async (): Promise<void> => {
      if (pending) return;
      pending = true;
      try {
        const processes = await ipcBridge.backgroundProcess.list.invoke({ conversation_id: conversationId });
        if (disposed) return;
        for (const process of processes) {
          if (seen.has(process.id) && !process.closed) continue;
          seen.add(process.id);
          open(process);
        }
      } catch {
        /* An unavailable backend never fabricates a terminal. Retry on recovery. */
      } finally {
        pending = false;
      }
    };
    void poll();
    const interval = setInterval(() => void poll(), 1500);
    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, [conversationId, open]);
}

export function useBackgroundProcess(conversationId: string, processId: string) {
  const [snapshot, setSnapshot] = useState<BackgroundProcessSnapshot>();
  const [failed, setFailed] = useState(false);
  const [stopping, setStopping] = useState(false);
  const epoch = useRef(0);
  const alive = useRef(true);
  const target = { conversation_id: conversationId, process_id: processId };
  const refresh = useCallback(async () => {
    const generation = epoch.current;
    try {
      const data = await ipcBridge.backgroundProcess.read.invoke({
        conversation_id: conversationId,
        process_id: processId,
      });
      if (!alive.current || epoch.current !== generation) return;
      setSnapshot(data);
      setFailed(false);
    } catch {
      if (alive.current && epoch.current === generation) setFailed(true);
    }
  }, [conversationId, processId]);
  useEffect(() => {
    alive.current = true;
    let pending = false;
    const poll = async (): Promise<void> => {
      if (pending) return;
      pending = true;
      try {
        await refresh();
      } finally {
        pending = false;
      }
    };
    void poll();
    const interval = setInterval(() => void poll(), 1000);
    return () => {
      alive.current = false;
      epoch.current += 1;
      clearInterval(interval);
    };
  }, [refresh]);
  const stop = async (): Promise<void> => {
    epoch.current += 1;
    setStopping(true);
    try {
      const data = await ipcBridge.backgroundProcess.stop.invoke(target);
      if (alive.current) {
        setSnapshot(data);
        setFailed(false);
      }
    } catch {
      if (alive.current) setFailed(true);
    } finally {
      // Reads started during teardown cannot replace its final status.
      epoch.current += 1;
      if (alive.current) setStopping(false);
    }
  };
  return { snapshot, failed, stopping, stop, refresh };
}
