import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ChatHistoryApiClient,
  ChatHistoryService,
  createChatHistoryServer,
} from '@process/resources/builtinMcp/chatHistoryServer';

type RouteResult = { data?: unknown; status?: number; error?: string };

function mockApi(routes: Record<string, RouteResult>) {
  const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const route = routes[`${url.pathname}${url.search}`];
    if (!route)
      return new Response(JSON.stringify({ error: `unhandled ${url.pathname}${url.search}` }), { status: 500 });
    return new Response(
      JSON.stringify(route.status && route.status >= 400 ? { error: route.error } : { data: route.data }),
      {
        status: route.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  });
  const api = new ChatHistoryApiClient(
    'http://127.0.0.1:25808/',
    'runtime-token',
    'user-1',
    'root-1',
    fetchMock as typeof fetch
  );
  return { api, fetchMock };
}

const root = {
  id: 'root-1',
  name: 'Root chat',
  type: 'acp',
  status: 'finished',
  project_id: 'project-1',
  created_at: 1,
  modified_at: 10,
  extra: { workspace: '/workspace/one' },
};

describe('chat history MCP service', () => {
  it('publishes the three discoverable tools as read-only MCP capabilities', async () => {
    const { api } = mockApi({ '/api/conversations/root-1': { data: root } });
    const server = createChatHistoryServer(new ChatHistoryService(api, 'root-1'));
    const client = new Client({ name: 'history-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name)).toEqual([
      'chat_history_list',
      'chat_history_search',
      'chat_history_read',
    ]);
    expect(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    const response = await client.callTool({
      name: 'chat_history_list',
      arguments: { scope: 'conversation', conversation_id: 'root-1' },
    });
    const content = response.content[0];
    expect(content?.type).toBe('text');
    if (content?.type !== 'text') throw new Error('text response expected');
    expect(JSON.parse(content.text)).toMatchObject({ chats: [{ id: 'root-1' }], page: { has_more: false } });
    await client.close();
    await server.close();
  });

  it('defaults listing to the current project and attributes child conversations', async () => {
    const child = {
      ...root,
      id: 'child-1',
      name: 'Reviewer',
      extra: {
        workspace: '/workspace/one',
        subagent: { parent_conversation_id: 'root-1', ref: 'reviewer', status: 'completed' },
      },
    };
    const foreign = { ...root, id: 'foreign-1', project_id: 'project-2', extra: { workspace: '/workspace/two' } };
    const { api, fetchMock } = mockApi({
      '/api/conversations/root-1': { data: root },
      '/api/conversations?limit=20': { data: { items: [foreign, child], total: 2, has_more: false } },
    });

    const page = await new ChatHistoryService(api, 'root-1').list({});

    expect(page.chats).toHaveLength(1);
    expect(page.chats[0]).toMatchObject({
      id: 'child-1',
      project_id: 'project-1',
      relationship: { kind: 'subagent', parent_conversation_id: 'root-1', ref: 'reviewer' },
    });
    expect(page.context).toMatchObject({ scope: 'current_project', root_conversation_id: 'root-1' });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      'x-aionui-runtime-token': 'runtime-token',
      'x-aionui-user-id': 'user-1',
      'x-aionui-conversation-id': 'root-1',
    });
  });

  it('rejects a continuation cursor reused with another scope', async () => {
    const { api } = mockApi({
      '/api/conversations/root-1': { data: root },
      '/api/conversations?limit=1': { data: { items: [root], total: 2, has_more: true } },
    });
    const service = new ChatHistoryService(api, 'root-1');
    const first = await service.list({ scope: 'all', limit: 1 });

    await expect(service.list({ scope: 'current_project', limit: 1, cursor: first.page.next_cursor! })).rejects.toThrow(
      'List cursor does not match this query scope.'
    );
  });

  it('searches persisted content with hydrated project attribution and explicit preview truncation', async () => {
    const longPreview = 'x'.repeat(2_100);
    const hit = { ...root, id: 'hit-1' };
    const { api } = mockApi({
      '/api/conversations/root-1': { data: root },
      '/api/conversations/hit-1': { data: hit },
      '/api/messages/search?keyword=needle&page_size=1': {
        data: {
          items: [
            {
              message_id: 'message-1',
              message_type: 'text',
              message_created_at: 12,
              preview_text: longPreview,
              conversation: { ...hit, project_id: undefined },
            },
          ],
          total: 2,
          has_more: true,
        },
      },
      '/api/messages/search?keyword=needle&page_size=1&before_created_at=12&before_message_id=message-1': {
        data: {
          items: [
            {
              message_id: 'message-0',
              message_type: 'text',
              message_created_at: 11,
              preview_text: 'older match',
              conversation: { ...hit, project_id: undefined },
            },
          ],
          total: 2,
          has_more: false,
        },
      },
    });

    const result = await new ChatHistoryService(api, 'root-1').search({ query: 'needle', limit: 1 });

    expect(result.matches[0]).toMatchObject({
      message_id: 'message-1',
      preview_truncated: true,
      conversation: { id: 'hit-1', project_id: 'project-1' },
    });
    expect(result.matches[0]?.preview_text).toHaveLength(2_000);
    expect(result.page).toMatchObject({ has_more: true, authenticated_user_total_matches: 2 });
    expect(result.page.next_cursor).toEqual(expect.any(String));

    const continuation = await new ChatHistoryService(api, 'root-1').search({
      query: 'needle',
      limit: 1,
      cursor: result.page.next_cursor!,
    });
    expect(continuation.matches.map((item) => item.message_id)).toEqual(['message-0']);
  });

  it('follows nested parent links for tree scope and preserves subagent parent refs', async () => {
    const treeRoot = { ...root, project_id: undefined, extra: {} };
    const child = {
      ...treeRoot,
      id: 'child-1',
      extra: { subagent: { parent_conversation_id: 'root-1', ref: 'child' } },
    };
    const grandchild = {
      ...treeRoot,
      id: 'grandchild-1',
      extra: {
        subagent: {
          parent_conversation_id: 'child-1',
          ref: 'grandchild',
          parent_ref: 'child',
        },
      },
    };
    const { api } = mockApi({
      '/api/conversations/root-1': { data: treeRoot },
      '/api/conversations/child-1': { data: child },
      '/api/conversations?limit=20': { data: { items: [grandchild], total: 1, has_more: false } },
    });

    const page = await new ChatHistoryService(api, 'root-1').list({ scope: 'current_tree' });

    expect(page.chats).toHaveLength(1);
    expect(page.chats[0]).toMatchObject({
      id: 'grandchild-1',
      relationship: {
        kind: 'subagent',
        parent_conversation_id: 'child-1',
        ref: 'grandchild',
        parent_ref: 'child',
      },
    });
  });

  it('fails explicitly when the list API drops a whole legacy page', async () => {
    const { api } = mockApi({
      '/api/conversations/root-1': { data: root },
      '/api/conversations?limit=20': { data: { items: [], total: 2, has_more: true } },
    });

    await expect(new ChatHistoryService(api, 'root-1').list({})).rejects.toThrow(
      'cannot provide a safe continuation cursor'
    );
  });

  it('reads compact tool results with backend truncation metadata and opaque paging cursors', async () => {
    const tool = {
      id: 'tool-1',
      conversation_id: 'child-1',
      type: 'acp_tool_call',
      content: { update: { rawOutput: 'preview' }, _compact: { truncated: true, original_size: 50_000 } },
      hidden: false,
      created_at: 11,
    };
    const text = {
      id: 'text-1',
      conversation_id: 'child-1',
      type: 'text',
      content: { content: 'answer' },
      hidden: false,
      created_at: 12,
    };
    const child = {
      ...root,
      id: 'child-1',
      extra: { workspace: '/workspace/one', subagent: { parent_conversation_id: 'root-1', ref: 'worker' } },
    };
    const { api } = mockApi({
      '/api/conversations/root-1': { data: root },
      '/api/conversations/child-1': { data: child },
      '/api/conversations/child-1/messages?limit=20&content_mode=compact': {
        data: {
          items: [tool, text],
          oldest_cursor: 'oldest-api-cursor',
          newest_cursor: 'newest-api-cursor',
          has_more_before: true,
          has_more_after: false,
        },
      },
    });

    const page = await new ChatHistoryService(api, 'root-1').read({ conversation_id: 'child-1' });

    expect(page.messages).toHaveLength(2);
    expect(page.conversation.relationship).toMatchObject({ kind: 'subagent', parent_conversation_id: 'root-1' });
    expect(page.page).toMatchObject({
      compacted_messages: 1,
      tool_messages_included: true,
      has_more_before: true,
      next_older_cursor: expect.any(String),
    });
  });

  it('can omit tool messages without hiding that the backend page contained more records', async () => {
    const { api } = mockApi({
      '/api/conversations/root-1': { data: root },
      '/api/conversations/root-1/messages?limit=20&content_mode=compact': {
        data: {
          items: [
            {
              id: 'tool-1',
              conversation_id: 'root-1',
              type: 'tool_group',
              content: {},
              hidden: false,
              created_at: 11,
            },
            {
              id: 'text-1',
              conversation_id: 'root-1',
              type: 'text',
              content: { content: 'answer' },
              hidden: false,
              created_at: 12,
            },
          ],
          oldest_cursor: null,
          newest_cursor: null,
          has_more_before: false,
          has_more_after: false,
        },
      },
    });

    const page = await new ChatHistoryService(api, 'root-1').read({ include_tool_messages: false });

    expect(page.messages.map((message) => message.id)).toEqual(['text-1']);
    expect(page.page).toMatchObject({ returned: 1, fetched: 2, tool_messages_included: false });
  });

  it('reports missing chats and blocks reads outside the default project scope', async () => {
    const foreign = { ...root, id: 'foreign-1', project_id: 'project-2', extra: { workspace: '/workspace/two' } };
    const { api } = mockApi({
      '/api/conversations/root-1': { data: root },
      '/api/conversations/foreign-1': { data: foreign },
      '/api/conversations/missing': { status: 404, error: 'Conversation missing not found' },
    });
    const service = new ChatHistoryService(api, 'root-1');

    await expect(service.read({ conversation_id: 'foreign-1' })).rejects.toMatchObject({ status: 403 });
    await expect(service.read({ conversation_id: 'missing', scope: 'all' })).rejects.toEqual(
      expect.objectContaining({ status: 404, message: 'Conversation missing not found' })
    );
  });
});
