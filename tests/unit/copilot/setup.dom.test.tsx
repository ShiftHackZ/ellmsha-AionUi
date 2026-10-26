import React from 'react';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CopilotIdeSetup from '@/renderer/pages/settings/AgentSettings/CopilotIde';
import type { CopilotIdeStatus, CopilotIdeAction } from '@/common/types/platform/electron';

const translate = (key: string) => key;
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/renderer/pages/settings/components/SettingsPageWrapper', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('swr', () => ({ mutate: vi.fn() }));
let status: CopilotIdeStatus;
let api: ReturnType<typeof vi.fn>;
beforeEach(() => {
  status = { enabled: false, running: false, starting: false, busy: false, models: [], runtimeAvailable: true };
  api = vi.fn(async (action: CopilotIdeAction) => {
    if (action === 'enable') status = { ...status, enabled: true };
    return status;
  });
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { copilotIde: api } });
});
afterEach(() => cleanup());

describe('Copilot setup controls', () => {
  it('loads status without login/model fetch and enables without waking the runtime', async () => {
    render(<CopilotIdeSetup />);
    const enable = await screen.findByRole('button', { name: 'settings.copilotIde.enable' });
    await waitFor(() => expect(enable).not.toBeDisabled());
    expect(api.mock.calls.map((call) => call[0])).toEqual(['status']);
    fireEvent.click(enable);
    await screen.findByRole('button', { name: 'settings.copilotIde.disable' });
    expect(api.mock.calls.map((call) => call[0])).toEqual(['status', 'enable']);
  });
  it('disables stop and disable actions during an active model request', async () => {
    status = { ...status, enabled: true, running: true, busy: true };
    render(<CopilotIdeSetup />);
    expect(await screen.findByRole('button', { name: 'settings.copilotIde.disable' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'settings.copilotIde.stop' })).toBeDisabled();
  });
  it('does not expose desktop controls in the web UI', () => {
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined });
    render(<CopilotIdeSetup />);
    expect(screen.queryByTestId('copilot-ide-setup')).toBeNull();
  });
});

it('can disable a previously enabled provider when its runtime assets are missing', async () => {
  status = { ...status, enabled: true, runtimeAvailable: false };
  render(<CopilotIdeSetup />);
  expect(await screen.findByRole('button', { name: 'settings.copilotIde.disable' })).not.toBeDisabled();
});
