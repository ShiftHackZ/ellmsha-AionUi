/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
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
              properties: { verbose: { type: 'boolean' }, filePath: { type: 'string' } },
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
      callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'upstream result' }] }),
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
    expect(upstream.callTool).toHaveBeenCalledWith({ name: 'take_snapshot', arguments: { verbose: true } });

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
    expect(upstream.callTool).toHaveBeenCalledWith({
      name: 'take_snapshot',
      arguments: { filePath: '/tmp/manual-snapshot.txt', verbose: false },
    });
  });
});
