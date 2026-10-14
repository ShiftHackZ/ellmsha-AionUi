/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IResponseMessage } from '@/common/adapter/ipcBridge';
import type { IMessageText, TMessage } from '@/common/chat/chatLib';
import { useAutoPreviewOfficeFiles } from '@/renderer/hooks/file/useAutoPreviewOfficeFiles';

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  list: vi.fn(),
  open: vi.fn(),
  find: vi.fn(),
  enabled: true,
  files: new Set<(event: { workspace: string; file_path: string }) => void>(),
  streams: new Set<(event: IResponseMessage) => void>(),
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    fs: { listWorkspaceFiles: { invoke: mocks.list } },
    conversation: {
      responseStream: {
        on: (fn: (event: IResponseMessage) => void) => {
          mocks.streams.add(fn);
          return () => mocks.streams.delete(fn);
        },
      },
    },
    workspaceOfficeWatch: {
      start: { invoke: mocks.start },
      stop: { invoke: mocks.stop },
      fileAdded: {
        on: (fn: (event: { workspace: string; file_path: string }) => void) => {
          mocks.files.add(fn);
          return () => mocks.files.delete(fn);
        },
      },
    },
  },
}));
vi.mock('@/renderer/hooks/system/useAutoPreviewOfficeFilesEnabled', () => ({
  useAutoPreviewOfficeFilesEnabled: () => mocks.enabled,
}));
vi.mock('@/renderer/pages/conversation/Preview', () => ({
  usePreviewContext: () => ({ findPreviewTab: mocks.find, openPreview: mocks.open }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const workspace = '/tmp/owned-office';
const file = `${workspace}/report.xlsx`;
const message = (content = `[Report](${file})`, overrides: Partial<IMessageText> = {}): IMessageText => ({
  id: 'row-1',
  msg_id: 'stream-1',
  conversation_id: 'chat-1',
  type: 'text',
  position: 'left',
  content: { content },
  ...overrides,
});
const emitFile = (file_path = file, root = workspace) =>
  act(() => {
    for (const fn of mocks.files) fn({ workspace: root, file_path });
  });
const emitStream = (overrides: Partial<IResponseMessage> = {}) =>
  act(() => {
    for (const fn of mocks.streams)
      fn({ conversation_id: 'chat-1', msg_id: 'stream-1', type: 'text', data: { content: 'output' }, ...overrides });
  });
const settle = async () => {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
};
const tick = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1100);
  });
};
const mount = async (messages: TMessage[] = [], root = workspace) => {
  const hook = renderHook(
    ({ chat, rows }) => useAutoPreviewOfficeFiles({ conversation_id: chat, workspace: root }, rows),
    {
      initialProps: { chat: 'chat-1', rows: messages },
    }
  );
  await settle();
  return hook;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.enabled = true;
  mocks.start.mockResolvedValue(undefined);
  mocks.stop.mockResolvedValue(undefined);
  mocks.list.mockResolvedValue([]);
  mocks.find.mockReturnValue(undefined);
});
afterEach(async () => {
  cleanup();
  await settle();
  vi.useRealTimers();
});

describe('Office auto-preview conversation ownership', () => {
  it('ignores unrelated creation and historical references, even in the same workspace', async () => {
    await mount([message()]);
    expect(mocks.list).toHaveBeenCalledWith({ root: workspace });
    emitFile();
    await tick();
    expect(mocks.open).not.toHaveBeenCalled();
    emitStream({ conversation_id: 'other-chat' });
    await tick();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it.each(['file-first', 'message-first'])('opens new current-chat output once (%s)', async (order) => {
    const hook = await mount();
    if (order === 'file-first') emitFile();
    emitStream();
    hook.rerender({ chat: 'chat-1', rows: [message()] });
    if (order === 'message-first') emitFile();
    emitFile();
    await tick();
    expect(mocks.open).toHaveBeenCalledTimes(1);
    expect(mocks.open).toHaveBeenCalledWith('', 'excel', expect.objectContaining({ file_path: file, workspace }));
    emitFile();
    emitStream();
    await tick();
    expect(mocks.open).toHaveBeenCalledTimes(1);
  });

  it('does not auto-open existing baseline files or duplicate preview tabs', async () => {
    mocks.list.mockResolvedValue([{ fullPath: file }]);
    const hook = await mount([message()]);
    emitStream();
    emitFile();
    await tick();
    expect(mocks.open).not.toHaveBeenCalled();
    hook.unmount();
    await settle();
    mocks.list.mockResolvedValue([]);
    mocks.find.mockReturnValue({ id: 'existing-preview' });
    await mount([message()]);
    emitStream();
    emitFile();
    await tick();
    expect(mocks.find).toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it('cancels delayed opening and old chat authorization when navigating within one workspace', async () => {
    const hook = await mount([message()]);
    emitStream();
    emitFile();
    hook.rerender({ chat: 'chat-2', rows: [message(undefined, { conversation_id: 'chat-2' })] });
    await settle();
    emitFile();
    await tick();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    emitStream({ conversation_id: 'chat-2' });
    await tick();
    expect(mocks.open).toHaveBeenCalledTimes(1);
  });

  it('cancels delayed opening on unmount, disabling and streamed reference replacement', async () => {
    const hook = await mount([message()]);
    emitStream();
    emitFile();
    hook.rerender({ chat: 'chat-1', rows: [message('No output document')] });
    await tick();
    expect(mocks.open).not.toHaveBeenCalled();
    hook.rerender({ chat: 'chat-1', rows: [message()] });
    mocks.enabled = false;
    hook.rerender({ chat: 'chat-1', rows: [message()] });
    await tick();
    expect(mocks.open).not.toHaveBeenCalled();
    mocks.enabled = true;
    hook.rerender({ chat: 'chat-1', rows: [message()] });
    await settle();
    emitStream();
    emitFile();
    hook.unmount();
    await tick();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it('does not authorize user messages, hidden rows, or files outside the workspace', async () => {
    const hook = await mount([message(undefined, { position: 'right' })]);
    emitStream();
    emitFile();
    await tick();
    expect(mocks.open).not.toHaveBeenCalled();
    hook.rerender({ chat: 'chat-1', rows: [message(undefined, { hidden: true })] });
    await tick();
    expect(mocks.open).not.toHaveBeenCalled();
    hook.rerender({ chat: 'chat-1', rows: [message('[Outside](../outside.xlsx)')] });
    emitFile('/tmp/outside.xlsx');
    await tick();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it.each([
    '[Report](https://example.com/report.xlsx)',
    '[Report](file://remote/tmp/owned-office/report.xlsx)',
    '```markdown\n[Report](/tmp/owned-office/report.xlsx)\n```',
    '<think>[Report](/tmp/owned-office/report.xlsx)</think> No output',
  ])('ignores non-output references: %s', async (content) => {
    await mount([message(content)]);
    emitStream();
    emitFile();
    await tick();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it.each([
    ['[Report](<report (1).xlsx>)', `${workspace}/report (1).xlsx`],
    ['`./résumé.xlsx`', `${workspace}/résumé.xlsx`],
    ['[Report][output]\n\n[output]: report.xlsx', file],
    ['[Report](file:///private/tmp/owned-office/report.xlsx)', file],
  ])('resolves rendered Markdown references: %s', async (content, path) => {
    await mount([message(content)]);
    emitStream();
    emitFile(path);
    await tick();
    expect(mocks.open).toHaveBeenCalledWith('', 'excel', expect.objectContaining({ file_path: path }));
  });

  it('matches Windows paths case-insensitively', async () => {
    await mount([message('[Report](C:/Owned/Report.XLSX)')], 'C:\\Owned');
    emitStream();
    emitFile('c:\\owned\\report.xlsx', 'C:\\Owned');
    await tick();
    expect(mocks.open).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['/', '/report.xlsx', '[Report](/report.xlsx)'],
    ['C:\\', 'c:\\report.xlsx', '[Report](C:/report.xlsx)'],
  ])('supports a filesystem root workspace: %s', async (root, path, content) => {
    await mount([message(content)], root);
    emitStream();
    emitFile(path, root);
    await tick();
    expect(mocks.open).toHaveBeenCalledWith('', 'excel', expect.objectContaining({ file_path: path }));
  });

  it.each([true, false])('preserves live creation during the initial scan (listed: %s)', async (listed) => {
    let resolveList!: (files: { fullPath: string }[]) => void;
    mocks.list.mockReturnValue(
      new Promise((resolve) => {
        resolveList = resolve;
      })
    );
    await mount([message()]);
    emitStream();
    emitFile();
    await tick();
    expect(mocks.open).not.toHaveBeenCalled();
    await act(async () => resolveList(listed ? [{ fullPath: file }] : []));
    emitFile();
    await tick();
    expect(mocks.open).toHaveBeenCalledTimes(1);
  });

  it('orders pending start, old stop and next start during a rapid same-workspace switch', async () => {
    let resolveStart!: () => void;
    mocks.start.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveStart = resolve;
      })
    );
    const hook = await mount();
    hook.rerender({ chat: 'chat-2', rows: [] });
    await settle();
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.stop).not.toHaveBeenCalled();
    await act(async () => resolveStart());
    await settle();
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(mocks.start).toHaveBeenCalledTimes(2);
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });
});
