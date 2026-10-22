/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  BROWSER_CONTEXT_ID,
  buildListPayload,
  buildTargetInfo,
  buildVersionPayload,
  decideCdpCommand,
  isAcceptableSessionId,
  sessionIdForTarget,
  tokensMatch,
} from '@process/resources/builtinMcp/cdpTargetProtocol';

const first = buildTargetInfo('browser-1', 'First', 'https://one.example/');
const second = buildTargetInfo('browser-2', 'Second', 'https://two.example/');
const targets = () => [first, second];

describe('cdpTargetProtocol — multi-tab discovery', () => {
  it('lists every authorized tab under its stable preview-tab id', () => {
    const list = buildListPayload('ws://127.0.0.1:1234/x', targets());
    expect(list.map((entry) => entry.id)).toEqual(['browser-1', 'browser-2']);
    expect(list.map((entry) => entry.url)).toEqual(['https://one.example/', 'https://two.example/']);
  });

  it('backfills creation and distinct attachment sessions for every existing tab', () => {
    const discovery = decideCdpCommand(
      { id: 1, method: 'Target.setDiscoverTargets', params: { discover: true } },
      targets
    );
    const attachment = decideCdpCommand(
      { id: 2, method: 'Target.setAutoAttach', params: { autoAttach: true, flatten: true } },
      targets
    );

    expect(discovery.kind).toBe('reply-and-emit');
    expect(attachment.kind).toBe('reply-and-emit');
    if (discovery.kind !== 'reply-and-emit' || attachment.kind !== 'reply-and-emit') return;
    expect(discovery.emit.map((event) => event.params.targetInfo)).toEqual(targets());
    expect(attachment.emit.map((event) => event.params.sessionId)).toEqual([
      sessionIdForTarget('browser-1'),
      sessionIdForTarget('browser-2'),
    ]);
  });

  it('reports no pages cleanly before the renderer has mounted a browser tab', () => {
    const decision = decideCdpCommand({ id: 3, method: 'Target.getTargets' }, () => []);
    expect(decision).toEqual({ kind: 'reply', payload: { targetInfos: [] } });
  });
});

describe('cdpTargetProtocol — stable routing', () => {
  it('routes a page command by session even when another tab is visible', () => {
    const decision = decideCdpCommand(
      {
        id: 4,
        method: 'Page.navigate',
        params: { url: 'https://next.example/' },
        sessionId: sessionIdForTarget('browser-1'),
      },
      targets
    );
    expect(decision).toEqual({ kind: 'forward', targetId: 'browser-1' });
  });

  it('attaches only to the requested stable tab id', () => {
    const decision = decideCdpCommand(
      { id: 5, method: 'Target.attachToTarget', params: { targetId: 'browser-2', flatten: true } },
      targets
    );
    expect(decision).toEqual({ kind: 'attach-target', targetId: 'browser-2' });
  });

  it('routes and detaches distinct manual sessions on the owning socket', () => {
    const manualSessions = new Map([
      ['manual-1', 'browser-1'],
      ['manual-2', 'browser-1'],
    ]);
    expect(
      decideCdpCommand(
        { id: 6, method: 'Page.navigate', sessionId: 'manual-2', params: { url: 'https://next.example/' } },
        targets,
        manualSessions
      )
    ).toEqual({ kind: 'forward', targetId: 'browser-1' });
    expect(
      decideCdpCommand(
        { id: 7, method: 'Target.detachFromTarget', params: { sessionId: 'manual-1' } },
        targets,
        manualSessions
      )
    ).toEqual({ kind: 'detach-session', sessionId: 'manual-1' });
  });

  it('rejects unknown targets and stale sessions', () => {
    expect(
      decideCdpCommand({ id: 8, method: 'Target.activateTarget', params: { targetId: 'closed-tab' } }, targets).kind
    ).toBe('error');
    expect(isAcceptableSessionId(sessionIdForTarget('closed-tab'), targets())).toBe(false);
  });

  it('keeps the same target and session ids after renderer target recreation', () => {
    const recreated = buildTargetInfo('browser-1', 'Recreated', 'https://restored.example/');
    expect(recreated.targetId).toBe(first.targetId);
    expect(sessionIdForTarget(recreated.targetId)).toBe(sessionIdForTarget(first.targetId));
  });
});

describe('cdpTargetProtocol — lifecycle operations', () => {
  it('maps create, activate, and close to explicit renderer lifecycle operations', () => {
    expect(
      decideCdpCommand(
        { id: 7, method: 'Target.createTarget', params: { url: 'https://github.com/login', background: false } },
        targets
      )
    ).toEqual({ kind: 'create-target', url: 'https://github.com/login', background: false });
    expect(
      decideCdpCommand({ id: 8, method: 'Target.activateTarget', params: { targetId: 'browser-2' } }, targets)
    ).toEqual({ kind: 'activate-target', targetId: 'browser-2' });
    expect(
      decideCdpCommand({ id: 9, method: 'Target.closeTarget', params: { targetId: 'browser-1' } }, targets)
    ).toEqual({ kind: 'close-target', targetId: 'browser-1' });
  });

  it('allows an explicit last-tab close while still protecting the application window', () => {
    const oneTarget = () => [first];
    expect(
      decideCdpCommand({ id: 10, method: 'Target.closeTarget', params: { targetId: 'browser-1' } }, oneTarget)
    ).toEqual({ kind: 'close-target', targetId: 'browser-1' });
    expect(decideCdpCommand({ id: 11, method: 'Browser.close' }, oneTarget).kind).toBe('error');
  });

  it('does not recurse auto-attach inside a page session', () => {
    const decision = decideCdpCommand(
      {
        id: 12,
        method: 'Target.setAutoAttach',
        params: { autoAttach: true, flatten: true },
        sessionId: sessionIdForTarget('browser-1'),
      },
      targets
    );
    expect(decision.kind).toBe('reply');
  });

  it('keeps one shared authenticated context and refuses additional contexts', () => {
    const contexts = decideCdpCommand({ id: 13, method: 'Target.getBrowserContexts' }, targets);
    expect(contexts).toEqual({ kind: 'reply', payload: { browserContextIds: [BROWSER_CONTEXT_ID] } });
    expect(decideCdpCommand({ id: 14, method: 'Target.createBrowserContext' }, targets).kind).toBe('error');
  });
});

describe('cdpTargetProtocol — discovery and token details', () => {
  it('exposes the websocket debugger URL expected by puppeteer', () => {
    const payload = buildVersionPayload('ws://127.0.0.1:1234/x', '120.0.0.0');
    expect(payload.webSocketDebuggerUrl).toBe('ws://127.0.0.1:1234/x');
    expect(payload.Browser).toContain('Chrome/');
  });

  it('compares bridge tokens without accepting prefixes', () => {
    expect(tokensMatch('abc123', 'abc123')).toBe(true);
    expect(tokensMatch('abc123', 'abc')).toBe(false);
    expect(tokensMatch('abc123', 'abc124')).toBe(false);
  });
});

describe('scoped CDP security', () => {
  it('rejects browser context overrides and nested target control', () => {
    for (const method of [
      'Target.sendMessageToTarget',
      'Target.exposeDevToolsProtocol',
      'Storage.getCookies',
      'Browser.grantPermissions',
    ]) {
      expect(decideCdpCommand({ method, params: {} }, targets).kind).toBe('error');
    }
    expect(
      decideCdpCommand(
        { method: 'Target.createTarget', params: { browserContextId: 'foreign' } },
        targets,
        undefined,
        'owned'
      ).kind
    ).toBe('error');
  });
  it('reports only the socket profile as browser context', () => {
    expect(decideCdpCommand({ method: 'Target.getBrowserContexts' }, targets, undefined, 'owned')).toEqual({
      kind: 'reply',
      payload: { browserContextIds: ['owned'] },
    });
  });
});
