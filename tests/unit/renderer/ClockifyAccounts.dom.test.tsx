import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClockifyConnection, ClockifyConnections } from '@/common/adapter/ipcBridge';
import ClockifyAccounts from '@/renderer/pages/settings/PluginsSettings/ClockifyAccounts';

const bridge = vi.hoisted(() => ({
  reconnect: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  list: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    extensions: {
      reconnectClockifyConnection: { invoke: bridge.reconnect },
      connectNewClockifyConnection: { invoke: bridge.connect },
      disconnectClockifyConnection: { invoke: bridge.disconnect },
      getClockifyConnections: { invoke: bridge.list },
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

const connection = (id: string, label: string): ClockifyConnection => ({
  id,
  namespace: `clockify-global-${id}`,
  label,
  realm: 'global',
  status: 'connected',
  identity: { account_id: id, account_name: label },
  workspaces: [],
  created_at: 1,
  updated_at: 1,
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ClockifyAccounts pending mutations', () => {
  it('keeps the reconnect target fixed, blocks duplicate handlers, and publishes the authoritative list', async () => {
    const accountA = connection('account-a', 'Account A');
    const accountB = connection('account-b', 'Account B');
    const mutation = deferred<ClockifyConnection>();
    const refresh = deferred<ClockifyConnections>();
    bridge.reconnect.mockReturnValue(mutation.promise);
    bridge.list.mockReturnValue(refresh.promise);
    const onChange = vi.fn();

    render(
      <ClockifyAccounts
        enabled
        value={{ connections: [accountA, accountB] }}
        loadError={false}
        retrying={false}
        onRetry={vi.fn()}
        onChange={onChange}
      />
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'settings.clockifyReconnect' })[0]);
    expect(screen.getByText('settings.clockifyReconnectAccount:Account A')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('settings.clockifyApiKeyLabel'), { target: { value: 'fixture-key' } });
    const submit = screen.getAllByRole('button', { name: 'settings.clockifyReconnect' })[0];
    fireEvent.click(submit);
    fireEvent.click(submit);

    expect(bridge.reconnect).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'common.cancel' })).toBeDisabled();
    expect(
      screen.getAllByRole('button', { name: 'settings.clockifyReconnect' }).every((button) => button.disabled)
    ).toBe(true);
    fireEvent.click(screen.getAllByRole('button', { name: 'settings.clockifyReconnect' }).at(-1)!);
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(screen.getByText('settings.clockifyReconnectAccount:Account A')).toBeInTheDocument();

    const authoritative = {
      connections: [{ ...accountA, updated_at: 2 }, accountB, connection('account-c', 'Account C')],
    };
    await act(async () => {
      mutation.resolve({ ...accountA, updated_at: 2 });
      await Promise.resolve();
      refresh.resolve(authoritative);
    });

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(authoritative));
    expect(screen.queryByRole('button', { name: 'common.cancel' })).not.toBeInTheDocument();
  });
});
