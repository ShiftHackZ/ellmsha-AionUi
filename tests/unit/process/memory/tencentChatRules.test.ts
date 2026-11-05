import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { registerChatRuleTools } from '@process/memory/tencentChatRules';

const fields = { title: 'Commit policy', content: 'Keep changes unstaged.' };
const identity = { path: 'knowledge/global/commit-policy.md', revision: 'a'.repeat(64) };
let server: McpServer;
let client: Client;
const request = vi.fn<typeof fetch>();

beforeEach(async () => {
  vi.stubEnv('AIONUI_CONVERSATION_ID', 'own-chat');
  vi.stubEnv('AIONUI_GENERATION_TOKEN', 'fixture-token');
  vi.stubEnv('AIONUI_GENERATION_CONTEXT_URL', 'http://fixture/api/memory/generation/context');
  request.mockReset();
  vi.stubGlobal('fetch', request);
  server = new McpServer({ name: 'fixture', version: '1' });
  registerChatRuleTools(server);
  client = new Client({ name: 'fixture-client', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
});

afterEach(async () => {
  await client.close();
  await server.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('exposes five independent tool grants and only the first one is read-only', async () => {
  const { tools } = await client.listTools();
  expect(tools.map(({ name }) => name)).toEqual([
    'tdai_rules_read',
    'tdai_global_rule_write',
    'tdai_global_rule_delete',
    'tdai_project_rule_write',
    'tdai_project_rule_delete',
  ]);
  expect(tools.map((tool) => tool.annotations?.readOnlyHint)).toEqual([true, false, false, false, false]);
  expect((await client.callTool({ name: 'tdai_rules', arguments: {} })).isError).toBe(true);
});

it.each([false, true])('returns the complete host-scoped rules on read (project %s)', async (project) => {
  const global = { ...identity, scope: 'global', ...fields };
  const snapshot = {
    tool: 'tdai_rules_read',
    project: project ? 'project' : null,
    complete: true,
    revision: 's1',
    rules: project
      ? [
          global,
          { scope: 'project', path: 'knowledge/project/verify.md', content: 'Run checks' },
          { scope: 'project file', path: './AGENTS.md', content: 'Follow the repository guide.' },
        ]
      : [global],
  };
  request.mockResolvedValueOnce(Response.json({ success: true, data: snapshot }));
  const read = await client.callTool({ name: 'tdai_rules_read' });
  expect(read.isError).toBeFalsy();
  expect(JSON.parse((read.content as [{ text: string }])[0].text)).toEqual(snapshot);
  expect(request).toHaveBeenCalledWith(
    new URL('http://fixture/api/memory/rules/read'),
    expect.objectContaining({
      body: JSON.stringify({ conversation_id: 'own-chat' }),
      redirect: 'error',
      headers: expect.objectContaining({ Authorization: 'Bearer fixture-token' }),
    })
  );
});

it.each(['global', 'project'] as const)(
  'only forwards the named %s scope and preserves required edit revisions',
  async (scope) => {
    request.mockImplementation(async () => Response.json({ success: true, data: null }));
    const writeName = `tdai_${scope}_rule_write`;
    const source = { ...identity, path: `knowledge/${scope}/commit-policy.md` };
    const calls = [
      [writeName, fields],
      [writeName, { ...source, ...fields }],
      [`tdai_${scope}_rule_delete`, source],
    ] as const;
    const results = await Promise.all(calls.map(([name, args]) => client.callTool({ name, arguments: args })));
    expect(results.every((result) => !result.isError)).toBe(true);
    expect(request.mock.calls.map(([url, init]) => [String(url), JSON.parse(String(init?.body))])).toEqual(
      expect.arrayContaining(
        [
          { action: 'add', scope, ...fields },
          { action: 'edit', scope, ...source, ...fields },
          { action: 'delete', scope, ...source },
        ].map((mutation) => [
          `http://fixture/api/memory/rules/${scope}/${mutation.action === 'delete' ? 'delete' : 'write'}`,
          { conversation_id: 'own-chat', mutation },
        ])
      )
    );
    expect(request).toHaveBeenCalledTimes(3);
  }
);

it.each([
  ['tdai_rules_read', { scope: 'project' }],
  ['tdai_rules_read', { path: 'knowledge/global/x.md' }],
  ['tdai_project_rule_write', { ...fields, scope: 'global' }],
  ['tdai_project_rule_write', { ...fields, conversation_id: 'another-chat' }],
  ['tdai_global_rule_write', { ...identity, ...fields, action: 'delete' }],
  ['tdai_global_rule_write', { ...fields, path: identity.path }],
  ['tdai_global_rule_write', { ...fields, revision: identity.revision }],
  ['tdai_global_rule_delete', { path: identity.path }],
  ['tdai_global_rule_delete', { ...identity, revision: 'stale' }],
] as const)('rejects invalid %s inputs before contacting the host', async (name, args) => {
  expect((await client.callTool({ name, arguments: args })).isError).toBe(true);
  expect(request).not.toHaveBeenCalled();
});

it('surfaces the host’s stale revision rejection without retrying or reporting success', async () => {
  request.mockResolvedValueOnce(new Response(null, { status: 409 }));
  const result = await client.callTool({ name: 'tdai_global_rule_delete', arguments: identity });
  expect(result.isError).toBe(true);
  expect((result.content as [{ text: string }])[0].text).toContain('tdai_rules_read');
  expect(request).toHaveBeenCalledTimes(1);
});

it('omits every tool from a sidecar without a chat-bound capability', () => {
  vi.stubEnv('AIONUI_GENERATION_TOKEN', '');
  const unbound = new McpServer({ name: 'external', version: '1' });
  const register = vi.spyOn(unbound, 'registerTool');
  registerChatRuleTools(unbound);
  expect(register).not.toHaveBeenCalled();
});
