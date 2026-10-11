/** Optional Tencent Agent Wiki and local code graph tools. Service credentials never reach model inputs. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { memoryScope, type MemoryConfig } from './tencentMemoryClient';
import { resolveTencentGenerationContext } from './tencentGenerationContext';

export type KnowledgeConfig = {
  nativeKnowledgeProjectsDir?: string;
  knowledgeUrl?: string;
  knowledgeServiceKey?: string;
  knowledgeWorkspaces?: Array<{ hostPath: string; servicePath: string }>;
};
export type KnowledgeDetail = {
  wiki_id?: string;
  code_graph_id?: string;
  team_id: string;
  name?: string;
  repo_name?: string;
  repo_url?: string;
  branch?: string;
  status: string;
  sync_error?: string | null;
  page_count?: number | null;
  stats?: { files: number; nodes: number; edges: number } | null;
  last_sync_at?: string | null;
};
type KnowledgeList = { items: KnowledgeDetail[]; total: number };
export type CodeRuntimeAction = 'status' | 'allocate' | 'deallocate';
export type CodeRuntimeStatus = {
  code_graph_id: string;
  index_status: string;
  loaded: boolean;
  loading: boolean;
  active_queries: number;
};

/** Resolve symlinks before mapping, so a workspace cannot expose files outside an allowed mount. */
export function knowledgeRepositoryUrl(workspace: string, mappings: KnowledgeConfig['knowledgeWorkspaces']): string {
  const canonical = realpathSync(workspace);
  if (!statSync(canonical).isDirectory()) throw new Error('Code index workspace must be a directory');
  for (const mapping of mappings ?? []) {
    let root: string;
    try {
      root = realpathSync(mapping.hostPath);
    } catch {
      continue;
    } // One disconnected project root must not block other mounted repositories.
    const relative = path.relative(root, canonical);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    if (!path.posix.isAbsolute(mapping.servicePath)) throw new Error('Knowledge service workspace must be absolute');
    const url = new URL('file:///');
    url.pathname = path.posix.join(mapping.servicePath, ...relative.split(path.sep));
    return url.href;
  }
  throw new Error(
    'Workspace is not mounted for Knowledge indexing; configure knowledgeWorkspaces and a read-only mount'
  );
}

export class TencentKnowledgeClient {
  constructor(private readonly config: MemoryConfig & KnowledgeConfig) {}

  private identity() {
    return { team_id: this.config.teamId, user_id: this.config.userId, agent_id: this.config.agentId };
  }

  async call<T>(route: string, body: Record<string, unknown>, write = false): Promise<T> {
    if (!this.config.knowledgeUrl) throw new Error('Tencent Knowledge is not configured');
    if (write && !this.config.knowledgeServiceKey) throw new Error('Tencent Knowledge service key is not configured');
    const response = await fetch(`${this.config.knowledgeUrl.replace(/\/$/, '')}/v3/${route}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tdai-service-id': this.config.serviceId,
        ...(this.config.knowledgeServiceKey ? { Authorization: `Bearer ${this.config.knowledgeServiceKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const envelope = (await response.json()) as {
      code: number;
      message?: string;
      data?: T & { isError?: boolean; text?: string };
    };
    if (!response.ok || envelope.code !== 0 || envelope.data?.isError)
      throw new Error(envelope.data?.text || envelope.message || `Tencent Knowledge returned HTTP ${response.status}`);
    return envelope.data as T;
  }

  private async detail(id: string): Promise<KnowledgeDetail> {
    const wiki = id.startsWith('wiki-');
    if (!wiki && !id.startsWith('cg-')) throw new Error('Expected a wiki- or cg- knowledge ID');
    const info = await this.call<KnowledgeDetail>(wiki ? 'wiki/get' : 'code-graph/get', {
      [wiki ? 'wiki_id' : 'code_graph_id']: id,
    });
    if (info.team_id !== this.config.teamId) throw new Error('Knowledge resource belongs to another team');
    return info;
  }

  async catalog(id?: string, kind?: 'wiki' | 'code', offset = 0, limit = 10) {
    if (id) return this.detail(id);
    const routes = kind === 'wiki' ? ['wiki'] : kind === 'code' ? ['code-graph'] : ['wiki', 'code-graph'];
    return Promise.all(
      routes.map(async (route) => {
        const data = await this.call<KnowledgeList>(`${route}/list`, { ...this.identity(), offset, limit });
        return { kind: route, items: data.items, total: data.total };
      })
    );
  }

  async query(id: string, tool: string, params: Record<string, unknown>) {
    const info = await this.detail(id);
    if (info.status !== 'ready' && !(id.startsWith('wiki-') && tool === 'read_raw'))
      throw new Error(`Knowledge ${id} is ${info.status}: ${info.sync_error || 'indexing is not complete'}`);
    const data = await this.call<Record<string, unknown> & { text?: string }>('tools/call', {
      knowledge_id: id,
      tool_name: tool,
      params,
    });
    if (!id.startsWith('cg-')) return data;
    // Upstream explore reads its service-side snapshot, not the user's live working tree.
    if (typeof data.text === 'string')
      data.text = data.text.replace(
        /^> The code below is the \*\*verbatim, current on-disk source\*\*[^\n]*/m,
        '> The code below is from the Knowledge index snapshot. It may differ from the current workspace; refresh the index after source changes.'
      );
    return {
      knowledge_id: id,
      indexed_at: info.last_sync_at ?? null,
      source: 'workspace snapshot at last successful sync',
      ...data,
    };
  }

  async runtime(id: string, action: CodeRuntimeAction): Promise<CodeRuntimeStatus> {
    if (!id.startsWith('cg-')) throw new Error('Expected a code graph ID');
    await this.detail(id);
    return this.call('code-graph/runtime', { ...this.identity(), code_graph_id: id, action }, true);
  }

  async ingest(input: { wiki_id?: string; name?: string; files: Array<{ filename: string; content: string }> }) {
    const llmContext = await resolveTencentGenerationContext();
    const wiki = input.wiki_id
      ? await this.detail(input.wiki_id)
      : await this.call<KnowledgeDetail>(
          'wiki/create',
          {
            ...this.identity(),
            name: input.name || `project-${memoryScope()}`,
          },
          true
        );
    await this.call('wiki/raw/write', { ...this.identity(), wiki_id: wiki.wiki_id, files: input.files }, true);
    const job = await this.call(
      'wiki/ingest',
      { wiki_id: wiki.wiki_id, user_id: this.config.userId, llm_context: llmContext },
      true
    );
    return {
      wiki_id: wiki.wiki_id,
      accepted: true,
      generation_model: llmContext.model,
      job,
      next: 'Check tdai_knowledge_catalog with knowledge_id; ingest is asynchronous.',
    };
  }

  async index(workspace = process.env.AIONUI_TDAI_MEMORY_WORKSPACE) {
    if (!workspace) throw new Error('Workspace is missing');
    const repoUrl = knowledgeRepositoryUrl(workspace, this.config.knowledgeWorkspaces);
    const graph = await this.call<KnowledgeDetail>(
      'code-graph/create',
      {
        ...this.identity(),
        repo_url: repoUrl,
        repo_name: memoryScope(workspace),
        branch: 'local',
      },
      true
    );
    const job =
      graph.status === 'pending' || graph.status === 'processing'
        ? { code_graph_id: graph.code_graph_id, status: graph.status, already_processing: true }
        : await this.call(
            'code-graph/sync',
            {
              code_graph_id: graph.code_graph_id,
              user_id: this.config.userId,
            },
            true
          );
    return {
      code_graph_id: graph.code_graph_id,
      accepted: true,
      job,
      next: 'Check tdai_knowledge_catalog with knowledge_id; indexing is asynchronous and includes local uncommitted source.',
    };
  }
}

function result(value: unknown) {
  const serialized = JSON.stringify(value);
  const text =
    serialized.length > 20000
      ? JSON.stringify({
          truncated: true,
          excerpt: serialized.slice(0, 20000),
          next: 'Narrow the query or request fewer page references.',
        })
      : serialized;
  return { content: [{ type: 'text' as const, text }] };
}

export function registerTencentKnowledgeTools(server: McpServer, config: MemoryConfig & KnowledgeConfig): void {
  if (!config.knowledgeUrl) return;
  const client = new TencentKnowledgeClient(config);
  const wikiId = z.string().regex(/^wiki-[a-zA-Z0-9_-]+$/);
  const graphId = z.string().regex(/^cg-[a-zA-Z0-9_-]+$/);
  const querySchema = z.string().min(1).max(2048);
  server.tool(
    'tdai_knowledge_catalog',
    'List Agent Wikis and code indexes, or inspect one resource status/error. Wait for ready before querying; accepted ingest/index is not completion.',
    {
      knowledge_id: z
        .string()
        .regex(/^(wiki|cg)-[a-zA-Z0-9_-]+$/)
        .optional(),
      kind: z.enum(['wiki', 'code']).optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(20).optional(),
    },
    async ({ knowledge_id, kind, offset, limit }) => result(await client.catalog(knowledge_id, kind, offset, limit))
  );
  server.tool(
    'tdai_wiki_ingest',
    'Upload verified Markdown/text sources and start Wiki synthesis with this chat’s selected model. To create a Wiki, provide name and omit wiki_id. Use wiki_id only for an existing ID returned by the catalog. Keep BMAD artifacts in tdai_scenario_write; do not upload secrets.',
    {
      wiki_id: wikiId.optional().describe('Existing Wiki ID from the catalog. Omit when creating; never invent an ID.'),
      name: z.string().min(1).max(200).optional(),
      files: z
        .array(
          z.object({
            filename: z
              .string()
              .min(1)
              .max(200)
              .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
            content: z.string().min(1).max(100000),
          })
        )
        .min(1)
        .max(5),
    },
    async (input) =>
      result(
        await client.ingest({
          ...input,
          files: input.files.map((file) => ({ filename: file.filename, content: file.content })),
        })
      )
  );
  server.tool(
    'tdai_wiki_search',
    'Search ready Agent Wiki pages. Returns references for tdai_wiki_read.',
    {
      wiki_id: wikiId,
      query: querySchema,
      limit: z.number().int().min(1).max(10).optional(),
    },
    async ({ wiki_id, query, limit }) => result(await client.query(wiki_id, 'search', { query, limit: limit ?? 5 }))
  );
  server.tool(
    'tdai_wiki_read',
    'Read synthesized Wiki pages by search references, or original uploaded files with source=raw and refs=filenames. Raw sources remain readable if synthesis fails.',
    {
      wiki_id: wikiId,
      refs: z.array(z.string().min(1).max(500)).min(1).max(5),
      source: z.enum(['page', 'raw']).optional(),
    },
    async ({ wiki_id, refs, source }) =>
      result(
        await client.query(
          wiki_id,
          source === 'raw' ? 'read_raw' : 'read_page',
          source === 'raw' ? { filenames: refs } : { refs }
        )
      )
  );
  server.tool(
    'tdai_code_index',
    'Create or refresh one Git workspace code index, including uncommitted files. Prefer tdai_project_index for product folders or multiple repositories. Only configured read-only Knowledge mounts are allowed. Returns an asynchronous job; check catalog status.',
    {
      workspace: z.string().min(1).optional(),
    },
    async ({ workspace }) => result(await client.index(workspace))
  );
  server.tool(
    'tdai_code_search',
    'Find indexed symbols and their file locations. Index again after source changes to refresh the snapshot.',
    {
      code_graph_id: graphId,
      query: querySchema,
      kind: z.enum(['function', 'method', 'class', 'interface', 'type', 'variable', 'route', 'component']).optional(),
      limit: z.number().int().min(1).max(20).optional(),
    },
    async ({ code_graph_id, query, kind, limit }) =>
      result(await client.query(code_graph_id, 'search', { query, kind, limit: limit ?? 8 }))
  );
  server.tool(
    'tdai_code_explore',
    'Read indexed source related to symbols/files or a code question. Returned source comes from the last index snapshot.',
    {
      code_graph_id: graphId,
      query: querySchema,
      max_files: z.number().int().min(1).max(5).optional(),
    },
    async ({ code_graph_id, query, max_files }) =>
      result(await client.query(code_graph_id, 'explore', { query, maxFiles: max_files ?? 3 }))
  );
  server.tool(
    'tdai_code_impact',
    'Inspect indexed dependencies affected by changing a symbol.',
    {
      code_graph_id: graphId,
      symbol: querySchema,
      depth: z.number().int().min(1).max(5).optional(),
    },
    async ({ code_graph_id, symbol, depth }) =>
      result(await client.query(code_graph_id, 'impact', { symbol, depth: depth ?? 2 }))
  );
}
