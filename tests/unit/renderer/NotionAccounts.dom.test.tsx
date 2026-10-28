import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotionConnection, NotionConnections } from '@/common/adapter/ipcBridge';
import NotionAccounts from '@/renderer/pages/settings/PluginsSettings/NotionAccounts';

const bridge = vi.hoisted(() => ({
  reconnect: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  list: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    extensions: {
      connectNotionConnection: { invoke: bridge.reconnect },
      connectNewNotionConnection: { invoke: bridge.connect },
      disconnectNotionConnection: { invoke: bridge.disconnect },
      getNotionConnections: { invoke: bridge.list },
    },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: { name?: string }) => (params?.name ? `${key}:${params.name}` : key),
  }),
}));

vi.mock('@icon-park/react', () => ({
  BranchTwo: () => null,
  CodeBrackets: () => null,
  Computer: () => null,
  Link: () => null,
  Phone: () => null,
  Puzzle: () => null,
  Refresh: () => null,
  Timer: () => null,
  Unlink: () => null,
  User: () => null,
}));

vi.mock('@arco-design/web-react', () => {
  return {
    Avatar: ({
      children,
      size: _size,
      shape: _shape,
      ...props
    }: React.PropsWithChildren<{ size?: number; shape?: string }>) => <span {...props}>{children}</span>,
    Button: ({ children, loading, icon: _icon, ...props }: React.ComponentProps<'button'> & { loading?: boolean }) => (
      <button {...props} data-loading={loading ? 'true' : 'false'}>
        {children}
      </button>
    ),
    Input: {
      Password: ({
        onChange,
        onPressEnter: _onPressEnter,
        ...props
      }: Omit<React.ComponentProps<'input'>, 'onChange'> & {
        onChange?: (value: string) => void;
        onPressEnter?: () => void;
      }) => <input {...props} type='password' onChange={(event) => onChange?.(event.target.value)} />,
    },
    Message: { success: vi.fn(), error: vi.fn() },
    Popconfirm: ({ children }: React.PropsWithChildren) => children,
    Select: Object.assign(
      ({ children, onChange, ...props }: React.ComponentProps<'select'> & { onChange?: (value: string) => void }) => (
        <select {...props} onChange={(event) => onChange?.(event.target.value)}>
          {children}
        </select>
      ),
      {
        Option: ({ children, ...props }: React.ComponentProps<'option'>) => <option {...props}>{children}</option>,
      }
    ),
    Spin: () => <span data-testid='spin' />,
    Tag: ({ children }: React.PropsWithChildren) => <span>{children}</span>,
  };
});

const account = (id: string): NotionConnection => ({
  id,
  namespace: `notion-${id}`,
  label: `Account ${id}`,
  status: 'connected',
  identity: {
    account_id: `user-${id}`,
    account_name: `Account ${id}`,
    account_email: `${id}@example.test`,
    workspace_id: `workspace-${id}`,
    workspace_name: `Workspace ${id}`,
  },
  capabilities: { search: true, read: true, write: true },
  created_at: 1,
  updated_at: 1,
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
beforeEach(() => {
  bridge.list.mockResolvedValue({ connections: [] });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('Notion account connections', () => {
  it('renders independent verified users and workspaces with shared account controls', async () => {
    bridge.list.mockResolvedValue({ connections: [account('a'), account('b')] });
    render(<NotionAccounts enabled />);
    expect(await screen.findByText('Workspace a')).toBeInTheDocument();
    expect(screen.getByText('Workspace b')).toBeInTheDocument();
    expect(screen.getByText('a@example.test')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'settings.notion.reconnect' })).toHaveLength(2);
  });
  it('starts browser authorization once and reconciles the authoritative accounts', async () => {
    const connecting = deferred<NotionConnection>();
    bridge.connect.mockReturnValue(connecting.promise);
    render(<NotionAccounts enabled />);
    const button = await screen.findByRole('button', { name: 'settings.notion.connect' });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    fireEvent.click(button);
    expect(bridge.connect).toHaveBeenCalledOnce();
    expect(button).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('settings.notion.authorizing');
    bridge.list.mockResolvedValue({ connections: [account('new')] });
    await act(async () => {
      connecting.resolve(account('new'));
    });
    expect(await screen.findByText('Workspace new')).toBeInTheDocument();
    expect(button).not.toBeDisabled();
  });
  it('reconnects only the selected account and recovers after failure', async () => {
    bridge.list.mockResolvedValue({ connections: [account('a'), account('b')] });
    bridge.reconnect.mockRejectedValue(new Error('private upstream error'));
    render(<NotionAccounts enabled />);
    await screen.findByText('Workspace a');
    fireEvent.click(screen.getAllByRole('button', { name: 'settings.notion.reconnect' })[1]);
    await waitFor(() => expect(bridge.reconnect).toHaveBeenCalledWith({ connection_id: 'b', reconnect: true }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'settings.notion.connect' })).not.toBeDisabled());
    expect(screen.getByText('Workspace a')).toBeInTheDocument();
    expect(screen.queryByText('private upstream error')).not.toBeInTheDocument();
  });
  it('offers retry after a list failure and prevents authorization when disabled', async () => {
    bridge.list.mockRejectedValueOnce(new Error('offline'));
    render(<NotionAccounts enabled={false} />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'settings.notion.connect' })).toBeDisabled();
    bridge.list.mockResolvedValue({ connections: [] });
    fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));
    expect(await screen.findByText('settings.notion.empty')).toBeInTheDocument();
    expect(bridge.connect).not.toHaveBeenCalled();
  });
  it('does not let a stale initial StrictMode load overwrite a new connection', async () => {
    const stale = deferred<NotionConnections>();
    bridge.list.mockReturnValueOnce(stale.promise).mockResolvedValue({ connections: [] });
    bridge.connect.mockResolvedValue(account('new'));
    render(
      <React.StrictMode>
        <NotionAccounts enabled />
      </React.StrictMode>
    );
    const connect = screen.getByRole('button', { name: 'settings.notion.connect' });
    await waitFor(() => expect(connect).not.toBeDisabled());
    bridge.list.mockResolvedValue({ connections: [account('new')] });
    fireEvent.click(connect);
    await screen.findByText('Workspace new');
    await act(async () => {
      stale.resolve({ connections: [account('old')] });
    });
    expect(screen.queryByText('Workspace old')).not.toBeInTheDocument();
    expect(screen.getByText('Workspace new')).toBeInTheDocument();
  });
});
