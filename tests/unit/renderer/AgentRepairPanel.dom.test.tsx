/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Message } from '@arco-design/web-react';
import AgentRepairPanel from '@/renderer/pages/settings/AgentSettings/Repair/AgentRepairPanel';
import type { ManagedAgent } from '@/renderer/utils/model/agentTypes';
import { acpConversation, systemSettings } from '@/common/adapter/ipcBridge';

vi.mock('@/common/adapter/ipcBridge', () => ({
  acpConversation: {
    getAgentOverrides: {
      invoke: vi.fn(),
    },
    setAgentOverrides: {
      invoke: vi.fn(),
    },
  },
  systemSettings: {
    getCliRuntime: { invoke: vi.fn() },
    setCliRuntimeSelection: { invoke: vi.fn() },
    updateCliRuntime: { invoke: vi.fn() },
    rollbackCliRuntime: { invoke: vi.fn() },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('AgentRepairPanel', () => {
  const mockAgent: ManagedAgent = {
    id: 'test-agent-1',
    name: 'Test Agent',
    agent_type: 'acp',
    agent_source: 'custom',
    command: '/usr/local/bin/test-cli',
    enabled: true,
    installed: true,
    status: 'offline',
    env_override_key_count: 2,
    has_command_override: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Message, 'success').mockImplementation(() => undefined as never);
  });

  it('loads current overrides on mount without an unlock step', async () => {
    const getMock = vi.mocked(acpConversation.getAgentOverrides.invoke);
    getMock.mockResolvedValue({
      command_override: '/custom/path/cli',
      env_override: [{ name: 'API_KEY', value: 'secret123' }],
    });
    const onSaved = vi.fn();

    render(<AgentRepairPanel agent={mockAgent} onSaved={onSaved} />);

    await waitFor(() => {
      expect(getMock).toHaveBeenCalledWith({ id: 'test-agent-1' });
    });
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/repair\.pathPlaceholder/)).toHaveValue('/custom/path/cli');
    });
  });

  it('saves overrides then triggers test connection once', async () => {
    const user = userEvent.setup();
    const getMock = vi.mocked(acpConversation.getAgentOverrides.invoke);
    const setMock = vi.mocked(acpConversation.setAgentOverrides.invoke);
    const onSaved = vi.fn();

    getMock.mockResolvedValue({
      command_override: '/custom/path/cli',
      env_override: [
        { name: 'API_KEY', value: 'secret123' },
        { name: 'FACTORY_URL', value: 'http://localhost:8080' },
      ],
    });

    setMock.mockResolvedValue({
      ...mockAgent,
      status: 'online',
      has_command_override: true,
      env_override_key_count: 2,
    });

    render(<AgentRepairPanel agent={mockAgent} onSaved={onSaved} />);

    // Overrides load on mount — wait for the path input to fill.
    await waitFor(() => {
      expect(getMock).toHaveBeenCalledWith({ id: 'test-agent-1' });
    });
    await waitFor(() => {
      const pathInput = screen.getByPlaceholderText(/repair\.pathPlaceholder/);
      expect(pathInput).toHaveValue('/custom/path/cli');
    });

    // Change path
    const pathInput = screen.getByPlaceholderText(/repair\.pathPlaceholder/);
    await user.clear(pathInput);
    await user.type(pathInput, '/new/path/cli');

    // Save
    const saveButton = screen.getByRole('button', { name: /repair\.saveAndTest/ });
    await user.click(saveButton);

    await waitFor(() => {
      expect(setMock).toHaveBeenCalledWith({
        id: 'test-agent-1',
        command_override: '/new/path/cli',
        env_override: [
          { name: 'API_KEY', value: 'secret123' },
          { name: 'FACTORY_URL', value: 'http://localhost:8080' },
        ],
      });
      expect(Message.success).toHaveBeenCalledWith('settings.agentManagement.testConnectionOnline');
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
  });

  it('blocks save on duplicate env keys', async () => {
    const user = userEvent.setup();
    const getMock = vi.mocked(acpConversation.getAgentOverrides.invoke);
    const setMock = vi.mocked(acpConversation.setAgentOverrides.invoke);
    const onSaved = vi.fn();

    getMock.mockResolvedValue({
      env_override: [
        { name: 'API_KEY', value: 'secret1' },
        { name: 'API_KEY', value: 'secret2' },
      ],
    });

    render(<AgentRepairPanel agent={mockAgent} onSaved={onSaved} />);

    // Wait for the mount-time load to populate the duplicate env rows.
    await waitFor(() => {
      expect(getMock).toHaveBeenCalledWith({ id: 'test-agent-1' });
    });

    // Try to save
    const saveButton = screen.getByRole('button', { name: /repair\.saveAndTest/ });
    await user.click(saveButton);

    // Should show error and not call setAgentOverrides
    await waitFor(() => {
      expect(screen.getByText(/repair\.duplicateKeysError/)).toBeInTheDocument();
    });

    expect(setMock).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('does not save when no override value was entered', async () => {
    const user = userEvent.setup();
    const getMock = vi.mocked(acpConversation.getAgentOverrides.invoke);
    const setMock = vi.mocked(acpConversation.setAgentOverrides.invoke);
    const onSaved = vi.fn();

    getMock.mockResolvedValue({});

    render(<AgentRepairPanel agent={mockAgent} onSaved={onSaved} />);

    await waitFor(() => {
      expect(getMock).toHaveBeenCalledWith({ id: 'test-agent-1' });
    });

    const saveButton = screen.getByRole('button', { name: /repair\.saveAndTest/ });
    await user.click(saveButton);

    await waitFor(() => {
      expect(screen.getByText(/repair\.emptyOverridesError/)).toBeInTheDocument();
    });

    expect(setMock).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('shows the offline diagnostic banner and the launch path for an offline agent', async () => {
    vi.mocked(acpConversation.getAgentOverrides.invoke).mockResolvedValue({});

    render(<AgentRepairPanel agent={mockAgent} onSaved={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('settings.repair.offlineTitle')).toBeInTheDocument();
    });
    // Non-online agents expose the launch path as the primary lever.
    expect(screen.getByText('settings.repair.pathLabel')).toBeInTheDocument();
  });

  it('shows the online banner and hides the launch path entirely when online', async () => {
    vi.mocked(acpConversation.getAgentOverrides.invoke).mockResolvedValue({});

    render(<AgentRepairPanel agent={{ ...mockAgent, status: 'online' }} onSaved={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('settings.repair.onlineTitle')).toBeInTheDocument();
    });
    // Online: only environment variables are shown; the launch path is hidden.
    expect(screen.getByText('settings.repair.envLabel')).toBeInTheDocument();
    expect(screen.queryByText('settings.repair.pathLabel')).toBeNull();
  });

  it('does not expose override editing for the internal Aion CLI agent', async () => {
    vi.mocked(acpConversation.getAgentOverrides.invoke).mockResolvedValue({
      command_override: '/bad/path',
      env_override: [{ name: 'ANTHROPIC_API_KEY', value: 'sk-x' }],
    });

    render(
      <AgentRepairPanel
        agent={{
          ...mockAgent,
          id: '632f31d2',
          name: 'Aion CLI',
          agent_type: 'aionrs',
          agent_source: 'internal',
          status: 'online',
        }}
        onSaved={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('settings.repair.onlineTitle')).toBeInTheDocument();
    });

    expect(acpConversation.getAgentOverrides.invoke).not.toHaveBeenCalled();
    expect(screen.queryByText('settings.repair.pathLabel')).toBeNull();
    expect(screen.queryByText('settings.repair.envLabel')).toBeNull();
    expect(screen.queryByRole('button', { name: /repair\.saveAndTest/ })).toBeNull();
  });

  it('shows the resolved managed CLI path and version and updates explicitly', async () => {
    const user = userEvent.setup();
    vi.mocked(acpConversation.getAgentOverrides.invoke).mockResolvedValue({ env_override: [] });
    const runtime = {
      name: 'codex',
      selection: 'managed' as const,
      selection_explicit: true,
      available: true,
      resolved_path: '/managed/codex/0.162.1/codex',
      version: 'codex-cli 0.162.1',
      bundled_version: '0.162.1',
      active_managed_version: '0.162.1',
    };
    vi.mocked(systemSettings.getCliRuntime.invoke).mockResolvedValue(runtime);
    vi.mocked(systemSettings.updateCliRuntime.invoke).mockResolvedValue(runtime);

    render(
      <AgentRepairPanel
        agent={{ ...mockAgent, agent_source: 'builtin', backend: 'codex', command: 'codex' }}
        onSaved={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(document.body.textContent).toContain('/managed/codex/0.162.1/codex');
      expect(document.body.textContent).toContain('codex-cli 0.162.1');
    });
    expect(screen.queryByText('settings.repair.pathLabel')).toBeNull();

    const runtimeButtons = [
      screen.getByRole('button', { name: 'settings.repair.runtimeApply' }),
      screen.getByRole('button', { name: 'settings.repair.runtimeUpdate' }),
      screen.getByRole('button', { name: 'settings.repair.runtimeRollback' }),
    ];
    for (const button of runtimeButtons) {
      expect(button).toHaveClass('!h-32px', '!rounded-8px', '!px-14px');
    }
    expect(runtimeButtons[2]).toBeDisabled();
    expect(
      screen.getByRole('radio', { name: 'settings.repair.runtimeManaged' }).closest('.arco-radio-group')
    ).toHaveClass(
      '[&_.arco-radio-button]:!text-t-secondary',
      '[&_.arco-radio-button.arco-radio-checked]:!text-t-primary'
    );
    expect(screen.getByText('settings.repair.runtimeSessionPinHint')).toHaveClass('text-t-secondary');

    await user.click(runtimeButtons[1]);
    await waitFor(() => {
      expect(systemSettings.updateCliRuntime.invoke).toHaveBeenCalledWith({ name: 'codex' });
    });
  });

  it('shows a themed loading state while runtime status resolves', async () => {
    vi.mocked(acpConversation.getAgentOverrides.invoke).mockResolvedValue({ env_override: [] });
    vi.mocked(systemSettings.getCliRuntime.invoke).mockReturnValue(new Promise(() => {}));

    render(
      <AgentRepairPanel
        agent={{ ...mockAgent, agent_source: 'builtin', backend: 'codex', command: 'codex' }}
        onSaved={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('common.loading')).toBeInTheDocument();
    });
    expect(screen.getByText('settings.repair.runtimeTitle').parentElement).toHaveClass('bg-aou-2');
  });
});
