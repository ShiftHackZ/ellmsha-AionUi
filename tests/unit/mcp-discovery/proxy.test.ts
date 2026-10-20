import { afterEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourcesResultSchema,
  ReadResourceRequestSchema,
  ReadResourceResultSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { createDiscoveryProxy } from '../../../packages/desktop/src/process/resources/mcp-discovery/proxy';

const peers: Array<Client | Server> = [];
afterEach(async () => {
  await Promise.allSettled(peers.splice(0).map((peer) => peer.close()));
});
const setup = async (definitions?: Tool[]) => {
  const tools: Tool[] =
    definitions ??
    Array.from({ length: 293 }, (_, index) => ({
      name: `qa_tool_${index}`,
      description: `Fixture ${index}. ${'Large integration documentation. '.repeat(30)}`,
      inputSchema: {
        type: 'object',
        properties: { proof: { type: 'string', description: 'Required proof' } },
        required: ['proof'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: index === 0, destructiveHint: index !== 0 },
      outputSchema: { type: 'object', properties: { proof: { type: 'string' } }, required: ['proof'] },
    }));
  const fixture = new Server(
    { name: 'fixture', version: '1' },
    { capabilities: { tools: { listChanged: true }, resources: {} }, instructions: 'QA_INTEGRATION_DOCUMENTATION' }
  );
  fixture.setRequestHandler(ListToolsRequestSchema, async (request) => ({
    tools: tools.slice(request.params?.cursor ? 200 : 0, request.params?.cursor ? undefined : 200),
    ...(request.params?.cursor ? {} : { nextCursor: 'page2' }),
  }));
  fixture.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [{ type: 'text', text: 'QA_EXECUTED' }],
    structuredContent: { proof: request.params.arguments?.proof },
    _meta: { fixture: true },
  }));
  fixture.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ name: 'qa-skill', uri: 'fixture://qa-skill' }],
  }));
  fixture.setRequestHandler(ReadResourceRequestSchema, async () => ({
    contents: [{ uri: 'fixture://qa-skill', text: 'QA_SKILL_BODY_ON_DEMAND' }],
  }));
  const upstream = new Client({ name: 'proxy-upstream', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await fixture.connect(a);
  await upstream.connect(b);
  const proxy = await createDiscoveryProxy(upstream);
  const downstream = new Client({ name: 'fixture-agent', version: '1' });
  const [c, d] = InMemoryTransport.createLinkedPair();
  await proxy.connect(c);
  await downstream.connect(d);
  peers.push(downstream, proxy, upstream, fixture);
  return { tools, downstream, fixture };
};
it('sends compact schemas for 293 tools, without eagerly injecting integration or skill bodies', async () => {
  const { tools, downstream } = await setup();
  const listed = await downstream.listTools();
  expect(JSON.stringify(listed).length).toBeLessThan(JSON.stringify(tools).length / 2);
  expect(listed.tools.find((tool) => tool.name === 'qa_tool_292')).toMatchObject({
    inputSchema: tools[292].inputSchema,
    annotations: { destructiveHint: true },
  });
  expect(JSON.stringify(listed)).not.toMatch(/QA_SKILL_BODY|QA_INTEGRATION_DOCUMENTATION/);
});
it('loads only the selected schema, executes the original name/arguments and preserves structured results', async () => {
  const { tools, downstream } = await setup();
  const search = await downstream.callTool({
    name: 'ellmsha_search_tools',
    arguments: { query: 'qa_tool_292', limit: 1 },
  });
  expect(JSON.stringify(search)).toContain('QA_INTEGRATION_DOCUMENTATION');
  const listed = await downstream.listTools();
  expect(listed.tools.find((tool) => tool.name === 'qa_tool_292')).toEqual(tools[292]);
  const result = await downstream.callTool({ name: 'qa_tool_292', arguments: { proof: 'selected-proof' } });
  expect(result).toMatchObject({
    content: [{ text: 'QA_EXECUTED' }],
    structuredContent: { proof: 'selected-proof' },
    _meta: { fixture: true },
  });
});
it('keeps discovery state separate for each agent and rejects missing/unknown tools', async () => {
  const one = await setup();
  const two = await setup();
  await one.downstream.callTool({ name: 'ellmsha_search_tools', arguments: { query: 'qa_tool_292' } });
  expect((await two.downstream.listTools()).tools.find((tool) => tool.name === 'qa_tool_292')?.description).not.toEqual(
    one.tools[292].description
  );
  await expect(one.downstream.callTool({ name: 'ellmsha_search_tools', arguments: {} })).rejects.toThrow();
  await expect(one.downstream.callTool({ name: 'unknown_tool', arguments: {} })).rejects.toThrow();
  await expect(one.downstream.callTool({ name: 'qa_tool_292', arguments: {} })).rejects.toThrow(/schema/);
});
it('preserves resource discovery and loads an MCP-backed skill only when read', async () => {
  const { downstream } = await setup();
  expect(await downstream.request({ method: 'resources/list' }, ListResourcesResultSchema)).toMatchObject({
    resources: [{ uri: 'fixture://qa-skill' }],
  });
  expect(
    await downstream.request(
      { method: 'resources/read', params: { uri: 'fixture://qa-skill' } },
      ReadResourceResultSchema
    )
  ).toMatchObject({ contents: [{ text: 'QA_SKILL_BODY_ON_DEMAND' }] });
});
it('invalidates a previously loaded schema after an upstream catalog change', async () => {
  const { downstream, tools, fixture } = await setup();
  await downstream.callTool({ name: 'ellmsha_search_tools', arguments: { query: 'qa_tool_292' } });
  tools[292] = { ...tools[292], inputSchema: { type: 'object', properties: { revision2: { type: 'string' } } } };
  await fixture.sendToolListChanged();
  // A second search refreshes even for clients ignoring list_changed notifications.
  const result = await downstream.callTool({ name: 'ellmsha_search_tools', arguments: { query: 'qa_tool_292' } });
  expect(JSON.stringify(result)).toContain('revision2');
  expect(
    (await downstream.listTools()).tools.find((tool) => tool.name === 'qa_tool_292')?.inputSchema.properties
  ).toHaveProperty('revision2');
});

it('retains resource-only MCP skill servers that do not offer tools/list', async () => {
  const fixture = new Server({ name: 'skills-only', version: '1' }, { capabilities: { resources: {} } });
  fixture.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ name: 'skill', uri: 'skill://proof' }],
  }));
  const upstream = new Client({ name: 'proxy-upstream', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await fixture.connect(a);
  await upstream.connect(b);
  const proxy = await createDiscoveryProxy(upstream);
  const downstream = new Client({ name: 'agent', version: '1' });
  const [c, d] = InMemoryTransport.createLinkedPair();
  await proxy.connect(c);
  await downstream.connect(d);
  peers.push(downstream, proxy, upstream, fixture);
  expect(await downstream.request({ method: 'resources/list' }, ListResourcesResultSchema)).toMatchObject({
    resources: [{ uri: 'skill://proof' }],
  });
});

it('validates revised input schemas even when the upstream reuses the same schema ID', async () => {
  const { downstream, tools } = await setup();
  tools[292].inputSchema.$id = 'https://fixture.invalid/input';
  await downstream.callTool({ name: 'ellmsha_search_tools', arguments: { query: 'qa_tool_292' } });
  await downstream.callTool({ name: 'qa_tool_292', arguments: { proof: 'first' } });
  tools[292] = {
    ...tools[292],
    inputSchema: {
      ...tools[292].inputSchema,
      properties: { proof: { type: 'string' }, revision2: { type: 'string' } },
      required: ['proof', 'revision2'],
    },
  };
  await downstream.callTool({ name: 'ellmsha_search_tools', arguments: { query: 'qa_tool_292' } });
  await expect(downstream.callTool({ name: 'qa_tool_292', arguments: { proof: 'stale' } })).rejects.toThrow(/schema/);
  expect(
    await downstream.callTool({ name: 'qa_tool_292', arguments: { proof: 'current', revision2: 'loaded' } })
  ).toMatchObject({ structuredContent: { proof: 'current' } });
});

it('propagates cancellation to an upstream tool instead of leaving detached work', async () => {
  const { downstream, fixture } = await setup();
  let cancelled = false;
  let start!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  fixture.setRequestHandler(CallToolRequestSchema, async (_request, extra) => {
    await new Promise<void>((resolve) => {
      extra.signal.addEventListener(
        'abort',
        () => {
          cancelled = true;
          resolve();
        },
        { once: true }
      );
      start();
    });
    return { content: [], structuredContent: { proof: 'cancelled' } };
  });
  const controller = new AbortController();
  const pending = downstream.callTool({ name: 'qa_tool_292', arguments: { proof: 'cancel' } }, undefined, {
    signal: controller.signal,
  });
  await started;
  controller.abort();
  await expect(pending).rejects.toThrow();
  await expect.poll(() => cancelled).toBe(true);
});

it('finds tools for the actual multi-keyword queries that failed in skcockpit', async () => {
  const { downstream } = await setup([
    { name: 'browser_tabs_list', description: 'List browser tabs', inputSchema: { type: 'object' } },
    { name: 'browser_tab_snapshot', description: 'Inspect a browser page', inputSchema: { type: 'object' } },
    { name: 'browser_tab_navigate', description: 'Navigate a tab', inputSchema: { type: 'object' } },
    { name: 'press_key', description: 'Press a keyboard shortcut', inputSchema: { type: 'object' } },
    { name: 'type_text', description: 'Type into an app', inputSchema: { type: 'object' } },
    {
      name: 'get_app_state',
      description: 'Inspect desktop window accessibility and screenshot',
      inputSchema: { type: 'object' },
    },
  ]);
  const search = async (query: string) => {
    const result = await downstream.callTool({ name: 'ellmsha_search_tools', arguments: { query } });
    const text = (result.content as Array<{ text: string }>)[0].text;
    return JSON.parse(text).tools.map((tool: Tool) => tool.name);
  };
  expect(await search('browser tabs list snapshot navigate')).toEqual([
    'browser_tabs_list',
    'browser_tab_snapshot',
    'browser_tab_navigate',
  ]);
  expect(await search('press_key type_text')).toEqual(['press_key', 'type_text']);
  expect(await search('computer use screenshot inspect desktop window')).toContain('get_app_state');
});

it('advertises real argument types before discovery, including parameters named description', async () => {
  const inputSchema: Tool['inputSchema'] = {
    type: 'object',
    properties: { app: { type: 'string' }, element_index: { type: 'string' }, description: { type: 'string' } },
    required: ['app', 'element_index'],
    additionalProperties: false,
  };
  const { downstream } = await setup([{ name: 'click', description: 'Click an app element', inputSchema }]);
  expect((await downstream.listTools()).tools.find((tool) => tool.name === 'click')?.inputSchema).toEqual(inputSchema);
  await expect(downstream.callTool({ name: 'click', arguments: { app: 'Arc', element_index: 280 } })).rejects.toThrow(
    /schema/
  );
  expect(await downstream.callTool({ name: 'click', arguments: { app: 'Arc', element_index: '280' } })).toMatchObject({
    content: [{ text: 'QA_EXECUTED' }],
  });
});
