import { copilotPaths } from './paths';
import { app, ipcMain, type BrowserWindow } from 'electron';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ipcBridge } from '@/common';
import type { ModelSettings } from '@/common/config/storage';
import type { CopilotIdeStatus } from '@/common/types/platform/electron';

const PROVIDER_ID = 'ellmsha-copilot-ide';
type Runtime = {
  initialize(): Promise<CopilotIdeStatus>;
  status(): CopilotIdeStatus;
  setEnabled(enabled: boolean): Promise<CopilotIdeStatus>;
  endpoint(): { baseUrl: string; apiKey: string };
  ensure(login?: boolean): Promise<number>;
  modelsRefresh(): Promise<CopilotIdeStatus>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
};
let runtime: Runtime | undefined;
let initialization: Promise<Runtime> | undefined;
let control: Promise<unknown> = Promise.resolve();

function getRuntime(): Promise<Runtime> {
  return (initialization ??= (async () => {
    const { extension, source } = copilotPaths({
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      packaged: app.isPackaged,
      developmentSource: process.env.ELLMSHA_COPILOT_IDE_SOURCE,
    });
    const load = createRequire(path.join(extension, 'package.json'));
    const { CopilotRuntime } = load('./runtime.cjs') as {
      CopilotRuntime: new (options: { source?: string; state: string; extension: string }) => Runtime;
    };
    runtime = new CopilotRuntime({
      source: existsSync(path.join(source, 'product.json')) ? source : undefined,
      // Stable, dedicated profile: survives application and runtime restarts.
      state: path.join(app.getPath('userData'), 'copilot-ide'),
      extension,
    });
    await runtime.initialize();
    return runtime;
  })().catch((error: unknown) => {
    initialization = undefined;
    throw error;
  }));
}

async function synchronizeProvider(value: Runtime): Promise<void> {
  const existing = (await ipcBridge.mode.listProviders.invoke())?.find((row) => row.id === PROVIDER_ID);
  const status = value.status();
  if (!status.enabled) {
    await ipcBridge.acpConversation.setAgentEnabled.invoke({ id: 'copilot-ide', enabled: false });
    if (existing) await ipcBridge.mode.updateProvider.invoke({ id: PROVIDER_ID, enabled: false });
    return;
  }
  const endpoint = value.endpoint();
  const settings = {
    name: 'Copilot IDE',
    platform: 'custom',
    base_url: endpoint.baseUrl,
    api_key: endpoint.apiKey,
    enabled: true,
    models: status.models,
    // Public vscode.lm supports text and tool calls. Do not advertise images or
    // Responses API until those paths have been implemented and accepted.
    model_settings: Object.fromEntries(
      status.models.map((model) => [
        model,
        { openai_api_mode: 'chat_completions', image_input: 'unsupported' } satisfies ModelSettings,
      ])
    ),
    model_protocols: Object.fromEntries(status.models.map((model) => [model, 'openai'])),
  };
  if (existing) await ipcBridge.mode.updateProvider.invoke({ id: PROVIDER_ID, ...settings });
  else await ipcBridge.mode.createProvider.invoke({ id: PROVIDER_ID, ...settings });
  await ipcBridge.acpConversation.setAgentEnabled.invoke({
    id: 'copilot-ide',
    enabled: status.runtimeAvailable && status.models.length > 0,
  });
  if (status.runtimeAvailable && status.models.length > 0) {
    // Replace a failed pre-login probe with current provider readiness. This
    // only reads Core configuration; it never launches the IDE runtime.
    await ipcBridge.acpConversation.checkManagedAgentHealthById.invoke({ id: 'copilot-ide' });
  }
}

/** Restore the local provider endpoint after Core starts; never starts Code OSS. */
export async function initializeCopilotProvider(): Promise<void> {
  const next = control.catch(() => {}).then(async () => synchronizeProvider(await getRuntime()));
  control = next;
  await next;
}

/** Stop the owned IDE runtime after Core has drained its agent requests. */
export async function disposeCopilotProvider(): Promise<void> {
  if (runtime) await runtime.dispose();
}

/** Desktop-only controls; web renderers cannot launch processes or access credentials. */
export function registerCopilotBridge(getMainWindow: () => BrowserWindow | undefined): void {
  ipcMain.handle('ellmsha:copilot-ide', (event, action: unknown) => {
    if (event.sender !== getMainWindow()?.webContents) throw new Error('copilot_main_window_required');
    if (!['status', 'enable', 'disable', 'login', 'refresh', 'stop'].includes(String(action)))
      throw new Error('copilot_invalid_action');
    const next = control
      .catch(() => {})
      .then(async () => {
        const value = await getRuntime();
        if (action === 'enable' || action === 'disable') await value.setEnabled(action === 'enable');
        if (action === 'login') await value.ensure(true);
        if (action === 'refresh') await value.modelsRefresh();
        if (action === 'stop') await value.stop();
        if (action !== 'status') await synchronizeProvider(value);
        return value.status();
      });
    control = next;
    return next;
  });
}
