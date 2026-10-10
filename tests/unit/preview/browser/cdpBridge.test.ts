/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { sessionIdForTarget } from '@process/resources/builtinMcp/cdpTargetProtocol';
import { MAX_BROWSER_TABS } from '@/common/config/constants';

const electronMock = vi.hoisted(() => ({
  browserSession: {},
  contents: new Map<number, FakeContents>(),
}));

class FakeDebugger extends EventEmitter {
  attached = false;
  sendCommand = vi.fn(async (method: string, params: Record<string, unknown>) => ({ method, params }));

  isAttached(): boolean {
    return this.attached;
  }

  attach(): void {
    this.attached = true;
  }

  detach(): void {
    this.attached = false;
  }
}

class FakeContents extends EventEmitter {
  readonly debugger = new FakeDebugger();
  readonly session = electronMock.browserSession;
  destroyed = false;

  constructor(
    readonly id: number,
    private url: string,
    private title: string
  ) {
    super();
  }

  getType(): string {
    return 'webview';
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  getURL(): string {
    return this.url;
  }

  getTitle(): string {
    return this.title;
  }

  destroy(): void {
    this.destroyed = true;
    this.emit('destroyed');
  }
}

vi.mock('electron', () => ({
  session: { fromPartition: () => electronMock.browserSession },
  webContents: { fromId: (id: number) => electronMock.contents.get(id) },
}));

import { startCdpBridge as startRawCdpBridge, type CdpBridgeHandle } from '@process/resources/builtinMcp/cdpBridge';
import { CdpBrowserTabController } from '@process/resources/builtinMcp/browserTabMcp';
import type { BrowserTabCommand } from '@/common/adapter/ipcBridge';

const createContents = (id: number, url = 'about:blank', title = 'Tab'): FakeContents => {
  const contents = new FakeContents(id, url, title);
  electronMock.contents.set(id, contents);
  return contents;
};

const connect = async (bridge: CdpBridgeHandle): Promise<WebSocket> => {
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/aionui-cdp?token=${bridge.token}`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return ws;
};

const request = <T>(ws: WebSocket, payload: Record<string, unknown>): Promise<T> =>
  new Promise((resolve) => {
    const id = payload.id;
    const onMessage = (raw: Buffer): void => {
      const message = JSON.parse(raw.toString()) as { id?: unknown };
      if (message.id !== id) return;
      ws.off('message', onMessage);
      resolve(message as T);
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify(payload));
  });

const closeSocket = (ws: WebSocket): Promise<void> =>
  new Promise((resolve) => {
    ws.once('close', () => resolve());
    ws.close();
  });

const openBridges: CdpBridgeHandle[] = [];
const openSockets: WebSocket[] = [];

const startCdpBridge = async (...args: Parameters<typeof startRawCdpBridge>): Promise<CdpBridgeHandle> => {
  const bridge = await startRawCdpBridge(...args);
  bridge.updateTabInventory({ ready: true, tabIds: [] });
  return bridge;
};

beforeEach(() => {
  electronMock.contents.clear();
});

afterEach(async () => {
  await Promise.all(
    openSockets.splice(0).map((ws) => (ws.readyState < WebSocket.CLOSING ? closeSocket(ws) : undefined))
  );
  await Promise.all(openBridges.splice(0).map((bridge) => bridge.close()));
});

describe('cdpBridge multi-tab routing and lifecycle', () => {
  it('waits for the restored renderer inventory instead of reporting a false empty list', async () => {
    const bridge = await startRawCdpBridge({ sendTabCommand: vi.fn() });
    openBridges.push(bridge);
    const ws = await connect(bridge);
    openSockets.push(ws);

    const pending = request<{ result: { targetInfos: Array<{ targetId: string }> } }>(ws, {
      id: 100,
      method: 'Target.getTargets',
    });
    await Promise.resolve();

    const restored = createContents(100, 'https://restored.example/', 'Restored');
    bridge.registerTab({ tabId: 'browser-restored-startup', webContentsId: restored.id, active: true });
    bridge.updateTabInventory({ ready: true, tabIds: ['browser-restored-startup'] });

    await expect(pending).resolves.toMatchObject({
      result: { targetInfos: [{ targetId: 'browser-restored-startup' }] },
    });
  });

  it('does not create a tab while restoration can still reveal a full renderer inventory', async () => {
    const commands: BrowserTabCommand[] = [];
    const bridge = await startRawCdpBridge({ sendTabCommand: (command) => commands.push(command) });
    openBridges.push(bridge);
    const ws = await connect(bridge);
    openSockets.push(ws);

    const pending = request<{ error: { message: string } }>(ws, {
      id: 101,
      method: 'Target.createTarget',
      params: { url: 'https://must-not-open.example/' },
    });
    await Promise.resolve();
    expect(commands).toEqual([]);

    const ids = Array.from({ length: MAX_BROWSER_TABS }, (_, index) => `browser-restored-${index}`);
    ids.forEach((tabId, index) => {
      const contents = createContents(110 + index, `https://restored.example/${index}`, tabId);
      bridge.registerTab({ tabId, webContentsId: contents.id, active: index === 0 });
    });
    bridge.updateTabInventory({ ready: true, tabIds: ids });

    await expect(pending).resolves.toMatchObject({
      error: { message: `The in-app browser already has its maximum of ${MAX_BROWSER_TABS} tabs.` },
    });
    expect(commands).toEqual([]);
  });

  it('rejects an in-flight lifecycle operation when renderer restoration tears down its target', async () => {
    const commands: BrowserTabCommand[] = [];
    const bridge = await startCdpBridge({ sendTabCommand: (command) => commands.push(command) });
    openBridges.push(bridge);
    const restored = createContents(130, 'https://restored.example/', 'Restored');
    bridge.registerTab({ tabId: 'browser-close-race', webContentsId: restored.id, active: true });
    bridge.updateTabInventory({ ready: true, tabIds: ['browser-close-race'] });
    const ws = await connect(bridge);
    openSockets.push(ws);

    const pending = request<{ error: { message: string } }>(ws, {
      id: 102,
      method: 'Target.closeTarget',
      params: { targetId: 'browser-close-race' },
    });
    await vi.waitFor(() => expect(commands).toEqual([{ action: 'close', tabId: 'browser-close-race' }]));

    bridge.updateTabInventory({ ready: false, tabIds: [] });

    await expect(pending).resolves.toMatchObject({
      error: { message: 'The in-app browser changed scope or reloaded during the request. Try again shortly.' },
    });
  });

  it('rejects webviews outside the dedicated authenticated browser session', async () => {
    const bridge = await startCdpBridge({ sendTabCommand: vi.fn() });
    openBridges.push(bridge);
    const unrelated = createContents(99, 'https://unrelated.example/', 'Unrelated');
    Object.defineProperty(unrelated, 'session', { value: {} });

    expect(bridge.registerTab({ tabId: 'browser-unrelated', webContentsId: 99, active: true })).toEqual({
      ok: false,
      reason: 'The webview does not belong to the in-app browser session.',
    });
  });

  it('keeps page commands on their session tab after the visible tab changes', async () => {
    const bridge = await startCdpBridge({ sendTabCommand: vi.fn() });
    openBridges.push(bridge);
    const first = createContents(1, 'https://one.example/', 'One');
    const second = createContents(2, 'https://two.example/', 'Two');
    expect(bridge.registerTab({ tabId: 'browser-1', webContentsId: 1, active: true })).toEqual({ ok: true });
    expect(bridge.registerTab({ tabId: 'browser-2', webContentsId: 2, active: false })).toEqual({ ok: true });

    const ws = await connect(bridge);
    openSockets.push(ws);
    await request(ws, { id: 1, method: 'Target.setDiscoverTargets', params: { discover: true } });
    await request(ws, { id: 2, method: 'Target.setAutoAttach', params: { autoAttach: true, flatten: true } });

    bridge.registerTab({ tabId: 'browser-1', webContentsId: 1, active: false });
    bridge.registerTab({ tabId: 'browser-2', webContentsId: 2, active: true });
    await request(ws, {
      id: 3,
      method: 'Page.navigate',
      params: { url: 'https://next.example/' },
      sessionId: sessionIdForTarget('browser-1'),
    });

    expect(first.debugger.sendCommand).toHaveBeenCalledWith('Page.navigate', { url: 'https://next.example/' });
    expect(second.debugger.sendCommand).not.toHaveBeenCalled();
  });

  it('creates, activates, and closes the exact renderer tab requested by CDP', async () => {
    let bridge: CdpBridgeHandle;
    let nextContentsId = 10;
    const contentsByTab = new Map<string, FakeContents>();
    const commands: BrowserTabCommand[] = [];
    bridge = await startCdpBridge({
      sendTabCommand: (command) => {
        commands.push(command);
        queueMicrotask(() => {
          if (command.action === 'create') {
            const contents = createContents(nextContentsId++, command.url, command.tabId);
            contentsByTab.set(command.tabId, contents);
            bridge.registerTab({ tabId: command.tabId, webContentsId: contents.id, active: command.activate });
          } else if (command.action === 'activate') {
            const contents = contentsByTab.get(command.tabId)!;
            bridge.registerTab({ tabId: command.tabId, webContentsId: contents.id, active: true });
          } else {
            contentsByTab.get(command.tabId)!.destroy();
          }
        });
      },
    });
    openBridges.push(bridge);
    const ws = await connect(bridge);
    openSockets.push(ws);

    const created = await request<{ result: { targetId: string } }>(ws, {
      id: 4,
      method: 'Target.createTarget',
      params: { url: 'https://github.com/login', background: false },
    });
    const targetId = created.result.targetId;
    expect(commands[0]).toEqual({ action: 'create', tabId: targetId, url: 'https://github.com/login', activate: true });

    await request(ws, { id: 5, method: 'Target.activateTarget', params: { targetId } });
    expect(commands[1]).toEqual({ action: 'activate', tabId: targetId });

    const closed = await request<{ result: { success: boolean } }>(ws, {
      id: 6,
      method: 'Target.closeTarget',
      params: { targetId },
    });
    expect(closed.result.success).toBe(true);
    expect(commands[2]).toEqual({ action: 'close', tabId: targetId });

    const stale = await request<{ error: { message: string } }>(ws, {
      id: 7,
      method: 'Runtime.evaluate',
      params: { expression: '1' },
      sessionId: sessionIdForTarget(targetId),
    });
    expect(stale.error.message).toContain('stale sessionId');
  });

  it('rebinds a recreated renderer target under the same stable tab and session ids', async () => {
    const bridge = await startCdpBridge({ sendTabCommand: vi.fn() });
    openBridges.push(bridge);
    const original = createContents(30, 'https://before.example/', 'Before');
    bridge.registerTab({ tabId: 'browser-restored', webContentsId: original.id, active: true });
    original.destroy();

    const recreated = createContents(31, 'https://after.example/', 'After');
    bridge.registerTab({ tabId: 'browser-restored', webContentsId: recreated.id, active: true });
    const ws = await connect(bridge);
    openSockets.push(ws);
    await request(ws, {
      id: 8,
      method: 'Runtime.evaluate',
      params: { expression: 'location.href' },
      sessionId: sessionIdForTarget('browser-restored'),
    });

    expect(recreated.debugger.sendCommand).toHaveBeenCalledWith('Runtime.evaluate', { expression: 'location.href' });
    expect(original.debugger.sendCommand).not.toHaveBeenCalled();
  });

  it('serializes concurrent target creation so each request receives its own tab', async () => {
    let bridge: CdpBridgeHandle;
    let nextContentsId = 40;
    const commands: BrowserTabCommand[] = [];
    bridge = await startCdpBridge({
      sendTabCommand: (command) => {
        commands.push(command);
        if (command.action !== 'create') return;
        queueMicrotask(() => {
          const contents = createContents(nextContentsId++, command.url, command.tabId);
          bridge.registerTab({ tabId: command.tabId, webContentsId: contents.id, active: command.activate });
        });
      },
    });
    openBridges.push(bridge);
    const ws = await connect(bridge);
    openSockets.push(ws);

    const [first, second] = await Promise.all([
      request<{ result: { targetId: string } }>(ws, {
        id: 9,
        method: 'Target.createTarget',
        params: { url: 'https://one.example/' },
      }),
      request<{ result: { targetId: string } }>(ws, {
        id: 10,
        method: 'Target.createTarget',
        params: { url: 'https://two.example/' },
      }),
    ]);

    expect(first.result.targetId).not.toBe(second.result.targetId);
    expect(commands.map((command) => command.action)).toEqual(['create', 'create']);
  });

  it('emits discovery and unique manual attachment events before their responses', async () => {
    const bridge = await startCdpBridge({ sendTabCommand: vi.fn() });
    openBridges.push(bridge);
    const first = createContents(50, 'https://one.example/', 'One');
    bridge.registerTab({ tabId: 'browser-ordered', webContentsId: first.id, active: true });
    const ws = await connect(bridge);
    openSockets.push(ws);
    const messages: Array<{ id?: number; method?: string; params?: { sessionId?: string } }> = [];
    ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));

    await request(ws, { id: 20, method: 'Target.setDiscoverTargets', params: { discover: true } });
    expect(messages.findIndex((message) => message.method === 'Target.targetCreated')).toBeLessThan(
      messages.findIndex((message) => message.id === 20)
    );

    const firstAttach = await request<{ result: { sessionId: string } }>(ws, {
      id: 21,
      method: 'Target.attachToTarget',
      params: { targetId: 'browser-ordered', flatten: true },
    });
    const secondAttach = await request<{ result: { sessionId: string } }>(ws, {
      id: 22,
      method: 'Target.attachToTarget',
      params: { targetId: 'browser-ordered', flatten: true },
    });
    expect(firstAttach.result.sessionId).not.toBe(secondAttach.result.sessionId);
    expect(
      messages.findIndex(
        (message) =>
          message.method === 'Target.attachedToTarget' && message.params?.sessionId === secondAttach.result.sessionId
      )
    ).toBeLessThan(messages.findIndex((message) => message.id === 22));

    await request(ws, {
      id: 23,
      method: 'Page.navigate',
      params: { url: 'https://manual.example/' },
      sessionId: secondAttach.result.sessionId,
    });
    expect(first.debugger.sendCommand).toHaveBeenCalledWith('Page.navigate', { url: 'https://manual.example/' });

    await request(ws, {
      id: 24,
      method: 'Target.detachFromTarget',
      params: { sessionId: secondAttach.result.sessionId },
    });
    const stale = await request<{ error: { message: string } }>(ws, {
      id: 25,
      method: 'Runtime.evaluate',
      sessionId: secondAttach.result.sessionId,
    });
    expect(stale.error.message).toContain('stale sessionId');
  });

  it('propagates an authoritative renderer rejection without waiting for timeout', async () => {
    let bridge: CdpBridgeHandle;
    bridge = await startCdpBridge({
      sendTabCommand: (command) => {
        queueMicrotask(() => bridge.rejectTabCommand(command.tabId, 'Renderer tab limit reached.'));
      },
    });
    openBridges.push(bridge);
    const ws = await connect(bridge);
    openSockets.push(ws);

    const rejected = await request<{ error: { message: string } }>(ws, {
      id: 26,
      method: 'Target.createTarget',
      params: { url: 'https://overflow.example/' },
    });
    expect(rejected.error.message).toBe('Renderer tab limit reached.');
  });

  it('drives stable lifecycle tools through discovery, navigation, recreation, and final close', async () => {
    let bridge: CdpBridgeHandle;
    let contents: FakeContents | undefined;
    bridge = await startCdpBridge({
      sendTabCommand: (command) => {
        queueMicrotask(() => {
          if (command.action === 'create') {
            contents = createContents(60, command.url, 'Stable tool tab');
            bridge.registerTab({ tabId: command.tabId, webContentsId: contents.id, active: command.activate });
          } else if (command.action === 'activate' && contents) {
            bridge.registerTab({ tabId: command.tabId, webContentsId: contents.id, active: true });
          } else if (command.action === 'close') {
            contents?.destroy();
          }
        });
      },
    });
    openBridges.push(bridge);
    const controller = new CdpBrowserTabController(`http://127.0.0.1:${bridge.port}`);

    const tabId = await controller.open('https://github.com/login', true);
    expect(await controller.list()).toEqual([
      { id: tabId, title: 'Stable tool tab', url: 'https://github.com/login', active: true },
    ]);
    await controller.navigate(tabId, 'https://example.com/next', true);
    expect(contents?.debugger.sendCommand).toHaveBeenCalledWith('Page.navigate', {
      url: 'https://example.com/next',
    });

    contents?.destroy();
    contents = createContents(61, 'https://example.com/restored', 'Restored');
    bridge.registerTab({ tabId, webContentsId: contents.id, active: true });
    expect((await controller.list())[0].id).toBe(tabId);

    await controller.close(tabId);
    expect(await controller.list()).toEqual([]);
    await controller.disconnect();
  });

  it('initializes the built stdio proxy and publishes stable plus upstream tools with zero tabs', async () => {
    const bridge = await startCdpBridge({ sendTabCommand: vi.fn() });
    openBridges.push(bridge);
    const root = path.resolve(__dirname, '../../../..');
    execFileSync(process.execPath, ['scripts/build-mcp-servers.js'], { cwd: root, stdio: 'pipe' });

    const client = new Client({ name: 'browser-stdio-regression', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, 'out/main/builtin-mcp-browser.js')],
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => !!entry[1])),
        AIONUI_CDP_ACTIVE_PORT: String(bridge.port),
        AIONUI_CDP_BRIDGE_TOKEN: bridge.token,
      },
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      const toolNames = tools.tools.map((tool) => tool.name);
      expect(toolNames).toHaveLength(32);
      expect(new Set(toolNames).size).toBe(32);
      expect(toolNames).toEqual(
        expect.arrayContaining([
          'browser_tabs_list',
          'browser_tab_open',
          'browser_tab_activate',
          'browser_tab_navigate',
          'browser_tab_close',
          'list_pages',
          'navigate_page',
          'take_snapshot',
          'take_snapshot_to_file',
        ])
      );
      const inlineSnapshot = tools.tools.find((tool) => tool.name === 'take_snapshot');
      expect(inlineSnapshot?.annotations?.readOnlyHint).toBe(true);
      expect(inlineSnapshot?.inputSchema.properties).not.toHaveProperty('filePath');
      const fileSnapshot = tools.tools.find((tool) => tool.name === 'take_snapshot_to_file');
      expect(fileSnapshot?.annotations?.readOnlyHint).toBe(false);
      expect(fileSnapshot?.inputSchema.required).toContain('filePath');

      const stableList = await client.callTool({ name: 'browser_tabs_list', arguments: {} });
      expect(stableList.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('"tabs": []') });

      const upstreamList = await client.callTool({ name: 'list_pages', arguments: {} });
      expect(upstreamList).toMatchObject({
        isError: true,
        content: [{ type: 'text', text: 'No page selected' }],
      });
    } finally {
      const closeStartedAt = Date.now();
      await client.close();
      expect(Date.now() - closeStartedAt).toBeLessThan(1_500);
      expect(stderr).toContain('Browser proxy stopped cleanly.');
    }
  }, 30_000);
});
