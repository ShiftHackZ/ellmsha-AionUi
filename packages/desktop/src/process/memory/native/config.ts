import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function savePrivate(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temporary, file);
}
export function readJson<T>(file: string, fallback: T): T {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : fallback;
}
export function nativeConfig(userData: string) {
  const root = path.join(userData, 'tencentdb');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const secretsFile = path.join(root, 'runtime-secrets.json');
  const secrets = readJson(secretsFile, {
    gateway: randomBytes(32).toString('hex'),
    knowledge: randomBytes(32).toString('hex'),
  });
  if (!existsSync(secretsFile)) savePrivate(secretsFile, secrets);
  const settingsFile = path.join(root, 'runtime-settings.json');
  const settings = readJson(settingsFile, {
    corePort: 8420,
    knowledgePort: 8424,
    panelPort: 8125,
    embedding: {
      provider: 'openai',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: 'ollama',
      model: 'bge-m3',
      dimensions: 1024,
      sendDimensions: false,
      maxInputChars: 8192,
      timeoutMs: 60000,
    },
    knowledgeWorkspaces: [] as Array<{ hostPath: string; servicePath: string }>,
  });
  for (const port of [settings.corePort, settings.knowledgePort, settings.panelPort]) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local memory port');
  }
  if (!existsSync(settingsFile)) savePrivate(settingsFile, settings);
  const coreUrl = `http://127.0.0.1:${settings.corePort}`;
  const knowledgeUrl = `http://127.0.0.1:${settings.knowledgePort}`;
  const panelUrl = `http://127.0.0.1:${settings.panelPort}`;
  const gatewayFile = path.join(root, 'gateway.json');
  savePrivate(gatewayFile, {
    deployMode: 'standalone',
    stateBackend: 'local',
    server: { host: '127.0.0.1', port: settings.corePort },
    data: { baseDir: path.join(root, 'core') },
    llm: { maxTokens: 32000, timeoutMs: 300000 },
    memory: {
      promptMode: 'code',
      capture: { enabled: true },
      extraction: { enabled: true, enableDedup: true, maxMemoriesPerSession: 20 },
      persona: { triggerEveryN: 50, maxScenes: 15 },
      pipeline: {
        everyNConversations: 5,
        enableWarmup: true,
        l1IdleTimeoutSeconds: 600,
        l2DelayAfterL1Seconds: 90,
        l2MinIntervalSeconds: 900,
        l2MaxIntervalSeconds: 3600,
      },
      recall: { enabled: true, maxResults: 5, scoreThreshold: 0.3, strategy: 'hybrid', timeoutMs: 5000 },
      storeBackend: 'sqlite',
      embedding: settings.embedding,
    },
    skill: { enabled: true, routing: { mode: 'bm25', searchTopK: 20 } },
  });
  const instancesFile = path.join(root, 'instances.json');
  savePrivate(instancesFile, {
    instances: [{ id: 'default', name: 'eLLMsha', gateway_endpoint: coreUrl, api_key: secrets.gateway }],
  });
  return { root, settings, secrets, coreUrl, knowledgeUrl, panelUrl, gatewayFile, instancesFile };
}

/** Provision once; on updates reuse and verify existing credentials and identity. */
export async function provision(config: ReturnType<typeof nativeConfig>): Promise<string> {
  const { root, coreUrl, knowledgeUrl, secrets, settings } = config;
  const request = async (route: string, body: Record<string, unknown>, key?: string) => {
    const response = await fetch(`${coreUrl}/v3/${route}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tdai-service-id': 'default',
        Authorization: `Bearer ${secrets.gateway}`,
        ...(key ? { 'x-tdai-user-key': key } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (route === 'internal/meta/user/init-admin' && response.status === 409) return {};
    if (!response.ok) throw new Error(`Local memory ${route}: HTTP ${response.status}`);
    const result = await response.json();
    if (result.code !== 0) throw new Error(`Local memory ${route} rejected the request`);
    return result.data;
  };
  const adminFile = path.join(root, 'admin-key');
  const adminKey = existsSync(adminFile)
    ? readFileSync(adminFile, 'utf8').trim()
    : `sk-mem-${randomBytes(24).toString('hex')}`;
  if (!existsSync(adminFile)) savePrivate(adminFile, adminKey);
  await request('internal/meta/user/init-admin', { username: 'admin', user_key: adminKey });
  const keyFile = path.join(root, 'business-key');
  const key = existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : `sk-mem-${randomBytes(24).toString('hex')}`;
  if (!existsSync(keyFile)) savePrivate(keyFile, key);
  let identity = await request('meta/auth/verify', { user_key: key });
  if (!identity.valid) {
    const users = await request('meta/user/list', { username: 'ellmsha_v3' }, adminKey);
    if (users.items?.length)
      throw new Error('Saved memory key does not match the existing user; recover the key, do not reset data');
    await request('meta/user/create-with-key', { username: 'ellmsha_v3', user_key: key }, adminKey);
    identity = await request('meta/auth/verify', { user_key: key });
  }
  if (!identity.valid || !identity.user) throw new Error('Saved memory identity is invalid; do not reset its database');
  const userId = identity.user.user_id;
  const teams = await request('meta/team/list', { user_id: userId, limit: 100 }, key);
  const team =
    teams.items?.find((item: { name: string }) => item.name === 'eLLMsha v3') ||
    (await request('meta/team/create', { name: 'eLLMsha v3', owner_user_id: userId }, key));
  const agents = await request('meta/agent/list', { team_id: team.team_id, limit: 100 }, key);
  const agent =
    agents.items?.find((item: { name: string }) => item.name === 'General') ||
    (await request('meta/agent/create', { team_id: team.team_id, owner_user_id: userId, name: 'General' }, key));
  const file = path.join(root, 'aionui-memory.json');
  savePrivate(file, {
    gatewayUrl: coreUrl,
    knowledgeUrl,
    serviceId: 'default',
    userId,
    teamId: team.team_id,
    agentId: agent.agent_id,
    gatewayApiKey: secrets.gateway,
    knowledgeServiceKey: secrets.knowledge,
    knowledgeWorkspaces: settings.knowledgeWorkspaces,
    nativeKnowledgeProjectsDir: path.join(root, 'knowledge-projects'),
  });
  return file;
}

/** Recover the previous index/configuration after an interrupted offline rebuild. */
export function recoverEmbeddingChange(userData: string): void {
  const root = path.join(userData, 'tencentdb');
  const marker = path.join(root, 'embedding-change.pending');
  if (!existsSync(marker)) return;
  const work = path.join(root, 'embedding-change');
  const previous = readJson(path.join(work, 'previous-settings.json'), null);
  if (!previous || !existsSync(path.join(work, 'backup/vectors.db')))
    throw new Error('Embedding recovery backup is missing');
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `vectors.db${suffix}`;
    rmSync(path.join(root, 'core', file), { force: true });
    if (existsSync(path.join(work, 'backup', file)))
      copyFileSync(path.join(work, 'backup', file), path.join(root, 'core', file));
  }
  savePrivate(path.join(root, 'runtime-settings.json'), previous);
  rmSync(marker);
}
