import type { ClockifyConnection } from '@/common/adapter/ipcBridge';

export type PluginAccountMutation =
  | { kind: 'connect'; connectionId?: string }
  | { kind: 'disconnect'; connectionId: string };

export type PluginAccountMutationOutcome<T = ClockifyConnection> =
  | { status: 'fulfilled'; connection: T }
  | { status: 'rejected'; error: unknown }
  | { status: 'ignored' };

type AccountConnections<T> = { connections: T[] };

type RunPluginAccountMutation<T> = {
  mutation: PluginAccountMutation;
  mutate: () => Promise<T>;
  load: () => Promise<AccountConnections<T>>;
  current: () => AccountConnections<T>;
  publish: (value: AccountConnections<T>) => void;
  onPendingChange: (value?: PluginAccountMutation) => void;
};

export const reconcilePluginConnection = <T extends { id: string }>(
  current: AccountConnections<T>,
  connection: T
): AccountConnections<T> => {
  const exists = current.connections.some((item) => item.id === connection.id);
  return {
    connections: exists
      ? current.connections.map((item) => (item.id === connection.id ? connection : item))
      : [...current.connections, connection],
  };
};

export class PluginAccountMutationController<T extends { id: string } = ClockifyConnection> {
  private active?: { token: symbol; mutation: PluginAccountMutation };

  get pending(): PluginAccountMutation | undefined {
    return this.active?.mutation;
  }

  async run(options: RunPluginAccountMutation<T>): Promise<PluginAccountMutationOutcome<T>> {
    if (this.active) return { status: 'ignored' };

    const active = { token: Symbol('plugin-account-mutation'), mutation: { ...options.mutation } };
    this.active = active;
    options.onPendingChange(active.mutation);
    try {
      const connection = await options.mutate();
      const latest = await options.load().catch(() => reconcilePluginConnection(options.current(), connection));
      options.publish(latest);
      return { status: 'fulfilled', connection };
    } catch (error) {
      const latest = await options.load().catch((): undefined => undefined);
      if (latest) options.publish(latest);
      return { status: 'rejected', error };
    } finally {
      if (this.active?.token === active.token) {
        this.active = undefined;
        options.onPendingChange(undefined);
      }
    }
  }
}
