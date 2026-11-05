import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AgentQuestionForm from '@/renderer/pages/conversation/Messages/components/MessagePermission/AgentQuestionForm';
import type { AgentQuestion } from '@/common/types/platform/acpTypes';
const confirm = vi.hoisted(() => vi.fn());
vi.mock('@/common', () => ({ ipcBridge: { conversation: { confirmation: { confirm: { invoke: confirm } } } } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const questions: AgentQuestion[] = [
  {
    id: 'single',
    header: 'Format',
    question: 'Which output?',
    options: [{ label: 'PDF', description: 'Print' }, { label: 'DOCX' }],
    multiSelect: false,
    isOther: true,
    isSecret: false,
  },
  {
    id: 'multi',
    header: 'Targets',
    question: 'Which systems?',
    options: [{ label: 'macOS' }, { label: 'Linux' }],
    multiSelect: true,
    isOther: false,
    isSecret: false,
  },
  {
    id: 'secret',
    header: 'Code',
    question: 'Enter code',
    options: [],
    multiSelect: false,
    isOther: true,
    isSecret: true,
  },
];
const renderForm = () =>
  render(<AgentQuestionForm questions={questions} conversationId='c1' callId='call1' msgId='m1' />);
afterEach(cleanup);
beforeEach(() => confirm.mockReset());
describe('Agent questions', () => {
  it('sends one structured reply for every question, supports custom input and masks secrets', async () => {
    confirm.mockResolvedValue(undefined);
    renderForm();
    const submit = screen.getByRole('button', { name: 'messages.questions.submit' });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: /PDF/ }));
    fireEvent.change(screen.getByLabelText('messages.questions.other'), { target: { value: 'HTML' } });
    expect(screen.getByRole('radio', { name: /PDF/ })).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'macOS' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Linux' }));
    const secret = screen.getByLabelText('Enter code', { selector: 'input' });
    expect(secret).toHaveAttribute('type', 'password');
    fireEvent.change(secret, { target: { value: '  test-only  ' } });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(await screen.findByRole('status')).toHaveTextContent('messages.questions.answered');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith({
      conversation_id: 'c1',
      call_id: 'call1',
      msg_id: 'm1',
      always_allow: false,
      data: {
        answers: [
          { question: 'single', labels: ['HTML'] },
          { question: 'multi', labels: ['macOS', 'Linux'] },
          { question: 'secret', labels: ['  test-only  '] },
        ],
      },
    });
  });
  it('can leave an optional MCP field empty and distinguishes Cancel from Decline', async () => {
    confirm.mockResolvedValue(undefined);
    const view = render(
      <AgentQuestionForm
        conversationId='c'
        msgId='m'
        callId='elicit:7'
        questions={[{ ...questions[2], optional: true }]}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'messages.questions.submit' }));
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ data: { answers: [{ question: 'secret', labels: [] }] } })
    );
    view.unmount();
    const cancelView = render(
      <AgentQuestionForm conversationId='c' msgId='m' callId='elicit:8' questions={[questions[0]]} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(confirm).toHaveBeenLastCalledWith(expect.objectContaining({ data: { value: 'cancel' } }));
    await screen.findByRole('status');
    cancelView.unmount();
    render(<AgentQuestionForm conversationId='c' msgId='m' callId='elicit:9' questions={[questions[0]]} />);
    fireEvent.click(screen.getByRole('button', { name: 'messages.questions.decline' }));
    expect(confirm).toHaveBeenLastCalledWith(expect.objectContaining({ data: { value: 'reject' } }));
    await screen.findByRole('status');
  });
  it('shows schema defaults for review and only submits them on user action', async () => {
    confirm.mockResolvedValue(undefined);
    render(
      <AgentQuestionForm
        conversationId='c'
        msgId='m'
        callId='elicit:10'
        questions={[
          { ...questions[0], defaultLabels: ['DOCX'] },
          { ...questions[1], allowEmpty: true },
        ]}
      />
    );
    expect(screen.getByRole('radio', { name: 'DOCX' })).toBeChecked();
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'messages.questions.submit' }));
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          answers: [
            { question: 'single', labels: ['DOCX'] },
            { question: 'multi', labels: [] },
          ],
        },
      })
    );
    await screen.findByRole('status');
  });
  it('can dismiss without inventing a response and retry after a failed request', async () => {
    confirm.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined);
    renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(await screen.findByRole('alert')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('messages.questions.dismissed'));
    expect(confirm).toHaveBeenLastCalledWith(expect.objectContaining({ data: { value: 'reject' } }));
  });
});
