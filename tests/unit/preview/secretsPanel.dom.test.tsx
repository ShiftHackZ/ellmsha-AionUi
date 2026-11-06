import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecretMetadata, SecretOperation } from '@/common/types/secrets';
const api = vi.hoisted(() => ({
  request: vi.fn(),
  locked: new Set<() => void>(),
  disabled: new Set<(v: { name: string; enabled: boolean }) => void>(),
}));
vi.mock('@/common/adapter/secretsBridge', () => ({ secretsRequest: api.request }));
vi.mock('@/common/adapter/ipcBridge', () => ({
  secrets: {
    locked: {
      on: (fn: () => void) => {
        api.locked.add(fn);
        return () => api.locked.delete(fn);
      },
    },
  },
  extensions: {
    stateChanged: {
      on: (fn: (v: { name: string; enabled: boolean }) => void) => {
        api.disabled.add(fn);
        return () => api.disabled.delete(fn);
      },
    },
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { SecretsPanel } from '@/renderer/components/secrets/SecretsPanel';
const metadata: SecretMetadata = {
  id: 'secret-a',
  incarnation: 'fixture-incarnation',
  title: 'Synthetic login',
  kind: 'login',
  revision: 4,
  scope: { project_id: null },
  bindings: [],
};
beforeEach(() => {
  api.request.mockReset();
  api.request.mockImplementation(async (operation: SecretOperation) => {
    if (operation === 'status')
      return { initialized: true, unlocked: true, vault_id: 'fixture', incarnation: 'fixture-incarnation' };
    if (operation === 'device/status') return { available: false, remembered: false };
    if (operation === 'records/groups') return [{ scope: { project_id: null }, name: '', retained: false }];
    if (operation === 'records/list') return { records: [metadata], cursor: null };
    if (operation === 'records/read')
      return { ...metadata, fields: { password: { kind: 'password', value: 'SYNTHETIC_VALUE' } } };
    return {};
  });
});
afterEach(() => {
  cleanup();
  api.locked.clear();
  api.disabled.clear();
});

describe('Secrets panel', () => {
  it('lists only metadata, explicitly reveals a masked editor and clears it on lock', async () => {
    render(<SecretsPanel conversationId='temporary-chat' />);
    expect(await screen.findByText('Synthetic login')).toBeVisible();
    expect(api.request).not.toHaveBeenCalledWith('records/read', expect.anything());
    fireEvent.click(screen.getByRole('button', { name: 'settings.secrets.reveal' }));
    const input = await screen.findByLabelText('password');
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveValue('SYNTHETIC_VALUE');
    act(() => {
      for (const notify of api.locked) notify();
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.body.textContent).not.toContain('SYNTHETIC_VALUE');
  });
  it('edits using the original revision and operation id, closes the dialog after success', async () => {
    render(<SecretsPanel conversationId='chat' />);
    fireEvent.click(await screen.findByRole('button', { name: 'common.edit' }));
    const input = await screen.findByLabelText('password');
    fireEvent.change(input, { target: { value: 'SYNTHETIC_REPLACEMENT' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'common.save' }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        'records/write',
        expect.objectContaining({
          id: metadata.id,
          expected_revision: 4,
          expected_incarnation: metadata.incarnation,
          scope: { project_id: null },
          operation_id: expect.any(String),
          patch: expect.objectContaining({
            fields: { password: { kind: 'password', value: 'SYNTHETIC_REPLACEMENT' } },
          }),
        })
      )
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
  it('never displays a pending raw response after switching chats', async () => {
    let finish: (value: unknown) => void = () => {};
    const original = api.request.getMockImplementation()!;
    api.request.mockImplementation((operation: SecretOperation, body?: unknown) =>
      operation === 'records/read'
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : original(operation, body)
    );
    const view = render(<SecretsPanel conversationId='chat-a' />);
    fireEvent.click(await screen.findByRole('button', { name: 'settings.secrets.reveal' }));
    view.rerender(<SecretsPanel conversationId='chat-b' />);
    finish({ ...metadata, fields: { password: { kind: 'password', value: 'SYNTHETIC_STALE' } } });
    await waitFor(() => expect(api.request).toHaveBeenCalledWith('records/groups', { conversation_id: 'chat-b' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.innerHTML).not.toContain('SYNTHETIC_STALE');
  });
  it('clears an open editor immediately when the plugin is disabled', async () => {
    render(<SecretsPanel conversationId='chat' />);
    fireEvent.click(await screen.findByRole('button', { name: 'common.edit' }));
    await screen.findByLabelText('password');
    act(() => {
      for (const notify of api.disabled) notify({ name: 'secrets', enabled: false });
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

it.each(['switch', 'lock', 'disable'] as const)(
  'dismisses a pending delete on %s and cannot mutate the old scope',
  async (change) => {
    const view = render(<SecretsPanel conversationId='project-a' />);
    fireEvent.click(await screen.findByRole('button', { name: 'common.delete' }));
    await screen.findByText('settings.secrets.deleteTitle');
    const oldConfirm = within(screen.getByRole('dialog')).getByRole('button', { name: 'common.delete' });
    if (change === 'switch') view.rerender(<SecretsPanel conversationId='temporary' />);
    else
      act(() => {
        if (change === 'lock') for (const notify of api.locked) notify();
        else for (const notify of api.disabled) notify({ name: 'secrets', enabled: false });
      });
    fireEvent.click(oldConfirm);
    await waitFor(() => expect(screen.queryByText('settings.secrets.deleteTitle')).toBeNull());
    expect(api.request.mock.calls.some(([op]) => op === 'records/delete')).toBe(false);
  }
);

it('clears an unlock passphrase on another lock event even when already locked', async () => {
  const original = api.request.getMockImplementation()!;
  api.request.mockImplementation((op: SecretOperation, body?: unknown) =>
    op === 'status'
      ? Promise.resolve({ initialized: true, unlocked: false, vault_id: 'fixture', incarnation: 'fixture-incarnation' })
      : original(op, body)
  );
  render(<SecretsPanel conversationId='chat' />);
  fireEvent.click(await screen.findByRole('button', { name: 'settings.secrets.unlock' }));
  const input = screen.getByRole('dialog').querySelector('input[type=password]')!;
  fireEvent.change(input, { target: { value: 'SYNTHETIC_PASSPHRASE' } });
  act(() => {
    for (const notify of api.locked) notify();
  });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(document.body.innerHTML).not.toContain('SYNTHETIC_PASSPHRASE');
});

it('clears a hidden raw editor and rejects a late response while hidden', async () => {
  let finish!: (value: unknown) => void;
  const original = api.request.getMockImplementation()!;
  api.request.mockImplementation((op: SecretOperation, body?: unknown) =>
    op === 'records/read'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : original(op, body)
  );
  render(<SecretsPanel conversationId='chat' />);
  fireEvent.click(await screen.findByRole('button', { name: 'settings.secrets.reveal' }));
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => finish({ ...metadata, fields: { password: { kind: 'password', value: 'SYNTHETIC_LATE' } } }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.body.innerHTML).not.toContain('SYNTHETIC_LATE');
  visibility.mockRestore();
});

it('deduplicates double clicks on one pagination cursor', async () => {
  let finish!: (value: unknown) => void;
  const original = api.request.getMockImplementation()!;
  api.request.mockImplementation((op: SecretOperation, body?: { cursor?: string }) =>
    op === 'records/list'
      ? body?.cursor
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve({ records: [metadata], cursor: 'page-two' })
      : original(op, body)
  );
  render(<SecretsPanel conversationId='chat' />);
  const more = await screen.findByRole('button', { name: 'settings.secrets.more' });
  fireEvent.click(more);
  fireEvent.click(more);
  expect(
    api.request.mock.calls.filter(([op, body]) => op === 'records/list' && body.cursor === 'page-two')
  ).toHaveLength(1);
  await act(async () => finish({ records: [{ ...metadata, id: 'second', title: 'Second record' }], cursor: null }));
  expect(screen.getAllByText('Second record')).toHaveLength(1);
});

it('invalidates old global editor when the same chat changes its project binding', async () => {
  let project = 'a';
  const original = api.request.getMockImplementation()!;
  api.request.mockImplementation((op: SecretOperation, body?: unknown) =>
    op === 'records/groups'
      ? Promise.resolve([
          { scope: { project_id: null }, name: '', retained: false },
          { scope: { project_id: project }, name: project, retained: false },
        ])
      : op === 'records/list'
        ? Promise.resolve({
            records: (body as { scope: { project_id: string | null } }).scope.project_id === null ? [metadata] : [],
            cursor: null,
          })
        : original(op, body)
  );
  render(<SecretsPanel conversationId='same-chat' />);
  fireEvent.click(await screen.findByRole('button', { name: 'common.edit' }));
  await screen.findByLabelText('password');
  project = 'b';
  fireEvent.click(screen.getByRole('button', { name: 'common.refresh' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(api.request.mock.calls.some(([op, body]) => op === 'records/list' && body.expected_project_id === 'b')).toBe(
    true
  );
});

it('removes fields whose names are Object prototype keys using own null patches', async () => {
  const original = api.request.getMockImplementation()!;
  const names = ['constructor', 'toString', '__proto__'];
  api.request.mockImplementation((op: SecretOperation, body?: unknown) =>
    op === 'records/read'
      ? Promise.resolve({
          ...metadata,
          fields: Object.fromEntries(names.map((name) => [name, { kind: 'password', value: 'SYNTHETIC' }])),
        })
      : original(op, body)
  );
  render(<SecretsPanel conversationId='chat' />);
  fireEvent.click(await screen.findByRole('button', { name: 'common.edit' }));
  await screen.findByLabelText('constructor');
  for (const _name of names)
    fireEvent.click(within(screen.getByRole('dialog')).getAllByRole('button', { name: 'common.delete' })[0]);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'common.save' }));
  await waitFor(() => expect(api.request.mock.calls.some(([op]) => op === 'records/write')).toBe(true));
  const fields = api.request.mock.calls.find(([op]) => op === 'records/write')![1].patch.fields;
  expect(Object.getPrototypeOf(fields)).toBeNull();
  for (const name of names) {
    expect(Object.hasOwn(fields, name)).toBe(true);
    expect(fields[name]).toBeNull();
  }
});

it('keeps explicit remember opt-in when polling sees unlock before its response', async () => {
  let unlocked = false;
  let finish!: (v: unknown) => void;
  const original = api.request.getMockImplementation()!;
  api.request.mockImplementation((op: SecretOperation, body?: unknown) => {
    if (op === 'status')
      return Promise.resolve({ initialized: true, unlocked, vault_id: 'fixture', incarnation: 'fixture-incarnation' });
    if (op === 'device/status') return Promise.resolve({ available: true, remembered: false });
    if (op === 'vault/unlock') {
      unlocked = true;
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
    return original(op, body);
  });
  render(<SecretsPanel conversationId='chat' />);
  fireEvent.click(await screen.findByRole('button', { name: 'settings.secrets.unlock' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.change(dialog.querySelector('input[type="password"]')!, { target: { value: 'synthetic test passphrase' } });
  fireEvent.click(await within(dialog).findByRole('checkbox', { name: 'settings.secrets.remember' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'common.confirm' }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  fireEvent.click(screen.getByRole('button', { name: 'common.refresh' }));
  await screen.findByText('Synthetic login');
  await act(async () => finish({}));
  await waitFor(() => expect(api.request).toHaveBeenCalledWith('device/remember'));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

// An external restore is an authorization/version boundary even in the same chat.
it.each(['edit', 'delete'] as const)('clears a pending %s after the vault incarnation changes', async (action) => {
  const original = api.request.getMockImplementation()!;
  let incarnation = 'fixture-incarnation';
  api.request.mockImplementation((operation: SecretOperation, body?: unknown) =>
    operation === 'status'
      ? Promise.resolve({ initialized: true, unlocked: true, vault_id: 'fixture', incarnation })
      : original(operation, body)
  );
  render(<SecretsPanel conversationId='chat' />);
  fireEvent.click(await screen.findByRole('button', { name: action === 'edit' ? 'common.edit' : 'common.delete' }));
  await screen.findByRole('dialog');
  incarnation = 'restored-incarnation';
  fireEvent.click(screen.getByRole('button', { name: 'common.refresh' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(api.request.mock.calls.some(([op]) => op === 'records/write' || op === 'records/delete')).toBe(false);
  expect(document.body.innerHTML).not.toContain('SYNTHETIC_VALUE');
});
