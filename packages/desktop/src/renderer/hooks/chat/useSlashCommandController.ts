import type { SlashCommandItem } from '@/common/chat/slash/types';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

export type SlashQuery = { start: number; end: number; query: string };

/** Find the slash token at the caret without treating URLs or path fragments as commands. */
export function getActiveSlashQuery(input: string, caretPosition = input.length): SlashQuery | null {
  const caret = Math.max(0, Math.min(caretPosition, input.length));
  const match = input.slice(0, caret).match(/(?:^|\s)\/([\p{L}\p{N}_.:-]*)$/u);
  if (!match) return null;
  const start = caret - match[1].length - 1;
  const end = caret + (input.slice(caret).match(/^\S*/)?.[0].length ?? 0);
  if (!/^[\p{L}\p{N}_.:-]*$/u.test(input.slice(start + 1, end))) return null;
  return { start, end, query: match[1] };
}

export function matchSlashQuery(input: string, caretPosition = input.length): string | null {
  return getActiveSlashQuery(input, caretPosition)?.query ?? null;
}

/** Exact known skill tokens can be styled while the editor remains plain text. */
export function getSkillTokenRanges(input: string, skillNames: readonly string[] = []): SlashQuery[] {
  const names = new Set(skillNames);
  return Array.from(input.matchAll(/(?:^|\s)\/([\p{L}\p{N}_.:-]+)(?=\s|$)/gu))
    .filter((match) => names.has(match[1]))
    .map((match) => ({
      start: match.index + match[0].length - match[1].length - 1,
      end: match.index + match[0].length,
      query: match[1],
    }));
}

export interface ActiveItemScrollInput {
  containerScrollTop: number;
  containerHeight: number;
  itemOffsetTop: number;
  itemOffsetHeight: number;
}

export function getScrollTopForActiveItem(input: ActiveItemScrollInput): number {
  const { containerScrollTop, containerHeight, itemOffsetTop, itemOffsetHeight } = input;
  if (containerHeight <= 0) {
    return containerScrollTop;
  }

  const viewportTop = containerScrollTop;
  const viewportBottom = containerScrollTop + containerHeight;
  const itemTop = itemOffsetTop;
  const itemBottom = itemOffsetTop + itemOffsetHeight;

  if (itemTop < viewportTop) {
    return itemTop;
  }
  if (itemBottom > viewportBottom) {
    return itemBottom - containerHeight;
  }
  return containerScrollTop;
}

export function getFuzzyMatchIndices(value: string, query: string): number[] | null {
  const keyword = query.trim();
  if (!keyword) {
    return [];
  }

  const valueLower = value.toLowerCase();
  const keywordLower = keyword.toLowerCase();
  const startIndex = valueLower.indexOf(keywordLower);
  if (startIndex < 0) {
    return null;
  }

  return Array.from({ length: keywordLower.length }, (_item, index) => startIndex + index);
}

export function filterSlashCommands(commands: SlashCommandItem[], query: string): SlashCommandItem[] {
  const keyword = query.trim();
  if (!keyword) {
    return commands;
  }

  return commands.filter((command) => getFuzzyMatchIndices(command.name, keyword) !== null);
}

function getSelectionBehavior(command: SlashCommandItem): 'execute' | 'insert' {
  if (command.selectionBehavior) {
    return command.selectionBehavior;
  }
  return command.kind === 'builtin' ? 'execute' : 'insert';
}

interface UseSlashCommandControllerOptions {
  input: string;
  caretPosition?: number;
  commands: SlashCommandItem[];
  onExecuteBuiltin?: (name: string) => void;
  onReplaceInput?: (value: string, caretPosition: number) => void;
}

export function useSlashCommandController(options: UseSlashCommandControllerOptions) {
  const { input, caretPosition = input.length, commands, onExecuteBuiltin, onReplaceInput } = options;
  const activeQuery = useMemo(() => getActiveSlashQuery(input, caretPosition), [input, caretPosition]);
  const query = activeQuery?.query ?? null;
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  // Editing or moving to another invocation reopens it; catalog refreshes do not.
  useEffect(() => {
    setActiveIndex(0);
    setDismissed(false);
  }, [input, caretPosition]);

  const filteredCommands = useMemo(() => {
    if (query === null) {
      return [];
    }
    return filterSlashCommands(commands, query);
  }, [commands, query]);

  const isOpen = query !== null && !dismissed;
  const safeActiveIndex = Math.min(activeIndex, Math.max(0, filteredCommands.length - 1));

  const executeCommand = useCallback(
    (index: number) => {
      const command = filteredCommands[index];
      if (!command || !activeQuery) {
        return false;
      }
      const executeBuiltin = getSelectionBehavior(command) === 'execute' && command.kind === 'builtin';
      if (executeBuiltin) {
        onExecuteBuiltin?.(command.name);
      }
      const suffix = input.slice(activeQuery.end);
      const replacement = executeBuiltin ? '' : `/${command.name}${suffix.startsWith(' ') ? '' : ' '}`;
      const nextInput = input.slice(0, activeQuery.start) + replacement + suffix;
      const nextCaret = activeQuery.start + replacement.length + (!executeBuiltin && suffix.startsWith(' ') ? 1 : 0);
      onReplaceInput?.(nextInput, nextCaret);
      setDismissed(true);
      return true;
    },
    [activeQuery, filteredCommands, input, onExecuteBuiltin, onReplaceInput]
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) {
        return false;
      }
      if (event.key === '/') {
        setDismissed(false);
        return false;
      }
      if (!isOpen) return false;

      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissed(true);
        return true;
      }

      if (filteredCommands.length === 0) return false;

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((safeActiveIndex + 1) % filteredCommands.length);
        return true;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((safeActiveIndex - 1 + filteredCommands.length) % filteredCommands.length);
        return true;
      }

      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        return executeCommand(safeActiveIndex);
      }

      return false;
    },
    [safeActiveIndex, executeCommand, filteredCommands.length, isOpen]
  );

  return {
    query,
    isOpen,
    activeIndex: safeActiveIndex,
    filteredCommands,
    onKeyDown,
    onSelectByIndex: executeCommand,
    setDismissed,
    setActiveIndex,
  };
}
