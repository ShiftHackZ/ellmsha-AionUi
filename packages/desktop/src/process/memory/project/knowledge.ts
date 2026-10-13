import type { ProjectIndexCatalog } from '@/common/types/platform/electron';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  TencentKnowledgeClient,
  knowledgeRepositoryUrl,
  type KnowledgeConfig,
  type KnowledgeDetail,
  type CodeRuntimeAction,
} from '../tencentKnowledgeClient';
import type { MemoryConfig } from '../tencentMemoryClient';
import { allowNativeProject, discoverRepositories, resolveProjectContext, type ProjectContext } from './index';

/** Current project roots are the registry. Tencent already deduplicates graphs by repository URL. */
export class ProjectKnowledge {
  constructor(private readonly config: MemoryConfig & KnowledgeConfig) {}

  private client(context: ProjectContext) {
    return new TencentKnowledgeClient({
      ...this.config,
      knowledgeWorkspaces: [
        ...(this.config.knowledgeWorkspaces || []),
        ...(this.config.nativeKnowledgeProjectsDir
          ? context.roots.map((root) => ({ hostPath: root, servicePath: root }))
          : []),
      ],
    });
  }

  async catalog(context: ProjectContext): Promise<ProjectIndexCatalog> {
    const discovered = await discoverRepositories(context);
    const client = this.client(context);
    const graphs: KnowledgeDetail[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await client.call<{ items: KnowledgeDetail[]; total: number }>('code-graph/list', {
        team_id: this.config.teamId,
        user_id: this.config.userId,
        offset,
        limit: 100,
      });
      graphs.push(...page.items);
      if (offset + page.items.length >= page.total) break;
      if (!page.items.length) throw new Error('Tencent returned an incomplete index catalog');
    }
    const repositories = discovered.repositories.map((repo) => {
      try {
        const url = knowledgeRepositoryUrl(repo.path, [
          ...(this.config.knowledgeWorkspaces || []),
          ...(this.config.nativeKnowledgeProjectsDir
            ? context.roots.map((root) => ({ hostPath: root, servicePath: root }))
            : []),
        ]);
        const graph = graphs.find((g) => g.repo_url === url && g.branch === 'local');
        return {
          ...repo,
          code_graph_id: graph?.code_graph_id,
          status: graph?.status || 'not_indexed',
          indexed_at: graph?.last_sync_at,
          error: graph?.sync_error || undefined,
          stats: graph?.stats,
        };
      } catch (error) {
        return { ...repo, status: 'unavailable', error: error instanceof Error ? error.message : String(error) };
      }
    });
    return {
      project_id: context.project_id,
      name: context.name,
      workspace: context.workspace,
      repositories,
      errors: discovered.errors,
    };
  }

  async index(context: ProjectContext, repository?: string) {
    const catalog = await this.catalog(context);
    const selected = repository
      ? catalog.repositories.filter((repo) => repo.path === repository)
      : catalog.repositories;
    if (!selected.length)
      throw new Error(
        repository
          ? 'Repository is not in the current project'
          : 'No Git repositories discovered; attach repository folders'
      );
    if (this.config.nativeKnowledgeProjectsDir) {
      // Grant only discovered/selected repository roots, not unrelated files in product folders.
      await allowNativeProject(this.config.nativeKnowledgeProjectsDir, {
        ...context,
        roots: catalog.repositories.map((repo) => repo.path),
      });
    }
    const client = this.client(context);
    const results = [];
    for (const repo of selected) {
      try {
        results.push({ repository: repo.path, name: repo.name, ...(await client.index(repo.path)) });
      } catch (error) {
        results.push({
          repository: repo.path,
          name: repo.name,
          accepted: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      project_id: context.project_id,
      results,
      errors: catalog.errors,
      next: 'Poll tdai_project_repositories; accepted is not ready.',
    };
  }

  async runtime(context: ProjectContext, graphId: string, action: CodeRuntimeAction) {
    const catalog = await this.catalog(context);
    if (!catalog.repositories.some((repo) => repo.code_graph_id === graphId))
      throw new Error('Code graph is not in the current project');
    return this.client(context).runtime(graphId, action);
  }

  async search(context: ProjectContext, query: string, repository?: string, limit = 5) {
    const catalog = await this.catalog(context);
    const selected = repository
      ? catalog.repositories.filter((repo) => repo.path === repository)
      : catalog.repositories;
    if (repository && !selected.length) throw new Error('Repository is not in the current project');
    const client = this.client(context);
    const results = [];
    for (const repo of selected) {
      if (repo.status !== 'ready' || !repo.code_graph_id) {
        results.push({ repository: repo.path, name: repo.name, status: repo.status, error: repo.error });
        continue;
      }
      try {
        results.push({
          repository: repo.path,
          name: repo.name,
          status: 'ready',
          ...(await client.query(repo.code_graph_id, 'search', { query, limit })),
        });
      } catch (error) {
        results.push({
          repository: repo.path,
          name: repo.name,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      project_id: context.project_id,
      results,
      errors: catalog.errors,
      complete: selected.length > 0 && !catalog.errors.length && results.every((r) => r.status === 'ready'),
    };
  }
}

export function registerProjectKnowledgeTools(server: McpServer, config: MemoryConfig & KnowledgeConfig): void {
  const client = new ProjectKnowledge(config);
  const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
  const repositorySchema = z
    .string()
    .min(1)
    .optional()
    .describe('Optional exact repository path from tdai_project_repositories; omit for all project repositories');
  server.tool(
    'tdai_project_repositories',
    'Discover Git repositories under the current project workspace and attached folders, with index status. Includes product folders which are not Git repositories. Does not index code.',
    {},
    async () => result(await client.catalog(await resolveProjectContext()))
  );
  server.tool(
    'tdai_project_index',
    'Create or refresh separate Tencent code indexes for all current project repositories, or one selected repository. Asynchronous; accepted is not ready. Poll tdai_project_repositories for completion. Refresh only a missing or stale index relevant to the task, not on every turn. No code is changed.',
    { repository: repositorySchema },
    async ({ repository }) => result(await client.index(await resolveProjectContext(), repository))
  );
  server.tool(
    'tdai_code_runtime',
    'Inspect, load, or release a current-project code index in runtime memory. Deallocate only closes idle handles; it preserves index files, metadata, and user code. Queries load indexes again automatically. Busy indexes return an error; retry later. Use tdai_project_index to create or refresh an index.',
    {
      code_graph_id: z
        .string()
        .regex(/^cg-[a-zA-Z0-9_-]+$/)
        .describe('Existing ID from tdai_project_repositories'),
      action: z.enum(['status', 'allocate', 'deallocate']),
    },
    { destructiveHint: false, openWorldHint: false, idempotentHint: true },
    async ({ code_graph_id, action }) =>
      result(await client.runtime(await resolveProjectContext(), code_graph_id, action))
  );
  server.tool(
    'tdai_project_code_search',
    'Search current-project code symbols by component, class/function name, or route (for example auth handler or PaymentService). For current architecture inspect repository/index freshness first, search relevant symbols, then verify source. Results identify repository and snapshot; incomplete/failed indexes are explicit. Use returned code_graph_id with tdai_code_explore/impact for details.',
    {
      query: z
        .string()
        .min(1)
        .max(2048)
        .describe(
          '1–2048 characters: symbol, component, or route query; use separate focused queries for unrelated topics.'
        ),
      repository: repositorySchema,
      limit: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe('Maximum returned matches: 1–10, default 5. Narrow the query or repository for more useful results.'),
    },
    async ({ query, repository, limit }) =>
      result(await client.search(await resolveProjectContext(), query, repository, limit))
  );
}
