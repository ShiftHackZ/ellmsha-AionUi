import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TencentMemoryClient,
  memoryScope,
  memorySearchProjectOptions,
} from '../../../../packages/desktop/src/process/memory/tencentMemoryClient';

const client = new TencentMemoryClient({
  gatewayUrl: 'http://memory.local/',
  serviceId: 'service',
  teamId: 'team',
  agentId: 'agent',
  userId: 'user',
});
const projectContext = {
  project_id: 'project-1',
  name: 'Project',
  workspace: '/tmp/project',
  roots: ['/tmp/project'],
};
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

  it('uses registered project roots and names for nested-workspace retrieval aliases', () => {
    const options = memorySearchProjectOptions({
      project_id: 'project-1',
      name: 'DemoProject',
      workspace: '/products/demoproject',
      roots: ['/products/demoproject', '/products/demoproject/mobile'],
    });
    expect(options.project_scopes).toEqual([
      memoryScope('/products/demoproject'),
      memoryScope('/products/demoproject/mobile'),
    ]);
    expect(options.project_aliases).toEqual(['demoproject']);
  });

  it.each(['x', 'x'.repeat(161), ' '])('retains hashed scopes when project aliases exceed gateway bounds', (name) => {
    const options = memorySearchProjectOptions({ ...projectContext, name, workspace: '/tmp/x', roots: ['/tmp/x'] });
    expect(options.project_scopes).toEqual([memoryScope('/tmp/x')]);
    expect(options.project_aliases).toEqual([]);
  });

  it('normalizes and deduplicates valid project aliases at both schema boundaries', () => {
    expect(memorySearchProjectOptions({ ...projectContext, name: '  PROJECT  ' }).project_aliases).toEqual(['project']);
    expect(memorySearchProjectOptions({ ...projectContext, name: 'ab' }).project_aliases).toEqual(['ab', 'project']);
    expect(memorySearchProjectOptions({ ...projectContext, name: 'a'.repeat(160) }).project_aliases).toContain(
      'a'.repeat(160)
    );
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
    const data = await client.context('example', projectContext);
    expect(data.unavailable).toEqual(['guidance']);
    expect(data.memories[0].content.length).toBeLessThanOrEqual(1100);
    expect(data.memories[0].truncated).toBe(true);
    expect(data.memories[0].source_path).toBe('knowledge/global/example.md');
    expect(requests.find((request) => request.url.endsWith('scenario/ls'))?.body.path_prefix).toBe(data.bmad_prefix);
    expect(requests.every((request) => request.body.user_id === 'user')).toBe(true);
  });

  it('binds context retrieval to registered project roots for identical queries in two projects', async () => {
    const searches: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options: RequestInit) => {
        const body = JSON.parse(String(options.body));
        if (url.endsWith('atomic/search')) {
          searches.push(body);
          return response({ items: [], complete: true, degraded: false, evidence_status: 'empty' });
        }
        return response(url.endsWith('scenario/ls') ? { entries: [] } : { content: '' });
      })
    );
    const first = { ...projectContext, roots: ['/tmp/project', '/tmp/project/mobile'] };
    const second = { project_id: 'project-2', name: 'Other', workspace: '/tmp/other', roots: ['/tmp/other'] };
    await client.context('latest task', first, '/tmp/project/mobile');
    await client.context('latest task', second);
    expect(searches).toEqual([
      expect.objectContaining({
        query: 'latest task',
        scope_mode: 'current_project',
        project_scopes: [memoryScope('/tmp/project'), memoryScope('/tmp/project/mobile')],
        project_aliases: ['project'],
      }),
      expect.objectContaining({
        query: 'latest task',
        scope_mode: 'current_project',
        project_scopes: [memoryScope('/tmp/other')],
        project_aliases: ['other'],
      }),
    ]);
  });

  it('rejects model-supplied workspace overrides outside the registered project before any gateway call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(client.context('latest task', projectContext, '/tmp/other')).rejects.toThrow(
      'outside the current project'
    );
    expect(fetchMock).not.toHaveBeenCalled();
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

  it('preserves scoped search pagination and exact-id evidence metadata', async () => {
    let request: Record<string, unknown> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, options: RequestInit) => {
        request = JSON.parse(String(options.body));
        return response({
          items: [
            {
              id: 'demo-1',
              content: 'Verified DEMO-4510',
              source_path: 'v2/projects/demoproject/task.md',
              event_date: '2026-10-10',
              status_hint: 'accepted',
            },
          ],
          returned: 1,
          total_candidates: 7,
          complete: false,
          next_offset: 1,
          matched_exact_ids: ['DEMO-4510'],
          missing_exact_ids: ['DEMO-4543'],
          source_catalog: {
            paths: ['v2/projects/demoproject/task.md'],
            returned: 1,
            total: 9,
            complete: false,
            next_offset: 1,
            unindexed_paths: ['v2/projects/demoproject/unindexed.md'],
          },
        });
      })
    );
    const result = await client.search('Compare DEMO-4510 and DEMO-4543', 4, 1800, {
      intent: 'exact_ids',
      scope_mode: 'current_project',
      project_scopes: ['demoproject-1234567890'],
      exact_ids: ['DEMO-4510', 'DEMO-4543'],
    });
    expect(request).toMatchObject({
      intent: 'exact_ids',
      scope_mode: 'current_project',
      exact_ids: ['DEMO-4510', 'DEMO-4543'],
    });
    expect(result).toMatchObject({
      returned: 1,
      total_candidates: 7,
      complete: false,
      next_offset: 1,
      matched_exact_ids: ['DEMO-4510'],
      missing_exact_ids: ['DEMO-4543'],
      source_catalog: {
        paths: ['v2/projects/demoproject/task.md'],
        returned: 1,
        total: 9,
        complete: false,
        next_offset: 1,
        unindexed_paths: ['v2/projects/demoproject/unindexed.md'],
      },
    });
    expect(result.items[0]).toMatchObject({ event_date: '2026-10-10', status_hint: 'accepted' });
  });

  it('keeps a failed retrieval branch visible even when the candidate census is complete', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response({
          items: [{ id: 'one', content: 'Available fallback evidence' }],
          complete: true,
          degraded: true,
          strategy: 'fts',
          message: 'A search branch failed; fallback evidence may omit relevant sources.',
          evidence_status: 'degraded',
          provider_response: 'must-not-be-exposed',
        })
      )
    );
    const result = await client.search('example');
    expect(result).toMatchObject({
      complete: true,
      degraded: true,
      strategy: 'fts',
      message: 'A search branch failed; fallback evidence may omit relevant sources.',
      evidence_status: 'degraded',
      items: [{ id: 'one', content: 'Available fallback evidence' }],
    });
    expect(result).not.toHaveProperty('provider_response');
  });

  it('does not turn a legacy response without retrieval health into complete evidence', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ items: [{ id: 'one', content: 'Legacy evidence' }] }))
    );
    const result = await client.search('example');
    expect(result).toMatchObject({
      complete: false,
      degraded: true,
      evidence_status: 'degraded',
      message: 'Gateway did not report retrieval health; treat the evidence as partial.',
    });
    expect(result.next_offset).toBeUndefined();
  });

  it('preserves a healthy empty result without inventing a retrieval failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ items: [], complete: true, degraded: false, evidence_status: 'empty' }))
    );
    expect(await client.search('no matching evidence')).toMatchObject({
      items: [],
      complete: true,
      degraded: false,
      evidence_status: 'empty',
      message: undefined,
    });
  });

  it('retains retrieval warnings in the context tool while returning usable memories', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        response(
          url.endsWith('atomic/search')
            ? {
                items: [{ id: 'one', content: 'Fallback evidence' }],
                complete: false,
                degraded: true,
                message: 'One retrieval path is unavailable.',
                evidence_status: 'degraded',
              }
            : url.endsWith('scenario/ls')
              ? { entries: [] }
              : { content: 'Current guidance' }
        )
      )
    );
    const result = await client.context('example', projectContext);
    expect(result.memories).toMatchObject([{ id: 'one', content: 'Fallback evidence' }]);
    expect(result.memory_retrieval).toMatchObject({
      complete: false,
      degraded: true,
      message: 'One retrieval path is unavailable.',
      evidence_status: 'degraded',
    });
    expect(result.memory_retrieval).not.toHaveProperty('items');
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
