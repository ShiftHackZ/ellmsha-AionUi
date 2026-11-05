import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChatRule,
  ChatRuleMutation,
  ChatRules,
  ProjectRuleFiles,
  ProjectFileMutation,
} from '@/common/types/agent/chatRules';
import { BackendHttpError } from '@/common/adapter/httpBridge';

const api = vi.hoisted(() => ({
  files: vi.fn<() => Promise<ProjectRuleFiles>>(),
  fileWrite: vi.fn<(input: { conversation_id: string; mutation: ProjectFileMutation }) => Promise<void>>(),
  skills: vi.fn<() => Promise<Array<{ name: string; description: string; source: string }>>>(),
  list: vi.fn<({ conversation_id }: { conversation_id: string }) => Promise<ChatRules>>(),
  write: vi.fn<(input: { conversation_id: string; mutation: ChatRuleMutation }) => Promise<void>>(),
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    project: { skills: { invoke: api.skills } },
    conversation: {
      getProjectRuleFiles: { invoke: api.files },
      mutateProjectRuleFile: { invoke: api.fileWrite },
      getRules: { invoke: api.list },
      mutateRule: { invoke: api.write },
    },
  },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: { title?: string; path?: string }) =>
      params ? `${key}: ${params.title ?? params.path}` : key,
  }),
}));

import { RulesPanel } from '@/renderer/pages/conversation/Preview/components/RulesPanel';

const rule: ChatRule = {
  path: 'knowledge/project/example.md',
  scope: 'project',
  title: 'Tests',
  content: 'Run unit tests',
  revision: 'v1',
  editable: true,
};
const global: ChatRule = {
  ...rule,
  scope: 'global',
  path: 'knowledge/global/rule.md',
  title: 'Language',
  content: 'Use English',
  editable: false,
};
const view = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
      <RulesPanel conversationId='chat-a' />
    </SWRConfig>
  );
const button = (name: string) => screen.getByRole('button', { name });

beforeEach(() => {
  api.files.mockReset().mockResolvedValue({ projectId: null, files: [] });
  api.fileWrite.mockReset().mockResolvedValue();
  api.skills.mockReset().mockResolvedValue([]);
  api.list.mockReset();
  api.write.mockReset();
});
afterEach(cleanup);

describe('Chat rules', () => {
  it('edits a repository file with its original revision and lists project slash skills independently of memory', async () => {
    api.list.mockRejectedValue(new Error('offline'));
    api.files.mockResolvedValue({
      projectId: 'registered',
      files: [
        {
          id: 'file1',
          rootLabel: 'repo',
          path: './repo/AGENTS.md',
          revision: 'old',
          writable: true,
          rules: [{ id: 'section1', title: 'Lint', content: 'Run lint' }],
        },
      ],
    });
    api.skills.mockResolvedValue([
      { name: 'verify', description: 'Check changes', source: './repo/.agents/skills/verify/SKILL.md' },
    ]);
    view();
    const group = await screen.findByRole('region', { name: 'conversation.rules.fileHeading: ./repo/AGENTS.md' });
    expect(await screen.findByText('/verify')).toBeVisible();
    fireEvent.click(within(group).getByRole('button', { name: 'conversation.rules.editNamed: Lint' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('conversation.rules.instruction'), {
      target: { value: 'Run the focused linter' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'common.save' }));
    await waitFor(() =>
      expect(api.fileWrite).toHaveBeenCalledWith({
        conversation_id: 'chat-a',
        mutation: {
          action: 'edit',
          fileId: 'file1',
          revision: 'old',
          ruleId: 'section1',
          title: 'Lint',
          content: 'Run the focused linter',
        },
      })
    );
    expect(api.write).not.toHaveBeenCalled();
  });

  it('groups active rules global first and preserves read-only sources', async () => {
    api.list.mockResolvedValue({
      enabled: true,
      writable: true,
      projectAvailable: true,
      overBudget: false,
      rules: [rule, global],
    });
    view();
    await screen.findByText('Run unit tests');
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
      'conversation.rules.global',
      'conversation.rules.project',
    ]);
    const globalSection = screen.getByRole('region', { name: 'conversation.rules.global' });
    expect(within(globalSection).getByText('Use English')).toBeVisible();
    expect(within(globalSection).queryByRole('button', { name: /editNamed/ })).toBeNull();
    expect(api.list).toHaveBeenCalledWith({ conversation_id: 'chat-a' });
  });

  it('shows the active inventory without write controls for a read-only gateway', async () => {
    api.list.mockResolvedValue({
      enabled: true,
      writable: false,
      projectAvailable: true,
      overBudget: false,
      rules: [rule],
    });
    view();
    await screen.findByText('Run unit tests');
    expect(screen.queryByRole('button', { name: /addGlobal|addProject|editNamed|deleteNamed/ })).toBeNull();
    expect(api.write).not.toHaveBeenCalled();
  });

  it('shows global rules and cannot add project rules in temporary chats', async () => {
    api.list.mockResolvedValue({
      enabled: true,
      writable: true,
      projectAvailable: false,
      overBudget: false,
      rules: [global],
    });
    view();
    await screen.findByText('conversation.rules.noProject');
    expect(button('conversation.rules.addGlobal')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'conversation.rules.addProject' })).toBeNull();
  });

  it('opens a structured form, checks required fields and refreshes after adding a rule', async () => {
    let rules: ChatRule[] = [];
    api.list.mockImplementation(async () => ({
      enabled: true,
      writable: true,
      projectAvailable: true,
      overBudget: false,
      rules,
    }));
    api.write.mockImplementation(async () => {
      rules = [rule];
    });
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'conversation.rules.addProject' }));
    expect(button('common.save')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('conversation.rules.ruleTitle'), { target: { value: rule.title } });
    fireEvent.change(screen.getByLabelText('conversation.rules.instruction'), { target: { value: rule.content } });
    fireEvent.click(button('common.save'));
    await screen.findByText(rule.content);
    expect(api.write).toHaveBeenCalledWith({
      conversation_id: 'chat-a',
      mutation: { action: 'add', scope: 'project', title: rule.title, content: rule.content },
    });
  });

  it('requires explicit confirmation and the revision shown in the delete dialog', async () => {
    let rules: ChatRule[] = [rule];
    api.list.mockImplementation(async () => ({
      enabled: true,
      writable: true,
      projectAvailable: true,
      overBudget: false,
      rules,
    }));
    api.write.mockImplementation(async () => {
      rules = [];
    });
    view();
    fireEvent.click(await screen.findByRole('button', { name: `conversation.rules.deleteNamed: ${rule.title}` }));
    fireEvent.click(button('common.cancel'));
    expect(button(`conversation.rules.deleteNamed: ${rule.title}`)).toHaveFocus();
    expect(api.write).not.toHaveBeenCalled();
    fireEvent.click(button(`conversation.rules.deleteNamed: ${rule.title}`));
    fireEvent.click(button('common.delete'));
    await screen.findByText('conversation.rules.emptyProject');
    expect(button('conversation.rules.addProject')).toHaveFocus();
    expect(api.write).toHaveBeenCalledWith({
      conversation_id: 'chat-a',
      mutation: { action: 'delete', scope: 'project', path: rule.path, revision: 'v1' },
    });
  });

  it('polls for an agent change without overwriting an unsaved draft or its original revision', async () => {
    let current = rule;
    api.list.mockImplementation(async () => ({
      enabled: true,
      writable: true,
      projectAvailable: true,
      overBudget: false,
      rules: [current],
    }));
    view();
    fireEvent.click(await screen.findByRole('button', { name: `conversation.rules.editNamed: ${rule.title}` }));
    const field = screen.getByLabelText('conversation.rules.instruction');
    fireEvent.change(field, { target: { value: 'My draft' } });
    current = { ...rule, content: 'Changes from agent', revision: 'v2' };
    await waitFor(() => expect(screen.getByText('Changes from agent')).toBeVisible(), { timeout: 6000 });
    expect(field).toHaveValue('My draft');
    expect(screen.getByRole('alert')).toHaveTextContent('conversation.rules.stale');
    expect(button('common.save')).toBeDisabled();
    expect(api.write).not.toHaveBeenCalled();
  });

  it('retains the draft and blocks repeat writes after a version conflict between polls', async () => {
    api.list.mockResolvedValue({
      enabled: true,
      writable: true,
      projectAvailable: true,
      overBudget: false,
      rules: [rule],
    });
    api.write.mockRejectedValue(new BackendHttpError({ method: 'POST', path: '/rules', status: 409, body: {} }));
    view();
    fireEvent.click(await screen.findByRole('button', { name: `conversation.rules.editNamed: ${rule.title}` }));
    const field = screen.getByLabelText('conversation.rules.instruction');
    fireEvent.change(field, { target: { value: 'Updated' } });
    fireEvent.click(button('common.save'));
    expect(await screen.findByRole('alert')).toHaveTextContent('conversation.rules.stale');
    expect(field).toHaveValue('Updated');
    expect(button('common.save')).toBeDisabled();
    expect(api.write).toHaveBeenCalledWith({
      conversation_id: 'chat-a',
      mutation: {
        action: 'edit',
        scope: 'project',
        title: rule.title,
        content: 'Updated',
        path: rule.path,
        revision: 'v1',
      },
    });
  });

  it('distinguishes a failed lookup from an empty or isolated chat and allows retry', async () => {
    api.list
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValue({ enabled: false, writable: false, projectAvailable: false, overBudget: false, rules: [] });
    view();
    await screen.findByText('conversation.rules.loadFailed');
    expect(screen.queryByText('conversation.rules.emptyGlobal')).toBeNull();
    fireEvent.click(button('common.retry'));
    await screen.findByText('conversation.rules.disabled');
    expect(screen.queryByRole('button', { name: 'conversation.rules.addGlobal' })).toBeNull();
  });
  it('discards cached bodies and the open draft when a live read loses authorization', async () => {
    api.list
      .mockResolvedValueOnce({
        enabled: true,
        writable: true,
        projectAvailable: true,
        overBudget: false,
        rules: [rule],
      })
      .mockRejectedValue(
        new BackendHttpError({ method: 'GET', path: '/rules', status: 403, body: 'Private server detail' })
      );
    view();
    fireEvent.click(await screen.findByRole('button', { name: `conversation.rules.editNamed: ${rule.title}` }));
    fireEvent.change(screen.getByLabelText('conversation.rules.instruction'), { target: { value: 'Private draft' } });
    await waitFor(() => expect(screen.getByText('conversation.rules.unavailable')).toBeVisible(), { timeout: 6000 });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText(rule.content)).toBeNull();
    expect(screen.queryByDisplayValue('Private draft')).toBeNull();
    api.list.mockResolvedValue({ enabled: true, writable: true, projectAvailable: true, overBudget: false, rules: [] });
    fireEvent.click(button('common.retry'));
    await screen.findByText('conversation.rules.emptyGlobal');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each([401, 403, 404])('clears the sensitive list on rejected mutation (HTTP %s)', async (status) => {
    api.list.mockResolvedValue({
      enabled: true,
      writable: true,
      projectAvailable: true,
      overBudget: false,
      rules: [rule],
    });
    api.write.mockRejectedValue(
      new BackendHttpError({ method: 'POST', path: '/rules', status, body: 'Private server detail' })
    );
    view();
    fireEvent.click(await screen.findByRole('button', { name: `conversation.rules.editNamed: ${rule.title}` }));
    fireEvent.click(button('common.save'));
    expect(await screen.findByRole('alert')).toHaveTextContent('conversation.rules.unavailable');
    expect(screen.queryByText(rule.content)).toBeNull();
    expect(screen.queryByText(/Private server detail/)).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('preserves a draft on a transient read error and resumes saving after a successful refresh', async () => {
    const active = { enabled: true, writable: true, projectAvailable: true, overBudget: false, rules: [rule] };
    api.list.mockResolvedValueOnce(active).mockRejectedValue(new Error('Temporary failure'));
    view();
    fireEvent.click(await screen.findByRole('button', { name: `conversation.rules.editNamed: ${rule.title}` }));
    const dialog = within(screen.getByRole('dialog'));
    const field = dialog.getByLabelText('conversation.rules.instruction');
    fireEvent.change(field, { target: { value: 'Still editing' } });
    await waitFor(() => expect(dialog.getByRole('alert')).toHaveTextContent('conversation.rules.staleList'), {
      timeout: 6000,
    });
    expect(field).toHaveValue('Still editing');
    expect(dialog.getByRole('button', { name: 'common.save' })).toBeDisabled();
    api.list.mockResolvedValue(active);
    fireEvent.click(dialog.getByRole('button', { name: 'common.retry' }));
    await waitFor(() => expect(dialog.getByRole('button', { name: 'common.save' })).toBeEnabled());
    expect(field).toHaveValue('Still editing');
  });

  it('blocks adding to over-budget rules and allows shortening an existing instruction', async () => {
    let catalog: ChatRules = { enabled: true, writable: true, projectAvailable: true, overBudget: true, rules: [rule] };
    api.list.mockImplementation(async () => catalog);
    api.write.mockImplementation(async () => {
      catalog = { ...catalog, overBudget: false, rules: [{ ...rule, content: 'Test' }] };
    });
    view();
    expect(await screen.findByRole('alert')).toHaveTextContent('conversation.rules.overBudget');
    expect(button('conversation.rules.addGlobal')).toBeDisabled();
    expect(button('conversation.rules.addProject')).toBeDisabled();
    expect(button(`conversation.rules.deleteNamed: ${rule.title}`)).toBeEnabled();
    fireEvent.click(button(`conversation.rules.editNamed: ${rule.title}`));
    fireEvent.change(screen.getByLabelText('conversation.rules.instruction'), { target: { value: 'Test' } });
    fireEvent.click(button('common.save'));
    await screen.findByText('Test');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(button('conversation.rules.addProject')).toBeEnabled();
  });
});
