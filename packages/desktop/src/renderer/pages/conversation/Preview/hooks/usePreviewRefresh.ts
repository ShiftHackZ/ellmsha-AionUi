import { ipcBridge } from '@/common';
import { chatFileRefKey } from '@/common/types/chatFile';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { PreviewTab } from '../context/PreviewContext';
import { LARGE_TEXT_PREVIEW_MAX_LENGTH } from '../constants';

const identity = (tab: PreviewTab): string | undefined => {
  const artifact = tab.metadata?.memoryArtifact;
  if (artifact) return JSON.stringify(['memory', artifact.conversationId, artifact.path]);
  return tab.metadata?.fileRef ? chatFileRefKey(tab.metadata.fileRef) : undefined;
};

/** Refresh every open document, including memory-backed BMAD specs and hidden tabs.
 * Polling also covers CLI/atomic writes and memory services without file events.
 * Never replace an edit, a saving document, a closed tab or a reused tab identity.
 */
export function usePreviewRefresh(
  tabs: PreviewTab[],
  setTabs: Dispatch<SetStateAction<PreviewTab[]>>,
  saving: MutableRefObject<Set<string>>,
  mtimes: MutableRefObject<Map<string, number>>
): void {
  const current = useRef(tabs);
  current.current = tabs;
  const accepted = useRef(new Map<string, { tabId: string; content: string; mtime: number }>());
  // Advance save preconditions only after the matching content is committed.
  // React may replay or abandon an updater, so it must not mutate the cursor.
  const acknowledge = useCallback(() => {
    for (const [key, update] of accepted.current) {
      const tab = current.current.find((item) => item.id === update.tabId && identity(item) === key);
      if (!tab) {
        accepted.current.delete(key);
        continue;
      }
      if (tab.isDirty || saving.current.has(key)) continue;
      if (tab.content === update.content && tab.originalContent === update.content) {
        mtimes.current.set(key, update.mtime);
        accepted.current.delete(key);
      }
    }
  }, [mtimes, saving]);
  useLayoutEffect(acknowledge, [acknowledge, tabs]);

  useEffect(() => {
    let disposed = false;
    const pending = new Set<string>();
    const refresh = async (tab: PreviewTab): Promise<void> => {
      const key = identity(tab);
      if (!key || tab.isDirty || saving.current.has(key) || pending.has(key)) return;
      if (!['markdown', 'code', 'html', 'diff', 'image'].includes(tab.content_type)) return;
      pending.add(key);
      try {
        let content: string;
        let mtime: number | undefined;
        const artifact = tab.metadata?.memoryArtifact;
        if (artifact) {
          const result = await ipcBridge.conversation.readMemoryArtifact.invoke({
            conversation_id: artifact.conversationId,
            path: artifact.path,
          });
          content = result.content;
        } else {
          const file = tab.metadata!.fileRef!;
          const metadata = await ipcBridge.fs.getContentMetadata.invoke({ file });
          if (!metadata) return;
          mtime = metadata.lastModified;
          if (mtime === mtimes.current.get(key)) return;
          content = await ipcBridge.fs.readContent.invoke({
            file,
            encoding: tab.content_type === 'image' ? 'dataurl' : 'utf8',
          });
          if (tab.metadata?.truncated) content = content.slice(0, LARGE_TEXT_PREVIEW_MAX_LENGTH);
        }
        if (disposed || typeof content !== 'string') return;
        if (mtime !== undefined) accepted.current.set(key, { tabId: tab.id, content, mtime });
        setTabs((latest) => {
          let changed = false;
          const updated = latest.map((item) => {
            if (
              item.id !== tab.id ||
              identity(item) !== key ||
              item.isDirty ||
              saving.current.has(key) ||
              item.content === content
            )
              return item;
            changed = true;
            return { ...item, content, originalContent: content, metadata: { ...item.metadata, missingFile: false } };
          });
          return changed ? updated : latest;
        });
        acknowledge();
      } catch {
        // Retain the last readable content; retry after a transient outage or
        // atomic replacement. A failed read never advances the mtime cursor.
      } finally {
        pending.delete(key);
      }
    };
    const poll = (): void => {
      for (const tab of current.current) void refresh(tab);
    };
    const timer = setInterval(poll, 1500);
    window.addEventListener('focus', poll);
    poll();
    return () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener('focus', poll);
    };
  }, [acknowledge, mtimes, saving, setTabs]);
}
