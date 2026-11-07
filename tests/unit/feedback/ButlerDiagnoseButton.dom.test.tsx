/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * ButlerDiagnoseButton — the "Ask the Butler" chip mounted next to
 * FeedbackButton on conversation error surfaces. Clicking it must hand a
 * diagnosis prompt containing the error text to the talk-to-butler flow
 * (the same flow behind the report modal's "Solve via chat").
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'settings.talkToButler.prompt.diagnoseChatError') {
        return `diagnose:${String(options?.error)}`;
      }
      return key;
    },
    i18n: { language: 'en' },
  }),
}));

const talkToButlerMock = vi.fn(() => Promise.resolve());
vi.mock('@/renderer/hooks/assistant/useTalkToButler', () => ({
  useTalkToButler: () => talkToButlerMock,
}));

import ButlerDiagnoseButton from '@/renderer/components/base/ButlerDiagnoseButton';

describe('ButlerDiagnoseButton', () => {
  beforeEach(() => {
    talkToButlerMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the solveWithButler label', () => {
    render(<ButlerDiagnoseButton conversationId='failed-chat' errorText='boom' />);
    expect(screen.getByText('settings.talkToButler.solveWithButler')).toBeInTheDocument();
  });

  it('hands the error text to talkToButler inside the diagnosis prompt', async () => {
    const user = userEvent.setup();
    render(<ButlerDiagnoseButton conversationId='failed-chat' errorText='  connection reset  ' />);
    await user.click(screen.getByText('settings.talkToButler.solveWithButler'));

    expect(talkToButlerMock).toHaveBeenCalledTimes(1);
    expect(talkToButlerMock).toHaveBeenCalledWith({
      prompt: 'diagnose:connection reset\nconversation_id: failed-chat',
    });
  });

  it('stops click propagation so the surrounding bubble does not react', async () => {
    const user = userEvent.setup();
    const outerClick = vi.fn();
    render(
      <div onClick={outerClick}>
        <ButlerDiagnoseButton conversationId='failed-chat' errorText='boom' />
      </div>
    );
    await user.click(screen.getByText('settings.talkToButler.solveWithButler'));
    expect(outerClick).not.toHaveBeenCalled();
  });
});
