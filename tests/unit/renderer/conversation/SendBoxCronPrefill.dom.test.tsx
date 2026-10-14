/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React, { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

const { layoutState } = vi.hoisted(() => ({
  layoutState: { isMobile: false },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    fs: {
      listAvailableSkills: { invoke: vi.fn().mockResolvedValue([]) },
      listWorkspaceFiles: { invoke: vi.fn().mockResolvedValue([]) },
    },
  },
}));

vi.mock('@/renderer/hooks/chat/useInputFocusRing', () => ({
  useInputFocusRing: () => ({
    activeBorderColor: 'var(--color-primary-6)',
    inactiveBorderColor: 'var(--color-border-2)',
    activeShadow: 'none',
  }),
}));

vi.mock('@/renderer/hooks/context/ConversationContext', () => ({
  useConversationContextSafe: () => ({
    conversation_id: 'sendbox-prefill-conversation',
    type: 'acp',
    loadedSkills: ['review', 'skills:edit'],
  }),
}));

vi.mock('@/renderer/hooks/context/LayoutContext', () => ({
  useLayoutContext: () => ({ isMobile: layoutState.isMobile }),
}));

vi.mock('@/renderer/pages/conversation/Preview', () => ({
  usePreviewContext: () => ({
    setSendBoxHandler: vi.fn(),
    domSnippets: [],
    removeDomSnippet: vi.fn(),
    clearDomSnippets: vi.fn(),
  }),
}));

vi.mock('@/renderer/pages/conversation/Messages/hooks', () => ({
  useMessageList: () => [],
}));

vi.mock('@/renderer/hooks/file/useConversationExport', () => ({
  useConversationExport: () => ({
    isOpen: false,
    showMenu: false,
    step: 'closed',
    filename: '',
    pathPreview: '',
    menuItems: [],
    activeIndex: 0,
    loading: false,
    openExportFlow: vi.fn(),
    closeExportFlow: vi.fn(),
    handleKeyDown: vi.fn(),
    onSelectMenuItem: vi.fn(),
    setActiveIndex: vi.fn(),
    setFilename: vi.fn(),
    submitFilename: vi.fn(),
  }),
}));

vi.mock('@/renderer/components/chat/BtwOverlay/useBtwCommand', () => ({
  useBtwCommand: () => ({
    answer: '',
    question: '',
    isLoading: false,
    isOpen: false,
    ask: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

vi.mock('@/renderer/hooks/file/useDragUpload', () => ({
  useDragUpload: () => ({ isFileDragging: false, dragHandlers: {} }),
}));

vi.mock('@/renderer/hooks/file/usePasteService', () => ({
  usePasteService: () => ({ onPaste: vi.fn(), onFocus: vi.fn() }),
}));

vi.mock('@/renderer/hooks/file/useUploadState', () => ({
  useUploadState: () => ({ isUploading: false }),
}));

vi.mock('@/renderer/hooks/file/useAbortUploadsOnConversationChange', () => ({
  useAbortUploadsOnConversationChange: vi.fn(),
}));

vi.mock('@/renderer/hooks/system/useLiveTranscriptInsertion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/renderer/hooks/system/useLiveTranscriptInsertion')>();
  return {
    ...actual,
    useLiveTranscriptInsertion: () => ({ handleLiveTranscript: vi.fn() }),
  };
});

vi.mock('@/renderer/utils/emitter', () => ({
  emitter: { emit: vi.fn() },
  useAddEventListener: vi.fn(),
}));

vi.mock('@/renderer/components/chat/BtwOverlay', () => ({ default: () => null }));
vi.mock('@/renderer/components/chat/SpeechInputButton', () => ({ default: () => null }));
vi.mock('@/renderer/components/media/UploadProgressBar', () => ({ default: () => null }));

import SendBox from '@/renderer/components/chat/SendBox';
import { requestConversationSendBoxPrefill } from '@/renderer/hooks/chat/useSendBoxDraft';

const SendBoxHarness = ({ initialValue = 'Existing draft' }: { initialValue?: string }) => {
  const [value, setValue] = useState(initialValue);
  return <SendBox value={value} onChange={setValue} onSend={vi.fn().mockResolvedValue(undefined)} />;
};

describe('SendBox scheduled-task prefill', () => {
  it('preserves the draft, focuses the mounted desktop input, and moves the caret to the end', async () => {
    layoutState.isMobile = false;
    render(
      <div>
        <button type='button'>Outside focus target</button>
        <SendBoxHarness />
      </div>
    );

    const textarea = screen.getByTestId('sendbox-input') as HTMLTextAreaElement;
    screen.getByRole('button', { name: 'Outside focus target' }).focus();
    expect(textarea).not.toHaveFocus();

    act(() => {
      requestConversationSendBoxPrefill('sendbox-prefill-conversation', 'Create with /cron in AionUi');
    });

    await waitFor(() => expect(textarea).toHaveValue('Existing draft\nCreate with /cron in AionUi'));
    await waitFor(() => expect(textarea).toHaveFocus());
    expect(textarea.selectionStart).toBe(textarea.value.length);
    expect(textarea.selectionEnd).toBe(textarea.value.length);
  });

  it('does not force focus on mobile', async () => {
    layoutState.isMobile = true;
    render(
      <div>
        <button type='button'>Mobile outside target</button>
        <SendBoxHarness />
      </div>
    );

    const textarea = screen.getByTestId('sendbox-input') as HTMLTextAreaElement;
    screen.getByRole('button', { name: 'Mobile outside target' }).focus();

    act(() => {
      requestConversationSendBoxPrefill('sendbox-prefill-conversation', 'Create with /cron in AionUi');
    });

    await waitFor(() => expect(textarea).toHaveValue('Existing draft\nCreate with /cron in AionUi'));
    expect(textarea).not.toHaveFocus();
  });

  it('chains consecutive requests before the controlled value rerenders', async () => {
    layoutState.isMobile = false;
    render(<SendBoxHarness />);
    const textarea = screen.getByTestId('sendbox-input') as HTMLTextAreaElement;

    act(() => {
      requestConversationSendBoxPrefill('sendbox-prefill-conversation', 'First /cron prompt');
      requestConversationSendBoxPrefill('sendbox-prefill-conversation', 'Second /cron prompt');
    });

    await waitFor(() => expect(textarea).toHaveValue('Existing draft\nFirst /cron prompt\nSecond /cron prompt'));
    expect(textarea).toHaveFocus();
    expect(textarea.selectionStart).toBe(textarea.value.length);
  });

  it('keeps the prefill when the textarea cannot be focused', async () => {
    layoutState.isMobile = false;
    render(<SendBoxHarness />);
    const textarea = screen.getByTestId('sendbox-input') as HTMLTextAreaElement;
    const outsideTarget = document.createElement('button');
    document.body.append(outsideTarget);
    outsideTarget.focus();

    const originalQuerySelector = Element.prototype.querySelector;
    const querySelectorSpy = vi.spyOn(Element.prototype, 'querySelector').mockImplementation(function (selector) {
      if (selector === 'textarea' && (this as Element).classList.contains('sendbox-panel')) return null;
      return originalQuerySelector.call(this, selector);
    });

    act(() => {
      requestConversationSendBoxPrefill('sendbox-prefill-conversation', 'Create with /cron in AionUi');
    });

    await waitFor(() => expect(textarea).toHaveValue('Existing draft\nCreate with /cron in AionUi'));
    expect(outsideTarget).toHaveFocus();

    querySelectorSpy.mockRestore();
    outsideTarget.remove();
  });
});

describe('SendBox slash editing', () => {
  it('preserves surrounding text and restores the caret after selecting a skill', async () => {
    layoutState.isMobile = false;
    const { container } = render(<SendBoxHarness initialValue='Before /rev after' />);
    const textarea = screen.getByTestId('sendbox-input') as HTMLTextAreaElement;
    textarea.setSelectionRange(11, 11);
    fireEvent.select(textarea);
    fireEvent.click(await screen.findByRole('option', { name: /\/review/ }));
    await waitFor(() => expect(textarea.selectionStart).toBe(15));
    expect(textarea).toHaveValue('Before /review after');
    expect(container.querySelector('[data-skill-token="review"]')).toHaveTextContent('/review');
  });

  it('reopens after dismissal when slash starts a new token in the draft', async () => {
    layoutState.isMobile = false;
    render(<SendBoxHarness initialValue='/' />);
    const textarea = screen.getByTestId('sendbox-input') as HTMLTextAreaElement;
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    fireEvent.change(textarea, { target: { value: '/ /', selectionStart: 3, selectionEnd: 3 } });
    expect(await screen.findByRole('option', { name: /\/review/ })).toBeInTheDocument();
  });

  it('keeps unknown-command feedback visible and leaves IME text untouched', () => {
    layoutState.isMobile = false;
    render(<SendBoxHarness initialValue='/unknown' />);
    const textarea = screen.getByTestId('sendbox-input') as HTMLTextAreaElement;
    expect(screen.getByText('No commands found')).toBeInTheDocument();
    fireEvent.compositionStart(textarea);
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });
    expect(textarea).toHaveValue('/unknown');
  });

  it('uses native text rendering during IME composition of a highlighted skill', () => {
    layoutState.isMobile = false;
    render(<SendBoxHarness initialValue='/review ' />);
    const textarea = screen.getByTestId('sendbox-input') as HTMLTextAreaElement;
    expect(textarea).toHaveClass('sendbox-highlight-textarea');
    fireEvent.compositionStart(textarea);
    expect(textarea).not.toHaveClass('sendbox-highlight-textarea');
    fireEvent.compositionEnd(textarea);
    expect(textarea).toHaveClass('sendbox-highlight-textarea');
  });

  it('does not send or accept a slash command on a native IME confirmation key', () => {
    layoutState.isMobile = false;
    const onSend = vi.fn().mockResolvedValue(undefined);
    const onChange = vi.fn();
    render(<SendBox value='/review' onChange={onChange} onSend={onSend} />);
    fireEvent.keyDown(screen.getByTestId('sendbox-input'), { key: 'Enter', isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });
});
