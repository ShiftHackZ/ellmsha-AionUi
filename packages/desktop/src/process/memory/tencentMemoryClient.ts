import type { KnowledgeConfig } from './tencentKnowledgeClient';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { resolveTencentGenerationContext } from './tencentGenerationContext';

export type MemoryConfig = {
  gatewayUrl: string;
  serviceId: string;
  teamId: string;
  agentId: string;
  userId: string;
  gatewayApiKey?: string;
};
type MemoryHit = { id: string; content: string; score?: number; type?: string; source_path?: string };
type ScenarioEntry = { path: string; summary?: string; version?: number };
type ScenarioWrite = { path: string; version?: number; memory_id?: string };

export function loadMemoryConfig(): MemoryConfig & KnowledgeConfig {
  const configPath = process.env.AIONUI_TDAI_MEMORY_CONFIG;
  if (!configPath) throw new Error('AIONUI_TDAI_MEMORY_CONFIG is missing');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as MemoryConfig & KnowledgeConfig;
  for (const key of ['gatewayUrl', 'serviceId', 'teamId', 'agentId', 'userId'] as const) {
    if (!config[key]) throw new Error(`Memory configuration is missing ${key}`);
  }
  return config;
}

/** Shared with AionCore: all agents in a workspace use the same artifact namespace. */
export function memoryScope(workspace = process.env.AIONUI_TDAI_MEMORY_WORKSPACE): string {
  if (!workspace?.trim())
    throw new Error('Memory workspace is missing; pass workspace to tdai_context or restart this conversation');
  let canonical = path.resolve(workspace);
  try {
    canonical = realpathSync(canonical);
  } catch {
    /* A new workspace may not exist yet. */
  }
  canonical = canonical.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  const name =
    path.posix
      .basename(canonical)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'project';
  return `${name}-${createHash('sha256').update(canonical).digest('hex').slice(0, 10)}`;
}

function clip(value: string, length: number): string {
  return value.slice(0, length).replace(/[\uD800-\uDBFF]$/, '');
}

export class TencentMemoryClient {
  constructor(private readonly config: MemoryConfig) {}

  async addConversation(sessionId: string, messages: Array<{ role: 'user' | 'assistant'; content: string }>) {
    const llmContext = await resolveTencentGenerationContext();
    const saved = await this.call<Record<string, unknown>>('conversation/add', {
      session_id: sessionId,
      messages,
      llm_context: llmContext,
    });
    return { ...saved, generation_model: llmContext.model };
  }

  async call<T>(route: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.config.gatewayUrl.replace(/\/$/, '')}/v3/${route}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tdai-service-id': this.config.serviceId,
        Authorization: `Bearer ${this.config.gatewayApiKey || 'local'}`,
      },
      body: JSON.stringify({
        ...body,
        team_id: this.config.teamId,
        agent_id: this.config.agentId,
        user_id: this.config.userId,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const envelope = (await response.json()) as { code: number; message?: string; data?: T };
    if (!response.ok || envelope.code !== 0)
      throw new Error(envelope.message || `MemoryCore returned HTTP ${response.status}`);
    return envelope.data as T;
  }

  async search(query: string, limit = 5, excerptLength = 1800) {
    const data = await this.call<{ items?: MemoryHit[] }>('atomic/search', { query, limit });
    return {
      items: (data.items ?? []).slice(0, limit).map((hit) => ({
        id: hit.id,
        type: hit.type,
        score: hit.score,
        source_path: hit.source_path,
        content: clip(hit.content, excerptLength),
        truncated: hit.content.length > excerptLength,
      })),
    };
  }

  async list(pathPrefix?: string, offset = 0, limit = 30) {
    const data = await this.call<{ entries?: ScenarioEntry[] }>('scenario/ls', { path_prefix: pathPrefix });
    const entries = (data.entries ?? []).toSorted((a, b) => a.path.localeCompare(b.path));
    return {
      entries: entries.slice(offset, offset + limit).map((entry) => ({
        path: entry.path,
        summary: entry.summary ? clip(entry.summary, 160) : undefined,
        version: entry.version,
      })),
      total: entries.length,
      offset,
      has_more: offset + limit < entries.length,
    };
  }

  async context(query: string, workspace?: string) {
    const scope = memoryScope(workspace);
    const prefix = `bmad/${scope}/`;
    const values = await Promise.allSettled([
      this.search(query, 4, 1100),
      this.call<{ content?: string | null }>('core/read', {}),
      this.list(prefix, 0, 8),
    ]);
    const [memories, guidance, artifacts] = values;
    return {
      project_scope: scope,
      bmad_prefix: prefix,
      memories: memories.status === 'fulfilled' ? memories.value.items : [],
      guidance: guidance.status === 'fulfilled' ? clip(guidance.value.content ?? '', 1000) : '',
      artifacts: artifacts.status === 'fulfilled' ? artifacts.value : null,
      unavailable: values.flatMap((value, index) =>
        value.status === 'rejected' ? [['search', 'guidance', 'artifacts'][index]] : []
      ),
    };
  }

  /** L2 is human-readable authority; its L1 excerpt is searchable before success is returned. */
  async writeScenario(
    documentPath: string,
    content: string,
    summary?: string,
    kind: 'episodic' | 'persona' | 'instruction' = 'episodic'
  ) {
    const saved = await this.call<ScenarioWrite>('scenario/write', {
      path: documentPath,
      content,
      summary,
      index_content: clip([documentPath, summary, content].filter(Boolean).join('\n\n'), 7800),
      index_type: kind,
    });
    if (!saved.memory_id)
      throw new Error('Document saved without a searchable record. Update MemoryCore and retry the same path.');
    return { ...saved, indexed: true };
  }

  async writeMemory(input: {
    subject: string;
    content: string;
    summary?: string;
    scope?: 'project' | 'global';
    kind?: 'episodic' | 'persona' | 'instruction';
  }) {
    const scope = input.scope === 'global' ? 'global' : memoryScope();
    return this.writeScenario(`knowledge/${scope}/${input.subject}.md`, input.content, input.summary, input.kind);
  }
}
