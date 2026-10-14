/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { act, render, renderHook } from '@testing-library/react';
import React from 'react';
import SlashCommandMenu from '@/renderer/components/chat/SlashCommandMenu';
import {
  filterSlashCommands,
  getActiveSlashQuery,
  getFuzzyMatchIndices,
  getSkillTokenRanges,
  useSlashCommandController,
} from '@/renderer/hooks/chat/useSlashCommandController';
import type { SlashCommandItem } from '@/common/chat/slash/types';

const command = (name: string): SlashCommandItem => ({
  name,
  description: name,
  kind: 'template',
  source: 'acp',
});

const keyEvent = (key: string, isComposing = false) =>
  ({
    key,
    nativeEvent: { isComposing },
    preventDefault: vi.fn(),
  }) as unknown as React.KeyboardEvent;

describe('slash invocation at the caret', () => {
  it.each([
    ['/', 1, { start: 0, end: 1, query: '' }],
    ['Please /rev next', 11, { start: 7, end: 11, query: 'rev' }],
    ['First\n/skills:review later', 14, { start: 6, end: 20, query: 'skills:' }],
    ['/review arguments', 3, { start: 0, end: 7, query: 're' }],
    ['https://example.com', 8, null],
    ['See src/review', 14, null],
    ['/tmp/review', 4, null],
    ['Escaped \\/review', 16, null],
    ['/review arguments', 17, null],
  ])('recognizes only a command token in %s at %s', (input, caret, expected) => {
    expect(getActiveSlashQuery(input, caret)).toEqual(expected);
  });

  it('highlights only complete known skill tokens', () => {
    expect(getSkillTokenRanges('/review /reviewer https://x/review /skills:edit', ['review', 'skills:edit'])).toEqual([
      { start: 0, end: 7, query: 'review' },
      { start: 35, end: 47, query: 'skills:edit' },
    ]);
    expect(getSkillTokenRanges('/unknown', ['review'])).toEqual([]);
  });
});

describe('slash menu lifecycle', () => {
  it('keeps dismissal through catalog updates and reopens a new invocation of the same query', () => {
    const { result, rerender } = renderHook((props) => useSlashCommandController(props), {
      initialProps: { input: '/', caretPosition: 1, commands: [command('review')] },
    });
    act(() => {
      result.current.onKeyDown(keyEvent('Escape'));
    });
    rerender({ input: '/', caretPosition: 1, commands: [command('review'), command('edit')] });
    expect(result.current.isOpen).toBe(false);
    rerender({ input: '/ /', caretPosition: 3, commands: [command('review')] });
    expect(result.current.isOpen).toBe(true);
  });

  it('keeps the empty state visible without intercepting navigation or submit', () => {
    const { result } = renderHook(() =>
      useSlashCommandController({ input: '/missing', commands: [command('review')] })
    );
    expect(result.current.isOpen).toBe(true);
    expect(result.current.onKeyDown(keyEvent('ArrowDown'))).toBe(false);
    expect(result.current.onKeyDown(keyEvent('Enter'))).toBe(false);
  });

  it('reopens when typing slash over an identical selected slash after dismissal', () => {
    const { result } = renderHook(() => useSlashCommandController({ input: '/', commands: [command('review')] }));
    act(() => {
      result.current.onKeyDown(keyEvent('Escape'));
    });
    act(() => {
      result.current.onKeyDown(keyEvent('/'));
    });
    expect(result.current.isOpen).toBe(true);
  });

  it('opens before the command catalog arrives and displays the arriving commands', () => {
    const { result, rerender } = renderHook(({ commands }) => useSlashCommandController({ input: '/', commands }), {
      initialProps: { commands: [] as SlashCommandItem[] },
    });
    expect(result.current.isOpen).toBe(true);
    rerender({ commands: [command('review')] });
    expect(result.current.filteredCommands).toHaveLength(1);
  });

  it('replaces the active token while preserving prefix, suffix, and caret', () => {
    const onReplaceInput = vi.fn();
    const { result } = renderHook(() =>
      useSlashCommandController({
        input: 'Please /rev next',
        caretPosition: 11,
        commands: [command('review')],
        onReplaceInput,
      })
    );
    act(() => {
      result.current.onSelectByIndex(0);
    });
    expect(onReplaceInput).toHaveBeenCalledWith('Please /review next', 15);
  });

  it('executes a builtin without deleting surrounding draft text', () => {
    const onExecuteBuiltin = vi.fn();
    const onReplaceInput = vi.fn();
    const { result } = renderHook(() =>
      useSlashCommandController({
        input: 'Before /open after',
        caretPosition: 12,
        commands: [{ ...command('open'), kind: 'builtin' }],
        onExecuteBuiltin,
        onReplaceInput,
      })
    );
    act(() => {
      result.current.onSelectByIndex(0);
    });
    expect(onExecuteBuiltin).toHaveBeenCalledWith('open');
    expect(onReplaceInput).toHaveBeenCalledWith('Before  after', 7);
  });

  it('keeps the active selection valid when the catalog shrinks', () => {
    const onReplaceInput = vi.fn();
    const { result, rerender } = renderHook(
      ({ commands }) => useSlashCommandController({ input: '/', commands, onReplaceInput }),
      {
        initialProps: { commands: [command('review'), command('edit')] },
      }
    );
    act(() => {
      result.current.onKeyDown(keyEvent('ArrowDown'));
    });
    rerender({ commands: [command('review')] });
    act(() => {
      result.current.onKeyDown(keyEvent('Enter'));
    });
    expect(onReplaceInput).toHaveBeenCalledWith('/review ', 8);
  });

  it('does not accept a command during native IME composition', () => {
    const onReplaceInput = vi.fn();
    const { result } = renderHook(() =>
      useSlashCommandController({ input: '/', commands: [command('review')], onReplaceInput })
    );
    const event = keyEvent('Enter', true);
    expect(result.current.onKeyDown(event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(onReplaceInput).not.toHaveBeenCalled();
  });
});

describe('slash command fuzzy matching', () => {
  it('matches command names by contiguous substring anywhere in the name', () => {
    expect(getFuzzyMatchIndices('review', 'ev')).toEqual([1, 2]);
    expect(getFuzzyMatchIndices('review', 'vie')).toEqual([2, 3, 4]);
    expect(getFuzzyMatchIndices('review', 'rv')).toBeNull();
  });

  it('filters commands with fuzzy matching while preserving command order', () => {
    const commands = [command('open'), command('review'), command('copy-last-output')];

    expect(filterSlashCommands(commands, 'vie').map((item) => item.name)).toEqual(['review']);
    expect(filterSlashCommands(commands, 'rv').map((item) => item.name)).toEqual([]);
    expect(filterSlashCommands(commands, 'co').map((item) => item.name)).toEqual(['copy-last-output']);
  });
});

describe('SlashCommandMenu highlights', () => {
  it('marks matched label characters as highlighted', () => {
    const { container } = render(
      <SlashCommandMenu
        title='Commands'
        items={[
          {
            key: 'review',
            label: '/review',
            description: 'Review',
            highlightIndices: [2, 3],
          },
        ]}
        activeIndex={0}
        onHoverItem={vi.fn()}
        onSelectItem={vi.fn()}
        emptyText='No commands found'
      />
    );

    const highlighted = Array.from(container.querySelectorAll('[data-slash-highlight="true"]'));
    expect(highlighted).toHaveLength(1);
    expect(highlighted.map((node) => node.textContent).join('')).toBe('ev');
    expect(highlighted.every((node) => node.classList.contains('bg-aou-2'))).toBe(true);
  });
});
