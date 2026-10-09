import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  knowledgeRepositoryUrl,
  TencentKnowledgeClient,
} from '../../../../packages/desktop/src/process/memory/tencentKnowledgeClient';
vi.mock('../../../../packages/desktop/src/process/memory/tencentGenerationContext', () => ({
  resolveTencentGenerationContext: async () => ({
    base_url: 'http://core.local/v1',
    model: 'selected-model',
    callback_token: 'private-callback',
  }),
}));

const config = {
  gatewayUrl: 'http://memory.local',
  knowledgeUrl: 'http://knowledge.local/',
  knowledgeServiceKey: 'private-service-key',
  teamId: 'team',
  agentId: 'agent',
  userId: 'user',
  serviceId: 'default',
};
const response = (data: unknown) => new Response(JSON.stringify({ code: 0, data }));
const tempDirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Tencent Knowledge adapter', () => {
  it('maps allowed directories and rejects traversal and symlink escapes', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'knowledge-mount-'));
    tempDirs.push(root);
    mkdirSync(path.join(root, 'allowed'));
    mkdirSync(path.join(root, 'allowed', 'space project'));
    mkdirSync(path.join(root, 'outside'));
    symlinkSync(path.join(root, 'outside'), path.join(root, 'allowed', 'escape'));
    const mappings = [
      { hostPath: path.join(root, 'missing'), servicePath: '/offline' },
      { hostPath: path.join(root, 'allowed'), servicePath: '/workspaces' },
    ];
    expect(knowledgeRepositoryUrl(path.join(root, 'allowed', 'space project'), mappings)).toBe(
      'file:///workspaces/space%20project'
    );
    expect(() => knowledgeRepositoryUrl(path.join(root, 'allowed', '..', 'outside'), mappings)).toThrow('not mounted');
    expect(() => knowledgeRepositoryUrl(path.join(root, 'allowed', 'escape'), mappings)).toThrow('not mounted');
  });

  it('does not report empty search results for unfinished or failed knowledge', async () => {
    const fetchMock = vi.fn(async () => response({ team_id: 'team', status: 'failed', sync_error: 'parser failed' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new TencentKnowledgeClient(config).query('cg-test', 'search', { query: 'foo' })).rejects.toThrow(
      'parser failed'
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps raw Wiki sources readable after failed synthesis', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        response(
          url.endsWith('/get')
            ? { team_id: 'team', status: 'failed', sync_error: 'model error' }
            : { items: [{ filename: 'source.md', content: 'Original verified facts' }] }
        )
      )
    );
    const source = await new TencentKnowledgeClient(config).query('wiki-test', 'read_raw', {
      filenames: ['source.md'],
    });
    expect(source).toEqual({ items: [{ filename: 'source.md', content: 'Original verified facts' }] });
  });

  it('keeps credentials out of query params and restricts resource reads to the configured team', async () => {
    const requests: Array<{ url: string; headers: HeadersInit | undefined; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options: RequestInit) => {
        requests.push({ url, headers: options.headers, body: JSON.parse(String(options.body)) });
        return response(
          url.endsWith('/get') ? { team_id: 'team', status: 'ready' } : { text: 'function foo', isError: false }
        );
      })
    );
    expect(await new TencentKnowledgeClient(config).query('cg-test', 'search', { query: 'foo' })).toMatchObject({
      text: 'function foo',
      isError: false,
    });
    expect(requests[1].body).toEqual({ knowledge_id: 'cg-test', tool_name: 'search', params: { query: 'foo' } });
    expect(new Headers(requests[1].headers).get('Authorization')).toBe('Bearer private-service-key');
    expect(JSON.stringify(requests.map((request) => request.body))).not.toContain('private-service-key');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ team_id: 'other-team', status: 'ready' }))
    );
    await expect(new TencentKnowledgeClient(config).query('cg-test', 'search', {})).rejects.toThrow('another team');
  });

  it('uploads wiki source before async ingest and preserves the stable wiki ID', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options: RequestInit) => {
        requests.push({ url, body: JSON.parse(String(options.body)) });
        return response(
          url.endsWith('/create')
            ? { wiki_id: 'wiki-test', team_id: 'team', status: 'draft' }
            : { status: 'processing' }
        );
      })
    );
    const result = await new TencentKnowledgeClient(config).ingest({
      name: 'Project',
      files: [{ filename: 'guide.md', content: '# Guide' }],
    });
    expect(result.wiki_id).toBe('wiki-test');
    expect(result.accepted).toBe(true);
    expect(requests.map((request) => request.url)).toEqual([
      'http://knowledge.local/v3/wiki/create',
      'http://knowledge.local/v3/wiki/raw/write',
      'http://knowledge.local/v3/wiki/ingest',
    ]);
    expect(requests[1].body.files).toEqual([{ filename: 'guide.md', content: '# Guide' }]);
    expect(requests[2].body.wiki_id).toBe('wiki-test');
    expect(requests[2].body.llm_context).toMatchObject({ model: 'selected-model' });
    expect(JSON.stringify(result)).not.toContain('private-callback');
  });

  it('returns the newly created pending index without starting a duplicate sync', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'knowledge-index-'));
    tempDirs.push(root);
    const fetchMock = vi.fn(async () => response({ code_graph_id: 'cg-test', team_id: 'team', status: 'pending' }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await new TencentKnowledgeClient({
      ...config,
      knowledgeWorkspaces: [{ hostPath: root, servicePath: '/workspace' }],
    }).index(root);
    expect(result.code_graph_id).toBe('cg-test');
    expect(result.accepted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('propagates engine errors even inside a successful HTTP envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ isError: true, text: 'instance not loaded' }))
    );
    await expect(new TencentKnowledgeClient(config).call('tools/call', {})).rejects.toThrow('instance not loaded');
  });
});
