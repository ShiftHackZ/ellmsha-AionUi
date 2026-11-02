import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createBackgroundProcessServer } from '@process/resources/background-process/server';
import { createBackgroundProcessClient } from '@process/resources/background-process/client';

const env = {
  AIONUI_BASE_URL: 'http://127.0.0.1:12345/',
  AIONUI_USER_ID: 'owner',
  AIONUI_CONVERSATION_ID: 'chat/one',
  AIONUI_RUNTIME_TOKEN: 'private-fixture-token',
};
const id = 'cd9bf2ea-93d9-49a3-baa8-540bc969819d';
afterEach(() => vi.unstubAllGlobals());
describe('app-owned background process MCP', () => {
  it('executes start/list/read/stop through MCP with immutable host identity and normal mutation approvals', async () => {
    const fetch = vi.fn(
      async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ data: { id } }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetch);
    const server = createBackgroundProcessServer(env);
    const client = new Client({ name: 'fixture', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).slice(0, 4)).toEqual([
        'ellmsha_background_start',
        'ellmsha_background_list',
        'ellmsha_background_read_stdout',
        'ellmsha_background_stop',
      ]);
      expect(
        tools
          .slice(0, 4)
          .filter((tool) => tool.annotations?.readOnlyHint)
          .map((tool) => tool.name)
      ).toEqual(['ellmsha_background_list', 'ellmsha_background_read_stdout']);
      expect(tools.find((tool) => tool.name === 'ellmsha_background_stop')?.annotations?.destructiveHint).toBe(true);
      for (const [name, args] of [
        [
          'ellmsha_background_start',
          {
            command: 'npm run dev',
            title: 'Frontend',
            cwd: 'web',
            user_id: 'attacker',
            conversation_id: 'other',
            pid: 1,
          },
        ],
        ['ellmsha_background_list', {}],
        ['ellmsha_background_read_stdout', { process_id: id }],
        ['ellmsha_background_stop', { process_id: id }],
      ] as const) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).not.toBe(true);
      }
      expect(fetch.mock.calls.map((call) => call[0])).toEqual([
        'http://127.0.0.1:12345/api/conversations/chat%2Fone/background-processes',
        'http://127.0.0.1:12345/api/conversations/chat%2Fone/background-processes',
        `http://127.0.0.1:12345/api/conversations/chat%2Fone/background-processes/${id}`,
        `http://127.0.0.1:12345/api/conversations/chat%2Fone/background-processes/${id}/stop`,
      ]);
      const init = fetch.mock.calls[0][1];
      expect(init).toMatchObject({
        method: 'POST',
        redirect: 'error',
        headers: {
          'x-aionui-runtime-token': env.AIONUI_RUNTIME_TOKEN,
          'x-aionui-user-id': 'owner',
          'x-aionui-conversation-id': 'chat/one',
        },
      });
      expect(JSON.parse(init.body as string)).toEqual({ command: 'npm run dev', title: 'Frontend', cwd: 'web' });
      const invalid = await client.callTool({ name: 'ellmsha_background_stop', arguments: { process_id: '1234' } });
      expect(invalid.isError).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(4);
      fetch.mockRejectedValueOnce(new Error('secret transport internals'));
      const unavailable = await client.callTool({ name: 'ellmsha_background_list', arguments: {} });
      expect(unavailable.isError).toBe(true);
      expect(JSON.stringify(unavailable)).not.toContain('secret transport internals');
      expect(JSON.stringify(unavailable)).toContain('Background terminal unavailable');
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('exposes the interactive toolset against the same host-owned session with revision-protected writes', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: { id } }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const server = createBackgroundProcessServer(env);
    const client = new Client({ name: 'terminal-fixture', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    try {
      const tools = (await client.listTools()).tools;
      expect(tools.filter((tool) => tool.name.startsWith('ellmsha_terminal_'))).toHaveLength(9);
      for (const [name, args] of [
        ['ellmsha_terminal_create', {}],
        ['ellmsha_terminal_list', {}],
        ['ellmsha_terminal_read', { process_id: id }],
        ['ellmsha_terminal_write', { process_id: id, data: 'hello', expected_revision: 4 }],
        ['ellmsha_terminal_execute', { process_id: id, command: 'pwd', expected_revision: 5 }],
        ['ellmsha_terminal_send_key', { process_id: id, key: 'CtrlC', expected_revision: 6 }],
        ['ellmsha_terminal_resize', { process_id: id, rows: 32, cols: 100 }],
        ['ellmsha_terminal_wait', { process_id: id, text: 'ready', timeout_ms: 1000 }],
        ['ellmsha_terminal_close', { process_id: id }],
      ] as const)
        expect((await client.callTool({ name, arguments: args })).isError).not.toBe(true);
      expect(
        fetch.mock.calls
          .slice(3, 6)
          .map((call) => JSON.parse((call as unknown as [string, RequestInit])[1].body as string))
      ).toEqual([
        { data: 'hello', expected_revision: 4 },
        { data: 'pwd\r', expected_revision: 5 },
        { data: '\x03', expected_revision: 6 },
      ]);
      const missing = await client.callTool({
        name: 'ellmsha_terminal_write',
        arguments: { process_id: id, data: 'bad' },
      });
      expect(missing.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('fails closed without complete runtime identity or with a credential-bearing or non-HTTP origin', () => {
    expect(() => createBackgroundProcessClient({})).toThrow('runtime context unavailable');
    for (const url of ['file:///tmp/backend', 'http://secret@localhost/']) {
      expect(() => createBackgroundProcessClient({ ...env, AIONUI_BASE_URL: url })).toThrow('Invalid runtime origin');
    }
  });
});
