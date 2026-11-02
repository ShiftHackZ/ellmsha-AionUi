import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ list: vi.fn(), connect: vi.fn(), reconnect: vi.fn(), disconnect: vi.fn() }));
vi.mock('@/common', () => ({
  ipcBridge: {
    extensions: {
      getFigmaConnections: { invoke: api.list },
      connectNewFigmaConnection: { invoke: api.connect },
      reconnectFigmaConnection: { invoke: api.reconnect },
      disconnectFigmaConnection: { invoke: api.disconnect },
    },
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import FigmaAccounts from '@/renderer/pages/settings/PluginsSettings/FigmaAccounts';
import PluginIcon from '@/renderer/pages/settings/PluginsSettings/PluginIcon';
const account = {
  id: 'account-one',
  namespace: 'figma-one',
  label: 'Work account',
  status: 'connected',
  identity: { account_id: 'one', account_name: 'One', account_email: 'one@example.test' },
  created_at: 1,
  updated_at: 1,
};
beforeEach(() => {
  vi.clearAllMocks();
  api.list.mockResolvedValue({ connections: [] });
});
describe('Figma account settings', () => {
  it('uses the bundled Figma brand mark while keeping account avatars distinct', () => {
    render(
      <>
        <PluginIcon name='figma' />
        <PluginIcon name='figma' account />
      </>
    );
    expect(screen.getByTestId('plugin-brand-logo-figma')).toHaveAttribute(
      'src',
      expect.stringContaining('data:image/svg+xml')
    );
    expect(screen.getByTestId('plugin-account-icon-figma').querySelector('img')).toBeNull();
  });
  it('privately connects and clears the token, blocks duplicate submissions and renders verified identity', async () => {
    let finish!: (value: unknown) => void;
    api.connect.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    render(<FigmaAccounts enabled />);
    await screen.findByText('settings.figma.empty');
    const input = screen.getByLabelText('settings.figma.token');
    expect(input).toHaveAttribute('type', 'password');
    fireEvent.change(input, { target: { value: 'fixture-private-token' } });
    const button = screen.getByRole('button', { name: 'settings.figma.connect' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(api.connect).toHaveBeenCalledTimes(1);
    expect(api.connect).toHaveBeenCalledWith({ personal_access_token: 'fixture-private-token' });
    api.list.mockResolvedValue({ connections: [account] });
    finish(account);
    await screen.findByText('Work account');
    expect(input).toHaveValue('');
    expect(screen.getByText('one@example.test')).toBeVisible();
    expect(screen.queryByText('fixture-private-token')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'settings.figma.reconnect' }));
    fireEvent.change(input, { target: { value: 'replacement-token' } });
    api.reconnect.mockResolvedValue(account);
    fireEvent.click(screen.getAllByRole('button', { name: 'settings.figma.reconnect' })[0]);
    await waitFor(() =>
      expect(api.reconnect).toHaveBeenCalledWith({
        connection_id: 'account-one',
        personal_access_token: 'replacement-token',
      })
    );
  });
  it('shows a recoverable list error and disables account mutations for inactive plugins', async () => {
    api.list.mockRejectedValueOnce(new Error('offline fixture'));
    render(<FigmaAccounts enabled={false} />);
    await screen.findByRole('alert');
    expect(screen.getByLabelText('settings.figma.token')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'settings.figma.connect' })).toBeDisabled();
    api.list.mockResolvedValue({ connections: [account] });
    fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));
    await screen.findByText('Work account');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
