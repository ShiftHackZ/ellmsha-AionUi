/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act, cleanup, render, screen, fireEvent } from '@testing-library/react';
import React, { type ReactNode } from 'react';
import { Message } from '@arco-design/web-react';
import TerminalViewer from '@/renderer/pages/conversation/Preview/components/Terminal';
import { ipcBridge } from '@/common';
import { localFileRef } from '@/common/types/chatFile';
import { PreviewProvider, usePreviewContext } from '@/renderer/pages/conversation/Preview/context/PreviewContext';

vi.mock('@/renderer/pages/conversation/Preview/components/Terminal/useTerminal', () => ({
  useTerminal: () => React.createRef<HTMLDivElement>(),
}));

// These legacy preview/workspace tests cover WebUI; native profile identity is tested separately.
vi.mock('@/renderer/utils/platform', () => ({ isElectronDesktop: () => false }));

vi.mock('@/common', () => ({
  ipcBridge: {
    application: {
      reportBrowserTabInventory: { invoke: vi.fn().mockResolvedValue(undefined) },
      browserTabCommand: { on: vi.fn(() => vi.fn()) },
      reportBrowserTabCommandFailure: { invoke: vi.fn().mockResolvedValue(undefined) },
    },
    fileStream: {
      contentUpdate: { on: vi.fn(() => vi.fn()) },
    },
    preview: {
      open: { on: vi.fn(() => vi.fn()) },
    },
    conversation: { readMemoryArtifact: { invoke: vi.fn() } },
    backgroundProcess: { close: { invoke: vi.fn() }, read: { invoke: vi.fn() }, stop: { invoke: vi.fn() } },
    fs: {
      getContentMetadata: { invoke: vi.fn() },
      readContent: { invoke: vi.fn() },
      writeFile: { invoke: vi.fn() },
      getFileMetadata: { invoke: vi.fn() },
      readFile: { invoke: vi.fn() },
      getImageBase64: { invoke: vi.fn() },
    },
  },
}));

vi.mock('@/renderer/utils/emitter', () => ({
  emitter: {
    on: vi.fn(),
    off: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string) => k,
    i18n: { language: 'en' },
  }),
}));

describe('PreviewContext', () => {
  const wrapper = ({ children }: { children: ReactNode }) => <PreviewProvider>{children}</PreviewProvider>;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('keeps memory artifact identity separate from files and other conversation scopes', () => {
    const { result } = renderHook(() => usePreviewContext(), { wrapper });
    act(() => {
      result.current.openPreview('local', 'markdown', { title: 'Spec' });
    });
    act(() => {
      result.current.openPreview('memory-a', 'markdown', {
        title: 'Spec',
        editable: false,
        memoryArtifact: { conversationId: 'a', path: 'bmad/fixture/spec.md' },
      });
    });
    act(() => {
      result.current.openPreview('memory-b', 'markdown', {
        title: 'Spec',
        editable: false,
        memoryArtifact: { conversationId: 'b', path: 'bmad/fixture/spec.md' },
      });
    });
    expect(result.current.tabs).toHaveLength(3);
    act(() => {
      result.current.openPreview('memory-a-updated', 'markdown', {
        title: 'Spec',
        editable: false,
        memoryArtifact: { conversationId: 'a', path: 'bmad/fixture/spec.md' },
      });
    });
    expect(result.current.tabs).toHaveLength(3);
    expect(result.current.activeTab?.content).toBe('memory-a-updated');
    expect(result.current.activeTab?.metadata?.file_path).toBeUndefined();
    expect(result.current.activeTab?.metadata?.fileRef).toBeUndefined();
  });

  it('initializes with closed state', () => {
    const { result } = renderHook(() => usePreviewContext(), { wrapper });
    expect(result.current.isOpen).toBe(false);
    expect(result.current.tabs).toEqual([]);
    expect(result.current.activeTabId).toBe(null);
  });

  it('opens preview and creates tab', () => {
    const { result } = renderHook(() => usePreviewContext(), { wrapper });
    act(() => {
      result.current.openPreview('# Hello', 'markdown', { title: 'test.md' });
    });
    expect(result.current.isOpen).toBe(true);
    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.tabs[0].content).toBe('# Hello');
    expect(result.current.tabs[0].content_type).toBe('markdown');
  });

  it('hides preview without discarding open tabs', () => {
    const { result } = renderHook(() => usePreviewContext(), { wrapper });
    act(() => {
      result.current.openPreview('content', 'code');
    });
    act(() => {
      result.current.closePreview();
    });
    expect(result.current.isOpen).toBe(false);
    expect(result.current.tabs).toHaveLength(1);
  });

  it('provides all context API methods', () => {
    const { result } = renderHook(() => usePreviewContext(), { wrapper });
    expect(typeof result.current.openPreview).toBe('function');
    expect(typeof result.current.closePreview).toBe('function');
    expect(typeof result.current.updateContent).toBe('function');
    expect(typeof result.current.findPreviewTab).toBe('function');
  });

  it('updates content and marks tab as dirty', () => {
    const { result } = renderHook(() => usePreviewContext(), { wrapper });
    act(() => {
      result.current.openPreview('original', 'code');
    });
    expect(result.current.activeTab?.isDirty).toBe(false);
    act(() => {
      result.current.updateContent('modified');
    });
    expect(result.current.activeTab?.content).toBe('modified');
    expect(result.current.activeTab?.isDirty).toBe(true);
  });
});

describe('live document refresh and terminal ownership', () => {
  const wrapper = ({ children }: { children: ReactNode }) => <PreviewProvider>{children}</PreviewProvider>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('refreshes an inactive memory-backed BMAD spec without stealing the active tab', async () => {
    vi.mocked(ipcBridge.conversation.readMemoryArtifact.invoke).mockResolvedValue({
      path: 'bmad/spec.md',
      title: 'Spec',
      content: '# Updated',
    });
    const { result } = renderHook(() => usePreviewContext(), { wrapper });
    act(() => {
      result.current.openPreview('# Previous', 'markdown', {
        memoryArtifact: { conversationId: 'a', path: 'bmad/spec.md' },
      });
    });
    const spec = result.current.activeTabId;
    act(() => {
      result.current.openPreview('another tab', 'code');
    });
    const selected = result.current.activeTabId;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(result.current.tabs.find((tab) => tab.id === spec)?.content).toBe('# Updated');
    expect(result.current.activeTabId).toBe(selected);
    expect(result.current.tabs.find((tab) => tab.id === spec)?.originalContent).toBe('# Updated');
  });

  it('keeps an unsaved edit when an earlier filesystem read finishes', async () => {
    vi.mocked(ipcBridge.fs.getContentMetadata.invoke).mockResolvedValue({
      name: 'file.ts',
      path: '/fixture/file.ts',
      size: 5,
      mimeType: 'text/plain',
      lastModified: 2,
      isDirectory: false,
    });
    let complete!: (content: string) => void;
    vi.mocked(ipcBridge.fs.readContent.invoke).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    const { result } = renderHook(() => usePreviewContext(), { wrapper });
    act(() => result.current.openPreview('previous', 'code', { fileRef: localFileRef('/fixture/file.ts') }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    act(() => result.current.updateContent('my unsaved edit'));
    await act(async () => {
      complete('external edit');
    });
    expect(result.current.activeTab?.content).toBe('my unsaved edit');
    expect(result.current.activeTab?.isDirty).toBe(true);
  });

  it('retries a failed content read without advancing its modification cursor', async () => {
    vi.mocked(ipcBridge.fs.getContentMetadata.invoke).mockResolvedValue({
      name: 'file.ts',
      path: '/fixture/file.ts',
      size: 5,
      mimeType: 'text/plain',
      lastModified: 2,
      isDirectory: false,
    });
    vi.mocked(ipcBridge.fs.readContent.invoke)
      .mockRejectedValueOnce(new Error('temporary outage'))
      .mockResolvedValue('recovered');
    const { result } = renderHook(() => usePreviewContext(), { wrapper });
    act(() => result.current.openPreview('previous', 'code', { fileRef: localFileRef('/fixture/file.ts') }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(result.current.activeTab?.content).toBe('previous');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(result.current.activeTab?.content).toBe('recovered');
  });

  it('preserves the current selection when a delayed terminal close finishes', async () => {
    let finish!: (value: Awaited<ReturnType<typeof ipcBridge.backgroundProcess.close.invoke>>) => void;
    vi.mocked(ipcBridge.backgroundProcess.close.invoke).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const { result } = renderHook(() => usePreviewContext(), { wrapper });
    act(() =>
      result.current.openPreview('opaque', 'terminal', {
        backgroundProcess: { conversationId: 'chat', processId: 'opaque' },
      })
    );
    const terminal = result.current.activeTabId!;
    act(() => result.current.closeTab(terminal));
    act(() => result.current.openPreview('my new selection', 'code'));
    const selected = result.current.activeTabId;
    await act(async () => finish({} as Awaited<ReturnType<typeof ipcBridge.backgroundProcess.close.invoke>>));
    expect(result.current.activeTabId).toBe(selected);
    expect(result.current.activeTab?.content).toBe('my new selection');
    expect(result.current.tabs.some((tab) => tab.id === terminal)).toBe(false);
  });

  it('keeps the terminal tab when its close cannot stop the process', async () => {
    const toast = vi.spyOn(Message, 'error').mockImplementation(() => '' as never);
    vi.mocked(ipcBridge.backgroundProcess.close.invoke).mockRejectedValueOnce(new Error('fixture offline'));
    const { result } = renderHook(() => usePreviewContext(), { wrapper });
    act(() =>
      result.current.openPreview('opaque', 'terminal', {
        backgroundProcess: { conversationId: 'chat', processId: 'opaque' },
      })
    );
    const terminal = result.current.activeTabId!;
    await act(async () => result.current.closeTab(terminal));
    expect(toast).toHaveBeenCalledWith('preview.terminal.unavailable');
    expect(result.current.tabs.some((tab) => tab.id === terminal)).toBe(true);
    expect(result.current.isOpen).toBe(true);
  });

  it('hides and restores tabs and drafts, and stops an owned terminal before closing it', async () => {
    const stop = vi
      .mocked(ipcBridge.backgroundProcess.close.invoke)
      .mockResolvedValue({} as Awaited<ReturnType<typeof ipcBridge.backgroundProcess.close.invoke>>);
    const { result } = renderHook(() => usePreviewContext(), { wrapper });
    act(() => result.current.openPreview('previous', 'code'));
    act(() => result.current.updateContent('draft'));
    const draft = result.current.activeTabId;
    act(() => result.current.togglePreview());
    expect(result.current.isOpen).toBe(false);
    act(() => result.current.togglePreview());
    expect(result.current.activeTab?.content).toBe('draft');
    act(() =>
      result.current.openPreview('process-1', 'terminal', {
        backgroundProcess: { conversationId: 'chat', processId: 'process-1' },
      })
    );
    await act(async () => {
      result.current.closeTab(result.current.activeTabId!);
    });
    expect(stop).toHaveBeenCalledWith({ conversation_id: 'chat', process_id: 'process-1' });
    expect(result.current.tabs.map((tab) => tab.id)).toEqual([draft]);
  });
});

describe('owned terminal viewer', () => {
  const snapshot = {
    id: 'opaque',
    conversation_id: 'chat',
    title: 'Frontend',
    command: 'npm run dev',
    cwd: '/workspace',
    pid: 1234,
    running: true,
    closed: false,
    exit_code: null,
    stdout: '<img src=x onerror=alert(1)>ready',
    stderr: 'fixture diagnostic',
    stdout_truncated: true,
    input_revision: 0,
    human_input_active: false,
    rows: 24,
    cols: 80,
    cursor: [0, 0] as [number, number],
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });
  it('renders the shared terminal host and stops through the owned-process API', async () => {
    vi.mocked(ipcBridge.backgroundProcess.read.invoke).mockResolvedValue(snapshot);
    vi.mocked(ipcBridge.backgroundProcess.stop.invoke).mockResolvedValue({ ...snapshot, running: false, exit_code: 0 });
    const { container } = render(<TerminalViewer conversationId='chat' processId='opaque' />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByRole('region', { name: 'conversation.workspace.openWith.terminal' })).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('preview.terminal.shared')).toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'preview.terminal.stop' })));
    expect(ipcBridge.backgroundProcess.stop.invoke).toHaveBeenCalledWith({
      conversation_id: 'chat',
      process_id: 'opaque',
    });
    expect(screen.getByRole('button', { name: 'preview.terminal.stop' })).toBeDisabled();
    expect(screen.getByRole('region', { name: 'conversation.workspace.openWith.terminal' })).toBeInTheDocument();
  });
  it('retains output and offers retry when Stop is unavailable', async () => {
    vi.mocked(ipcBridge.backgroundProcess.read.invoke).mockResolvedValue(snapshot);
    vi.mocked(ipcBridge.backgroundProcess.stop.invoke).mockRejectedValue(new Error('fixture unavailable'));
    render(<TerminalViewer conversationId='chat' processId='opaque' />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'preview.terminal.stop' })));
    expect(screen.getByText('preview.terminal.unavailable')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'conversation.workspace.openWith.terminal' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'common.retry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'preview.terminal.stop' })).not.toBeDisabled();
  });
});
