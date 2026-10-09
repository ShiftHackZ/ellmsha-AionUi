import { ipcBridge } from '@/common';
import { loadMemoryConfig } from './tencentMemoryClient';
import { ProjectKnowledge } from './project/knowledge';
import { z } from 'zod';
import { embeddingStatus, probeEmbedding, applyEmbedding } from './native/embedding';
import { type BrowserWindow, ipcMain } from 'electron';
import { readFile } from 'node:fs/promises';

type MemoryConfig = {
  gatewayUrl: string;
  gatewayApiKey?: string;
  serviceId: string;
  userId: string;
};

export function registerMemoryIdentityBridge(getMainWindow: () => BrowserWindow | undefined): void {
  const assertMainWindow = (sender: Electron.WebContents) => {
    if (sender !== getMainWindow()?.webContents)
      throw new Error('Memory identity is only available in the main window');
  };

  ipcMain.handle('ellmsha:memory:project', async (event, input: unknown) => {
    assertMainWindow(event.sender);
    const request = z
      .object({ projectId: z.string().min(1), action: z.enum(['catalog', 'index']), repository: z.string().optional() })
      .parse(input);
    // Read trusted registered roots from the authenticated backend; no renderer path grants.
    const project = await ipcBridge.project.get.invoke({ project_id: request.projectId });
    const workspace = project.explorer.entries.find((entry) => entry.role === 'workspace')?.display_path;
    if (!workspace) throw new Error('Project has no workspace');
    const context = {
      project_id: project.project_id,
      name: project.name,
      workspace,
      roots: project.explorer.entries.map((entry) => entry.display_path),
    };
    const client = new ProjectKnowledge(loadMemoryConfig());
    if (request.action === 'index') return client.index(context, request.repository);
    return client.catalog(context);
  });

  ipcMain.handle('ellmsha:memory:embedding-status', (event) => {
    assertMainWindow(event.sender);
    return embeddingStatus();
  });
  ipcMain.handle('ellmsha:memory:embedding-probe', (event, input: unknown) => {
    assertMainWindow(event.sender);
    return probeEmbedding(input);
  });
  ipcMain.handle('ellmsha:memory:embedding-apply', (event, input: unknown) => {
    assertMainWindow(event.sender);
    applyEmbedding(input);
  });

  ipcMain.handle('ellmsha:memory:panel-url', (event) => {
    assertMainWindow(event.sender);
    return process.env.ELLM_SHA_TDAI_PANEL_URL || 'http://127.0.0.1:8125/';
  });

  ipcMain.handle('ellmsha:memory:local-key', async (event) => {
    assertMainWindow(event.sender);
    const file = process.env.ELLM_SHA_TDAI_USER_KEY_FILE;
    if (!file) return null;
    try {
      return (await readFile(file, 'utf8')).trim() || null;
    } catch {
      return null;
    }
  });

  ipcMain.handle('ellmsha:memory:verify-key', async (event, key: unknown) => {
    assertMainWindow(event.sender);
    if (typeof key !== 'string' || !key.trim()) throw new Error('Enter your memory user key');
    const configPath = process.env.AIONUI_TDAI_MEMORY_CONFIG;
    if (!configPath) throw new Error('Agent memory has not been configured');
    const config = JSON.parse(await readFile(configPath, 'utf8')) as MemoryConfig;
    if (!config.gatewayUrl || !config.serviceId || !config.userId)
      throw new Error('Agent memory configuration is incomplete');

    const response = await fetch(`${config.gatewayUrl.replace(/\/$/, '')}/v3/meta/auth/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tdai-service-id': config.serviceId,
        ...(config.gatewayApiKey ? { Authorization: `Bearer ${config.gatewayApiKey}` } : {}),
      },
      body: JSON.stringify({ user_key: key.trim() }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error('Memory service is unavailable or rejected the key');
    const envelope = (await response.json()) as {
      code?: number;
      data?: { valid?: boolean; user?: { user_id: string; username: string; display_name?: string } };
    };
    if (envelope.code !== 0 || !envelope.data?.valid || !envelope.data.user) {
      throw new Error('Memory user key is invalid');
    }
    if (envelope.data.user.user_id !== config.userId) {
      throw new Error(
        'This key belongs to another memory account; ask the administrator to configure your agent identity'
      );
    }
    return { user: envelope.data.user, instanceId: config.serviceId };
  });
}
