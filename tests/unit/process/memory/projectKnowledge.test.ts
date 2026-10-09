import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import {
  discoverRepositories,
  allowNativeProject,
  resolveProjectContext,
} from '../../../../packages/desktop/src/process/memory/project';
import { ProjectKnowledge } from '../../../../packages/desktop/src/process/memory/project/knowledge';

const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  temporary.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'project-code-')));
  temporary.push(root);
  const product = path.join(root, 'Product');
  mkdirSync(product);
  const repo = (directory: string) => {
    mkdirSync(directory, { recursive: true });
    execFileSync('git', ['init', '-q', directory]);
    writeFileSync(path.join(directory, 'source.ts'), 'export function commonSymbol() {}');
    return directory;
  };
  const backend = repo(path.join(product, 'backend'));
  const mobile = repo(path.join(product, 'mobile'));
  const attached = repo(path.join(root, 'frontend'));
  const context = { project_id: 'product-1', name: 'Product', workspace: product, roots: [product, attached] };
  const config = {
    gatewayUrl: 'http://memory',
    knowledgeUrl: 'http://knowledge',
    serviceId: 'service',
    teamId: 'team',
    userId: 'user',
    agentId: 'agent',
    knowledgeServiceKey: 'private',
    nativeKnowledgeProjectsDir: path.join(root, 'grants'),
  };
  return { root, product, backend, mobile, attached, context, config, repo };
}
const response = (data: unknown) => new Response(JSON.stringify({ code: 0, data }));
it('discovers a non-Git product and attached repositories while excluding symlinks and worktrees', async () => {
  const f = fixture();
  f.repo(path.join(f.product, '.worktrees/old'));
  f.repo(path.join(f.product, 'node_modules/dependency'));
  symlinkSync(f.attached, path.join(f.product, 'linked'));
  const result = await discoverRepositories(f.context);
  expect(result.repositories.map((r) => r.path)).toEqual([f.backend, f.mobile, f.attached]);
  expect(result.errors).toEqual([]);
});
it('keeps valid repositories and reports missing attached roots', async () => {
  const f = fixture();
  const result = await discoverRepositories({
    ...f.context,
    roots: [...f.context.roots, path.join(f.root, 'missing')],
  });
  expect(result.repositories).toHaveLength(3);
  expect(result.errors[0].path).toContain('missing');
});
it('searches only current project graphs and exposes partial results instead of a false empty success', async () => {
  const f = fixture();
  const graphs = [
    {
      code_graph_id: 'cg-backend',
      repo_url: pathToFileURL(f.backend).href,
      branch: 'local',
      status: 'ready',
      team_id: 'team',
    },
    {
      code_graph_id: 'cg-mobile',
      repo_url: pathToFileURL(f.mobile).href,
      branch: 'local',
      status: 'failed',
      sync_error: 'parser failed',
      team_id: 'team',
    },
    { code_graph_id: 'cg-other', repo_url: 'file:///other-project', branch: 'local', status: 'ready', team_id: 'team' },
  ];
  const queries: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (url.endsWith('/list')) return response({ items: graphs, total: graphs.length });
      if (url.endsWith('/get')) return response(graphs.find((g) => g.code_graph_id === body.code_graph_id));
      queries.push(body.knowledge_id);
      return response({ text: 'commonSymbol source.ts' });
    })
  );
  const result = await new ProjectKnowledge(f.config).search(f.context, 'commonSymbol');
  expect(queries).toEqual(['cg-backend']);
  expect(result.complete).toBe(false);
  expect(result.results.map((r) => r.status)).toEqual(['ready', 'failed', 'not_indexed']);
  // Detaching the frontend removes it from the project result immediately.
  expect(
    (await new ProjectKnowledge(f.config).catalog({ ...f.context, roots: [f.product] })).repositories
  ).toHaveLength(2);
});
it('indexes each repository once, keeps project grants, and rejects unrelated requested paths', async () => {
  const f = fixture();
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (url.endsWith('/list')) return response({ items: [], total: 0 });
      urls.push(body.repo_url);
      return response({ code_graph_id: `cg-${urls.length}`, status: 'pending', team_id: 'team' });
    })
  );
  const client = new ProjectKnowledge(f.config);
  await expect(client.index(f.context, '/unrelated')).rejects.toThrow('not in the current project');
  const result = await client.index(f.context);
  expect(result.results).toHaveLength(3);
  expect(new Set(urls)).toEqual(new Set([f.backend, f.mobile, f.attached].map((p) => pathToFileURL(p).href)));
  const grants = JSON.parse(
    readFileSync(
      path.join(f.config.nativeKnowledgeProjectsDir, readdirSync(f.config.nativeKnowledgeProjectsDir)[0]),
      'utf8'
    )
  );
  expect(grants).toEqual([f.backend, f.mobile, f.attached]);
});
it('project grant files remain separate across concurrent projects', async () => {
  const f = fixture();
  await Promise.all([
    allowNativeProject(f.config.nativeKnowledgeProjectsDir, f.context),
    allowNativeProject(f.config.nativeKnowledgeProjectsDir, { ...f.context, project_id: 'other' }),
  ]);
  expect(readdirSync(f.config.nativeKnowledgeProjectsDir).filter((p) => p.endsWith('.json'))).toHaveLength(2);
});
it('resolves live project context through the chat capability and fails closed on rejection', async () => {
  const f = fixture();
  vi.stubEnv('AIONUI_GENERATION_CONTEXT_URL', 'http://backend/api/memory/generation/context');
  vi.stubEnv('AIONUI_GENERATION_TOKEN', 'private');
  vi.stubEnv('AIONUI_CONVERSATION_ID', 'chat');
  const fetchMock = vi.fn(
    async (_url: unknown, _init: unknown) => new Response(JSON.stringify({ success: true, data: f.context }))
  );
  vi.stubGlobal('fetch', fetchMock);
  expect(await resolveProjectContext()).toEqual(f.context);
  expect(String(fetchMock.mock.calls[0][0])).toBe('http://backend/api/memory/project/context');
  vi.stubGlobal('fetch', async () => new Response('', { status: 401 }));
  await expect(resolveProjectContext()).rejects.toThrow('HTTP 401');
});
