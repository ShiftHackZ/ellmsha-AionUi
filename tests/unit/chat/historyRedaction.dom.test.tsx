import React from 'react';
import { act, cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TMessage } from '@/common/chat/chatLib';
const api = vi.hoisted(() => ({
  fetch: vi.fn(),
  changed: new Set<(event: { conversation_ids: string[]; revisions: Record<string, number> }) => void>(),
  reconnect: new Set<() => void>(),
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    database: { getConversationMessages: { invoke: api.fetch } },
    conversation: {
      historyChanged: {
        on: (fn: Parameters<typeof api.changed.add>[0]) => {
          api.changed.add(fn);
          return () => api.changed.delete(fn);
        },
      },
      userCreated: { on: () => () => {} },
    },
    realtime: {
      reconnected: {
        on: (fn: () => void) => {
          api.reconnect.add(fn);
          return () => api.reconnect.delete(fn);
        },
      },
    },
  },
}));
import {
  MessageListProvider,
  MessageListLoadingProvider,
  MessagePaginationProvider,
  useMessageLstCache,
  useMessageList,
  useMessageListLoading,
  useLoadPreviousMessagePage,
  useLoadAnchorMessageWindow,
  useAddOrUpdateMessage,
} from '@/renderer/pages/conversation/Messages/hooks';
const row = (id: string, revision = 0, redacted = false): TMessage => ({
  id,
  msg_id: id,
  conversation_id: 'chat',
  type: 'text',
  position: 'right',
  revision,
  redacted,
  content: { content: redacted ? `safe-${id}` : `SYNTHETIC_RAW_${id}` },
});
const page = (items: TMessage[], more = false) => ({
  items,
  oldest_cursor: 'older',
  newest_cursor: 'newer',
  has_more_before: more,
  has_more_after: false,
});
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
};
function Probe() {
  useMessageLstCache('chat');
  const list = useMessageList();
  const loading = useMessageListLoading();
  const older = useLoadPreviousMessagePage('chat');
  const anchor = useLoadAnchorMessageWindow('chat');
  const live = useAddOrUpdateMessage();
  return (
    <>
      <output data-testid='rows'>{JSON.stringify(list)}</output>
      <output data-testid='loading'>{String(loading)}</output>
      <button onClick={() => void older()}>older</button>
      <button onClick={() => void anchor('old')}>anchor</button>
      <button onClick={() => live(row('new-live'), true)}>live</button>
      <button onClick={() => live(row('old'), true)}>late</button>
    </>
  );
}
function mount() {
  return render(
    <MessageListProvider value={[]}>
      <MessageListLoadingProvider value={false}>
        <MessagePaginationProvider
          value={{ hasMoreBefore: false, hasMoreAfter: false, isLoadingBefore: false, isLoadingAnchor: false }}
        >
          <Probe />
        </MessagePaginationProvider>
      </MessageListLoadingProvider>
    </MessageListProvider>
  );
}
const mask = (id: string, chat = 'chat') => {
  for (const fn of api.changed) fn({ conversation_ids: [chat], revisions: { [id]: 2 } });
};
beforeEach(() => {
  api.fetch.mockReset();
});
afterEach(() => {
  cleanup();
  api.changed.clear();
  api.reconnect.clear();
});
describe('canonical history revision fences', () => {
  it('keeps initial/reconnect loading cleanup alive across masks and ignores other conversations', async () => {
    const first = deferred<ReturnType<typeof page>>();
    api.fetch.mockImplementation((request) =>
      request.anchor_message_id ? Promise.resolve(page([row(request.anchor_message_id, 2, true)])) : first.promise
    );
    mount();
    expect(screen.getByTestId('loading')).toHaveTextContent('true');
    act(() => {
      mask('first', 'other');
    });
    expect(api.fetch).toHaveBeenCalledTimes(1);
    act(() => {
      mask('first');
    });
    await act(async () => {
      first.resolve(page([row('first')]));
    });
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(screen.getByTestId('rows')).not.toHaveTextContent('SYNTHETIC_RAW');
    const reconnect = deferred<ReturnType<typeof page>>();
    api.fetch.mockImplementation((request) =>
      request.anchor_message_id ? Promise.resolve(page([row(request.anchor_message_id, 3, true)])) : reconnect.promise
    );
    act(() => {
      for (const fn of api.reconnect) fn();
      mask('first');
    });
    await act(async () => {
      reconnect.resolve(page([row('first')]));
    });
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(screen.getByTestId('rows')).not.toHaveTextContent('SYNTHETIC_RAW');
  });
  it('fences unloaded rows from stale earlier pages and direct late stream additions', async () => {
    const older = deferred<ReturnType<typeof page>>();
    const hydration = deferred<ReturnType<typeof page>>();
    api.fetch.mockImplementation((request) =>
      request.anchor_message_id
        ? hydration.promise
        : request.before
          ? older.promise
          : Promise.resolve(page([row('recent')], true))
    );
    mount();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    fireEvent.click(screen.getByText('older'));
    act(() => {
      mask('old');
    });
    await act(async () => {
      older.resolve(page([row('old')]));
    });
    expect(screen.getByTestId('rows')).not.toHaveTextContent('SYNTHETIC_RAW_old');
    fireEvent.click(screen.getByText('late'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(screen.getByTestId('rows')).not.toHaveTextContent('SYNTHETIC_RAW_old');
    await act(async () => {
      hydration.resolve(page([row('old', 2, true)]));
    });
    expect(screen.getByTestId('rows')).toHaveTextContent('safe-old');
  });
  it('never restores an older already-redacted row after a second mask', async () => {
    const secondMask = deferred<ReturnType<typeof page>>();
    api.fetch.mockResolvedValue(page([row('same', 2, true)]));
    mount();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    api.fetch.mockImplementation((request) =>
      request.anchor_message_id
        ? secondMask.promise
        : Promise.resolve(page([{ ...row('same', 2, true), content: { content: 'SYNTHETIC_SECOND_SECRET' } }]))
    );
    act(() => {
      for (const fn of api.changed) fn({ conversation_ids: ['chat'], revisions: { same: 3 } });
      for (const fn of api.reconnect) fn();
    });
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(screen.getByTestId('rows')).not.toHaveTextContent('SYNTHETIC_SECOND_SECRET');
    await act(async () => {
      secondMask.resolve(page([row('same', 3, true)]));
    });
    // This hydration predates reconnect and cannot restore its cached payload.
    expect(screen.getByTestId('rows')).not.toHaveTextContent('SYNTHETIC_SECOND_SECRET');
    api.fetch.mockResolvedValue(page([row('same', 3, true)]));
    act(() => {
      for (const fn of api.reconnect) fn();
    });
    await waitFor(() => expect(screen.getByTestId('rows')).toHaveTextContent('safe-same'));
  });
  it('hydrates independent rapid masks even when their requests complete in reverse order', async () => {
    const a = deferred<ReturnType<typeof page>>();
    const b = deferred<ReturnType<typeof page>>();
    api.fetch.mockImplementation((request) =>
      request.anchor_message_id === 'a'
        ? a.promise
        : request.anchor_message_id === 'b'
          ? b.promise
          : Promise.resolve(page([row('a'), row('b')]))
    );
    mount();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    act(() => {
      mask('a');
      mask('b');
    });
    await act(async () => {
      b.resolve(page([row('b', 2, true)]));
    });
    await act(async () => {
      a.resolve(page([row('a', 2, true)]));
    });
    expect(screen.getByTestId('rows')).toHaveTextContent('safe-a');
    expect(screen.getByTestId('rows')).toHaveTextContent('safe-b');
    expect(screen.getByTestId('rows')).not.toHaveTextContent('SYNTHETIC_RAW');
  });
});

it.each(['older', 'anchor'])(
  'drops old loaded plaintext and pre-reconnect %s response but keeps new live frames',
  async (kind) => {
    const stale = deferred<ReturnType<typeof page>>();
    const fresh = deferred<ReturnType<typeof page>>();
    let reconnecting = false;
    let pageCalls = 0;
    api.fetch.mockImplementation((request) => {
      if (request.anchor_message_id) return stale.promise;
      if (request.before) return ++pageCalls === 1 ? Promise.resolve(page([row('old')], true)) : stale.promise;
      return reconnecting ? fresh.promise : Promise.resolve(page([row('recent')], true));
    });
    mount();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    fireEvent.click(screen.getByText('older'));
    await waitFor(() => expect(screen.getByTestId('rows')).toHaveTextContent('SYNTHETIC_RAW_old'));
    fireEvent.click(screen.getByText(kind));
    reconnecting = true;
    act(() => {
      fireEvent.click(screen.getByText('late')); // queued before reconnect, not yet flushed
      for (const listener of api.reconnect) listener();
    });
    expect(screen.getByTestId('rows')).not.toHaveTextContent('SYNTHETIC_RAW');
    fireEvent.click(screen.getByText('live'));
    await act(async () => {
      stale.resolve(page([row('old')]));
      fresh.resolve(page([row('recent', 2, true)], true));
    });
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(screen.getByTestId('rows')).not.toHaveTextContent('SYNTHETIC_RAW_old');
    await waitFor(() => expect(screen.getByTestId('rows')).toHaveTextContent('SYNTHETIC_RAW_new-live'));
  }
);
