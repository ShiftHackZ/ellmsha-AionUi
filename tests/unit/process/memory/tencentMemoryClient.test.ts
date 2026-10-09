import { afterEach, describe, expect, it, vi } from 'vitest';
import { TencentMemoryClient, memoryScope } from '../../../../packages/desktop/src/process/memory/tencentMemoryClient';

const client = new TencentMemoryClient({
  gatewayUrl: 'http://memory.local/',
  serviceId: 'service',
  teamId: 'team',
  agentId: 'agent',
  userId: 'user',
});
const response = (data: unknown, code = 0, message = 'ok') =>
  new Response(JSON.stringify({ code, message, data }), { status: code || 200 });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('TencentDB shared memory client', () => {
  it('uses stable workspace namespaces and separates equal basenames', () => {
    expect(memoryScope('/tmp/project/')).toBe(memoryScope('/tmp/project'));
    expect(memoryScope('/tmp/a/project')).not.toBe(memoryScope('/tmp/b/project'));
    expect(() => memoryScope('')).toThrow('workspace is missing');
  });

  it('retains useful recall and explicit unavailable status when one layer fails', async () => {
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options: RequestInit) => {
        const body = JSON.parse(String(options.body));
        requests.push({ url, body });
        if (url.endsWith('core/read')) throw new Error('offline');
        if (url.endsWith('scenario/ls'))
          return response({ entries: [{ path: 'bmad/project/prd.md', summary: 'PRD' }] });
        return response({
          items: [{ id: 'one', content: '😀'.repeat(5000), source_path: 'knowledge/global/example.md' }],
        });
      })
    );
    const data = await client.context('example', '/tmp/project');
    expect(data.unavailable).toEqual(['guidance']);
    expect(data.memories[0].content.length).toBeLessThanOrEqual(1100);
    expect(data.memories[0].truncated).toBe(true);
    expect(data.memories[0].source_path).toBe('knowledge/global/example.md');
    expect(requests.find((request) => request.url.endsWith('scenario/ls'))?.body.path_prefix).toBe(data.bmad_prefix);
    expect(requests.every((request) => request.body.user_id === 'user')).toBe(true);
  });

  it('requires synchronous indexing and sends full content separately from its bounded excerpt', async () => {
    let request: Record<string, unknown> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, options: RequestInit) => {
        request = JSON.parse(String(options.body));
        return response({ path: request.path, memory_id: 'stable-id', version: 2 });
      })
    );
    const content = '😀'.repeat(20000);
    const saved = await client.writeScenario('bmad/test/prd.md', content, 'Requirements');
    expect(saved.indexed).toBe(true);
    expect(request.content).toBe(content);
    expect(String(request.index_content).length).toBeLessThanOrEqual(7800);
    expect(String(request.index_content)).toContain('Requirements');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ path: 'bmad/test/prd.md' }))
    );
    await expect(client.writeScenario('bmad/test/prd.md', 'PRD')).rejects.toThrow('without a searchable record');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(null, 503, 'Document saved, but its memory index failed. Retry the same path.'))
    );
    await expect(client.writeScenario('bmad/test/prd.md', 'PRD')).rejects.toThrow('Retry the same path');
  });

  it('updates a deterministic project subject and provides bounded catalog pagination', async () => {
    vi.stubEnv('AIONUI_TDAI_MEMORY_WORKSPACE', '/tmp/project');
    const fetchMock = vi.fn(async (url: string, options: RequestInit) => {
      const body = JSON.parse(String(options.body));
      return response(
        url.endsWith('scenario/ls')
          ? { entries: Array.from({ length: 50 }, (_, i) => ({ path: `bmad/prd-${i}.md` })) }
          : { path: body.path, memory_id: 'same-id' }
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const first = await client.writeMemory({ subject: 'csv-delimiter', content: 'Use semicolon' });
    const second = await client.writeMemory({ subject: 'csv-delimiter', content: 'Use comma' });
    expect(second.path).toBe(first.path);
    expect(first.path).toBe(`knowledge/${memoryScope()}/csv-delimiter.md`);
    const catalog = await client.list('bmad/', 30, 10);
    expect(catalog.entries).toHaveLength(10);
    expect(catalog.total).toBe(50);
    expect(catalog.has_more).toBe(true);
  });
});
