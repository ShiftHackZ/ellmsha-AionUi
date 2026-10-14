/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { isBackendHttpError } from '@/common/adapter/httpBridge';
import type { ConversationContextValue } from '@/renderer/hooks/context/ConversationContext';
import { usePreviewContext } from '@/renderer/pages/conversation/Preview';
import { useAutoPreviewOfficeFilesEnabled } from '@/renderer/hooks/system/useAutoPreviewOfficeFilesEnabled';
import { getFileTypeInfo } from '@/renderer/utils/file/fileType';
import { Message } from '@arco-design/web-react';
import { useEffect, useRef } from 'react';
import type { TMessage } from '@/common/chat/chatLib';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { resolveLocalFileLinkPath } from '@/renderer/components/Markdown/markdownUtils';
import { stripThinkTags } from '@/renderer/utils/chat/thinkTagFilter';
import { stripSkillSuggest } from '@/renderer/utils/chat/skillSuggestParser';
import { useTranslation } from 'react-i18next';

const OFFICE_OPEN_DELAY_MS = 1000;
const OFFICE_CONTENT_TYPES = new Set(['ppt', 'word', 'excel']);

/**
 * Backend error code (HTTP 503) when the file-watch service is disabled — e.g.
 * the OS inotify instance/watch quota is exhausted (ARM Linux, EMFILE/ENFILE).
 * The backend now degrades gracefully (watcher off, backend still starts), so
 * the front end must degrade too: auto-preview silently stops working, and we
 * surface ONE accurate, actionable hint — never a "reinstall / missing
 * resources" prompt, which does not fix a quota problem (ELECTRON-2PM).
 */
const FILE_WATCH_UNAVAILABLE_CODE = 'FILE_WATCH_UNAVAILABLE';

// Session-scoped guard: the hook remounts on every conversation/workspace
// switch, but the hint must fire at most once per app session (not per mount).
let fileWatchUnavailableWarned = false;

// A chat switch can finish an old asynchronous stop after the new start. Keep
// lifecycle requests ordered per workspace without tying previews to that scope.
const watchRequests = new Map<string, Promise<unknown>>();
const requestWatch = (workspace: string, action: 'start' | 'stop') => {
  const previous = watchRequests.get(workspace) ?? Promise.resolve();
  const request = previous.catch(() => {}).then(() => ipcBridge.workspaceOfficeWatch[action].invoke({ workspace }));
  watchRequests.set(workspace, request);
  const clear = () => {
    if (watchRequests.get(workspace) === request) watchRequests.delete(workspace);
  };
  void request.then(clear, clear);
  return request;
};

const normalizeWatchPath = (value: string): string => {
  const slashPath = value.replaceAll('\\', '/');
  const parts: string[] = [];
  for (const part of slashPath.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  let normalized = `${slashPath.startsWith('/') ? '/' : ''}${parts.join('/')}`;
  if (/^[A-Za-z]:$/.test(normalized)) normalized += '/';
  if (normalized === '/private/var' || normalized.startsWith('/private/var/')) normalized = normalized.slice(8);
  if (normalized === '/private/tmp' || normalized.startsWith('/private/tmp/')) normalized = normalized.slice(8);
  // Windows file names are case-insensitive; preserve POSIX case sensitivity.
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
};

const isWithinWorkspace = (path: string, root: string) =>
  path !== root && path.startsWith(root.endsWith('/') ? root : `${root}/`);

const officeReferences = (content: string, workspace: string): Set<string> => {
  content = stripSkillSuggest(stripThinkTags(content));
  const paths = new Set<string>();
  const root = normalizeWatchPath(workspace);
  // Reuse the editor's Markdown parser: links with spaces/parentheses, reference
  // links and inline paths must obey the same syntax as the rendered message.
  markdownLanguage.parser.parse(content).iterate({
    enter(node) {
      if (node.name !== 'URL' && node.name !== 'InlineCode') return;
      let reference = content.slice(node.from, node.to);
      if (node.name === 'InlineCode') reference = reference.replace(/^`+|`+$/g, '').trim();
      else reference = reference.replace(/^<|>$/g, '');
      reference = reference.replace(/\\([\\()])/g, '$1');
      if (/^file:/i.test(reference)) {
        try {
          const url = new URL(reference);
          if (url.hostname && url.hostname !== 'localhost') return;
        } catch {
          return;
        }
      } else if (/^[a-z][a-z0-9+.-]*:/i.test(reference) && !/^[A-Za-z]:[\\/]/.test(reference)) return;
      let filePath = resolveLocalFileLinkPath(reference);
      if (!filePath) {
        if (reference.startsWith('//') || reference.startsWith('\\\\')) return;
        try {
          filePath = decodeURIComponent(reference);
        } catch {
          return;
        }
        if (!filePath.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(filePath)) filePath = `${workspace}/${filePath}`;
      }
      const normalized = normalizeWatchPath(filePath);
      if (isWithinWorkspace(normalized, root) && OFFICE_CONTENT_TYPES.has(getFileTypeInfo(normalized).contentType)) {
        paths.add(normalized);
      }
    },
  });
  return paths;
};

/** Workspace changes are candidates only. A live assistant output in this exact
 * conversation must also reference the file before it may open automatically. */
export const useAutoPreviewOfficeFiles = (
  conversation: Pick<ConversationContextValue, 'conversation_id' | 'workspace'> | null,
  messages: readonly TMessage[] = []
) => {
  const enabled = useAutoPreviewOfficeFilesEnabled();
  const { t } = useTranslation();
  const { findPreviewTab, openPreview } = usePreviewContext();
  const workspace = conversation?.workspace?.trim() ? conversation.workspace : undefined;
  const conversationId = conversation?.conversation_id;
  const latest = useRef({ messages, findPreviewTab, openPreview, t });
  latest.current = { messages, findPreviewTab, openPreview, t };
  const reconcileRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!enabled || !workspace || !conversationId) return;
    const normalizedWorkspace = normalizeWatchPath(workspace);
    const knownFiles = new Set<string>();
    const candidates = new Map<string, string>();
    const liveMessageIds = new Set<string>();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    let ready = false;
    let cancelled = false;
    const reconcile = () => {
      if (!ready || cancelled || candidates.size === 0) return;
      const references = new Set<string>();
      for (const message of latest.current.messages) {
        if (
          message.type !== 'text' ||
          message.position !== 'left' ||
          message.hidden ||
          message.conversation_id !== conversationId ||
          !message.msg_id ||
          !liveMessageIds.has(message.msg_id)
        )
          continue;
        for (const path of officeReferences(message.content.content, workspace)) references.add(path);
      }
      for (const [path, timer] of timers) {
        if (!references.has(path)) {
          clearTimeout(timer);
          timers.delete(path);
        }
      }
      for (const [path, file_path] of candidates) {
        if (!references.has(path) || timers.has(path)) continue;
        timers.set(
          path,
          setTimeout(() => {
            timers.delete(path);
            candidates.delete(path);
            if (cancelled) return;
            const { contentType } = getFileTypeInfo(file_path);
            const file_name = file_path.split(/[\\/]/).pop() ?? file_path;
            if (!latest.current.findPreviewTab(contentType, '', { file_path, file_name })) {
              latest.current.openPreview('', contentType, {
                file_path,
                file_name,
                title: file_name,
                workspace,
                editable: false,
              });
            }
          }, OFFICE_OPEN_DELAY_MS)
        );
      }
    };
    reconcileRef.current = reconcile;
    // Only actual streamed assistant rows qualify. History hydration, pagination,
    // user messages and another chat in the same workspace cannot authorize tabs.
    const unsubscribeMessages = ipcBridge.conversation.responseStream.on((event) => {
      if (
        event.conversation_id !== conversationId ||
        !event.msg_id ||
        (event.type !== 'text' && event.type !== 'content') ||
        event.position === 'right' ||
        event.hidden
      )
        return;
      liveMessageIds.add(event.msg_id);
      reconcile();
    });
    const primeOfficeWatch = async () => {
      try {
        await requestWatch(workspace, 'start');
        if (cancelled) return;
        const currentFiles = await ipcBridge.fs.listWorkspaceFiles.invoke({ root: workspace });
        if (cancelled) return;
        for (const file of currentFiles) knownFiles.add(normalizeWatchPath(file.fullPath));
        ready = true;
        reconcile();
      } catch (error) {
        // File-watch unavailable (503 FILE_WATCH_UNAVAILABLE): the OS watch quota
        // is exhausted. Auto-preview just stops working — surface ONE accurate,
        // actionable hint, never a "reinstall / missing resources" prompt.
        if (
          !cancelled &&
          !fileWatchUnavailableWarned &&
          isBackendHttpError(error) &&
          error.code === FILE_WATCH_UNAVAILABLE_CODE
        ) {
          fileWatchUnavailableWarned = true;
          const errno = (error.details as { errno?: number } | undefined)?.errno;
          if (errno !== undefined) {
            console.warn(`[useAutoPreviewOfficeFiles] file watch unavailable (errno ${errno}); auto-preview disabled`);
          }
          Message.warning(
            latest.current.t('conversation.officePreview.fileWatchUnavailable', {
              defaultValue:
                'Live file watching is unavailable — the system may have run out of file-watch handles (inotify). Auto-preview of new Office files is disabled. Raise fs.inotify.max_user_instances or close programs holding many file watches.',
            })
          );
        }
        // Any other failure: stay inert rather than noisy.
      }
    };

    void primeOfficeWatch();

    const unsubscribeFileAdded = ipcBridge.workspaceOfficeWatch.fileAdded.on((event) => {
      try {
        if (cancelled) return;
        const normalizedEventWorkspace = normalizeWatchPath(event.workspace);
        if (normalizedEventWorkspace !== normalizedWorkspace) return;

        const normalizedFilePath = normalizeWatchPath(event.file_path);
        if (
          !isWithinWorkspace(normalizedFilePath, normalizedWorkspace) ||
          knownFiles.has(normalizedFilePath) ||
          !OFFICE_CONTENT_TYPES.has(getFileTypeInfo(normalizedFilePath).contentType)
        )
          return;
        knownFiles.add(normalizedFilePath);
        // Preserve live creations while the initial listing is pending. That
        // listing can already include the new file; reconcile still waits for
        // readiness and a live reference from this conversation.
        candidates.set(normalizedFilePath, event.file_path);
        reconcile();
      } catch (error) {
        console.error('[useAutoPreviewOfficeFiles] failed to process fileAdded event', error, event);
      }
    });

    return () => {
      cancelled = true;
      unsubscribeFileAdded();
      unsubscribeMessages();
      if (reconcileRef.current === reconcile) reconcileRef.current = null;
      for (const timer of timers.values()) clearTimeout(timer);
      void requestWatch(workspace, 'stop').catch(() => {});
    };
  }, [enabled, workspace, conversationId]);

  useEffect(() => {
    reconcileRef.current?.();
  }, [messages]);
};
