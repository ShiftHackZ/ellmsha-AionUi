/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import FilePreview from '@/renderer/components/media/FilePreview';
import UploadProgressBar from '@/renderer/components/media/UploadProgressBar';
import { useLayoutContext } from '@/renderer/hooks/context/LayoutContext';
import { useCompositionInput } from '@/renderer/hooks/chat/useCompositionInput';
import { getSkillTokenRanges } from '@/renderer/hooks/chat/useSlashCommandController';
import { Input } from '@arco-design/web-react';
import type { RefTextAreaType } from '@arco-design/web-react/es/Input';
import React, { useEffect, useLayoutEffect, useRef } from 'react';
import '@/renderer/components/chat/SendBox/sendbox.css';
import styles from '../index.module.css';
import GuidWorkspaceFootnote from './GuidWorkspaceFootnote';

type GuidInputCardProps = {
  focusRequestKey?: string;
  // Input state
  input: string;
  onInputChange: (value: string, caretPosition: number) => void;
  onCaretChange: (caretPosition: number) => void;
  caretRequest?: { value: string; position: number };
  skillNames?: readonly string[];
  onKeyDown: (event: React.KeyboardEvent) => void;
  onPaste: React.ClipboardEventHandler;
  onFocus: () => void;
  onBlur: () => void;
  placeholder: string;

  // Styling
  isInputActive: boolean;
  isFileDragging: boolean;
  activeBorderColor: string;
  inactiveBorderColor: string;
  activeShadow: string;
  dragHandlers: React.HTMLAttributes<HTMLDivElement>;

  // Files
  files: string[];
  onRemoveFile: (path: string) => void;

  // Action row
  actionRow: React.ReactNode;
  slashCommandMenu?: React.ReactNode;

  // Workspace
  workspaceDir: string;
  onSelectWorkspace: (dir: string) => void;
  onClearWorkspace: () => void;
};

const GuidInputCard: React.FC<GuidInputCardProps> = ({
  focusRequestKey,
  input,
  onInputChange,
  onCaretChange,
  caretRequest,
  skillNames,
  onKeyDown,
  onPaste,
  onFocus,
  onBlur,
  placeholder,
  isInputActive,
  isFileDragging,
  activeBorderColor,
  inactiveBorderColor,
  activeShadow,
  dragHandlers,
  files,
  onRemoveFile,
  actionRow,
  slashCommandMenu,
  workspaceDir,
  onSelectWorkspace,
  onClearWorkspace,
}) => {
  const layout = useLayoutContext();
  const isMobile = layout?.isMobile ?? false;
  const { compositionHandlers, isComposing, isComposingState } = useCompositionInput();
  const inputRef = useRef<RefTextAreaType | null>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const skillTokens = getSkillTokenRanges(input, skillNames);
  const showHighlights = !isComposingState && skillTokens.length > 0;
  const textareaAutoSize = isMobile ? { minRows: 2, maxRows: 8 } : { minRows: 2, maxRows: 20 };

  useEffect(() => {
    if (!focusRequestKey || isMobile) return;
    inputRef.current?.focus();
    inputRef.current?.dom.setSelectionRange(input.length, input.length);
  }, [focusRequestKey, input, isMobile]);

  useEffect(() => {
    if (!caretRequest || input !== caretRequest.value) return;
    inputRef.current?.focus();
    inputRef.current?.dom.setSelectionRange(caretRequest.position, caretRequest.position);
  }, [caretRequest, input]);

  useLayoutEffect(() => {
    const textarea = inputRef.current?.dom;
    const highlight = highlightRef.current;
    if (!textarea || !highlight) return;
    const textStyle = getComputedStyle(textarea);
    for (const property of [
      'font',
      'lineHeight',
      'letterSpacing',
      'padding',
      'tabSize',
      'direction',
      'textAlign',
    ] as const) {
      highlight.style[property] = textStyle[property];
    }
    highlight.scrollTop = textarea.scrollTop;
    highlight.scrollLeft = textarea.scrollLeft;
  }, [input, showHighlights]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (isComposing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
    onKeyDown(e);
  };

  const borderColor = isFileDragging
    ? 'rgb(var(--primary-3))'
    : isInputActive
      ? activeBorderColor
      : inactiveBorderColor;

  return (
    <div
      className={`${styles.guidInputCardWrap} guid-input-card-shell relative rd-24px flex flex-col ${slashCommandMenu ? 'overflow-visible' : 'overflow-hidden'} transition-all duration-200 ${isFileDragging ? 'b b-solid border-dashed guid-input-card-shell--dragging' : ''}`}
      style={{
        zIndex: 1,
        transition: 'box-shadow 0.25s ease',
        width: isMobile ? 'calc(100% + 28px)' : undefined,
        marginLeft: isMobile ? -14 : undefined,
        marginRight: isMobile ? -14 : undefined,
        ...(isFileDragging
          ? {
              backgroundColor: 'var(--color-primary-light-1)',
              borderColor: 'rgb(var(--primary-3))',
              borderWidth: '1px',
            }
          : {
              boxShadow: isInputActive ? activeShadow : 'none',
            }),
      }}
      {...dragHandlers}
    >
      {/* inner white card — narrower than outer wrap */}
      <div
        className={`${styles.guidInputInner} relative p-12px flex flex-col bg-dialog-fill-0`}
        style={{
          transition: 'box-shadow 0.25s ease, border-color 0.25s ease',
          borderColor: isFileDragging ? 'rgb(var(--primary-3))' : borderColor,
          boxShadow: isInputActive && !isFileDragging ? activeShadow : 'none',
        }}
      >
        <div className='sendbox-highlight-container'>
          <div
            ref={highlightRef}
            aria-hidden='true'
            className='sendbox-highlight-layer'
            style={!showHighlights ? { visibility: 'hidden' } : undefined}
          >
            {skillTokens.map((token, index) => (
              <React.Fragment key={token.start}>
                <span className='sendbox-highlight-text'>
                  {input.slice(index ? skillTokens[index - 1].end : 0, token.start)}
                </span>
                <span className='sendbox-highlight-skill' data-skill-token={token.query}>
                  {input.slice(token.start, token.end)}
                </span>
              </React.Fragment>
            ))}
            <span className='sendbox-highlight-text'>{input.slice(skillTokens.at(-1)?.end ?? 0)}</span>
          </div>
          <Input.TextArea
            ref={inputRef}
            autoSize={textareaAutoSize}
            placeholder={placeholder}
            spellCheck={false}
            className={`${showHighlights ? 'sendbox-highlight-textarea ' : ''}text-14px focus:b-none rounded-xl !bg-transparent !b-none !resize-none !py-0 !pr-0 !pl-7px ${styles.lightPlaceholder}`}
            value={input}
            onChange={(value, event: React.ChangeEvent<HTMLTextAreaElement>) =>
              onInputChange(value, event.target.selectionStart)
            }
            onSelect={(event) => onCaretChange(event.currentTarget.selectionStart)}
            onKeyUp={(event) => onCaretChange(event.currentTarget.selectionStart)}
            onClick={(event) => onCaretChange(event.currentTarget.selectionStart)}
            onScroll={(event) => {
              if (!highlightRef.current) return;
              highlightRef.current.scrollTop = event.currentTarget.scrollTop;
              highlightRef.current.scrollLeft = event.currentTarget.scrollLeft;
            }}
            onPaste={onPaste}
            onFocus={() => {
              onCaretChange(inputRef.current?.dom.selectionStart ?? input.length);
              onFocus();
            }}
            onBlur={onBlur}
            {...compositionHandlers}
            onKeyDown={handleKeyDown}
            data-testid='guid-input'
          />
        </div>
        <div style={{ height: 12, flexShrink: 0 }} aria-hidden='true' />
        {files.length > 0 && (
          <div className='flex flex-wrap items-center gap-8px mt-12px mb-12px'>
            {files.map((path) => (
              <FilePreview key={path} path={path} onRemove={() => onRemoveFile(path)} />
            ))}
          </div>
        )}
        <UploadProgressBar source='sendbox' />
        {actionRow}
        {slashCommandMenu && (
          <div className='absolute left-0 right-0 top-[calc(100%+4px)] z-70'>{slashCommandMenu}</div>
        )}
      </div>
      <GuidWorkspaceFootnote
        workspaceDir={workspaceDir}
        onSelectWorkspace={onSelectWorkspace}
        onClearWorkspace={onClearWorkspace}
      />
    </div>
  );
};

export default GuidInputCard;
