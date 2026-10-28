import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IExtensionInfo } from '@/common/adapter/ipcBridge';
import liveCatalog from '../../fixtures/api/extensions-sd07-live.json';
import PluginsContent from '@/renderer/pages/settings/PluginsSettings/PluginsContent';
import PluginsSettings from '@/renderer/pages/settings/PluginsSettings';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

type MockButtonProps = Omit<React.ComponentProps<'button'>, 'type'> & {
  loading?: boolean;
  icon?: React.ReactNode;
  type?: string;
  status?: string;
};
type MockInputProps = Omit<React.ComponentProps<'input'>, 'onChange'> & {
  prefix?: React.ReactNode;
  allowClear?: boolean;
  onChange?: (value: string) => void;
};
type MockSwitchProps = Omit<React.ComponentProps<'input'>, 'checked' | 'onChange'> & {
  checked?: boolean;
  loading?: boolean;
  onChange?: (checked: boolean) => void;
};

const bridge = vi.hoisted(() => ({
  list: vi.fn(),
  linear: vi.fn(),
  linearList: vi.fn(),
  clockify: vi.fn(),
  notion: vi.fn(),
  notionDisconnect: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
  install: vi.fn(),
  update: vi.fn(),
  uninstall: vi.fn(),
  systemInfo: vi.fn(),
  computerUsePermissions: vi.fn(),
}));
const translate = vi.hoisted(
  () => (key: string, options?: { count?: number }) => (options?.count === undefined ? key : `${key}:${options.count}`)
);

vi.mock('@/common', () => ({
  ipcBridge: {
    application: {
      systemInfo: { invoke: bridge.systemInfo },
      checkComputerUsePermissions: { invoke: bridge.computerUsePermissions },
    },
    extensions: {
      getLoadedExtensions: { invoke: bridge.list },
      migrateLegacyLinearConnection: { invoke: bridge.linear },
      getLinearConnections: { invoke: bridge.linearList },
      getClockifyConnections: { invoke: bridge.clockify },
      getNotionConnections: { invoke: bridge.notion },
      disconnectNotionConnection: { invoke: bridge.notionDisconnect },
      enableExtension: { invoke: bridge.enable },
      disableExtension: { invoke: bridge.disable },
      installPlugin: { invoke: bridge.install },
      updatePlugin: { invoke: bridge.update },
      uninstallPlugin: { invoke: bridge.uninstall },
    },
  },
}));

vi.mock('@/renderer/pages/settings/components/SettingsPageWrapper', () => ({
  default: ({ children }: React.PropsWithChildren) => <main>{children}</main>,
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }));

vi.mock('@/renderer/components/base/TalkToButlerButton', () => ({
  AION_ADD_BUTTON_CLASS: '!h-32px !rounded-8px !px-14px',
}));
vi.mock('@/renderer/pages/settings/PluginsSettings/ClockifyAccounts', () => ({
  default: () => <div data-testid='clockify-detail'>Clockify detail</div>,
}));
vi.mock('@icon-park/react', () => ({
  AddUser: () => null,
  ArrowLeft: () => null,
  CheckOne: () => <span data-icon='check' />,
  CodeBrackets: () => <span data-icon='code' />,
  Computer: () => <span data-icon='computer' />,
  Login: () => null,
  Link: () => null,
  Refresh: () => null,
  Unlink: () => null,
  Phone: () => <span data-icon='mobile' />,
  Puzzle: () => <span data-icon='plugin' />,
  Right: () => null,
  Search: () => null,
  User: () => <span data-icon='account' />,
}));
vi.mock('@arco-design/web-react', () => ({
  Avatar: ({
    children,
    size: _size,
    shape: _shape,
    ...props
  }: React.PropsWithChildren<{ size?: number; shape?: string }>) => <span {...props}>{children}</span>,
  Button: ({ children, loading: _loading, icon: _icon, type: _type, status: _status, ...props }: MockButtonProps) => (
    <button {...props}>{children}</button>
  ),
  Empty: ({ description }: { description?: React.ReactNode }) => <div>{description}</div>,
  Input: ({ prefix: _prefix, allowClear: _allowClear, onChange, ...props }: MockInputProps) => (
    <input {...props} onChange={(event) => onChange?.(event.target.value)} />
  ),
  Message: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
  Popconfirm: ({ children, onOk }: React.PropsWithChildren<{ onOk?: () => void }>) => (
    <span data-testid='popconfirm' onClick={() => onOk?.()}>
      {children}
    </span>
  ),
  Spin: () => <span data-testid='spin' />,
  Switch: ({ checked, loading: _loading, onChange, ...props }: MockSwitchProps) => (
    <input {...props} type='checkbox' checked={checked} onChange={(event) => onChange?.(event.target.checked)} />
  ),
  Tag: ({ children, color: _color }: React.PropsWithChildren<{ color?: string }>) => <span>{children}</span>,
}));

beforeEach(() => {
  window.__backendPort = 13400;
  bridge.list.mockResolvedValue([
    ...(liveCatalog as unknown as IExtensionInfo[]).map((plugin) =>
      plugin.name === 'sd07-live-qa'
        ? {
            ...plugin,
            source_provenance: {
              source_type: 'git' as const,
              url: 'https://github.com/trailofbits/skills.git',
              ref: '442fc9d6c89b1e937e6f7a477e7071ea75fcbea4',
              subdirectory: 'plugins/vulnerability-triage-brocards',
              resolved_revision: '442fc9d6c89b1e937e6f7a477e7071ea75fcbea4',
            },
          }
        : plugin
    ),
    {
      name: 'computer-use',
      display_name: 'Open Computer Use',
      description: 'Desktop interaction.',
      version: '1.0.0',
      source: 'builtin',
      enabled: true,
      package_format: 'native',
    },
  ]);
  bridge.linear.mockResolvedValue({ connections: [] });
  bridge.linearList.mockResolvedValue({ connections: [] });
  bridge.clockify.mockResolvedValue({ connections: [] });
  bridge.notion.mockResolvedValue({ connections: [] });
  bridge.enable.mockResolvedValue(undefined);
  bridge.disable.mockResolvedValue(undefined);
  bridge.install.mockResolvedValue({
    name: 'sd07-live-qa',
    version: '1.0.0',
    directory: '/tmp/plugins/sd07-live-qa',
    provenance: {},
  });
  bridge.update.mockResolvedValue(undefined);
  bridge.uninstall.mockResolvedValue(undefined);
  bridge.systemInfo.mockResolvedValue({ platform: 'darwin', arch: 'arm64' });
  bridge.computerUsePermissions.mockResolvedValue({
    success: true,
    data: {
      supported: true,
      platform: 'darwin',
      accessibility: 'granted',
      screenRecording: 'granted',
      onboardingOpened: false,
    },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  delete window.__backendPort;
});

describe('PluginsContent live catalog compatibility', () => {
  it('uses read-only account loading and hides machine-wide package actions in WebUI', async () => {
    delete window.__backendPort;

    render(<PluginsContent />);

    expect(await screen.findByText('Clockify')).toBeInTheDocument();
    expect(bridge.linearList).toHaveBeenCalledTimes(1);
    expect(bridge.linear).not.toHaveBeenCalled();
    expect(screen.queryByText('settings.pluginInstallGit')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('sd07-live-qa').closest('[role="button"]')!);
    expect(await screen.findByText('settings.pluginInstallSource')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'settings.pluginUpdateFromSource' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'settings.pluginUninstall' })).not.toBeInTheDocument();
  });

  it('renders native and imported catalog rows and opens both detail shapes without crashing', async () => {
    render(<PluginsContent />);

    expect(await screen.findByText('Clockify')).toBeInTheDocument();
    expect(screen.getByText('Linear')).toBeInTheDocument();
    expect(screen.getByText('Mobile Next')).toBeInTheDocument();
    expect(screen.getByText('Plugin Authoring')).toBeInTheDocument();
    expect(screen.getByText('sd07-live-qa')).toBeInTheDocument();
    expect(screen.getByText('Open Computer Use')).toBeInTheDocument();
    expect(screen.getByTestId('plugin-icon-clockify')).toBeInTheDocument();
    expect(screen.getByTestId('plugin-icon-linear')).toBeInTheDocument();
    expect(screen.getByTestId('plugin-icon-mobile')).toBeInTheDocument();
    expect(screen.getByTestId('plugin-icon-plugin-dev')).toBeInTheDocument();
    expect(screen.getByTestId('plugin-icon-sd07-live-qa')).toBeInTheDocument();
    expect(screen.getByTestId('plugin-icon-computer-use')).toBeInTheDocument();
    expect(screen.getByTestId('plugin-brand-logo-clockify')).toHaveAttribute(
      'src',
      expect.stringContaining('data:image/svg+xml')
    );
    expect(screen.getByTestId('plugin-brand-logo-linear')).toHaveAttribute(
      'src',
      expect.stringContaining('data:image/svg+xml')
    );
    expect(screen.getByTestId('plugin-brand-logo-clockify')).toHaveStyle({ margin: 'auto' });
    expect(screen.getByTestId('plugin-brand-logo-linear')).toHaveStyle({ margin: 'auto' });
    expect(screen.getByTestId('plugin-icon-sd07-live-qa').querySelector('[data-icon="plugin"]')).toBeInTheDocument();

    const clockifyRow = screen.getByText('Clockify').closest('[role="button"]');
    expect(clockifyRow).toHaveClass('bg-base', 'rd-12px', 'px-14px', 'py-10px');

    fireEvent.click(screen.getByText('sd07-live-qa').closest('[role="button"]')!);
    expect(await screen.findByText('settings.pluginCompatibility')).toBeInTheDocument();
    expect(screen.getByText('settings.pluginComponent.skills')).toBeInTheDocument();
    expect(screen.getByText('settings.pluginComponent.mcp_servers')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'settings.pluginDetailBack' }));
    await waitFor(() => expect(screen.getByText('Clockify')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Clockify').closest('[role="button"]')!);
    expect(await screen.findByTestId('clockify-detail')).toBeInTheDocument();
    expect(screen.getByTestId('plugin-brand-logo-clockify')).toBeInTheDocument();
  });

  it('checks macOS Computer Use permissions through the native runtime bridge', async () => {
    render(<PluginsContent />);

    fireEvent.click((await screen.findByText('Open Computer Use')).closest('[role="button"]')!);
    expect(await screen.findByText('settings.computerUseSetupTitle')).toBeInTheDocument();
    expect(bridge.systemInfo).toHaveBeenCalledTimes(1);

    const checkButton = screen.getByRole('button', { name: 'settings.computerUseCheckPermissions' });
    expect(checkButton).toHaveClass('!h-32px', '!rounded-8px', '!px-14px');
    fireEvent.click(checkButton);

    await waitFor(() => expect(bridge.computerUsePermissions).toHaveBeenCalledTimes(1));
    expect(await screen.findAllByText('settings.computerUsePermissionStatus.granted')).toHaveLength(2);
  });

  it('shows a permission check failure and clears it after a successful retry', async () => {
    bridge.computerUsePermissions
      .mockResolvedValueOnce({ success: false, msg: 'COMPUTER_USE_PERMISSION_CHECK_FAILED' })
      .mockResolvedValueOnce({
        success: true,
        data: {
          supported: true,
          platform: 'darwin',
          accessibility: 'missing',
          screenRecording: 'granted',
          onboardingOpened: true,
        },
      });
    render(<PluginsContent />);

    fireEvent.click((await screen.findByText('Open Computer Use')).closest('[role="button"]')!);
    fireEvent.click(await screen.findByRole('button', { name: 'settings.computerUseCheckPermissions' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('settings.computerUseCheckError');

    const retryButton = screen.getByRole('button', { name: 'settings.computerUseCheckAgain' });
    expect(retryButton).toHaveClass('!h-32px', '!rounded-8px', '!px-14px');
    fireEvent.click(retryButton);

    expect(await screen.findByText('settings.computerUseOnboardingOpened')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('explains that Computer Use permission setup is unavailable in WebUI', async () => {
    delete window.__backendPort;
    render(<PluginsContent />);

    fireEvent.click((await screen.findByText('Open Computer Use')).closest('[role="button"]')!);

    expect(await screen.findByText('settings.computerUseWebUnsupported')).toBeInTheDocument();
    expect(bridge.systemInfo).not.toHaveBeenCalled();
    expect(bridge.computerUsePermissions).not.toHaveBeenCalled();
  });

  it('does not offer the macOS permission action on a non-macOS desktop', async () => {
    bridge.systemInfo.mockResolvedValue({ platform: 'linux', arch: 'arm64' });
    render(<PluginsContent />);

    fireEvent.click((await screen.findByText('Open Computer Use')).closest('[role="button"]')!);

    expect(await screen.findByText('settings.computerUsePlatformUnsupported')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'settings.computerUseCheckPermissions' })).not.toBeInTheDocument();
    expect(bridge.computerUsePermissions).not.toHaveBeenCalled();
  });

  it('installs a selected Git subdirectory and reuses recorded provenance for update and uninstall', async () => {
    render(<PluginsContent />);
    await screen.findByText('Clockify');

    expect(screen.queryByPlaceholderText('settings.pluginGitUrlPlaceholder')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'settings.pluginInstall' }));
    expect(screen.queryByPlaceholderText('settings.pluginsSearchPlaceholder')).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('settings.pluginGitUrlPlaceholder'), {
      target: { value: 'https://github.com/trailofbits/skills.git' },
    });
    fireEvent.change(screen.getByPlaceholderText('settings.pluginGitRefPlaceholder'), {
      target: { value: '442fc9d6c89b1e937e6f7a477e7071ea75fcbea4' },
    });
    fireEvent.change(screen.getByPlaceholderText('settings.pluginGitSubdirectoryPlaceholder'), {
      target: { value: 'plugins/vulnerability-triage-brocards' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'settings.pluginInstall' }));

    await waitFor(() =>
      expect(bridge.install).toHaveBeenCalledWith({
        type: 'git',
        url: 'https://github.com/trailofbits/skills.git',
        ref: '442fc9d6c89b1e937e6f7a477e7071ea75fcbea4',
        subdirectory: 'plugins/vulnerability-triage-brocards',
      })
    );
    expect(await screen.findByText('settings.pluginInstallSource')).toBeInTheDocument();
    expect(screen.getByText('https://github.com/trailofbits/skills.git')).toBeInTheDocument();
    expect(screen.getAllByText('442fc9d6c89b1e937e6f7a477e7071ea75fcbea4')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'settings.pluginUpdateFromSource' }));
    await waitFor(() => expect(bridge.update).toHaveBeenCalledWith({ name: 'sd07-live-qa' }));

    fireEvent.click(screen.getByRole('button', { name: 'settings.pluginUninstall' }));
    await waitFor(() => expect(bridge.uninstall).toHaveBeenCalledWith({ name: 'sd07-live-qa' }));
  });

  it('shows a recoverable inline error when the plugin catalog fails', async () => {
    bridge.list.mockRejectedValueOnce(new Error('catalog unavailable'));
    render(<PluginsContent />);

    expect(await screen.findByRole('alert')).toHaveTextContent('settings.pluginsLoadError');
    fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));

    expect(await screen.findByText('Clockify')).toBeInTheDocument();
    expect(bridge.list).toHaveBeenCalledTimes(2);
  });

  it('keeps nested switch keyboard input from opening plugin detail', async () => {
    render(<PluginsContent />);

    const linearRow = (await screen.findByText('Linear')).closest('[role="button"]')!;
    const linearSwitch = linearRow.querySelector('input[type="checkbox"]')!;
    fireEvent.keyDown(linearSwitch, { key: ' ' });
    expect(screen.getByText('Clockify')).toBeInTheDocument();

    fireEvent.keyDown(linearRow, { key: 'Enter' });
    expect(await screen.findByText('settings.linearConnectedAccounts')).toBeInTheDocument();
    expect(screen.getAllByTestId('plugin-brand-logo-linear')).toHaveLength(2);
  });

  it('distinguishes a Linear account load failure from an empty account list and retries it', async () => {
    bridge.linear.mockRejectedValueOnce(new Error('linear unavailable'));
    render(<PluginsContent />);

    fireEvent.click((await screen.findByText('Linear')).closest('[role="button"]')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('settings.pluginsLoadError');
    expect(screen.queryByText('settings.linearNoConnectedAccounts')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'settings.linearConnectAccount' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));
    expect(await screen.findByText('settings.linearNoConnectedAccounts')).toBeInTheDocument();
    expect(bridge.linear).toHaveBeenCalledTimes(2);
  });

  it('shows each Linear identity field once and keeps workspace separate', async () => {
    bridge.linear.mockResolvedValue({
      connections: [
        {
          id: 'linear-named',
          namespace: 'linear-team-ada-linear-named',
          label: 'Stored Ada',
          status: 'connected',
          identity: {
            account_id: 'account-ada',
            account_name: 'Ada Lovelace',
            account_email: 'ada@example.test',
            workspace_id: 'workspace-1',
            workspace_name: 'Analytical Engines',
          },
          capabilities: {},
          migrated: false,
          created_at: 1,
          updated_at: 1,
        },
        {
          id: 'linear-email-only',
          namespace: 'linear-team-email-linear-email-only',
          label: 'email@example.test',
          status: 'connected',
          identity: {
            account_id: 'account-email',
            account_name: 'email@example.test',
            account_email: 'email@example.test',
            workspace_id: 'workspace-2',
            workspace_name: 'Email Workspace',
          },
          capabilities: {},
          migrated: false,
          created_at: 1,
          updated_at: 1,
        },
      ],
    });

    render(<PluginsContent />);
    fireEvent.click((await screen.findByText('Linear')).closest('[role="button"]')!);

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getAllByText('ada@example.test')).toHaveLength(1);
    expect(screen.getAllByText('email@example.test')).toHaveLength(1);
    expect(screen.getAllByText('settings.linearWorkspaceIdentity')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'settings.pluginDetailBack' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'settings.linearConnectAnotherAccount' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'settings.linearReconnect' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'settings.linearDisconnect' })).toHaveLength(2);
  });
});

const LocationPreview = () => {
  const location = useLocation();
  return (
    <output data-testid='route-location'>
      {location.pathname}
      {location.search}
    </output>
  );
};
const renderPluginPage = (url = '/settings/plugins') =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path='/settings/plugins' element={<PluginsSettings />} />
        <Route path='/settings/plugins/:pluginName' element={<PluginsSettings />} />
      </Routes>
      <LocationPreview />
    </MemoryRouter>
  );

describe('Plugins settings page navigation', () => {
  it('opens Git installation from the page-header action and returns to the catalog', async () => {
    renderPluginPage();
    await screen.findByText('Clockify');
    expect(screen.queryByPlaceholderText('settings.pluginGitUrlPlaceholder')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'settings.pluginInstall' }));
    expect(await screen.findByPlaceholderText('settings.pluginGitUrlPlaceholder')).toBeInTheDocument();
    expect(screen.getByTestId('route-location')).toHaveTextContent('/settings/plugins?view=install');
    expect(screen.queryByText('Clockify')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('settings.pluginsSearchPlaceholder')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'settings.pluginDetailBack' }));
    expect(await screen.findByText('Clockify')).toBeInTheDocument();
    expect(screen.getByTestId('route-location')).toHaveTextContent('/settings/plugins');
    expect(screen.queryByPlaceholderText('settings.pluginGitUrlPlaceholder')).not.toBeInTheDocument();
  });

  it('shows only connected Notion identities and updates the catalog after a disconnect', async () => {
    bridge.list.mockResolvedValue([
      { name: 'notion', display_name: 'Notion', version: '1.0.0', source: 'builtin', enabled: true },
    ]);
    const accounts = ['a', 'b', 'c'].map((id) => ({
      id,
      namespace: `notion-${id}`,
      label: `Account ${id}`,
      status: id === 'c' ? 'reconnect_required' : 'connected',
      capabilities: { search: true, read: true, write: true },
      created_at: 1,
      updated_at: 1,
    }));
    bridge.notion.mockResolvedValue({ connections: accounts });
    renderPluginPage('/settings/plugins');
    expect(await screen.findByText('settings.pluginAccountCount:2')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Notion'));
    await screen.findByText('Account a');
    const disconnected = { ...accounts[0], status: 'disconnected' };
    bridge.notionDisconnect.mockResolvedValue(disconnected);
    bridge.notion.mockResolvedValue({ connections: [disconnected, ...accounts.slice(1)] });
    fireEvent.click(screen.getAllByRole('button', { name: 'settings.notion.disconnect' })[0]);
    await waitFor(() => expect(bridge.notionDisconnect).toHaveBeenCalledWith({ connection_id: 'a' }));
    // Wait for the mutation's authoritative refresh before navigating back.
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'settings.notion.disconnect' })[0]).toBeDisabled()
    );
    fireEvent.click(screen.getByRole('button', { name: 'settings.pluginDetailBack' }));
    expect(await screen.findByText('settings.pluginAccountCount:1')).toBeInTheDocument();
  });

  it('does not invent a Notion count when its account list fails to load', async () => {
    bridge.list.mockResolvedValue([
      { name: 'notion', display_name: 'Notion', version: '1.0.0', source: 'builtin', enabled: true },
    ]);
    bridge.notion.mockRejectedValue(new Error('unavailable'));
    renderPluginPage('/settings/plugins');
    expect(await screen.findByText('Notion')).toBeInTheDocument();
    expect(screen.queryByText(/settings.pluginAccountCount:/)).not.toBeInTheDocument();
  });

  it('uses the shared plugin detail chrome for Notion and shows its account icon header', async () => {
    bridge.list.mockResolvedValue([
      {
        name: 'notion',
        display_name: 'Notion',
        description: 'Notion workspace connections',
        version: '1.0.0',
        source: 'builtin',
        enabled: true,
        package_format: 'native',
      },
    ]);
    renderPluginPage('/settings/plugins/notion');
    expect(await screen.findByText('settings.notion.accounts')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'settings.plugins' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'settings.pluginDetailBack' })).toBeInTheDocument();
    expect(screen.getAllByTestId('plugin-brand-logo-notion')).toHaveLength(2);
    expect(screen.getByText('settings.notion.connectTitle')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'settings.notion.connect' })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('settings.pluginGitUrlPlaceholder')).not.toBeInTheDocument();
  });
});
