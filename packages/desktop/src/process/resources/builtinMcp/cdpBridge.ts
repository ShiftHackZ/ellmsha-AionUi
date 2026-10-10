/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Authenticated CDP bridge exposing only registered in-app browser webviews.
 * Every browser tab owns one debugger attachment and one deterministic CDP
 * session, so commands cannot drift when the visible tab changes.
 */

import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { session, webContents, type Debugger, type WebContents } from 'electron';
import { WebSocketServer, type WebSocket } from 'ws';
import { BROWSER_SESSION_PARTITION, MAX_BROWSER_TABS } from '@/common/config/constants';
import type { BrowserTabCommand, BrowserTabInventory, BrowserTabRegistration } from '@/common/adapter/ipcBridge';
import {
  attachedToTargetEvent,
  buildListPayload,
  buildTargetInfo,
  buildVersionPayload,
  decideCdpCommand,
  isAcceptableSessionId,
  sessionIdForTarget,
  targetCreatedEvent,
  tokensMatch,
  type CdpEvent,
  type CdpRequest,
  type TargetInfo,
} from './cdpTargetProtocol';

const HOST = '127.0.0.1';
const WS_PATH = '/aionui-cdp';
const TAB_COMMAND_TIMEOUT_MS = 10_000;
const TAB_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,200}$/;

export type CdpBridgeOptions = {
  sendTabCommand: (command: BrowserTabCommand) => void;
};

export type CdpBridgeHandle = {
  port: number;
  token: string;
  registerTab: (registration: BrowserTabRegistration) => { ok: true } | { ok: false; reason: string };
  updateTabInventory: (inventory: BrowserTabInventory) => { ok: true } | { ok: false; reason: string };
  rejectTabCommand: (tabId: string, reason: string) => void;
  close: () => Promise<void>;
};

type TargetState = {
  tabId: string;
  contents: WebContents;
  dbg: Debugger;
  active: boolean;
  onMessage: (event: unknown, method: string, params: unknown, sessionId: string) => void;
  onDestroyed: () => void;
};

type SocketState = {
  discover: boolean;
  autoAttach: boolean;
  manualSessions: Map<string, string>;
};

type StateWaiter = {
  tabId?: string;
  predicate: () => boolean;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const sendEvent = (ws: WebSocket, event: CdpEvent): void => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
};

const sendError = (ws: WebSocket, id: number | undefined, message: string, code = -32000): void => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ id: id ?? 0, error: { code, message } }));
};

const writeJson = (res: ServerResponse, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
};

export const startCdpBridge = async (options: CdpBridgeOptions): Promise<CdpBridgeHandle> => {
  const token = randomBytes(24).toString('hex');
  const targets = new Map<string, TargetState>();
  const socketStates = new Map<WebSocket, SocketState>();
  const waiters = new Set<StateWaiter>();
  let activeTargetId: string | null = null;
  let lifecycleTail: Promise<void> = Promise.resolve();
  let rendererReady = false;
  let expectedTabIds = new Set<string>();

  const targetInfos = (): TargetInfo[] =>
    [...targets.values()].map((target) =>
      buildTargetInfo(target.tabId, target.contents.getTitle(), target.contents.getURL(), target.active)
    );

  const notifyWaiters = (): void => {
    for (const waiter of [...waiters]) {
      if (!waiter.predicate()) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve();
    }
  };

  const waitForState = (predicate: () => boolean, message: string, tabId?: string): Promise<void> => {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter: StateWaiter = {
        tabId,
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(message));
        }, TAB_COMMAND_TIMEOUT_MS),
      };
      waiters.add(waiter);
    });
  };

  const rejectTabCommand = (tabId: string, reason: string): void => {
    for (const waiter of [...waiters]) {
      if (waiter.tabId !== tabId) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.reject(new Error(reason));
    }
  };

  const rejectPendingLifecycle = (reason: string): void => {
    for (const waiter of [...waiters]) {
      if (waiter.tabId === undefined) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.reject(new Error(reason));
    }
  };

  const inventoryIsReady = (): boolean => rendererReady && [...expectedTabIds].every((tabId) => targets.has(tabId));

  const waitForInventory = (): Promise<void> =>
    waitForState(
      inventoryIsReady,
      'The in-app browser is not ready because its persisted tabs are still restoring. Try again shortly.'
    );

  const announceTarget = (target: TargetState): void => {
    const info = buildTargetInfo(target.tabId, target.contents.getTitle(), target.contents.getURL(), target.active);
    for (const [ws, state] of socketStates) {
      if (state.discover) sendEvent(ws, targetCreatedEvent(info));
      if (state.autoAttach) sendEvent(ws, attachedToTargetEvent(info));
    }
  };

  const detachTarget = (target: TargetState): void => {
    try {
      target.dbg.removeListener('message', target.onMessage);
      target.contents.removeListener('destroyed', target.onDestroyed);
      if (target.dbg.isAttached()) target.dbg.detach();
    } catch {
      // Electron throws after a webContents has already been destroyed.
    }
  };

  const removeTarget = (tabId: string, expectedContents?: WebContents): void => {
    const target = targets.get(tabId);
    if (!target || (expectedContents && target.contents !== expectedContents)) return;
    targets.delete(tabId);
    if (activeTargetId === tabId) activeTargetId = null;
    detachTarget(target);
    for (const [ws, state] of socketStates) {
      if (state.autoAttach) {
        sendEvent(ws, {
          method: 'Target.detachedFromTarget',
          params: { sessionId: sessionIdForTarget(tabId), targetId: tabId },
        });
      }
      for (const [sessionId, targetId] of [...state.manualSessions]) {
        if (targetId !== tabId) continue;
        state.manualSessions.delete(sessionId);
        sendEvent(ws, { method: 'Target.detachedFromTarget', params: { sessionId, targetId: tabId } });
      }
      if (state.discover) sendEvent(ws, { method: 'Target.targetDestroyed', params: { targetId: tabId } });
    }
    notifyWaiters();
  };

  const registerTab = (registration: BrowserTabRegistration): { ok: true } | { ok: false; reason: string } => {
    const { tabId, webContentsId, active } = registration;
    if (!TAB_ID_PATTERN.test(tabId)) return { ok: false, reason: 'Browser tab id is invalid.' };

    const contents = webContents.fromId(webContentsId);
    if (!contents || contents.isDestroyed()) {
      return { ok: false, reason: `No live webContents with id ${webContentsId}` };
    }
    if (contents.getType() !== 'webview') {
      return { ok: false, reason: 'Only an in-app browser webview may be exposed.' };
    }
    if (contents.session !== session.fromPartition(BROWSER_SESSION_PARTITION)) {
      return { ok: false, reason: 'The webview does not belong to the in-app browser session.' };
    }

    const aliased = [...targets.values()].find(
      (target) => target.contents.id === webContentsId && target.tabId !== tabId
    );
    if (aliased) return { ok: false, reason: `webContents ${webContentsId} is already registered to another tab.` };

    const existing = targets.get(tabId);
    if (existing?.contents === contents) {
      if (active) {
        for (const target of targets.values()) target.active = target.tabId === tabId;
        activeTargetId = tabId;
      } else if (activeTargetId === tabId) {
        existing.active = false;
        activeTargetId = null;
      }
      notifyWaiters();
      return { ok: true };
    }

    if (existing) removeTarget(tabId, existing.contents);

    const dbg = contents.debugger;
    try {
      if (!dbg.isAttached()) dbg.attach('1.3');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `Could not attach debugger (DevTools open on this tab will block it): ${message}` };
    }

    const onMessage = (_event: unknown, method: string, params: unknown, _sessionId: string): void => {
      const eventParams = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
      for (const [ws, state] of socketStates) {
        if (state.autoAttach) {
          sendEvent(ws, { method, params: eventParams, sessionId: sessionIdForTarget(tabId) });
        }
        for (const [manualSessionId, targetId] of state.manualSessions) {
          if (targetId === tabId) sendEvent(ws, { method, params: eventParams, sessionId: manualSessionId });
        }
      }
    };
    const onDestroyed = (): void => removeTarget(tabId, contents);
    const target: TargetState = { tabId, contents, dbg, active, onMessage, onDestroyed };
    dbg.on('message', onMessage);
    contents.once('destroyed', onDestroyed);
    targets.set(tabId, target);

    if (active) {
      for (const candidate of targets.values()) candidate.active = candidate.tabId === tabId;
      activeTargetId = tabId;
    }

    announceTarget(target);
    notifyWaiters();
    return { ok: true };
  };

  const updateTabInventory = (inventory: BrowserTabInventory): { ok: true } | { ok: false; reason: string } => {
    const uniqueTabIds = new Set(inventory.tabIds);
    if (uniqueTabIds.size !== inventory.tabIds.length || uniqueTabIds.size > MAX_BROWSER_TABS) {
      rendererReady = false;
      return { ok: false, reason: 'Browser tab inventory is invalid.' };
    }
    for (const tabId of uniqueTabIds) {
      if (!TAB_ID_PATTERN.test(tabId)) {
        rendererReady = false;
        return { ok: false, reason: 'Browser tab inventory contains an invalid id.' };
      }
    }

    if (!inventory.ready) {
      rejectPendingLifecycle('The in-app browser changed scope or reloaded during the request. Try again shortly.');
    }
    rendererReady = inventory.ready;
    expectedTabIds = uniqueTabIds;
    for (const tabId of [...targets.keys()]) {
      if (!uniqueTabIds.has(tabId)) removeTarget(tabId);
    }
    notifyWaiters();
    return { ok: true };
  };

  const runLifecycle = <T>(operation: () => Promise<T>): Promise<T> => {
    const task = lifecycleTail.then(operation, operation);
    lifecycleTail = task.then(
      (): void => undefined,
      (): void => undefined
    );
    return task;
  };

  const createTarget = (url: string, background: boolean): Promise<string> =>
    runLifecycle(async () => {
      await waitForInventory();
      if (targets.size >= MAX_BROWSER_TABS) {
        throw new Error(`The in-app browser already has its maximum of ${MAX_BROWSER_TABS} tabs.`);
      }
      const tabId = `browser-agent-${randomBytes(12).toString('hex')}`;
      const registered = waitForState(
        () => targets.has(tabId),
        `Timed out waiting for in-app browser tab ${tabId} to be created.`,
        tabId
      );
      options.sendTabCommand({ action: 'create', tabId, url, activate: !background });
      await registered;
      return tabId;
    });

  const activateTarget = (targetId: string): Promise<void> =>
    runLifecycle(async () => {
      await waitForInventory();
      if (!targets.has(targetId)) throw new Error(`No such in-app browser tab: ${targetId}`);
      const activated = waitForState(
        () => activeTargetId === targetId,
        `Timed out waiting for in-app browser tab ${targetId} to become visible.`,
        targetId
      );
      options.sendTabCommand({ action: 'activate', tabId: targetId });
      await activated;
    });

  const closeTarget = (targetId: string): Promise<void> =>
    runLifecycle(async () => {
      await waitForInventory();
      if (!targets.has(targetId)) throw new Error(`No such in-app browser tab: ${targetId}`);
      const closed = waitForState(
        () => !targets.has(targetId),
        `Timed out waiting for in-app browser tab ${targetId} to close.`,
        targetId
      );
      options.sendTabCommand({ action: 'close', tabId: targetId });
      await closed;
    });

  const forwardTarget = (): TargetState | undefined =>
    (activeTargetId ? targets.get(activeTargetId) : undefined) ?? targets.values().next().value;

  const handleSocketMessage = async (ws: WebSocket, raw: string): Promise<void> => {
    let req: CdpRequest;
    try {
      req = JSON.parse(raw) as CdpRequest;
    } catch {
      return;
    }

    const { id, method, params, sessionId } = req;
    if (!method) return;

    const infos = targetInfos();
    const socketState = socketStates.get(ws);
    if (!isAcceptableSessionId(sessionId, infos, socketState?.manualSessions)) {
      sendError(ws, id, `Unknown or stale sessionId: ${sessionId}`);
      return;
    }

    if (socketState && method === 'Target.setDiscoverTargets' && !sessionId) {
      socketState.discover = params?.discover === true;
    }
    if (socketState && method === 'Target.setAutoAttach' && !sessionId) {
      socketState.autoAttach = params?.autoAttach === true;
    }

    try {
      if (
        method !== 'Target.setDiscoverTargets' &&
        method !== 'Target.setAutoAttach' &&
        method !== 'Target.getBrowserContexts'
      ) {
        await waitForInventory();
      }
      const decision = decideCdpCommand(req, targetInfos, socketState?.manualSessions);
      if (decision.kind === 'error') {
        sendError(ws, id, decision.message, -32601);
        return;
      }
      if (decision.kind === 'reply' || decision.kind === 'reply-and-emit') {
        if (decision.kind === 'reply-and-emit') {
          for (const event of decision.emit) sendEvent(ws, event);
        }
        ws.send(JSON.stringify({ id, result: decision.payload }));
        return;
      }
      if (decision.kind === 'attach-target') {
        if (!socketState) throw new Error('Browser control socket is unavailable.');
        const info = targetInfos().find((target) => target.targetId === decision.targetId);
        if (!info) throw new Error(`No such in-app browser tab: ${decision.targetId}`);
        const manualSessionId = `aionui-browser-manual:${randomBytes(12).toString('hex')}`;
        socketState.manualSessions.set(manualSessionId, decision.targetId);
        sendEvent(ws, attachedToTargetEvent(info, manualSessionId));
        ws.send(JSON.stringify({ id, result: { sessionId: manualSessionId } }));
        return;
      }
      if (decision.kind === 'detach-session') {
        socketState?.manualSessions.delete(decision.sessionId);
        sendEvent(ws, {
          method: 'Target.detachedFromTarget',
          params: { sessionId: decision.sessionId },
        });
        ws.send(JSON.stringify({ id, result: {} }));
        return;
      }
      if (decision.kind === 'create-target') {
        const targetId = await createTarget(decision.url, decision.background);
        ws.send(JSON.stringify({ id, result: { targetId } }));
        return;
      }
      if (decision.kind === 'activate-target') {
        await activateTarget(decision.targetId);
        ws.send(JSON.stringify({ id, result: {} }));
        return;
      }
      if (decision.kind === 'close-target') {
        await closeTarget(decision.targetId);
        ws.send(JSON.stringify({ id, result: { success: true } }));
        return;
      }

      const target = decision.targetId ? targets.get(decision.targetId) : forwardTarget();
      if (!target || target.contents.isDestroyed()) {
        sendError(
          ws,
          id,
          decision.targetId
            ? `Browser tab ${decision.targetId} is closed or reloading.`
            : 'No in-app browser tab is open.'
        );
        return;
      }
      const result = await target.dbg.sendCommand(method, params ?? {});
      ws.send(JSON.stringify({ id, result: result ?? {}, sessionId }));
    } catch (error) {
      sendError(ws, id, error instanceof Error ? error.message : String(error));
    }
  };

  let port = 0;
  const httpServer: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    const wsUrl = `ws://${HOST}:${port}${WS_PATH}?token=${token}`;

    if (url.pathname === '/json/version') {
      writeJson(res, buildVersionPayload(wsUrl, process.versions.chrome ?? '0.0.0.0'));
      return;
    }
    if (url.pathname === '/json/list' || url.pathname === '/json') {
      writeJson(res, buildListPayload(wsUrl, targetInfos()));
      return;
    }
    res.writeHead(404).end('not found');
  });

  const wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    if (url.pathname !== WS_PATH || !tokensMatch(token, url.searchParams.get('token') ?? '')) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      socketStates.set(ws, { discover: false, autoAttach: false, manualSessions: new Map() });
      ws.on('message', (data) => void handleSocketMessage(ws, data.toString()));
      const forget = (): void => {
        socketStates.delete(ws);
      };
      ws.on('close', forget);
      ws.on('error', forget);
    });
  });

  port = await new Promise<number>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, HOST, () => {
      const address = httpServer.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('Could not determine bridge port'));
    });
  });

  return {
    port,
    token,
    registerTab,
    updateTabInventory,
    rejectTabCommand,
    close: async () => {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('The in-app browser bridge is shutting down.'));
      }
      waiters.clear();
      for (const target of targets.values()) detachTarget(target);
      targets.clear();
      for (const ws of socketStates.keys()) ws.close();
      socketStates.clear();
      await new Promise<void>((resolve) => {
        wss.close(() => httpServer.close(() => resolve()));
      });
    },
  };
};
