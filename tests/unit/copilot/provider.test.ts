import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mocks = vi.hoisted(() => ({
  profile: '',
  appPath: '',
  handle: vi.fn(),
  setAgentEnabled: vi.fn(),
  checkHealth: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => mocks.appPath, getPath: () => mocks.profile },
  ipcMain: { handle: mocks.handle },
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    acpConversation: {
      setAgentEnabled: { invoke: mocks.setAgentEnabled },
      checkManagedAgentHealthById: { invoke: mocks.checkHealth },
    },
    mode: {
      listProviders: { invoke: mocks.list },
      createProvider: { invoke: mocks.create },
      updateProvider: { invoke: mocks.update },
    },
  },
}));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: (file: string) => String(file).endsWith('product.json') || actual.existsSync(file) };
});
let provider: typeof import('../../../packages/desktop/src/process/services/copilot/provider');

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.profile = await mkdtemp(path.join(tmpdir(), 'copilot-provider-'));
  mocks.appPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  mocks.list.mockResolvedValue([]);
  mocks.create.mockResolvedValue({});
  mocks.update.mockResolvedValue({});
  provider = await import('../../../packages/desktop/src/process/services/copilot/provider');
});
afterEach(async () => {
  await provider.disposeCopilotProvider();
  await rm(mocks.profile, { recursive: true, force: true });
});

describe('desktop managed Copilot provider', () => {
  it('restores disabled settings without registering a provider or creating IDE user data', async () => {
    await provider.initializeCopilotProvider();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    await expect(readFile(path.join(mocks.profile, 'copilot-ide/user-data/User/settings.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('enables a private model provider without starting Code OSS and keeps the auth profile on disable', async () => {
    const window = { webContents: {} };
    provider.registerCopilotBridge(() => window as Electron.BrowserWindow);
    const action = mocks.handle.mock.calls[0][1];
    const state = await action({ sender: window.webContents }, 'enable');
    expect(state).toMatchObject({ enabled: true, running: false });
    expect(mocks.setAgentEnabled).toHaveBeenLastCalledWith({ id: 'copilot-ide', enabled: false });
    expect(mocks.create.mock.calls[0][0]).toMatchObject({
      id: 'ellmsha-copilot-ide',
      platform: 'custom',
      enabled: true,
      models: [],
    });
    const privateProfile = path.join(mocks.profile, 'copilot-ide/user-data');
    await mkdir(privateProfile, { recursive: true });
    await writeFile(path.join(privateProfile, 'auth-sentinel'), 'fixture');
    await action({ sender: window.webContents }, 'disable');
    expect(await readFile(path.join(privateProfile, 'auth-sentinel'), 'utf8')).toBe('fixture');
  });

  it('refreshes stale agent health after restoring a connected catalog without starting Code OSS', async () => {
    await mkdir(path.join(mocks.profile, 'copilot-ide'), { recursive: true });
    await writeFile(
      path.join(mocks.profile, 'copilot-ide/settings.json'),
      JSON.stringify({ enabled: true, models: [{ id: 'test-model' }] })
    );
    await provider.initializeCopilotProvider();
    expect(mocks.setAgentEnabled).toHaveBeenLastCalledWith({ id: 'copilot-ide', enabled: true });
    expect(mocks.checkHealth).toHaveBeenCalledWith({ id: 'copilot-ide' });
    await expect(readFile(path.join(mocks.profile, 'copilot-ide/user-data/User/settings.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects another webContents and arbitrary process commands at the IPC boundary', () => {
    const window = { webContents: {} };
    provider.registerCopilotBridge(() => window as Electron.BrowserWindow);
    const action = mocks.handle.mock.calls[0][1];
    expect(() => action({ sender: {} }, 'login')).toThrow('copilot_main_window_required');
    expect(() => action({ sender: window.webContents }, 'spawn-other-binary')).toThrow('copilot_invalid_action');
  });
});
