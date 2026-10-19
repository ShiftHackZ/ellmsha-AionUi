/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TChatConversation } from '@/common/config/storage';
import { getRouterChildMetadata } from '@/common/types/agent/routerTypes';
import type { ReactNode } from 'react';

export type WorkspaceGroup = {
  workspace: string;
  display_name: string;
  conversations: TChatConversation[];
};

export type SubagentMetadata = {
  parent_conversation_id: string;
  ref: string;
  parent_ref?: string;
  label?: string;
  status?:
    | 'pending_init'
    | 'running'
    | 'waiting_for_user'
    | 'waiting_for_approval'
    | 'completed'
    | 'errored'
    | 'interrupted'
    | 'shutdown';
};

export const getSubagentMetadata = (conversation?: TChatConversation): SubagentMetadata | undefined => {
  const metadata = (conversation?.extra as { subagent?: SubagentMetadata } | undefined)?.subagent;
  if (metadata?.parent_conversation_id && metadata.ref) return metadata;
  const managed = getRouterChildMetadata(conversation?.extra);
  return managed ? { parent_conversation_id: managed.parent_conversation_id, ref: managed.task_id } : undefined;
};

export const isSubagentConversation = (conversation?: TChatConversation): boolean =>
  Boolean(getSubagentMetadata(conversation));

/** Managed children use current runtime state; persisted running metadata may outlive Core. */
export const getSubagentDisplayStatus = (
  conversation?: TChatConversation
): NonNullable<SubagentMetadata['status']> | 'idle' | 'unknown' | 'cancelling' => {
  const persisted = getSubagentMetadata(conversation)?.status ?? 'running';
  if (!getRouterChildMetadata(conversation?.extra)) return persisted;
  const runtime = conversation?.runtime;
  if (!runtime) return 'unknown';
  if (runtime.pending_confirmations > 0 || runtime.state === 'waiting_confirmation') return 'waiting_for_approval';
  if (runtime.state === 'starting') return 'pending_init';
  if (runtime.state === 'running') return 'running';
  if (runtime.state === 'cancelling') return 'cancelling';
  return ['completed', 'errored', 'interrupted', 'shutdown'].includes(persisted) ? persisted : 'idle';
};
export const isSubagentRunning = (conversation?: TChatConversation): boolean => {
  if (!getSubagentMetadata(conversation)) return false;
  return ['pending_init', 'running', 'cancelling'].includes(getSubagentDisplayStatus(conversation));
};

export const isConversationRuntimeActive = (conversation?: TChatConversation): boolean =>
  conversation?.runtime?.is_processing === true;

export type TimelineItem = {
  type: 'workspace' | 'conversation';
  time: number;
  workspaceGroup?: WorkspaceGroup;
  conversation?: TChatConversation;
};

export type TimelineSection = {
  timeline: string;
  items: TimelineItem[];
};

export type GroupedHistoryResult = {
  pinnedConversations: TChatConversation[];
  timelineSections: TimelineSection[];
};

export type ExportZipFile = {
  name: string;
  content?: string;
  sourcePath?: string;
};

export type ExportTask =
  | { mode: 'single'; conversation: TChatConversation }
  | { mode: 'batch'; conversation_ids: string[] }
  | null;

export type ConversationRowProps = {
  conversation: TChatConversation;
  isGenerating: boolean;
  hasCompletionUnread: boolean;
  collapsed: boolean;
  tooltipEnabled: boolean;
  batchMode: boolean;
  checked: boolean;
  selected: boolean;
  menuVisible: boolean;
  onToggleChecked: (conversation: TChatConversation) => void;
  onConversationClick: (conversation: TChatConversation) => void;
  onOpenMenu: (conversation: TChatConversation) => void;
  onMenuVisibleChange: (conversation_id: string, visible: boolean) => void;
  onEditStart: (conversation: TChatConversation) => void;
  onCreateCronTask: (conversation: TChatConversation) => void;
  onDelete: (conversation_id: string) => void;
  onExport?: (conversation: TChatConversation) => void;
  onTogglePin: (conversation: TChatConversation) => void;
  getJobStatus: (conversation_id: string) => 'none' | 'active' | 'paused' | 'error' | 'unread';
  /** Resolve a loaded conversation's name by id (fork-lineage badge tooltip). */
  resolveConversationName?: (conversation_id: string) => string | undefined;
  /** When true, the agent icon is dimmed by default and only shows full color on hover. Used inside project folders to reduce visual weight. */
  dimIcon?: boolean;
  /** Hover-reveal drag handle overlaying the leading icon; supplied by the sortable wrapper for reorderable (pinned) rows. */
  dragHandle?: ReactNode;
};

export type WorkspaceGroupedHistoryProps = {
  onSessionClick?: () => void;
  collapsed?: boolean;
  tooltipEnabled?: boolean;
  batchMode?: boolean;
  onBatchModeChange?: (value: boolean) => void;
  afterPinnedContent?: ReactNode;
};

export type DragItemType = 'conversation' | 'workspace';

export type DragItem = {
  type: DragItemType;
  id: string;
  conversation?: TChatConversation;
  workspaceGroup?: WorkspaceGroup;
  sourceSection: 'pinned' | string;
  sourceWorkspace?: string;
};
