/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  activeProfile: 'profile-a',
  revoked: false,
  validationHook: undefined as undefined | (() => Promise<void>),
  popups: new Map<string, { active: boolean; contents: FakeContents; mountId?: string; profileId?: string }>(),
  contents: new Map<number, FakeContents>(),
  focusedId: undefined as number | undefined,
  reportedFocusedId: undefined as number | undefined,
  windowFocused: true,
  hostDestroyed: false,
  frameLookupThrows: false,
  host: {
    isDestroyed: () => electronMock.hostDestroyed,
    isFocused: () => electronMock.windowFocused,
    focus: vi.fn(() => {
      electronMock.windowFocused = true;
    }),
    get focusedFrame() {
      return electronMock.focusedId === undefined ? null : { ownerId: electronMock.focusedId };
    },
  },
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
  readonly hostWebContents = electronMock.host;
  destroyed = false;
  focus = vi.fn(() => {
    electronMock.focusedId = this.id;
  });

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

vi.mock('@process/services/browser/profiles', () => ({
  browserProfileFromToken: (token: string) => {
    if (!['scoped-token', 'other-token'].includes(token)) throw new Error('Invalid scope');
    return { id: token === 'scoped-token' ? 'profile-a' : 'profile-b' };
  },
  validateBrowserToken: async (token: string) => {
    await electronMock.validationHook?.();
    if (electronMock.revoked || !['scoped-token', 'other-token'].includes(token)) throw new Error('Invalid scope');
    return token === 'scoped-token' ? 'profile-a' : 'profile-b';
  },
  getActiveBrowserProfile: () => ({ profileId: electronMock.activeProfile, generation: 1 }),
  browserSession: () => electronMock.browserSession,
}));
vi.mock('electron', () => ({
  session: { fromPartition: () => electronMock.browserSession },
  webContents: {
    fromId: (id: number) => electronMock.contents.get(id),
    getFocusedWebContents: () =>
      electronMock.contents.get(electronMock.reportedFocusedId ?? electronMock.focusedId ?? -1),
    fromFrame: (frame: { ownerId: number }) => {
      if (electronMock.frameLookupThrows) throw new Error('Frame detached');
      return electronMock.contents.get(frame.ownerId);
    },
  },
}));

vi.mock('@process/services/browser/popups', () => ({
  canOpenBrowserUrl: (url: string) => url === 'about:blank' || /^https?:\/\//.test(url),
  getBrowserPopup: (tabId: string, contentsId?: number) => {
    const popup = electronMock.popups.get(tabId);
    return popup && (contentsId === undefined || popup.contents.id === contentsId)
      ? { ...popup, profileId: popup.profileId ?? 'profile-a' }
      : undefined;
  },
}));

import { startCdpBridge as startRawCdpBridge, type CdpBridgeHandle } from '@process/resources/builtinMcp/cdpBridge';
import { CdpBrowserTabController } from '@process/resources/builtinMcp/browserTabMcp';
import type { BrowserTabCommand, BrowserTabRegistration } from '@/common/adapter/ipcBridge';

const createContents = (id: number, url = 'about:blank', title = 'Tab'): FakeContents => {
  const contents = new FakeContents(id, url, title);
  electronMock.contents.set(id, contents);
  return contents;
};

const connect = async (bridge: CdpBridgeHandle): Promise<WebSocket> => {
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/scope/scoped-token/aionui-cdp`);
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
  const registrations = new Map<string, BrowserTabRegistration>();
  const bridge = await startRawCdpBridge({
    ...args[0],
    sendTabCommand: (command) => {
      if (command.action !== 'focus') return args[0].sendTabCommand(command);
      // Simulate the renderer's exact webview focus, not main-process guest.focus().
      queueMicrotask(() => {
        const registration = registrations.get(command.tabId)!;
        const contents = electronMock.contents.get(registration.webContentsId)!;
        contents.focus();
        if (electronMock.focusedId !== contents.id) {
          bridge.rejectTabCommand(
            command.tabId,
            'The exact browser webview could not receive focus. No input was sent.'
          );
          return;
        }
        bridge.registerTab({ ...registration, focusRequestId: command.requestId });
      });
    },
  });
  const register = bridge.registerTab;
  bridge.registerTab = (registration) => {
    registrations.set(registration.tabId, registration);
    return register(registration);
  };
  bridge.updateTabInventory({ ready: true, tabIds: [] });
  return bridge;
};

beforeEach(() => {
  electronMock.activeProfile = 'profile-a';
  electronMock.revoked = false;
  electronMock.validationHook = undefined;
  electronMock.contents.clear();
  electronMock.popups.clear();
  electronMock.focusedId = undefined;
  electronMock.reportedFocusedId = undefined;
  electronMock.windowFocused = true;
  electronMock.hostDestroyed = false;
  electronMock.frameLookupThrows = false;
  electronMock.host.focus.mockClear();
});

afterEach(async () => {
  await Promise.all(
    openSockets.splice(0).map((ws) => (ws.readyState < WebSocket.CLOSING ? closeSocket(ws) : undefined))
  );
  await Promise.all(openBridges.splice(0).map((bridge) => bridge.close()));
});

describe('cdpBridge multi-tab routing and lifecycle', () => {
  it('requires exact native contents and its current attachment, and rejects unsafe native navigation', async () => {
    const alpha = createContents(277);
    const foreign = createContents(278);
    vi.spyOn(alpha, 'getType').mockReturnValue('window');
    vi.spyOn(foreign, 'getType').mockReturnValue('window');
    electronMock.popups.set('alpha', { active: false, contents: alpha, mountId: 'current' });
    const bridge = await startRawCdpBridge({ sendTabCommand: () => undefined });
    openBridges.push(bridge);
    bridge.updateTabInventory({ ready: true, tabIds: [] });
    const registration = { tabId: 'alpha', webContentsId: alpha.id, active: false, mountId: 'current' };
    expect(bridge.registerTab({ ...registration, mountId: 'stale' }).ok).toBe(false);
    expect(bridge.registerTab({ ...registration, mountId: undefined }).ok).toBe(false);
    expect(bridge.registerTab({ ...registration, active: true }).ok).toBe(false);
    expect(bridge.registerTab({ ...registration, webContentsId: foreign.id }).ok).toBe(false);
    expect(bridge.registerTab(registration)).toEqual({ ok: true });
    const ws = await connect(bridge);
    openSockets.push(ws);
    const sessionId = sessionIdForTarget('alpha');
    const rejected = await request<{ error: { message: string } }>(ws, {
      id: 277,
      method: 'Page.navigate',
      params: { url: 'file:///private/secret' },
      sessionId,
    });
    expect(rejected.error.message).toContain('Unsupported browser URL');
    expect(alpha.debugger.sendCommand).not.toHaveBeenCalled();
    const accepted = await request<{ result: unknown }>(ws, {
      id: 278,
      method: 'Page.navigate',
      params: { url: 'https://fixture.test/' },
      sessionId,
    });
    expect(accepted.result).toBeDefined();
    expect(alpha.debugger.sendCommand).toHaveBeenCalledExactlyOnceWith('Page.navigate', {
      url: 'https://fixture.test/',
    });
  });

  it('waits for exact native popup frame focus before input and rejects a closed pending target', async () => {
    const alpha = createContents(279);
    vi.spyOn(alpha, 'getType').mockReturnValue('window');
    let frameReady = false;
    Object.defineProperty(alpha, 'focusedFrame', { get: () => (frameReady ? { ownerId: alpha.id } : null) });
    alpha.focus.mockImplementation(() => undefined);
    electronMock.popups.set('alpha', { active: true, contents: alpha });
    const bridge = await startRawCdpBridge({ sendTabCommand: () => undefined });
    openBridges.push(bridge);
    bridge.updateTabInventory({ ready: true, tabIds: [] });
    bridge.registerTab({ tabId: 'alpha', webContentsId: alpha.id, active: true });
    const ws = await connect(bridge);
    openSockets.push(ws);
    const sessionId = sessionIdForTarget('alpha');
    const input = request<{ result: unknown }>(ws, {
      id: 275,
      method: 'Input.insertText',
      params: { text: 'OWNED' },
      sessionId,
    });
    await vi.waitFor(() => expect(alpha.focus).toHaveBeenCalledOnce());
    expect(alpha.debugger.sendCommand).not.toHaveBeenCalled();
    frameReady = true;
    expect((await input).result).toBeDefined();
    expect(alpha.debugger.sendCommand).toHaveBeenCalledTimes(1);

    frameReady = false;
    const pending = request<{ error: { message: string }; sessionId: string }>(ws, {
      id: 276,
      method: 'Input.insertText',
      params: { text: 'NEVER_SENT' },
      sessionId,
    });
    await vi.waitFor(() => expect(alpha.focus).toHaveBeenCalledTimes(2));
    alpha.destroy();
    expect(await pending).toMatchObject({
      sessionId,
      error: { message: expect.stringContaining('No input was sent') },
    });
    expect(alpha.debugger.sendCommand).toHaveBeenCalledTimes(1);
  });

  it('preserves the outer page session on intercepted replies and errors', async () => {
    const alpha = createContents(280);
    const bridge = await startCdpBridge({ sendTabCommand: () => undefined });
    openBridges.push(bridge);
    bridge.registerTab({ tabId: 'alpha', webContentsId: alpha.id, active: true });
    const ws = await connect(bridge);
    openSockets.push(ws);
    const sessionId = sessionIdForTarget('alpha');

    const activated = await request(ws, { id: 280, method: 'Page.bringToFront', sessionId });
    expect(activated).toEqual({ id: 280, result: {}, sessionId });
    const rejected = await request<{ sessionId: string; error: { message: string } }>(ws, {
      id: 281,
      method: 'Browser.close',
      sessionId,
    });
    expect(rejected.sessionId).toBe(sessionId);
    expect(rejected.error.message).toContain('not permitted');

    alpha.debugger.sendCommand.mockRejectedValueOnce(new Error('Fixture command failed'));
    const forwardedError = await request<{ sessionId: string; error: { message: string } }>(ws, {
      id: 282,
      method: 'Page.getFrameTree',
      sessionId,
    });
    expect(forwardedError.sessionId).toBe(sessionId);
    expect(forwardedError.error.message).toBe('Fixture command failed');

    alpha.destroy();
    const stale = await request<{ sessionId: string; error: { message: string } }>(ws, {
      id: 283,
      method: 'Page.bringToFront',
      sessionId,
    });
    expect(stale.sessionId).toBe(sessionId);
    expect(stale.error.message).toContain('stale sessionId');
  });

  it('rejects a closed guest immediately while awaiting renderer focus without sending input', async () => {
    const commands: BrowserTabCommand[] = [];
    const bridge = await startRawCdpBridge({ sendTabCommand: (command) => commands.push(command) });
    bridge.updateTabInventory({ ready: true, tabIds: [] });
    openBridges.push(bridge);
    const alpha = createContents(290);
    bridge.registerTab({ tabId: 'alpha', webContentsId: alpha.id, active: true });
    const ws = await connect(bridge);
    openSockets.push(ws);
    const input = request<{ error: { message: string } }>(ws, {
      id: 289,
      method: 'Input.insertText',
      params: { text: 'A' },
      sessionId: sessionIdForTarget('alpha'),
    });
    await vi.waitFor(() => expect(commands.at(-1)?.action).toBe('focus'));
    alpha.destroy();
    expect((await input).error.message).toContain('closed or reloaded before receiving input focus');
    expect(alpha.debugger.sendCommand).not.toHaveBeenCalled();
  });

  it('requires matching renderer acknowledgement and native guest focus before activation completes', async () => {
    const commands: BrowserTabCommand[] = [];
    const bridge = await startRawCdpBridge({ sendTabCommand: (command) => commands.push(command) });
    bridge.updateTabInventory({ ready: true, tabIds: [] });
    openBridges.push(bridge);
    const alpha = createContents(291);
    bridge.registerTab({ tabId: 'alpha', webContentsId: alpha.id, active: true });
    const ws = await connect(bridge);
    openSockets.push(ws);
    let complete = false;
    const activation = request(ws, { id: 290, method: 'Target.activateTarget', params: { targetId: 'alpha' } }).then(
      () => {
        complete = true;
      }
    );
    await vi.waitFor(() => expect(commands.at(-1)?.action).toBe('focus'));
    const focus = commands.at(-1)!;
    if (focus.action !== 'focus') throw new Error('Expected focus command');
    alpha.focus();
    bridge.registerTab({ tabId: 'alpha', webContentsId: alpha.id, active: true, focusRequestId: 'stale' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(complete).toBe(false);
    bridge.registerTab({ tabId: 'alpha', webContentsId: alpha.id, active: true, focusRequestId: focus.requestId });
    await activation;
    expect(complete).toBe(true);
  });

  it('waits for asynchronous native focus after the renderer acknowledges its request', async () => {
    const commands: BrowserTabCommand[] = [];
    const bridge = await startRawCdpBridge({ sendTabCommand: (command) => commands.push(command) });
    bridge.updateTabInventory({ ready: true, tabIds: [] });
    openBridges.push(bridge);
    const alpha = createContents(292);
    bridge.registerTab({ tabId: 'alpha', webContentsId: alpha.id, active: true });
    const ws = await connect(bridge);
    openSockets.push(ws);
    const input = request(ws, {
      id: 291,
      method: 'Input.insertText',
      params: { text: 'A' },
      sessionId: sessionIdForTarget('alpha'),
    });
    await vi.waitFor(() => expect(commands.at(-1)?.action).toBe('focus'));
    const focus = commands.at(-1)!;
    if (focus.action !== 'focus') throw new Error('Expected focus command');
    bridge.registerTab({ tabId: 'alpha', webContentsId: alpha.id, active: true, focusRequestId: focus.requestId });
    expect(alpha.debugger.sendCommand).not.toHaveBeenCalled();
    alpha.focus();
    alpha.emit('focus');
    await input;
    expect(alpha.debugger.sendCommand).toHaveBeenCalledExactlyOnceWith('Input.insertText', { text: 'A' });
  });

  it('keeps typed characters in the exact guest even when the host composer regains focus', async () => {
    const bridge = await startCdpBridge({ sendTabCommand: vi.fn() });
    openBridges.push(bridge);
    const alpha = createContents(301, 'https://same.example/', 'Alpha');
    const beta = createContents(302, 'https://same.example/', 'Beta');
    const host = createContents(303, 'app://host', 'Host composer');
    bridge.registerTab({ tabId: 'alpha', webContentsId: alpha.id, active: true });
    bridge.registerTab({ tabId: 'beta', webContentsId: beta.id, active: false });
    // Real Electron may report this guest focused even while the host composer
    // owns the focused frame. The global getter must not authorize input.
    electronMock.reportedFocusedId = alpha.id;
    const values = new Map<number, string>([
      [alpha.id, ''],
      [beta.id, 'BETA_ORIGINAL'],
      [host.id, ''],
    ]);
    alpha.debugger.sendCommand.mockImplementation(async (method, params) => {
      // Model Electron's observed focus-based input routing, rather than
      // assuming a debugger attachment alone determines the keyboard target.
      const focusedId = electronMock.focusedId!;
      values.set(focusedId, `${values.get(focusedId)}${String(params.text)}`);
      return { method, params };
    });
    const ws = await connect(bridge);
    openSockets.push(ws);
    for (const [index, text] of ['A', 'B'].entries()) {
      host.focus();
      await request(ws, {
        id: 300 + index,
        method: index === 0 ? 'Input.dispatchKeyEvent' : 'Input.insertText',
        params: { type: 'char', text },
        sessionId: sessionIdForTarget('alpha'),
      });
    }
    expect(Object.fromEntries(values)).toEqual({ 301: 'AB', 302: 'BETA_ORIGINAL', 303: '' });
    expect(alpha.focus).toHaveBeenCalledTimes(2);
    expect(beta.debugger.sendCommand).not.toHaveBeenCalled();
  });

  it('uses the actual focused frame when the global getter reports a hidden sibling guest', async () => {
    const bridge = await startCdpBridge({ sendTabCommand: vi.fn() });
    openBridges.push(bridge);
    const alpha = createContents(304);
    const beta = createContents(305);
    bridge.registerTab({ tabId: 'alpha', webContentsId: alpha.id, active: true });
    bridge.registerTab({ tabId: 'beta', webContentsId: beta.id, active: false });
    alpha.focus();
    electronMock.reportedFocusedId = beta.id;
    const ws = await connect(bridge);
    openSockets.push(ws);
    await request(ws, {
      id: 304,
      method: 'Input.insertText',
      params: { text: 'A' },
      sessionId: sessionIdForTarget('alpha'),
    });
    expect(alpha.debugger.sendCommand).toHaveBeenCalledExactlyOnceWith('Input.insertText', { text: 'A' });
    expect(beta.debugger.sendCommand).not.toHaveBeenCalled();
  });

  it('routes input to the exact native guest frame without activating a non-key host', async () => {
    const bridge = await startCdpBridge({ sendTabCommand: vi.fn() });
    openBridges.push(bridge);
    const alpha = createContents(306);
    bridge.registerTab({ tabId: 'alpha', webContentsId: alpha.id, active: true });
    electronMock.windowFocused = false;
    const ws = await connect(bridge);
    openSockets.push(ws);
    await request(ws, {
      id: 306,
      method: 'Input.insertText',
      params: { text: 'A' },
      sessionId: sessionIdForTarget('alpha'),
    });
    expect(electronMock.host.focus).not.toHaveBeenCalled();
    expect(electronMock.windowFocused).toBe(false);
    expect(alpha.focus.mock.invocationCallOrder[0]).toBeLessThan(
      alpha.debugger.sendCommand.mock.invocationCallOrder[0]
    );
    expect(alpha.debugger.sendCommand).toHaveBeenCalledExactlyOnceWith('Input.insertText', { text: 'A' });
  });

  it('fails closed on a detached focused frame and clears the pending focus request for recovery', async () => {
    let rejectFocus = true;
    const bridge = await startRawCdpBridge({
      sendTabCommand: (command) => {
        if (command.action !== 'focus') return;
        bridge.registerTab({ tabId: 'alpha', webContentsId: 307, active: true, focusRequestId: command.requestId });
        if (rejectFocus) bridge.rejectTabCommand('alpha', 'Focused frame detached');
      },
    });
    bridge.updateTabInventory({ ready: true, tabIds: [] });
    openBridges.push(bridge);
    const alpha = createContents(307);
    bridge.registerTab({ tabId: 'alpha', webContentsId: alpha.id, active: true });
    alpha.focus();
    electronMock.frameLookupThrows = true;
    const ws = await connect(bridge);
    openSockets.push(ws);
    const result = await request<{ error: { message: string } }>(ws, {
      id: 307,
      method: 'Input.insertText',
      params: { text: 'A' },
      sessionId: sessionIdForTarget('alpha'),
    });
    expect(result.error.message).toContain('renderer_ack=true, exact_frame_focus=false');
    expect(alpha.debugger.sendCommand).not.toHaveBeenCalled();
    rejectFocus = false;
    electronMock.frameLookupThrows = false;
    await request(ws, {
      id: 308,
      method: 'Input.insertText',
      params: { text: 'A' },
      sessionId: sessionIdForTarget('alpha'),
    });
    expect(alpha.debugger.sendCommand).toHaveBeenCalledExactlyOnceWith('Input.insertText', { text: 'A' });
  });

  it.each([true, false])('refuses input when the exact frame cannot acquire focus (host key: %s)', async (hostKey) => {
    const bridge = await startCdpBridge({ sendTabCommand: vi.fn() });
    openBridges.push(bridge);
    const alpha = createContents(311);
    const host = createContents(312);
    alpha.focus.mockImplementation(() => undefined);
    host.focus();
    electronMock.windowFocused = hostKey;
    bridge.registerTab({ tabId: 'alpha', webContentsId: alpha.id, active: true });
    const ws = await connect(bridge);
    openSockets.push(ws);
    const rejected = await request<{ error: { message: string } }>(ws, {
      id: 310,
      method: 'Input.insertText',
      params: { text: 'MUST_NOT_REACH_COMPOSER' },
      sessionId: sessionIdForTarget('alpha'),
    });
    expect(rejected.error.message).toContain('No input was sent');
    expect(alpha.debugger.sendCommand).not.toHaveBeenCalled();
    expect(host.debugger.sendCommand).not.toHaveBeenCalled();
  });

  it('refuses input to a background target while observations stay independent of focus', async () => {
    const bridge = await startCdpBridge({ sendTabCommand: vi.fn() });
    openBridges.push(bridge);
    const alpha = createContents(321);
    const beta = createContents(322);
    bridge.registerTab({ tabId: 'alpha', webContentsId: alpha.id, active: false });
    bridge.registerTab({ tabId: 'beta', webContentsId: beta.id, active: true });
    beta.focus();
    const ws = await connect(bridge);
    openSockets.push(ws);
    await request(ws, { id: 320, method: 'Accessibility.getFullAXTree', sessionId: sessionIdForTarget('alpha') });
    const rejected = await request<{ error: { message: string } }>(ws, {
      id: 321,
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mousePressed', x: 10, y: 10 },
      sessionId: sessionIdForTarget('alpha'),
    });
    expect(rejected.error.message).toContain('no longer the visible input target');
    expect(alpha.focus).not.toHaveBeenCalled();
    expect(alpha.debugger.sendCommand.mock.calls).toEqual([['Accessibility.getFullAXTree', {}]]);
  });

  it('keeps a concurrent activation behind the focused input dispatch', async () => {
    const events: string[] = [];
    const alpha = createContents(331);
    const beta = createContents(332);
    let releaseInput!: () => void;
    const inputPending = new Promise<void>((resolve) => {
      releaseInput = resolve;
    });
    alpha.debugger.sendCommand.mockImplementation(async (method, params) => {
      events.push(`input:${electronMock.focusedId}`);
      await inputPending;
      events.push('input-complete');
      return { method, params };
    });
    const bridge = await startCdpBridge({
      sendTabCommand: (command) => {
        events.push(`activate:${command.tabId}`);
        bridge.registerTab({ tabId: 'beta', webContentsId: beta.id, active: true });
      },
    });
    openBridges.push(bridge);
    bridge.registerTab({ tabId: 'alpha', webContentsId: alpha.id, active: true });
    bridge.registerTab({ tabId: 'beta', webContentsId: beta.id, active: false });
    const ws = await connect(bridge);
    openSockets.push(ws);
    const typing = request(ws, {
      id: 330,
      method: 'Input.insertText',
      params: { text: 'A' },
      sessionId: sessionIdForTarget('alpha'),
    });
    await vi.waitFor(() => expect(events).toEqual(['input:331']));
    const switching = request(ws, { id: 331, method: 'Target.activateTarget', params: { targetId: 'beta' } });
    releaseInput();
    await Promise.all([typing, switching]);
    expect(events).toEqual(['input:331', 'input-complete', 'activate:beta']);
  });

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
    await vi.waitFor(() =>
      expect(commands).toEqual([
        { action: 'close', tabId: 'browser-close-race', profileId: 'profile-a', generation: 1 },
      ])
    );

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
    expect(commands[0]).toEqual({
      action: 'create',
      tabId: targetId,
      url: 'https://github.com/login',
      activate: true,
      profileId: 'profile-a',
      generation: 1,
    });

    await request(ws, { id: 5, method: 'Target.activateTarget', params: { targetId } });
    expect(commands[1]).toEqual({ action: 'activate', tabId: targetId, profileId: 'profile-a', generation: 1 });

    const closed = await request<{ result: { success: boolean } }>(ws, {
      id: 6,
      method: 'Target.closeTarget',
      params: { targetId },
    });
    expect(closed.result.success).toBe(true);
    expect(commands[2]).toEqual({ action: 'close', tabId: targetId, profileId: 'profile-a', generation: 1 });

    const stale = await request<{ error: { message: string } }>(ws, {
      id: 7,
      method: 'Runtime.evaluate',
      params: { expression: '1' },
      sessionId: sessionIdForTarget(targetId),
    });
    expect(stale.error.message).toContain('stale sessionId');
  });

  it('acknowledges background tab activation only after the renderer reports that exact tab visible', async () => {
    const sendTabCommand = vi.fn();
    const bridge = await startCdpBridge({ sendTabCommand });
    openBridges.push(bridge);
    const first = createContents(201, 'https://same.example/', 'First');
    const second = createContents(202, 'https://same.example/', 'Second');
    bridge.registerTab({ tabId: 'browser-first', webContentsId: first.id, active: true });
    bridge.registerTab({ tabId: 'browser-second', webContentsId: second.id, active: false });
    const controller = new CdpBrowserTabController(`http://127.0.0.1:${bridge.port}/scope/scoped-token`);
    let acknowledged = false;
    try {
      const activation = controller.activate('browser-second').then(() => {
        acknowledged = true;
      });
      await vi.waitFor(() =>
        expect(sendTabCommand).toHaveBeenCalledExactlyOnceWith({
          action: 'activate',
          tabId: 'browser-second',
          profileId: 'profile-a',
          generation: 1,
        })
      );
      expect(acknowledged).toBe(false);
      bridge.registerTab({ tabId: 'browser-second', webContentsId: second.id, active: true });
      await activation;
      expect(acknowledged).toBe(true);
    } finally {
      await controller.disconnect();
    }
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

  it('bootstraps each Runtime session from current contexts without resetting other subscribers', async () => {
    const bridge = await startCdpBridge({ sendTabCommand: vi.fn() });
    openBridges.push(bridge);
    const contents = createContents(550, 'https://owned.example/', 'Owned');
    let physicalEnabled = false;
    const context = (id: number) => ({
      id,
      origin: 'https://owned.example',
      name: '',
      auxData: { isDefault: true, frameId: 'frame-owned' },
    });
    contents.debugger.sendCommand.mockImplementation(async (method, params) => {
      if (method === 'Runtime.enable' && !physicalEnabled) {
        physicalEnabled = true;
        contents.debugger.emit('message', {}, 'Runtime.executionContextCreated', { context: context(1) }, '');
        contents.debugger.emit('message', {}, 'Runtime.consoleAPICalled', { type: 'log', args: [] }, '');
        contents.debugger.emit('message', {}, 'Runtime.exceptionThrown', { exceptionDetails: { text: 'owned' } }, '');
      }
      return { method, params };
    });
    bridge.registerTab({ tabId: 'browser-runtime', webContentsId: contents.id, active: true });
    const auto = await connect(bridge);
    const manual = await connect(bridge);
    openSockets.push(auto, manual);
    const autoEvents: Array<{
      method?: string;
      params?: { context?: { id: number } };
      sessionId?: string;
      id?: number;
    }> = [];
    const manualEvents: typeof autoEvents = [];
    auto.on('message', (raw) => autoEvents.push(JSON.parse(raw.toString())));
    manual.on('message', (raw) => manualEvents.push(JSON.parse(raw.toString())));
    await request(auto, { id: 100, method: 'Target.setAutoAttach', params: { autoAttach: true, flatten: true } });
    const autoId = sessionIdForTarget('browser-runtime');
    await request(auto, { id: 101, method: 'Runtime.enable', sessionId: autoId });
    expect(
      autoEvents.filter((e) => e.method === 'Runtime.executionContextCreated').map((e) => e.params?.context?.id)
    ).toEqual([1]);
    expect(autoEvents.some((e) => e.method === 'Runtime.consoleAPICalled')).toBe(true);
    expect(autoEvents.some((e) => e.method === 'Runtime.exceptionThrown')).toBe(true);
    expect(manualEvents.filter((e) => e.method?.startsWith('Runtime.'))).toEqual([]);
    const attached = await request<{ result: { sessionId: string } }>(manual, {
      id: 102,
      method: 'Target.attachToTarget',
      params: { targetId: 'browser-runtime', flatten: true },
    });
    const manualId = attached.result.sessionId;
    await request(manual, { id: 103, method: 'Runtime.enable', sessionId: manualId });
    const bootstrapIndex = manualEvents.findIndex((e) => e.method === 'Runtime.executionContextCreated');
    expect(bootstrapIndex).toBeGreaterThanOrEqual(0);
    expect(bootstrapIndex).toBeLessThan(manualEvents.findIndex((e) => e.id === 103));
    expect(manualEvents[bootstrapIndex].sessionId).toBe(manualId);
    expect(autoEvents.filter((e) => e.method === 'Runtime.executionContextCreated')).toHaveLength(1);
    await request(manual, { id: 104, method: 'Runtime.enable', sessionId: manualId });
    expect(manualEvents.filter((e) => e.method === 'Runtime.executionContextCreated')).toHaveLength(1);
    await request(manual, { id: 105, method: 'Runtime.disable', sessionId: manualId });
    expect(contents.debugger.sendCommand.mock.calls.some(([method]) => method === 'Runtime.disable')).toBe(false);
    contents.debugger.emit('message', {}, 'Runtime.executionContextDestroyed', { executionContextId: 1 }, '');
    contents.debugger.emit('message', {}, 'Runtime.executionContextCreated', { context: context(2) }, '');
    await vi.waitFor(() =>
      expect(autoEvents.filter((e) => e.method === 'Runtime.executionContextCreated')).toHaveLength(2)
    );
    expect(manualEvents.filter((e) => e.method === 'Runtime.executionContextCreated')).toHaveLength(1);
    await request(manual, { id: 106, method: 'Runtime.enable', sessionId: manualId });
    expect(
      manualEvents.filter((e) => e.method === 'Runtime.executionContextCreated').map((e) => e.params?.context?.id)
    ).toEqual([1, 2]);
    contents.debugger.emit('message', {}, 'Runtime.executionContextsCleared', {}, '');
    contents.debugger.emit('message', {}, 'Runtime.executionContextCreated', { context: context(3) }, '');
    const reconnect = await connect(bridge);
    openSockets.push(reconnect);
    const reconnectEvents: typeof autoEvents = [];
    reconnect.on('message', (raw) => reconnectEvents.push(JSON.parse(raw.toString())));
    await request(reconnect, { id: 107, method: 'Runtime.enable', sessionId: autoId });
    expect(
      reconnectEvents.filter((e) => e.method === 'Runtime.executionContextCreated').map((e) => e.params?.context?.id)
    ).toEqual([3]);
  });

  it('discards queued Runtime bootstrap events after manual detachment', async () => {
    const bridge = await startCdpBridge({ sendTabCommand: vi.fn() });
    openBridges.push(bridge);
    const contents = createContents(551);
    bridge.registerTab({ tabId: 'browser-detach-runtime', webContentsId: contents.id, active: true });
    const ws = await connect(bridge);
    openSockets.push(ws);
    const attached = await request<{ result: { sessionId: string } }>(ws, {
      id: 120,
      method: 'Target.attachToTarget',
      params: { targetId: 'browser-detach-runtime', flatten: true },
    });
    const sessionId = attached.result.sessionId;
    const messages: Array<{ method?: string; id?: number }> = [];
    ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    let release!: () => void;
    let blocked = false;
    contents.debugger.sendCommand.mockImplementation(async (method, params) => {
      if (method === 'Runtime.enable') {
        electronMock.validationHook = () => {
          electronMock.validationHook = undefined;
          blocked = true;
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        };
        contents.debugger.emit('message', {}, 'Runtime.executionContextCreated', { context: { id: 1 } }, '');
      }
      return { method, params };
    });
    const enabling = request(ws, { id: 121, method: 'Runtime.enable', sessionId });
    await vi.waitFor(() => expect(blocked).toBe(true));
    await request(ws, { id: 122, method: 'Target.detachFromTarget', params: { sessionId } });
    release();
    await enabling;
    expect(messages.some((m) => m.method === 'Runtime.executionContextCreated')).toBe(false);
    expect(messages.some((m) => m.method === 'Target.detachedFromTarget')).toBe(true);
  });

  it('does not revive pre-disable events when the same Runtime session is enabled again', async () => {
    const bridge = await startCdpBridge({ sendTabCommand: vi.fn() });
    openBridges.push(bridge);
    const contents = createContents(553);
    bridge.registerTab({ tabId: 'browser-runtime-epoch', webContentsId: contents.id, active: true });
    const ws = await connect(bridge);
    openSockets.push(ws);
    const sessionId = sessionIdForTarget('browser-runtime-epoch');
    await request(ws, { id: 124, method: 'Runtime.enable', sessionId });
    const contexts: number[] = [];
    ws.on('message', (raw) => {
      const e = JSON.parse(raw.toString());
      if (e.method === 'Runtime.executionContextCreated') contexts.push(e.params.context.id);
    });
    let release!: () => void;
    let blocked = false;
    electronMock.validationHook = () => {
      electronMock.validationHook = undefined;
      blocked = true;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    contents.debugger.emit('message', {}, 'Runtime.executionContextCreated', { context: { id: 7 } }, '');
    await vi.waitFor(() => expect(blocked).toBe(true));
    await request(ws, { id: 125, method: 'Runtime.disable', sessionId });
    const enabling = request(ws, { id: 126, method: 'Runtime.enable', sessionId });
    await vi.waitFor(() =>
      expect(contents.debugger.sendCommand.mock.calls.filter(([method]) => method === 'Runtime.enable')).toHaveLength(2)
    );
    release();
    await enabling;
    expect(contexts).toEqual([7]);
  });

  it('acknowledges Runtime bootstrap while a continuous console stream remains active', async () => {
    const bridge = await startCdpBridge({ sendTabCommand: vi.fn() });
    openBridges.push(bridge);
    const contents = createContents(552);
    bridge.registerTab({ tabId: 'browser-noisy-runtime', webContentsId: contents.id, active: true });
    const ws = await connect(bridge);
    openSockets.push(ws);
    electronMock.validationHook = () => new Promise((resolve) => setTimeout(resolve, 2));
    let timer: ReturnType<typeof setInterval> | undefined;
    contents.debugger.sendCommand.mockImplementation(async (method, params) => {
      if (method === 'Runtime.enable') {
        contents.debugger.emit('message', {}, 'Runtime.executionContextCreated', { context: { id: 1 } }, '');
        timer = setInterval(
          () => contents.debugger.emit('message', {}, 'Runtime.consoleAPICalled', { type: 'log', args: [] }, ''),
          1
        );
      }
      return { method, params };
    });
    try {
      await Promise.race([
        request(ws, { id: 123, method: 'Runtime.enable', sessionId: sessionIdForTarget('browser-noisy-runtime') }),
        new Promise((_, reject) => setTimeout(() => reject(Error('No finite bootstrap barrier')), 500)),
      ]);
      expect(timer).toBeDefined();
    } finally {
      clearInterval(timer);
      electronMock.validationHook = undefined;
    }
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
    const controller = new CdpBrowserTabController(`http://127.0.0.1:${bridge.port}/scope/scoped-token`);

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
    const output = mkdtempSync(path.join(tmpdir(), 'ellmsha-browser-mcp-test-'));
    execFileSync(process.execPath, ['scripts/build-mcp-servers.js'], {
      cwd: root,
      stdio: 'pipe',
      env: { ...process.env, ELLM_SHA_MCP_OUTPUT_DIR: output },
    });

    const client = new Client({ name: 'browser-stdio-regression', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(output, 'builtin-mcp-browser.js')],
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => !!entry[1])),
        AIONUI_CDP_ACTIVE_PORT: String(bridge.port),
        AIONUI_BROWSER_SCOPE_TOKEN: 'scoped-token',
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
      expect(stderr).not.toContain('scoped-token');
      rmSync(output, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('CDP profile security boundaries', () => {
  it('authenticates HTTP discovery and never returns a credential from the old public endpoint', async () => {
    const bridge = await startCdpBridge({ sendTabCommand: vi.fn() });
    openBridges.push(bridge);
    const publicResponse = await fetch(`http://127.0.0.1:${bridge.port}/json/version`);
    expect(publicResponse.status).toBe(403);
    expect(await publicResponse.text()).not.toContain('scoped-token');
    const scoped = await fetch(`http://127.0.0.1:${bridge.port}/scope/scoped-token/json/version`);
    expect(scoped.status).toBe(200);
  });
  it('filters discovery, rejects foreign sessions and browser-wide escapes, and revokes old sockets', async () => {
    const alpha = createContents(550);
    const beta = createContents(551);
    electronMock.popups.set('alpha', { contents: alpha, active: true, profileId: 'profile-a' });
    electronMock.popups.set('beta', { contents: beta, active: false, profileId: 'profile-b' });
    const bridge = await startCdpBridge({ sendTabCommand: vi.fn() });
    openBridges.push(bridge);
    bridge.registerTab({ tabId: 'alpha', webContentsId: alpha.id, active: true });
    bridge.registerTab({ tabId: 'beta', webContentsId: beta.id, active: false });
    const ws = await connect(bridge);
    openSockets.push(ws);
    const list = await request<{ result: { targetInfos: Array<{ targetId: string }> } }>(ws, {
      id: 1,
      method: 'Target.getTargets',
    });
    expect(list.result.targetInfos.map((target) => target.targetId)).toEqual(['alpha']);
    for (const [index, command] of [
      { method: 'Runtime.evaluate', sessionId: sessionIdForTarget('beta'), params: { expression: 'document.cookie' } },
      { method: 'Target.sendMessageToTarget', params: { targetId: 'beta', message: '{}' } },
      { method: 'Storage.getCookies', params: { browserContextId: 'profile-b' } },
    ].entries()) {
      expect(await request(ws, { id: index + 2, ...command })).toHaveProperty('error');
    }
    expect(beta.debugger.sendCommand).not.toHaveBeenCalled();
    electronMock.activeProfile = 'profile-b';
    expect(await request(ws, { id: 8, method: 'Target.getTargets' })).toHaveProperty('error');
    electronMock.activeProfile = 'profile-a';
    electronMock.revoked = true;
    expect(await request(ws, { id: 9, method: 'Target.getTargets' })).toHaveProperty('error');
  });
});
