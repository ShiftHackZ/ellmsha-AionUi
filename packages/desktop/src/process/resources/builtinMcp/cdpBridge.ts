import {
  browserProfileFromToken,
  getActiveBrowserProfile,
  validateBrowserToken,
  browserSession,
} from '../../services/browser/profiles';
import { canOpenBrowserUrl, getBrowserPopup } from '../../services/browser/popups';
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
import { webContents, type Debugger, type WebContents } from 'electron';
import { WebSocketServer, type WebSocket } from 'ws';
import { MAX_BROWSER_TABS } from '@/common/config/constants';
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
  registerTab: (registration: BrowserTabRegistration) => { ok: true } | { ok: false; reason: string };
  updateTabInventory: (inventory: BrowserTabInventory) => { ok: true } | { ok: false; reason: string };
  rejectTabCommand: (tabId: string, reason: string) => void;
  close: () => Promise<void>;
};

type TargetState = {
  tabId: string;
  profileId: string;
  contents: WebContents;
  dbg: Debugger;
  active: boolean;
  executionContexts: Map<number, Record<string, unknown>>;
  runtimeInitialized: boolean;
  runtimeQueue: Promise<void>;
  onMessage: (event: unknown, method: string, params: unknown, sessionId: string) => void;
  onDestroyed: () => void;
  onFocus: () => void;
};

type SocketState = {
  token: string;
  profileId: string;
  events: Array<{
    event: CdpEvent;
    runtimeTargetId?: string;
    runtimeEpoch?: number;
    delivered: Promise<void>;
    settle: () => void;
  }>;
  eventFlush?: Promise<void>;
  discover: boolean;
  autoAttach: boolean;
  manualSessions: Map<string, string>;
  runtimeSessions: Map<string, string>;
  runtimeEpochs: Map<string, number>;
  nextRuntimeEpoch: number;
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

const sendError = (ws: WebSocket, id: number | undefined, message: string, code = -32000, sessionId?: string): void => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ id: id ?? 0, error: { code, message }, sessionId }));
};

const writeJson = (res: ServerResponse, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
};

export const startCdpBridge = async (options: CdpBridgeOptions): Promise<CdpBridgeHandle> => {
  const targets = new Map<string, TargetState>();
  const socketStates = new Map<WebSocket, SocketState>();
  const waiters = new Set<StateWaiter>();
  let activeTargetId: string | null = null;
  let lifecycleTail: Promise<void> = Promise.resolve();
  let rendererReady = false;
  let expectedTabIds = new Set<string>();
  let pendingFocus: { target: TargetState; requestId: string; acknowledged: boolean } | undefined;

  const sendScopedCommand = (command: BrowserTabCommand): void => {
    const profile = getActiveBrowserProfile();
    if (!profile) throw new Error('Browser profile is unresolved.');
    options.sendTabCommand({ ...command, profileId: profile.profileId, generation: profile.generation });
  };
  const targetInfos = (profileId?: string): TargetInfo[] =>
    [...targets.values()]
      .filter((target) => target.profileId === profileId)
      .map((target) =>
        buildTargetInfo(
          target.tabId,
          target.contents.getTitle(),
          target.contents.getURL(),
          target.active,
          target.profileId
        )
      );
  const assertVisible = (profileId: string): void => {
    if (getActiveBrowserProfile()?.profileId !== profileId)
      throw new Error('This browser profile is not visible. Open its conversation first.');
  };
  const authorizedEvent = (ws: WebSocket, state: SocketState, event: CdpEvent, runtimeTargetId?: string): void => {
    // Bound memory and preserve Chromium event order behind one fresh ownership
    // read per batch. Never let independently resolving HTTP requests reorder CDP.
    if (state.events.length >= 1024) {
      ws.close(1008, 'Browser event queue overflow');
      return;
    }
    let settle!: () => void;
    const delivered = new Promise<void>((resolve) => {
      settle = resolve;
    });
    state.events.push({
      event,
      runtimeTargetId,
      runtimeEpoch: runtimeTargetId ? state.runtimeEpochs.get(event.sessionId ?? '') : undefined,
      delivered,
      settle,
    });
    if (state.eventFlush) return;
    state.eventFlush = (async () => {
      while (state.events.length) {
        const profileId = await validateBrowserToken(state.token);
        if (socketStates.get(ws) !== state || profileId !== state.profileId)
          throw new Error('Browser ownership changed.');
        assertVisible(profileId);
        const batch = state.events.splice(0);
        for (const { event, runtimeTargetId, runtimeEpoch, settle } of batch) {
          if (
            !runtimeTargetId ||
            (state.runtimeSessions.get(event.sessionId ?? '') === runtimeTargetId &&
              state.runtimeEpochs.get(event.sessionId ?? '') === runtimeEpoch)
          )
            sendEvent(ws, event);
          settle();
        }
      }
    })()
      .catch(() => {
        for (const queued of state.events) queued.settle();
        state.events.length = 0;
        ws.close(1008, 'Browser ownership unavailable');
      })
      .finally(() => {
        state.eventFlush = undefined;
      });
  };
  // Snapshot a finite watermark: a noisy page must not keep command replies
  // waiting for the event stream to become idle.
  const waitForQueuedEvents = async (state: SocketState): Promise<void> => {
    await Promise.all(state.events.map((queued) => queued.delivered));
  };

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
    const info = buildTargetInfo(
      target.tabId,
      target.contents.getTitle(),
      target.contents.getURL(),
      target.active,
      target.profileId
    );
    for (const [ws, state] of socketStates) {
      if (state.profileId !== target.profileId) continue;
      if (state.discover) authorizedEvent(ws, state, targetCreatedEvent(info));
      if (state.autoAttach) authorizedEvent(ws, state, attachedToTargetEvent(info));
    }
  };

  const detachTarget = (target: TargetState): void => {
    try {
      target.dbg.removeListener('message', target.onMessage);
      target.contents.removeListener('destroyed', target.onDestroyed);
      target.contents.removeListener('focus', target.onFocus);
      if (target.dbg.isAttached()) target.dbg.detach();
    } catch {
      // Electron throws after a webContents has already been destroyed.
    }
  };

  const removeTarget = (tabId: string, expectedContents?: WebContents): void => {
    const target = targets.get(tabId);
    if (!target || (expectedContents && target.contents !== expectedContents)) return;
    targets.delete(tabId);
    if (pendingFocus?.target === target) {
      rejectTabCommand(
        tabId,
        `Browser tab ${tabId} closed or reloaded before receiving input focus. No input was sent.`
      );
    }
    if (activeTargetId === tabId) activeTargetId = null;
    detachTarget(target);
    for (const [ws, state] of socketStates) {
      if (state.profileId !== target.profileId) continue;
      for (const [runtimeSessionId, runtimeTargetId] of state.runtimeSessions)
        if (runtimeTargetId === tabId) {
          state.runtimeSessions.delete(runtimeSessionId);
          state.runtimeEpochs.delete(runtimeSessionId);
        }
      if (state.autoAttach) {
        authorizedEvent(ws, state, {
          method: 'Target.detachedFromTarget',
          params: { sessionId: sessionIdForTarget(tabId), targetId: tabId },
        });
      }
      for (const [sessionId, targetId] of [...state.manualSessions]) {
        if (targetId !== tabId) continue;
        state.manualSessions.delete(sessionId);
        authorizedEvent(ws, state, { method: 'Target.detachedFromTarget', params: { sessionId, targetId: tabId } });
      }
      if (state.discover) authorizedEvent(ws, state, { method: 'Target.targetDestroyed', params: { targetId: tabId } });
    }
    notifyWaiters();
  };

  const registerTab = (registration: BrowserTabRegistration): { ok: true } | { ok: false; reason: string } => {
    const { tabId, webContentsId, active } = registration;
    if (typeof tabId !== 'string' || !TAB_ID_PATTERN.test(tabId))
      return { ok: false, reason: 'Browser tab id is invalid.' };

    const contents = webContents.fromId(webContentsId);
    if (!contents || contents.isDestroyed()) {
      return { ok: false, reason: `No live webContents with id ${webContentsId}` };
    }
    if (contents.getType() !== 'webview' && !getBrowserPopup(tabId, contents.id)) {
      return { ok: false, reason: 'Only an in-app browser webview may be exposed.' };
    }
    const native = getBrowserPopup(tabId, contents.id);
    const profileId = native?.profileId ?? getActiveBrowserProfile()?.profileId;
    if (!profileId || contents.session !== browserSession(profileId)) {
      return { ok: false, reason: 'The webview does not belong to the in-app browser session.' };
    }
    if (native && (registration.mountId !== native.mountId || (active && !native.active))) {
      return { ok: false, reason: 'The native browser attachment is stale or hidden.' };
    }

    const aliased = [...targets.values()].find(
      (target) => target.contents.id === webContentsId && target.tabId !== tabId
    );
    if (aliased) return { ok: false, reason: `webContents ${webContentsId} is already registered to another tab.` };

    const existing = targets.get(tabId);
    if (existing?.contents === contents) {
      if (pendingFocus?.target === existing && registration.focusRequestId === pendingFocus.requestId) {
        pendingFocus.acknowledged = true;
      }
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
      if (method.startsWith('Target.') || _sessionId) return;
      const eventParams = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
      if (method === 'Runtime.executionContextsCleared') target.executionContexts.clear();
      else if (method === 'Runtime.executionContextDestroyed') {
        target.executionContexts.delete(eventParams.executionContextId as number);
      } else if (method === 'Runtime.executionContextCreated') {
        const context = eventParams.context as Record<string, unknown> | undefined;
        if (typeof context?.id === 'number') target.executionContexts.set(context.id, context);
      }
      for (const [ws, state] of socketStates) {
        if (state.profileId !== target.profileId) continue;
        if (method.startsWith('Runtime.')) {
          for (const [runtimeSessionId, runtimeTargetId] of state.runtimeSessions) {
            if (runtimeTargetId === tabId)
              authorizedEvent(
                ws,
                state,
                { method, params: eventParams, sessionId: runtimeSessionId || undefined },
                tabId
              );
          }
          continue;
        }
        if (state.autoAttach) {
          authorizedEvent(ws, state, { method, params: eventParams, sessionId: sessionIdForTarget(tabId) });
        }
        for (const [manualSessionId, targetId] of state.manualSessions) {
          if (targetId === tabId)
            authorizedEvent(ws, state, { method, params: eventParams, sessionId: manualSessionId });
        }
      }
    };
    const onDestroyed = (): void => removeTarget(tabId, contents);
    const onFocus = (): void => notifyWaiters();
    const target: TargetState = {
      tabId,
      profileId,
      contents,
      dbg,
      active,
      onMessage,
      onDestroyed,
      onFocus,
      executionContexts: new Map(),
      runtimeInitialized: false,
      runtimeQueue: Promise.resolve(),
    };
    dbg.on('message', onMessage);
    contents.once('destroyed', onDestroyed);
    contents.on('focus', onFocus);
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

  const createTarget = (url: string, background: boolean, scopeToken: string, profileId: string): Promise<string> =>
    runLifecycle(async () => {
      await validateBrowserToken(scopeToken);
      assertVisible(profileId);
      await waitForInventory();
      await validateBrowserToken(scopeToken);
      assertVisible(profileId);
      if (targets.size >= MAX_BROWSER_TABS) {
        throw new Error(`The in-app browser already has its maximum of ${MAX_BROWSER_TABS} tabs.`);
      }
      const tabId = `browser-agent-${randomBytes(12).toString('hex')}`;
      const registered = waitForState(
        () => targets.has(tabId),
        `Timed out waiting for in-app browser tab ${tabId} to be created.`,
        tabId
      );
      sendScopedCommand({ action: 'create', tabId, url, activate: !background });
      await registered;
      return tabId;
    });

  const hasTargetInputFocus = (target: TargetState): boolean => {
    try {
      const popup = getBrowserPopup(target.tabId, target.contents.id);
      if (popup) {
        const frame = target.contents.focusedFrame;
        return popup.active && !!frame && webContents.fromFrame(frame) === target.contents;
      }
      const host = target.contents.hostWebContents;
      if (!host || host.isDestroyed()) return false;
      const frame = host.focusedFrame;
      // Guest isFocused() reflects the shared root view, so the global
      // getFocusedWebContents() can return a different, even hidden webview.
      // CDP input follows this native frame even when another macOS app is key.
      return !!frame && webContents.fromFrame(frame) === target.contents;
    } catch {
      // A frame can detach while Chromium changes the focused guest.
      return false;
    }
  };

  const focusTarget = async (target: TargetState): Promise<void> => {
    if (targets.get(target.tabId) !== target || target.contents.isDestroyed() || activeTargetId !== target.tabId) {
      throw new Error(`Browser tab ${target.tabId} is no longer the visible input target.`);
    }
    const nativePopup = getBrowserPopup(target.tabId, target.contents.id);
    if (nativePopup) {
      // A WebContentsView owns a native widget (unlike a webview OOPIF).
      // Focus that exact widget on every dispatch; OS key-window status is irrelevant.
      if (!nativePopup.active) throw new Error('The popup tab is no longer visible. No input was sent.');
      target.contents.focus();
      const isCurrentTarget = () =>
        targets.get(target.tabId) === target &&
        !target.contents.isDestroyed() &&
        activeTargetId === target.tabId &&
        nativePopup.active;
      // Native widget focus can reach Chromium after the synchronous focus call.
      // Observe the exact frame before dispatch; never retry an input event.
      const focusPoll = setInterval(notifyWaiters, 16);
      try {
        await waitForState(
          () => !isCurrentTarget() || hasTargetInputFocus(target),
          'The exact popup frame could not receive input. No input was sent.',
          target.tabId
        );
        if (!isCurrentTarget() || !hasTargetInputFocus(target))
          throw new Error('The popup tab changed before receiving input focus. No input was sent.');
      } finally {
        clearInterval(focusPoll);
      }
      return;
    }
    if (hasTargetInputFocus(target)) return;
    const host =
      target.contents.hostWebContents ?? getBrowserPopup(target.tabId, target.contents.id)?.window.webContents;
    if (!host || host.isDestroyed()) throw new Error('The browser host is no longer available. No input was sent.');
    const request = { target, requestId: randomBytes(12).toString('hex'), acknowledged: false };
    pendingFocus = request;
    const focused = waitForState(
      () => request.acknowledged && hasTargetInputFocus(target),
      `Browser tab ${target.tabId} did not confirm input focus. No input was sent.`,
      target.tabId
    );
    // Electron does not guarantee a guest focus event when only the focused
    // frame changes. Observe that native state until the bounded waiter settles.
    const focusPoll = setInterval(notifyWaiters, 16);
    try {
      sendScopedCommand({ action: 'focus', tabId: target.tabId, requestId: request.requestId });
      await focused;
    } catch (error) {
      rejectTabCommand(target.tabId, error instanceof Error ? error.message : String(error));
      await focused.catch((): void => undefined);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${message} (renderer_ack=${request.acknowledged}, exact_frame_focus=${hasTargetInputFocus(target)}, host_focused=${!host.isDestroyed() && host.isFocused()})`
      );
    } finally {
      clearInterval(focusPoll);
      if (pendingFocus === request) pendingFocus = undefined;
    }
  };

  const activateTarget = (targetId: string, scopeToken: string, profileId: string): Promise<void> =>
    runLifecycle(async () => {
      await validateBrowserToken(scopeToken);
      assertVisible(profileId);
      await waitForInventory();
      await validateBrowserToken(scopeToken);
      assertVisible(profileId);
      if (targets.get(targetId)?.profileId !== profileId) throw new Error(`No such in-app browser tab: ${targetId}`);
      const activated = waitForState(
        () => activeTargetId === targetId,
        `Timed out waiting for in-app browser tab ${targetId} to become visible.`,
        targetId
      );
      sendScopedCommand({ action: 'activate', tabId: targetId });
      await activated;
      const target = targets.get(targetId);
      if (!target) throw new Error(`No such in-app browser tab: ${targetId}`);
      // Fail before a locator can clear a field while preparing to type.
      await focusTarget(target);
    });

  const closeTarget = (targetId: string, scopeToken: string, profileId: string): Promise<void> =>
    runLifecycle(async () => {
      await validateBrowserToken(scopeToken);
      assertVisible(profileId);
      await waitForInventory();
      await validateBrowserToken(scopeToken);
      assertVisible(profileId);
      if (targets.get(targetId)?.profileId !== profileId) throw new Error(`No such in-app browser tab: ${targetId}`);
      const closed = waitForState(
        () => !targets.has(targetId),
        `Timed out waiting for in-app browser tab ${targetId} to close.`,
        targetId
      );
      sendScopedCommand({ action: 'close', tabId: targetId });
      await closed;
    });

  const forwardTarget = (profileId: string): TargetState | undefined =>
    [...targets.values()].find((target) => target.profileId === profileId && target.active) ??
    [...targets.values()].find((target) => target.profileId === profileId);

  const handleSocketMessage = async (ws: WebSocket, raw: string): Promise<void> => {
    let req: CdpRequest;
    try {
      req = JSON.parse(raw) as CdpRequest;
    } catch {
      return;
    }

    const { id, method, params, sessionId } = req;
    if (!method) return;

    const socketState = socketStates.get(ws);
    if (!socketState) return;
    const profileId = socketState.profileId;
    try {
      await validateBrowserToken(socketState.token);
      assertVisible(profileId);
    } catch {
      sendError(ws, id, 'Browser profile unavailable or ownership changed.', -32000, sessionId);
      return;
    }
    const infos = targetInfos(profileId);
    if (!isAcceptableSessionId(sessionId, infos, socketState?.manualSessions)) {
      sendError(ws, id, `Unknown or stale sessionId: ${sessionId}`, -32000, sessionId);
      return;
    }

    if (socketState && method === 'Target.setDiscoverTargets' && !sessionId) {
      socketState.discover = params?.discover === true;
    }
    if (socketState && method === 'Target.setAutoAttach' && !sessionId) {
      socketState.autoAttach = params?.autoAttach === true;
      if (!socketState.autoAttach)
        for (const runtimeSessionId of socketState.runtimeSessions.keys())
          if (runtimeSessionId.startsWith('aionui-browser-session:')) {
            socketState.runtimeSessions.delete(runtimeSessionId);
            socketState.runtimeEpochs.delete(runtimeSessionId);
          }
    }

    try {
      if (
        method !== 'Target.setDiscoverTargets' &&
        method !== 'Target.setAutoAttach' &&
        method !== 'Target.getBrowserContexts'
      ) {
        await waitForInventory();
      }
      await validateBrowserToken(socketState.token);
      assertVisible(profileId);
      const decision = decideCdpCommand(req, () => targetInfos(profileId), socketState.manualSessions, profileId);
      if (decision.kind === 'error') {
        sendError(ws, id, decision.message, -32601, sessionId);
        return;
      }
      if (decision.kind === 'reply' || decision.kind === 'reply-and-emit') {
        if (decision.kind === 'reply-and-emit') {
          for (const event of decision.emit) authorizedEvent(ws, socketState, event);
          await waitForQueuedEvents(socketState);
        }
        ws.send(JSON.stringify({ id, result: decision.payload, sessionId }));
        return;
      }
      if (decision.kind === 'attach-target') {
        if (!socketState) throw new Error('Browser control socket is unavailable.');
        const info = targetInfos(profileId).find((target) => target.targetId === decision.targetId);
        if (!info) throw new Error(`No such in-app browser tab: ${decision.targetId}`);
        const manualSessionId = `aionui-browser-manual:${randomBytes(12).toString('hex')}`;
        socketState.manualSessions.set(manualSessionId, decision.targetId);
        authorizedEvent(ws, socketState, attachedToTargetEvent(info, manualSessionId));
        await waitForQueuedEvents(socketState);
        ws.send(JSON.stringify({ id, result: { sessionId: manualSessionId }, sessionId }));
        return;
      }
      if (decision.kind === 'detach-session') {
        socketState?.manualSessions.delete(decision.sessionId);
        socketState.runtimeSessions.delete(decision.sessionId);
        socketState.runtimeEpochs.delete(decision.sessionId);
        sendEvent(ws, {
          method: 'Target.detachedFromTarget',
          params: { sessionId: decision.sessionId },
        });
        ws.send(JSON.stringify({ id, result: {}, sessionId }));
        return;
      }
      if (decision.kind === 'create-target') {
        const targetId = await createTarget(decision.url, decision.background, socketState.token, profileId);
        ws.send(JSON.stringify({ id, result: { targetId }, sessionId }));
        return;
      }
      if (decision.kind === 'activate-target') {
        await activateTarget(decision.targetId, socketState.token, profileId);
        ws.send(JSON.stringify({ id, result: {}, sessionId }));
        return;
      }
      if (decision.kind === 'close-target') {
        await closeTarget(decision.targetId, socketState.token, profileId);
        ws.send(JSON.stringify({ id, result: { success: true }, sessionId }));
        return;
      }

      const target = decision.targetId ? targets.get(decision.targetId) : forwardTarget(profileId);
      if (!target || target.contents.isDestroyed()) {
        sendError(
          ws,
          id,
          decision.targetId
            ? `Browser tab ${decision.targetId} is closed or reloading.`
            : 'No in-app browser tab is open.',
          -32000,
          sessionId
        );
        return;
      }
      const dispatch = async (): Promise<unknown> => {
        await validateBrowserToken(socketState.token);
        assertVisible(profileId);
        if (target.profileId !== profileId || targets.get(target.tabId) !== target)
          throw new Error('Foreign or stale browser target.');
        if (
          method === 'Page.navigate' &&
          getBrowserPopup(target.tabId, target.contents.id) &&
          (typeof params?.url !== 'string' || !canOpenBrowserUrl(params.url))
        ) {
          throw new Error('Unsupported browser URL.');
        }
        if (method.startsWith('Input.')) {
          // A guest debugger is not an input focus boundary: Electron can send
          // CDP keystrokes to the focused host (e.g. the chat composer). Check
          // every event, since the host may regain focus between keystrokes.
          // Keep focus + dispatch in the lifecycle queue. Never replay failed input.
          await focusTarget(target);
          if (
            targets.get(target.tabId) !== target ||
            target.contents.isDestroyed() ||
            activeTargetId !== target.tabId
          ) {
            throw new Error(`Browser tab ${target.tabId} is no longer the visible input target.`);
          }
          // No await between this final native focus check and sendCommand.
          if (!hasTargetInputFocus(target)) {
            throw new Error(`Browser tab ${target.tabId} could not receive input focus. No input was sent.`);
          }
        }
        await validateBrowserToken(socketState.token);
        assertVisible(profileId);
        if (targets.get(target.tabId) !== target) throw new Error('Stale browser target.');
        if (method.startsWith('Input.') && (!hasTargetInputFocus(target) || activeTargetId !== target.tabId))
          throw new Error('Browser input focus changed. No input was sent.');
        return target.dbg.sendCommand(method, params ?? {});
      };
      if (method === 'Runtime.enable' || method === 'Runtime.disable') {
        // Virtual sessions share one Electron debugger. Chromium emits existing
        // contexts only on the physical domain's first enable, so each new
        // subscriber needs its own current-context bootstrap (not a global reset).
        const runtimeSessionId = sessionId ?? '';
        const operation = target.runtimeQueue.then(async () => {
          await validateBrowserToken(socketState.token);
          assertVisible(profileId);
          if (targets.get(target.tabId) !== target) throw new Error('Stale browser target.');
          if (method === 'Runtime.disable') {
            socketState.runtimeSessions.delete(runtimeSessionId);
            socketState.runtimeEpochs.delete(runtimeSessionId);
            return;
          }
          if (socketState.runtimeSessions.get(runtimeSessionId) === target.tabId) return;
          const initialEnable = !target.runtimeInitialized;
          // Preserve Chromium's initial console/error replay as well as contexts.
          if (initialEnable) {
            socketState.runtimeSessions.set(runtimeSessionId, target.tabId);
            socketState.runtimeEpochs.set(runtimeSessionId, ++socketState.nextRuntimeEpoch);
          }
          try {
            await dispatch();
            target.runtimeInitialized = true;
            await validateBrowserToken(socketState.token);
            assertVisible(profileId);
            if (targets.get(target.tabId) !== target) throw new Error('Stale browser target.');
            if (!isAcceptableSessionId(sessionId, targetInfos(profileId), socketState.manualSessions))
              throw new Error('Stale browser session.');
            socketState.runtimeSessions.set(runtimeSessionId, target.tabId);
            if (!initialEnable) socketState.runtimeEpochs.set(runtimeSessionId, ++socketState.nextRuntimeEpoch);
            if (!initialEnable)
              for (const context of target.executionContexts.values())
                authorizedEvent(
                  ws,
                  socketState,
                  {
                    method: 'Runtime.executionContextCreated',
                    params: { context },
                    sessionId,
                  },
                  target.tabId
                );
          } catch (error) {
            socketState.runtimeSessions.delete(runtimeSessionId);
            socketState.runtimeEpochs.delete(runtimeSessionId);
            throw error;
          }
          await waitForQueuedEvents(socketState);
        });
        target.runtimeQueue = operation.catch(() => {});
        await operation;
        ws.send(JSON.stringify({ id, result: {}, sessionId }));
        return;
      }
      const result = method.startsWith('Input.') ? await runLifecycle(dispatch) : await dispatch();
      ws.send(JSON.stringify({ id, result: result ?? {}, sessionId }));
    } catch (error) {
      sendError(ws, id, error instanceof Error ? error.message : String(error), -32000, sessionId);
    }
  };

  let port = 0;
  const parseScope = (request: IncomingMessage) => {
    if (request.headers.origin) throw new Error('Cross-origin CDP access denied.');
    const url = new URL(request.url ?? '/', `http://${HOST}`);
    const match = /^\/scope\/([^/]+)(\/.*)$/.exec(url.pathname);
    if (!match) throw new Error('Scoped browser authorization required.');
    const scopeToken = decodeURIComponent(match[1]);
    return { token: scopeToken, profileId: browserProfileFromToken(scopeToken).id, path: match[2] };
  };
  const httpServer: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const scope = parseScope(req);
      await validateBrowserToken(scope.token);
      assertVisible(scope.profileId);
      const wsUrl = `ws://${HOST}:${port}/scope/${encodeURIComponent(scope.token)}${WS_PATH}`;
      res.setHeader('Cache-Control', 'no-store');
      if (scope.path === '/json/version')
        writeJson(res, buildVersionPayload(wsUrl, process.versions.chrome ?? '0.0.0.0'));
      else if (scope.path === '/json/list' || scope.path === '/json')
        writeJson(res, buildListPayload(wsUrl, targetInfos(scope.profileId)));
      else res.writeHead(404).end('not found');
    })().catch(() => {
      if (!res.headersSent) res.writeHead(403);
      res.end('forbidden');
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    void (async () => {
      const scope = parseScope(req);
      if (scope.path !== WS_PATH) throw new Error('Invalid CDP endpoint');
      await validateBrowserToken(scope.token);
      assertVisible(scope.profileId);
      wss.handleUpgrade(req, socket, head, (ws) => {
        socketStates.set(ws, {
          token: scope.token,
          profileId: scope.profileId,
          events: [],
          discover: false,
          autoAttach: false,
          manualSessions: new Map(),
          runtimeSessions: new Map(),
          runtimeEpochs: new Map(),
          nextRuntimeEpoch: 0,
        });
        ws.on('message', (data) => void handleSocketMessage(ws, data.toString()));
        const forget = (): void => {
          socketStates.delete(ws);
        };
        ws.on('close', forget);
        ws.on('error', forget);
      });
    })().catch(() => {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
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
