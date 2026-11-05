import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, expect, it, vi } from 'vitest';
import { registerUserQuestionTool } from '@process/memory/tencentUserQuestion';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('only the bound chat can ask a question and receives the host answer through MCP', async () => {
  vi.stubEnv('AIONUI_CONVERSATION_ID', 'fixture-chat');
  vi.stubEnv('AIONUI_GENERATION_TOKEN', 'fixture-token');
  vi.stubEnv('AIONUI_GENERATION_CONTEXT_URL', 'http://fixture/api/memory/generation/context');
  const response = { answers: [{ question: 'choice', labels: ['Selected'] }] };
  const api = vi.fn().mockResolvedValue(Response.json({ success: true, data: response }));
  vi.stubGlobal('fetch', api);
  const server = new McpServer({ name: 'fixture', version: '1' });
  registerUserQuestionTool(server);
  const client = new Client({ name: 'test', version: '1' });
  const [host, agent] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(host), client.connect(agent)]);
  try {
    const result = await client.callTool({
      name: 'ellmsha_ask_user',
      arguments: { conversation_id: 'other', questions: [{ id: 'choice', question: 'Which one?' }] },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse((result.content as [{ text: string }])[0].text)).toEqual(response);
    const [url, init] = api.mock.calls[0];
    expect(String(url)).toBe('http://fixture/api/memory/question');
    expect(JSON.parse(init.body)).toMatchObject({
      conversation_id: 'fixture-chat',
      questions: [{ id: 'choice', question: 'Which one?', options: [], isOther: true, isSecret: false }],
    });
  } finally {
    await client.close();
    await server.close();
  }
});
