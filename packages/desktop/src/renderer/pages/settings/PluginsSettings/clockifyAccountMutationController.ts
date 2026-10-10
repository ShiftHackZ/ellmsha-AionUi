import type { ClockifyConnection, ClockifyConnections } from '@/common/adapter/ipcBridge';

export type ClockifyAccountMutation =
  | { kind: 'connect'; connectionId?: string }
  | { kind: 'disconnect'; connectionId: string };

export type ClockifyAccountMutationOutcome =
  | { status: 'fulfilled'; connection: ClockifyConnection }
  | { status: 'rejected'; error: unknown }
  | { status: 'ignored' };

type RunClockifyAccountMutation = {
  mutation: ClockifyAccountMutation;
  mutate: () => Promise<ClockifyConnection>;
  load: () => Promise<ClockifyConnections>;
  current: () => ClockifyConnections;
  publish: (value: ClockifyConnections) => void;
  onPendingChange: (value?: ClockifyAccountMutation) => void;
};

export const reconcileClockifyConnection = (
  current: ClockifyConnections,
  connection: ClockifyConnection
): ClockifyConnections => {
  const exists = current.connections.some((item) => item.id === connection.id);
  return {
    connections: exists
      ? current.connections.map((item) => (item.id === connection.id ? connection : item))
      : [...current.connections, connection],
  };
};

export class ClockifyAccountMutationController {
  private active?: { token: symbol; mutation: ClockifyAccountMutation };

  get pending(): ClockifyAccountMutation | undefined {
    return this.active?.mutation;
  }

  async run(options: RunClockifyAccountMutation): Promise<ClockifyAccountMutationOutcome> {
    if (this.active) return { status: 'ignored' };

    const active = { token: Symbol('clockify-account-mutation'), mutation: { ...options.mutation } };
    this.active = active;
    options.onPendingChange(active.mutation);
    try {
      const connection = await options.mutate();
      const latest = await options.load().catch(() => reconcileClockifyConnection(options.current(), connection));
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
