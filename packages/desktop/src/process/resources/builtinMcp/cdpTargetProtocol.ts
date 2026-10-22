/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure Target-domain protocol for the in-app browser bridge.
 *
 * Chromium's remote-debugging-port exposes every Electron target, including the
 * application window and its preload bridge. This protocol instead presents only
 * renderer-registered browser tabs. Each tab keeps its preview-tab id as its CDP
 * target id and receives a deterministic session id, so page commands stay bound
 * to the selected tab even if the user changes the visible tab concurrently.
 */

export const BROWSER_CONTEXT_ID = 'aionui-browser-context';
const SESSION_PREFIX = 'aionui-browser-session:';

export type TargetInfo = {
  targetId: string;
  type: 'page';
  title: string;
  url: string;
  attached: boolean;
  canAccessOpener: boolean;
  browserContextId: string;
  /** App extension consumed by the stable-id MCP tools; Chromium clients ignore it. */
  aionuiActive: boolean;
};

export type CdpRequest = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
};

export type CdpEvent = { method: string; params: Record<string, unknown>; sessionId?: string };

export type CdpDecision =
  | { kind: 'reply'; payload: Record<string, unknown> }
  | { kind: 'reply-and-emit'; payload: Record<string, unknown>; emit: CdpEvent[] }
  | { kind: 'forward'; targetId?: string }
  | { kind: 'attach-target'; targetId: string }
  | { kind: 'detach-session'; sessionId: string }
  | { kind: 'create-target'; url: string; background: boolean }
  | { kind: 'activate-target'; targetId: string }
  | { kind: 'close-target'; targetId: string }
  | { kind: 'error'; message: string };

export const buildTargetInfo = (
  targetId: string,
  title: string,
  url: string,
  active = false,
  browserContextId = BROWSER_CONTEXT_ID
): TargetInfo => ({
  targetId,
  type: 'page',
  title,
  url: url || 'about:blank',
  attached: true,
  canAccessOpener: false,
  browserContextId,
  aionuiActive: active,
});

export const sessionIdForTarget = (targetId: string): string => `${SESSION_PREFIX}${targetId}`;

export const targetIdFromSession = (
  sessionId: string | undefined,
  targets: TargetInfo[],
  manualSessions?: ReadonlyMap<string, string>
): string | undefined => {
  const manualTarget = sessionId ? manualSessions?.get(sessionId) : undefined;
  if (manualTarget && targets.some((target) => target.targetId === manualTarget)) return manualTarget;
  if (!sessionId?.startsWith(SESSION_PREFIX)) return undefined;
  const targetId = sessionId.slice(SESSION_PREFIX.length);
  return targets.some((target) => target.targetId === targetId) ? targetId : undefined;
};

export const targetCreatedEvent = (targetInfo: TargetInfo): CdpEvent => ({
  method: 'Target.targetCreated',
  params: { targetInfo },
});

export const attachedToTargetEvent = (
  targetInfo: TargetInfo,
  sessionId = sessionIdForTarget(targetInfo.targetId)
): CdpEvent => ({
  method: 'Target.attachedToTarget',
  params: {
    sessionId,
    targetInfo,
    waitingForDebugger: false,
  },
});

export const buildVersionPayload = (wsUrl: string, chromeVersion: string) => ({
  Browser: `Chrome/${chromeVersion}`,
  'Protocol-Version': '1.3',
  'User-Agent': `AionUi in-app browser (Chrome/${chromeVersion})`,
  'V8-Version': process.versions.v8 ?? '',
  'WebKit-Version': '',
  webSocketDebuggerUrl: wsUrl,
});

export const buildListPayload = (wsUrl: string, targets: TargetInfo[]) =>
  targets.map((target) => ({
    description: '',
    devtoolsFrontendUrl: '',
    id: target.targetId,
    title: target.title,
    type: target.type,
    url: target.url,
    webSocketDebuggerUrl: wsUrl,
  }));

const targetForRequest = (
  req: CdpRequest,
  targets: TargetInfo[],
  manualSessions?: ReadonlyMap<string, string>
): TargetInfo | undefined => {
  const requested = req.params?.targetId;
  if (typeof requested === 'string') return targets.find((target) => target.targetId === requested);
  const fromSession = targetIdFromSession(req.sessionId, targets, manualSessions);
  return fromSession ? targets.find((target) => target.targetId === fromSession) : undefined;
};

const requireTarget = (
  req: CdpRequest,
  targets: TargetInfo[],
  manualSessions?: ReadonlyMap<string, string>
): TargetInfo | CdpDecision => {
  const target = targetForRequest(req, targets, manualSessions);
  if (target) return target;
  const requested = typeof req.params?.targetId === 'string' ? req.params.targetId : req.sessionId;
  return { kind: 'error', message: `No such in-app browser tab: ${requested ?? '(missing target id)'}` };
};

export const decideCdpCommand = (
  req: CdpRequest,
  getTargetInfos: () => TargetInfo[],
  manualSessions?: ReadonlyMap<string, string>,
  browserContextId = BROWSER_CONTEXT_ID
): CdpDecision => {
  const method = req.method ?? '';
  const targets = getTargetInfos();
  if (req.params?.browserContextId !== undefined && req.params.browserContextId !== browserContextId)
    return { kind: 'error', message: 'Foreign browser context is not permitted.' };

  switch (method) {
    case 'Target.setDiscoverTargets': {
      if (req.params?.discover !== true) return { kind: 'reply', payload: {} };
      return { kind: 'reply-and-emit', payload: {}, emit: targets.map(targetCreatedEvent) };
    }

    case 'Target.setAutoAttach': {
      // A session-scoped call asks for child targets of one page. None are exposed.
      if (req.sessionId) return { kind: 'reply', payload: {} };
      if (req.params?.autoAttach !== true) return { kind: 'reply', payload: {} };
      return { kind: 'reply-and-emit', payload: {}, emit: targets.map((target) => attachedToTargetEvent(target)) };
    }

    case 'Target.getTargets':
      return { kind: 'reply', payload: { targetInfos: targets } };

    case 'Target.getTargetInfo': {
      const target = requireTarget(req, targets, manualSessions);
      return 'kind' in target ? target : { kind: 'reply', payload: { targetInfo: target } };
    }

    case 'Target.getBrowserContexts':
      return { kind: 'reply', payload: { browserContextIds: [browserContextId] } };

    case 'Target.attachToTarget': {
      const target = requireTarget(req, targets, manualSessions);
      if ('kind' in target) return target;
      return { kind: 'attach-target', targetId: target.targetId };
    }

    case 'Target.detachFromTarget': {
      const requested = req.params?.sessionId;
      if (typeof requested !== 'string' || !manualSessions?.has(requested)) {
        return { kind: 'error', message: `No such attached session: ${String(requested ?? '(missing session id)')}` };
      }
      return { kind: 'detach-session', sessionId: requested };
    }

    case 'Target.createTarget': {
      const url = typeof req.params?.url === 'string' && req.params.url ? req.params.url : 'about:blank';
      return { kind: 'create-target', url, background: req.params?.background === true };
    }

    case 'Target.activateTarget':
    case 'Page.bringToFront': {
      const target = requireTarget(req, targets, manualSessions);
      return 'kind' in target ? target : { kind: 'activate-target', targetId: target.targetId };
    }

    case 'Target.closeTarget': {
      const target = requireTarget(req, targets, manualSessions);
      return 'kind' in target ? target : { kind: 'close-target', targetId: target.targetId };
    }

    case 'Target.createBrowserContext':
    case 'Target.disposeBrowserContext':
      return { kind: 'error', message: 'Browser profiles are managed by the application.' };

    case 'Browser.getVersion':
      return {
        kind: 'reply',
        payload: {
          protocolVersion: '1.3',
          product: `Chrome/${process.versions.chrome ?? '0'}`,
          revision: '',
          userAgent: 'eLLMsha scoped browser',
          jsVersion: process.versions.v8 ?? '',
        },
      };

    case 'Browser.getWindowForTarget': {
      const target = requireTarget(req, targets, manualSessions);
      return 'kind' in target ? target : { kind: 'reply', payload: { windowId: 1, bounds: { windowState: 'normal' } } };
    }

    case 'Browser.setDownloadBehavior':
      return req.params?.behavior === 'deny'
        ? { kind: 'reply', payload: {} }
        : { kind: 'error', message: 'Browser download policy is managed by the application.' };

    case 'Browser.close':
      return { kind: 'error', message: 'Browser.close is not permitted against the AionUi in-app browser.' };

    default:
      // Never forward browser-wide or nested Target control to Electron.
      if (
        /^(Target|Browser|Storage|SystemInfo|Tethering)\./.test(method) ||
        req.params?.targetId !== undefined ||
        req.params?.browserContextId !== undefined
      )
        return { kind: 'error', message: 'Browser-wide CDP command is not permitted.' };
      if (
        !/^(Page|Runtime|DOM|DOMSnapshot|CSS|Accessibility|Network|Input|Emulation|Log|Performance|Profiler|Debugger|HeapProfiler|IO|Fetch|Overlay|Security|Audits|WebAuthn)\./.test(
          method
        )
      )
        return { kind: 'error', message: 'Unsupported page CDP domain.' };
      // Page-level commands carry the stable session id. Browser-level commands
      // have no target and are routed by the bridge to its deterministic fallback.
      return { kind: 'forward', targetId: targetIdFromSession(req.sessionId, targets, manualSessions) };
  }
};

export const isAcceptableSessionId = (
  sessionId: string | undefined,
  targets: TargetInfo[],
  manualSessions?: ReadonlyMap<string, string>
): boolean =>
  sessionId === undefined || sessionId === '' || targetIdFromSession(sessionId, targets, manualSessions) !== undefined;

/** Constant-time compare so token prefixes do not leak. */
export const tokensMatch = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};
