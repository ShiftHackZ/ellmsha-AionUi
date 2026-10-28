import { describe, expect, it, vi } from 'vitest';
import type { ClockifyConnection, ClockifyConnections } from '@/common/adapter/ipcBridge';
import {
  PluginAccountMutationController,
  type PluginAccountMutation,
} from '@/renderer/pages/settings/PluginsSettings/pluginAccountMutationController';

const connection = (id: string, status: ClockifyConnection['status'] = 'connected'): ClockifyConnection => ({
  id,
  namespace: `clockify-global-${id}`,
  label: id,
  realm: 'global',
  status,
  identity: { account_id: id, account_name: id },
  workspaces: [],
  created_at: 1,
  updated_at: status === 'connected' ? 1 : 2,
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const runOptions = (
  mutation: PluginAccountMutation,
  mutate: () => Promise<ClockifyConnection>,
  load: () => Promise<ClockifyConnections>,
  current: () => ClockifyConnections,
  publish: (value: ClockifyConnections) => void,
  onPendingChange: (value?: PluginAccountMutation) => void
) => ({ mutation, mutate, load, current, publish, onPendingChange });

describe('Clockify account mutation controller', () => {
  it('synchronously blocks double submit and keeps the original form target pending', async () => {
    const controller = new PluginAccountMutationController();
    const mutation = deferred<ClockifyConnection>();
    const load = deferred<ClockifyConnections>();
    const pending: Array<PluginAccountMutation | undefined> = [];
    const publish = vi.fn();
    const secondMutation = vi.fn(async () => connection('account-b'));
    const current = () => ({ connections: [connection('account-a')] });

    const first = controller.run(
      runOptions(
        { kind: 'connect', connectionId: 'account-a' },
        () => mutation.promise,
        () => load.promise,
        current,
        publish,
        (value) => pending.push(value)
      )
    );
    const second = await controller.run(
      runOptions(
        { kind: 'connect', connectionId: 'account-b' },
        secondMutation,
        async () => ({ connections: [] }),
        current,
        publish,
        (value) => pending.push(value)
      )
    );

    expect(second).toEqual({ status: 'ignored' });
    expect(secondMutation).not.toHaveBeenCalled();
    expect(controller.pending).toEqual({ kind: 'connect', connectionId: 'account-a' });
    expect(pending).toEqual([{ kind: 'connect', connectionId: 'account-a' }]);

    mutation.resolve(connection('account-a'));
    load.resolve({ connections: [connection('account-a'), connection('account-b')] });
    await expect(first).resolves.toMatchObject({ status: 'fulfilled' });
    expect(controller.pending).toBeUndefined();
    expect(pending.at(-1)).toBeUndefined();
  });

  it('waits for and publishes the authoritative list instead of a captured account list', async () => {
    const controller = new PluginAccountMutationController();
    const mutation = deferred<ClockifyConnection>();
    const load = deferred<ClockifyConnections>();
    let current = { connections: [connection('account-a')] };
    const publish = vi.fn((next: ClockifyConnections) => {
      current = next;
    });

    const running = controller.run(
      runOptions(
        { kind: 'disconnect', connectionId: 'account-a' },
        () => mutation.promise,
        () => load.promise,
        () => current,
        publish,
        vi.fn()
      )
    );
    current = { connections: [connection('account-a'), connection('account-b')] };
    mutation.resolve(connection('account-a', 'disconnected'));
    await Promise.resolve();
    expect(publish).not.toHaveBeenCalled();

    const authoritative = {
      connections: [connection('account-a', 'disconnected'), connection('account-b'), connection('account-c')],
    };
    load.resolve(authoritative);
    await expect(running).resolves.toMatchObject({ status: 'fulfilled' });
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(authoritative);
  });

  it('reconciles rejection state, releases the guard, and permits the next mutation', async () => {
    const controller = new PluginAccountMutationController();
    const mutation = deferred<ClockifyConnection>();
    const load = deferred<ClockifyConnections>();
    const pending: Array<PluginAccountMutation | undefined> = [];
    const authoritative = { connections: [connection('account-a'), connection('account-b')] };
    const publish = vi.fn();
    const current = () => ({ connections: [connection('account-a')] });

    const rejected = controller.run(
      runOptions(
        { kind: 'disconnect', connectionId: 'account-a' },
        () => mutation.promise,
        () => load.promise,
        current,
        publish,
        (value) => pending.push(value)
      )
    );
    mutation.reject(new Error('fixture failure'));
    await Promise.resolve();
    expect(controller.pending).toEqual({ kind: 'disconnect', connectionId: 'account-a' });
    load.resolve(authoritative);

    await expect(rejected).resolves.toMatchObject({ status: 'rejected' });
    expect(publish).toHaveBeenCalledWith(authoritative);
    expect(controller.pending).toBeUndefined();
    expect(pending.at(-1)).toBeUndefined();

    const next = await controller.run(
      runOptions(
        { kind: 'connect' },
        async () => connection('account-c'),
        async () => ({ connections: [...authoritative.connections, connection('account-c')] }),
        current,
        publish,
        (value) => pending.push(value)
      )
    );
    expect(next.status).toBe('fulfilled');
  });

  it('merges into the latest state when authoritative refresh fails', async () => {
    const controller = new PluginAccountMutationController();
    let current = { connections: [connection('account-a'), connection('account-b')] };
    const publish = vi.fn((next: ClockifyConnections) => {
      current = next;
    });

    const result = await controller.run(
      runOptions(
        { kind: 'disconnect', connectionId: 'account-a' },
        async () => connection('account-a', 'disconnected'),
        async () => {
          throw new Error('refresh unavailable');
        },
        () => current,
        publish,
        vi.fn()
      )
    );

    expect(result.status).toBe('fulfilled');
    expect(current.connections).toEqual([connection('account-a', 'disconnected'), connection('account-b')]);
  });
});
