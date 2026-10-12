/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ErrorCode, McpError, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserMcpProxy, type BrowserTabController } from '@process/resources/builtinMcp/browserTabMcp';

class MemoryTransport implements Transport {
  peer?: MemoryTransport;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    queueMicrotask(() => this.peer?.onmessage?.(message));
  }

  async close(): Promise<void> {
    this.onclose?.();
  }
}

const linkedTransports = (): [MemoryTransport, MemoryTransport] => {
  const first = new MemoryTransport();
  const second = new MemoryTransport();
  first.peer = second;
  second.peer = first;
  return [first, second];
};

const openProtocols: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.allSettled(openProtocols.splice(0).map((protocol) => protocol.close()));
});

describe('browser MCP stable tab contract', () => {
  it('publishes stable tools through a real MCP handshake and forwards upstream tools', async () => {
    const upstream = {
      listTools: vi.fn().mockResolvedValue({
        tools: [
          {
            name: 'take_snapshot',
            description: 'Upstream snapshot tool',
            inputSchema: {
              type: 'object',
              properties: { verbose: { type: 'boolean' }, filePath: { type: 'string' }, targetId: { type: 'string' } },
            },
            annotations: { readOnlyHint: false },
          },
          {
            name: 'select_page',
            description: 'Select a page',
            inputSchema: { type: 'object', properties: { pageId: { type: 'number' } }, required: ['pageId'] },
            annotations: { readOnlyHint: true },
          },
        ],
      }),
      callTool: vi.fn().mockImplementation(async (request) => ({
        content: [{ type: 'text', text: 'upstream result' }],
        structuredContent: {
          target: { id: request.arguments.targetId, url: 'https://github.com/login', closed: false },
        },
      })),
    };
    const controller: BrowserTabController = {
      list: vi
        .fn()
        .mockResolvedValue([{ id: 'browser-stable', title: 'Login', url: 'https://github.com/login', active: true }]),
      open: vi.fn().mockResolvedValue('browser-opened'),
      activate: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const server = createBrowserMcpProxy(upstream as never, controller);
    const client = new Client({ name: 'browser-tab-test', version: '1.0.0' });
    openProtocols.push(server, client);
    const [serverTransport, clientTransport] = linkedTransports();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'take_snapshot',
        'take_snapshot_to_file',
        'select_page',
        'browser_tabs_list',
        'browser_tab_open',
        'browser_tab_activate',
        'browser_tab_navigate',
        'browser_tab_close',
      ])
    );
    const inlineSnapshot = tools.tools.find((tool) => tool.name === 'take_snapshot');
    expect(inlineSnapshot?.annotations?.readOnlyHint).toBe(true);
    expect(inlineSnapshot?.inputSchema.properties).not.toHaveProperty('filePath');
    const fileSnapshot = tools.tools.find((tool) => tool.name === 'take_snapshot_to_file');
    expect(fileSnapshot?.annotations?.readOnlyHint).toBe(false);
    expect(fileSnapshot?.inputSchema.required).toContain('filePath');

    const opened = await client.callTool({
      name: 'browser_tab_open',
      arguments: { url: 'https://github.com/login', activate: false },
    });
    expect(controller.open).toHaveBeenCalledWith('https://github.com/login', false);
    expect(opened.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('browser-opened') });

    await client.callTool({ name: 'browser_tab_close', arguments: { tab_id: 'browser-stable' } });
    expect(controller.close).toHaveBeenCalledWith('browser-stable');

    await client.callTool({ name: 'take_snapshot', arguments: { verbose: true } });
    expect(upstream.callTool).toHaveBeenCalledWith(
      { name: 'take_snapshot', arguments: { verbose: true, targetId: 'browser-stable' } },
      undefined,
      expect.objectContaining({ timeout: 60_000 })
    );

    upstream.callTool.mockClear();
    const rejected = await client.callTool({
      name: 'take_snapshot',
      arguments: { filePath: '/tmp/must-not-bypass-approval.txt' },
    });
    expect(rejected.isError).toBe(true);
    expect(upstream.callTool).not.toHaveBeenCalled();

    await client.callTool({
      name: 'take_snapshot_to_file',
      arguments: { filePath: '/tmp/manual-snapshot.txt', verbose: false },
    });
    expect(upstream.callTool).toHaveBeenCalledWith(
      {
        name: 'take_snapshot',
        arguments: { filePath: '/tmp/manual-snapshot.txt', verbose: false, targetId: 'browser-stable' },
      },
      undefined,
      expect.objectContaining({ timeout: 60_000 })
    );
  });
});

const exactTargetFixture = async () => {
  const tabs = [
    { id: 'a', title: 'First', url: 'https://same.example/', active: true },
    { id: 'b', title: 'Second', url: 'https://same.example/', active: false },
  ];
  let selected = 'a';
  const upstream = {
    listTools: vi.fn().mockResolvedValue({
      tools: [{ name: 'take_snapshot', inputSchema: { type: 'object', properties: { targetId: { type: 'string' } } } }],
    }),
    callTool: vi.fn().mockImplementation(async (request) => {
      selected = request.arguments.targetId || (request.name === 'select_page' ? 'b' : selected);
      return {
        content: [{ type: 'text', text: `Observed ${selected}` }],
        structuredContent: { target: { id: selected, url: 'https://same.example/', closed: false } },
      };
    }),
  };
  const controller: BrowserTabController = {
    list: vi.fn().mockImplementation(async () => [...tabs]),
    open: vi.fn().mockResolvedValue('b'),
    activate: vi.fn().mockResolvedValue(undefined),
    navigate: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockImplementation(async (id: string) => {
      tabs.splice(
        tabs.findIndex((tab) => tab.id === id),
        1
      );
    }),
  };
  const server = createBrowserMcpProxy(upstream as never, controller);
  const client = new Client({ name: 'target-test', version: '1' });
  openProtocols.push(server, client);
  const [serverTransport, clientTransport] = linkedTransports();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, upstream, controller };
};

describe('browser exact target dispatch', () => {
  it('binds observations after stable activation, open and navigation despite identical URLs', async () => {
    const { client, upstream } = await exactTargetFixture();
    for (const name of ['browser_tab_activate', 'browser_tab_open', 'browser_tab_navigate']) {
      await client.callTool({ name, arguments: { tab_id: 'b', url: 'https://same.example/' } });
      const snapshot = await client.callTool({ name: 'take_snapshot', arguments: {} });
      expect(upstream.callTool.mock.lastCall?.[0].arguments).toEqual({ targetId: 'b' });
      expect(snapshot.structuredContent).toMatchObject({ target: { id: 'b' } });
    }
  });

  it('does not fall back to another tab after the selected stable tab closes', async () => {
    const { client, upstream } = await exactTargetFixture();
    await client.callTool({ name: 'browser_tab_activate', arguments: { tab_id: 'b' } });
    await client.callTool({ name: 'browser_tab_close', arguments: { tab_id: 'b' } });
    const response = await client.callTool({ name: 'click', arguments: { uid: 'old' } });
    expect(response.isError).toBe(true);
    expect(upstream.callTool).not.toHaveBeenCalled();
  });

  it('preserves explicit legacy select_page selection for subsequent default actions', async () => {
    const { client, upstream } = await exactTargetFixture();
    await client.callTool({ name: 'browser_tab_activate', arguments: { tab_id: 'a' } });
    await client.callTool({ name: 'select_page', arguments: { pageId: 2 } });
    await client.callTool({ name: 'take_snapshot', arguments: {} });
    expect(upstream.callTool.mock.lastCall?.[0].arguments).toEqual({ targetId: 'b' });
  });

  it('preserves the legacy close_page fallback while stable close stays pinned', async () => {
    const { client, upstream } = await exactTargetFixture();
    await client.callTool({ name: 'select_page', arguments: { pageId: 2 } });
    upstream.callTool.mockResolvedValueOnce({
      content: [],
      structuredContent: { target: { id: 'a', url: 'https://same.example/', closed: false } },
    });
    await client.callTool({ name: 'close_page', arguments: { pageId: 2 } });
    await client.callTool({ name: 'take_snapshot', arguments: {} });
    expect(upstream.callTool.mock.lastCall?.[0].arguments).toEqual({ targetId: 'a' });
  });

  it('carries each concurrent request target atomically and returns the actual target', async () => {
    const { client, upstream } = await exactTargetFixture();
    const responses = await Promise.all(
      ['b', 'a'].map((tab_id) =>
        client.callTool({ name: 'evaluate_script', arguments: { tab_id, function: '() => document.title' } })
      )
    );
    expect(upstream.callTool.mock.calls.map(([request]) => request.arguments.targetId)).toEqual(['b', 'a']);
    expect(responses.map((response) => (response.structuredContent as { target: { id: string } }).target.id)).toEqual([
      'b',
      'a',
    ]);
  });

  it('observes a background tab without activating it, then shows that exact tab for default input', async () => {
    const { client, upstream, controller } = await exactTargetFixture();
    await client.callTool({ name: 'take_snapshot', arguments: { tab_id: 'b' } });
    await client.callTool({ name: 'evaluate_script', arguments: { tab_id: 'b', function: '() => document.title' } });
    expect(controller.activate).not.toHaveBeenCalled();

    await client.callTool({ name: 'fill', arguments: { uid: '1_7', value: 'ALPHA_EDITED_BY_BROWSER' } });
    expect(controller.activate).toHaveBeenCalledExactlyOnceWith('b');
    expect(upstream.callTool.mock.lastCall?.[0]).toEqual({
      name: 'fill',
      arguments: { targetId: 'b', uid: '1_7', value: 'ALPHA_EDITED_BY_BROWSER' },
    });
  });

  it('waits for visible-tab acknowledgement and keeps concurrent input activation ordered', async () => {
    const { client, upstream, controller } = await exactTargetFixture();
    const events: string[] = [];
    let acknowledge!: () => void;
    const visible = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    vi.mocked(controller.activate).mockImplementation(async (id) => {
      events.push(`activate:${id}`);
      if (id === 'b') await visible;
      events.push(`visible:${id}`);
    });
    upstream.callTool.mockImplementation(async (request) => {
      const id = request.arguments.targetId;
      events.push(`input:${id}`);
      return { content: [], structuredContent: { target: { id, url: 'https://same.example/', closed: false } } };
    });
    const first = client.callTool({ name: 'fill', arguments: { tab_id: 'b', uid: 'b_1', value: 'first' } });
    const second = client.callTool({ name: 'press_key', arguments: { tab_id: 'a', key: 'Tab' } });
    await vi.waitFor(() => expect(controller.activate).toHaveBeenCalledExactlyOnceWith('b'));
    expect(upstream.callTool).not.toHaveBeenCalled();
    acknowledge();
    await Promise.all([first, second]);
    expect(events).toEqual(['activate:b', 'visible:b', 'input:b', 'activate:a', 'visible:a', 'input:a']);
  });

  it('does not dispatch input if its exact tab closes during activation', async () => {
    const { client, upstream, controller } = await exactTargetFixture();
    vi.mocked(controller.activate).mockRejectedValueOnce(new Error('No such in-app browser tab: b'));
    const response = await client.callTool({ name: 'fill', arguments: { tab_id: 'b', uid: 'b_1', value: 'edit' } });
    expect(response.isError).toBe(true);
    expect(upstream.callTool).not.toHaveBeenCalled();
  });

  it('quarantines uncertain activation timeouts without dispatching or replaying input', async () => {
    const { client, upstream, controller } = await exactTargetFixture();
    vi.mocked(controller.activate).mockRejectedValueOnce(
      new McpError(ErrorCode.RequestTimeout, 'Activation timed out')
    );
    await client.callTool({ name: 'fill', arguments: { tab_id: 'b', uid: 'b_1', value: 'edit' } });
    const repeated = await client.callTool({ name: 'fill', arguments: { tab_id: 'b', uid: 'b_1', value: 'edit' } });
    expect(repeated.isError).toBe(true);
    expect(controller.activate).toHaveBeenCalledTimes(1);
    expect(upstream.callTool).not.toHaveBeenCalled();
  });

  it('does not dispatch input cancelled while waiting for the visible tab', async () => {
    const { client, upstream, controller } = await exactTargetFixture();
    let acknowledge!: () => void;
    vi.mocked(controller.activate).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        })
    );
    const cancellation = new AbortController();
    const input = client
      .callTool({ name: 'fill', arguments: { tab_id: 'b', uid: 'b_1', value: 'edit' } }, undefined, {
        signal: cancellation.signal,
      })
      .catch(() => undefined);
    await vi.waitFor(() => expect(controller.activate).toHaveBeenCalledExactlyOnceWith('b'));
    cancellation.abort();
    await input;
    acknowledge();
    await client.callTool({ name: 'browser_tabs_list', arguments: {} });
    expect(upstream.callTool).not.toHaveBeenCalled();
  });

  it('rejects an unknown explicit ID before attempting an action', async () => {
    const { client, upstream } = await exactTargetFixture();
    expect((await client.callTool({ name: 'click', arguments: { tab_id: 'missing', uid: '1' } })).isError).toBe(true);
    expect(upstream.callTool).not.toHaveBeenCalled();
  });

  it('blocks further actions after an uncertain timeout without replaying the mutation', async () => {
    const { client, upstream } = await exactTargetFixture();
    upstream.callTool.mockRejectedValueOnce(new McpError(ErrorCode.RequestTimeout, 'Timed out'));
    await client.callTool({ name: 'click', arguments: { tab_id: 'a', uid: '1' } });
    const repeated = await client.callTool({ name: 'click', arguments: { tab_id: 'a', uid: '1' } });
    const inventory = await client.callTool({ name: 'browser_tabs_list', arguments: {} });
    expect(repeated.isError).toBe(true);
    expect(upstream.callTool).toHaveBeenCalledTimes(1);
    expect(inventory.isError).not.toBe(true);
  });

  it.each([
    ['transient discovery failure', new Error('Temporary upstream disconnect')],
    ['discovery timeout', new McpError(ErrorCode.RequestTimeout, 'Catalog timed out')],
  ])('recovers from %s without quarantining an unstarted action', async (_label, failure) => {
    const { client, upstream } = await exactTargetFixture();
    upstream.listTools.mockRejectedValueOnce(failure);
    const failed = await client.callTool({ name: 'click', arguments: { tab_id: 'a', uid: '1' } });
    expect(failed.isError).toBe(true);
    expect(upstream.callTool).not.toHaveBeenCalled();

    const recovered = await client.callTool({ name: 'click', arguments: { tab_id: 'a', uid: '1' } });
    expect(recovered.isError).not.toBe(true);
    expect(recovered.structuredContent).toMatchObject({ target: { id: 'a' } });
    expect(upstream.listTools).toHaveBeenCalledTimes(2);
    expect(upstream.callTool).toHaveBeenCalledTimes(1);
  });

  it('does not execute a cancelled request that was waiting behind another action', async () => {
    const { client, upstream } = await exactTargetFixture();
    let finishFirst!: () => void;
    const waiting = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    upstream.callTool.mockImplementationOnce(async () => {
      await waiting;
      return {
        content: [{ type: 'text', text: 'done' }],
        structuredContent: { target: { id: 'a', url: 'https://same.example/', closed: false } },
      };
    });
    const first = client.callTool({ name: 'take_snapshot', arguments: { tab_id: 'a' } });
    await vi.waitFor(() => expect(upstream.callTool).toHaveBeenCalledTimes(1));
    const cancellation = new AbortController();
    const second = client
      .callTool({ name: 'click', arguments: { tab_id: 'b', uid: 'old' } }, undefined, { signal: cancellation.signal })
      .catch(() => undefined);
    cancellation.abort();
    await second;
    finishFirst();
    await first;
    await client.callTool({ name: 'browser_tabs_list', arguments: {} });
    expect(upstream.callTool).toHaveBeenCalledTimes(1);
  });

  it('refuses an old upstream runtime before sending an exact-target action', async () => {
    const { client, upstream } = await exactTargetFixture();
    upstream.listTools.mockResolvedValue({ tools: [] });
    expect((await client.callTool({ name: 'click', arguments: { tab_id: 'a', uid: '1' } })).isError).toBe(true);
    expect(upstream.callTool).not.toHaveBeenCalled();
  });
});
