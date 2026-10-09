import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:net';
import { nativeConfig, provision, recoverEmbeddingChange } from './config';

const children = new Set<ChildProcess>();
let stopping = false;

/** Stop only owned service process groups; never remove persistent data. */
export async function stopNativeMemory(): Promise<void> {
  stopping = true;
  await Promise.all(
    [...children].map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || !child.pid) {
            resolve();
            return;
          }
          const pid = child.pid;
          const kill = (signal: NodeJS.Signals) => {
            try {
              if (process.platform === 'win32')
                spawn('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
              else process.kill(-pid, signal);
            } catch {
              /* Already exited. */
            }
          };
          const timer = setTimeout(() => {
            kill('SIGKILL');
            resolve();
          }, 5000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
          kill('SIGTERM');
        })
    )
  );
  children.clear();
}

/** Launch the bundled services before AionCore; all mutable files live in userData. */
export async function startNativeMemory(bundle: string, userData: string, recover = true): Promise<void> {
  if (!existsSync(path.join(bundle, 'runtime.json'))) throw new Error('Bundled Tencent memory runtime is missing');
  stopping = false;
  if (recover) recoverEmbeddingChange(userData);
  const config = nativeConfig(userData);
  const logDir = path.join(config.root, 'logs');
  mkdirSync(logDir, { recursive: true });
  const node = path.join(bundle, 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
  const common = {
    ...process.env,
    NODE_ENV: 'production',
    NODE_OPTIONS: '',
    ELECTRON_RUN_AS_NODE: '',
    PATH: `${path.dirname(node)}${path.delimiter}${process.env.PATH || ''}`,
    AION_LLM_REQUIRE_CONTEXT: '1',
    AION_LLM_CALLBACK_ALLOWED_HOSTS: '127.0.0.1,localhost,[::1]',
    LOG_LEVEL: 'info',
    LOG_PATH: logDir,
  };
  const start = async (name: string, entry: string, url: string, env: Record<string, string>) => {
    await new Promise<void>((resolve, reject) => {
      const probe = createServer();
      probe.once('error', () => reject(new Error(`${name} port is occupied; stop the other memory instance first`)));
      probe.listen(Number(new URL(url).port), '127.0.0.1', () => probe.close(() => resolve()));
    });
    const log = openSync(path.join(logDir, `${name}.log`), 'a', 0o600);
    const child = spawn(node, ['--import', 'tsx', path.join(bundle, 'runner.mjs'), path.join(bundle, name, entry)], {
      cwd: path.join(bundle, name),
      env: { ...common, ...env },
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', log, log, 'ipc'],
    });
    closeSync(log);
    children.add(child);
    let exited = false;
    child.once('error', () => {
      exited = true;
    });
    child.once('exit', () => {
      exited = true;
      children.delete(child);
      if (!stopping) console.error(`[Memory] ${name} exited; see ${logDir}`);
    });
    for (let attempt = 0; attempt < 120; attempt++) {
      if (exited) throw new Error(`${name} could not start; see ${logDir}`);
      try {
        if ((await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) })).ok) {
          // A foreign listener must not make a failed child appear healthy.
          await new Promise((resolve) => setTimeout(resolve, 300));
          if (exited) throw new Error(`${name} port is occupied`);
          return;
        }
      } catch {
        /* Wait for our child, bounded below. */
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`${name} startup timed out; see ${logDir}`);
  };
  try {
    await start('MemoryCore', 'src/gateway/server.ts', config.coreUrl, {
      TDAI_GATEWAY_CONFIG: config.gatewayFile,
      TDAI_GATEWAY_HOST: '127.0.0.1',
      TDAI_GATEWAY_PORT: String(config.settings.corePort),
      TDAI_GATEWAY_API_KEY: config.secrets.gateway,
      TDAI_DATA_DIR: path.join(config.root, 'core'),
      STORE_MODE: 'sqlite',
    });
    const appConfig = await provision(config);
    await start('MemoryKnowledge', 'src/server.ts', config.knowledgeUrl, {
      HOST: '127.0.0.1',
      PORT: String(config.settings.knowledgePort),
      KNOWLEDGE_SERVICE_KEY: config.secrets.knowledge,
      KNOWLEDGE_DATA_DIR: path.join(config.root, 'knowledge'),
      KNOWLEDGE_DB_PATH: path.join(config.root, 'knowledge/knowledge.db'),
      KNOWLEDGE_PUBLIC_BASE_URL: `${config.knowledgeUrl}/v3`,
      TMC_CALLBACK_URL: config.panelUrl,
      KNOWLEDGE_LOCAL_ROOTS: config.settings.knowledgeWorkspaces.map((item) => item.servicePath).join(path.delimiter),
      KNOWLEDGE_LOCAL_PROJECTS_DIR: path.join(config.root, 'knowledge-projects'),
      LLM_MODE: 'custom',
    });
    await start('MemoryPanel', 'src/index.ts', config.panelUrl, {
      HOST: '127.0.0.1',
      PORT: String(config.settings.panelPort),
      UI_DIST_DIR: path.join(bundle, 'MemoryPanel/web/dist'),
      METADATA_INSTANCES_CONFIG: config.instancesFile,
      KNOWLEDGE_SERVICE_URL: config.knowledgeUrl,
      KNOWLEDGE_AUTH_TOKEN: config.secrets.knowledge,
      KNOWLEDGE_LLM_BINDING_SYNC: '0',
      TDAI_AGENT_TEMPLATE_DIR: path.join(config.root, 'knowledge/agent-templates'),
      PANEL_AUTH_IDENTITY_STORE_PATH: path.join(config.root, 'panel/identities.json'),
    });
    process.env.AIONUI_TDAI_MEMORY_CONFIG = appConfig;
    process.env.ELLM_SHA_TDAI_USER_KEY_FILE = path.join(config.root, 'business-key');
    process.env.ELLM_SHA_TDAI_PANEL_URL = `${config.panelUrl}/`;
    process.env.AIONUI_MEMORY_NATIVE = '1';
    process.env.PATH = common.PATH;
  } catch (error) {
    await stopNativeMemory();
    throw error;
  }
}
