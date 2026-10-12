/**
 * Stable-id browser tab tools layered beside chrome-devtools-mcp.
 *
 * chrome-devtools-mcp intentionally numbers Puppeteer Page objects. Those
 * numbers are useful for its page tools but cannot identify a renderer-owned
 * tab across webview recreation. These five tools expose the bridge's stable
 * preview tab IDs while the proxy keeps every upstream DevTools tool intact.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { WebSocket } from 'ws';

type JsonObject = Record<string, unknown>;

export type StableBrowserTab = {
  id: string;
  title: string;
  url: string;
  active: boolean;
};

export interface BrowserTabController {
  list(): Promise<StableBrowserTab[]>;
  open(url: string, activate: boolean): Promise<string>;
  activate(tabId: string): Promise<void>;
  navigate(tabId: string, url: string, activate: boolean): Promise<void>;
  close(tabId: string): Promise<void>;
}

const objectSchema = (properties: JsonObject, required: string[] = []) => ({
  type: 'object' as const,
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

export const STABLE_BROWSER_TOOLS = [
  {
    name: 'browser_tabs_list',
    description:
      'List authorized in-app browser tabs. Returns stable tab IDs that survive renderer webview recreation.',
    inputSchema: objectSchema({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'browser_tab_open',
    description: 'Open a new in-app browser tab at a URL and return its stable tab ID.',
    inputSchema: objectSchema(
      {
        url: { type: 'string', description: 'URL to open. Use about:blank for an empty tab.' },
        activate: { type: 'boolean', description: 'Show the tab immediately. Defaults to true.' },
      },
      ['url']
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'browser_tab_activate',
    description: 'Switch the visible in-app browser to the tab with this stable tab ID.',
    inputSchema: objectSchema({ tab_id: { type: 'string', description: 'Stable ID from browser_tabs_list.' } }, [
      'tab_id',
    ]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'browser_tab_navigate',
    description: 'Change the address of one exact in-app browser tab, identified by stable tab ID.',
    inputSchema: objectSchema(
      {
        tab_id: { type: 'string', description: 'Stable ID from browser_tabs_list.' },
        url: { type: 'string', description: 'Destination URL.' },
        activate: { type: 'boolean', description: 'Show the tab after navigation. Defaults to true.' },
      },
      ['tab_id', 'url']
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'browser_tab_close',
    description: 'Close one exact in-app browser tab by stable tab ID, including the final remaining tab.',
    inputSchema: objectSchema({ tab_id: { type: 'string', description: 'Stable ID from browser_tabs_list.' } }, [
      'tab_id',
    ]),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
] as const;

const INLINE_SNAPSHOT_TOOL = 'take_snapshot';
export const FILE_SNAPSHOT_TOOL = 'take_snapshot_to_file';

/**
 * Upstream marks take_snapshot as a write because its optional filePath can
 * save to disk. Keep the familiar name for the inline observation and expose
 * file output separately so approval policy can distinguish the two semantics.
 */
export const splitSnapshotTool = (tool: Tool): Tool[] => {
  if (tool.name !== INLINE_SNAPSHOT_TOOL) return [tool];

  const properties = { ...(tool.inputSchema.properties || {}) };
  delete properties.filePath;
  const inlineRequired = tool.inputSchema.required?.filter((name) => name !== 'filePath');
  const inlineTool: Tool = {
    ...tool,
    description: `${tool.description || 'Take a text snapshot of the selected page.'} Returns the snapshot inline.`,
    inputSchema: {
      ...tool.inputSchema,
      properties,
      ...(inlineRequired?.length ? { required: inlineRequired } : { required: undefined }),
    },
    annotations: { ...tool.annotations, readOnlyHint: true, destructiveHint: false },
  };
  const fileTool: Tool = {
    ...tool,
    name: FILE_SNAPSHOT_TOOL,
    description: 'Take a text snapshot of the selected page and save it to a file.',
    inputSchema: {
      ...tool.inputSchema,
      required: Array.from(new Set([...(tool.inputSchema.required || []), 'filePath'])),
    },
    annotations: { ...tool.annotations, readOnlyHint: false },
  };
  return [inlineTool, fileTool];
};

const stringArgument = (args: JsonObject | undefined, name: string): string => {
  const value = args?.[name];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} must be a non-empty string.`);
  return value;
};

const textResult = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
});

export const callStableBrowserTool = async (controller: BrowserTabController, name: string, args?: JsonObject) => {
  switch (name) {
    case 'browser_tabs_list':
      return textResult({ tabs: await controller.list() });
    case 'browser_tab_open': {
      const tabId = await controller.open(stringArgument(args, 'url'), args?.activate !== false);
      return textResult({ tab_id: tabId });
    }
    case 'browser_tab_activate':
      await controller.activate(stringArgument(args, 'tab_id'));
      return textResult({ activated: true, tab_id: args?.tab_id });
    case 'browser_tab_navigate':
      await controller.navigate(stringArgument(args, 'tab_id'), stringArgument(args, 'url'), args?.activate !== false);
      return textResult({ navigated: true, tab_id: args?.tab_id, url: args?.url });
    case 'browser_tab_close':
      await controller.close(stringArgument(args, 'tab_id'));
      return textResult({ closed: true, tab_id: args?.tab_id });
    default:
      throw new Error(`Unknown stable browser tool: ${name}`);
  }
};

const PAGE_LIFECYCLE_TOOLS = new Set(['list_pages', 'select_page', 'new_page', 'close_page']);
// Puppeteer input waits for visible, interactive elements; selecting a CDP target
// alone does not unhide its Electron webview. Observations can stay in the background.
const INPUT_TOOLS = new Set(['click', 'click_at', 'hover', 'fill', 'drag', 'fill_form', 'upload_file', 'press_key']);
const TOOL_TIMEOUT_MS = 60_000;

const addTargetSchema = (tool: Tool): Tool => {
  const properties = { ...(tool.inputSchema.properties || {}) };
  delete properties.targetId;
  if (!PAGE_LIFECYCLE_TOOLS.has(tool.name)) {
    properties.tab_id = {
      type: 'string',
      description:
        'Exact stable tab ID from browser_tabs_list. Omit to use the last selected tab. Use IDs from a snapshot of this same tab for element actions.',
    };
  }
  return { ...tool, inputSchema: { ...tool.inputSchema, properties } };
};

export const createBrowserMcpProxy = (upstream: Client, controller: BrowserTabController): Server => {
  let selectedTabId: string | undefined;
  let legacySelection = false;
  let targetSupport: Promise<boolean> | undefined;
  let uncertainOutcome = false;
  let tail: Promise<unknown> = Promise.resolve();
  const server = new Server(
    { name: 'aionui-browser', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'Use browser_tabs_list and browser_tab_* for stable tab lifecycle and exact navigation. ' +
        'Pass tab_id to DevTools observations/actions to operate on that exact tab atomically. ' +
        'Input actions show their exact target tab before interacting; observations can run in the background. ' +
        'After switching tabs take a fresh snapshot before using element IDs. ' +
        'Replies include the actual target ID and URL; never infer identity from a duplicate URL. ' +
        'Legacy select_page remains supported and changes the default target. ' +
        'A timed-out action may have completed: do not repeat mutations blindly.',
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const upstreamResult = await upstream.listTools(request.params);
    return {
      ...upstreamResult,
      tools: [
        ...upstreamResult.tools.flatMap(splitSnapshotTool).map(addTargetSchema),
        ...(request.params?.cursor ? [] : STABLE_BROWSER_TOOLS),
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
    // ponytail: one queue per MCP connection; keeps lifecycle/default selection ordered.
    // Explicit target + action is additionally atomic inside the upstream tool mutex.
    const result = tail.then(async () => {
      let commandStarted = false;
      try {
        if (extra.signal.aborted) throw new Error('Browser request was cancelled before execution.');
        const { name } = request.params;
        const args = request.params.arguments;
        if (uncertainOutcome && name !== 'browser_tabs_list') {
          throw new Error(
            'Previous browser command timed out; its outcome is unknown. Reconnect browser tools before further actions. Do not replay mutations without checking their outcome.'
          );
        }
        if (STABLE_BROWSER_TOOLS.some((tool) => tool.name === name)) {
          commandStarted = name !== 'browser_tabs_list';
          const response = await callStableBrowserTool(controller, name, args);
          if (name === 'browser_tab_activate' || (name === 'browser_tab_navigate' && args?.activate !== false)) {
            selectedTabId = stringArgument(args, 'tab_id');
            legacySelection = false;
          } else if (name === 'browser_tab_open' && args?.activate !== false) {
            selectedTabId = (JSON.parse(response.content[0].text) as { tab_id: string }).tab_id;
            legacySelection = false;
          }
          // Keep a closed selected ID pinned: the next action must fail, not hit another tab.
          return response;
        }
        if (name === INLINE_SNAPSHOT_TOOL && args?.filePath !== undefined) {
          throw new Error(`Use ${FILE_SNAPSHOT_TOOL} when a snapshot must be saved to disk.`);
        }
        const upstreamName = name === FILE_SNAPSHOT_TOOL ? INLINE_SNAPSHOT_TOOL : name;
        if (name === FILE_SNAPSHOT_TOOL) stringArgument(args, 'filePath');
        if (args?.targetId !== undefined) throw new Error('Use tab_id for stable in-app targeting.');
        const { tab_id: explicitTabId, ...upstreamArgs } = args || {};
        let targetId: string | undefined;
        if (!PAGE_LIFECYCLE_TOOLS.has(name)) {
          targetId = explicitTabId !== undefined ? stringArgument(args, 'tab_id') : selectedTabId;
          if (!targetId && !legacySelection) {
            targetId = (await controller.list()).find((tab) => tab.active)?.id;
            if (!targetId) throw new Error('No active in-app browser tab. Open or select a tab first.');
          }
          if (targetId) {
            if (!(await controller.list()).some((tab) => tab.id === targetId)) {
              throw new Error(`Browser tab ${targetId} is closed or unavailable. List tabs again.`);
            }
            targetSupport ??= upstream
              .listTools()
              .then((catalog) =>
                catalog.tools.some(
                  (tool) => tool.name === INLINE_SNAPSHOT_TOOL && tool.inputSchema.properties?.targetId
                )
              )
              .catch((error: unknown) => {
                targetSupport = undefined;
                throw error;
              });
            if (!(await targetSupport))
              throw new Error(
                'Browser runtime does not support exact targeting; update the bundled browser tools before acting.'
              );
          }
        } else if (explicitTabId !== undefined) {
          throw new Error(`Use browser_tab_* for stable lifecycle, or the original ${name} parameters.`);
        }
        if (extra.signal.aborted) throw new Error('Browser request was cancelled before execution.');
        if (targetId && INPUT_TOOLS.has(name)) {
          commandStarted = true;
          // Keep activation and input in the same queue and await the renderer's
          // active-tab acknowledgement before Puppeteer starts its visibility wait.
          await controller.activate(targetId);
          if (extra.signal.aborted) throw new Error('Browser request was cancelled before input.');
        }
        commandStarted = true;
        const response = await upstream.callTool(
          { ...request.params, name: upstreamName, arguments: { ...upstreamArgs, ...(targetId ? { targetId } : {}) } },
          undefined,
          {
            timeout: TOOL_TIMEOUT_MS,
            maxTotalTimeout: TOOL_TIMEOUT_MS,
            resetTimeoutOnProgress: false,
            signal: extra.signal,
          }
        );
        const target = (
          response.structuredContent as { target?: { id?: string; url?: string; closed?: boolean } } | undefined
        )?.target;
        if (!response.isError && targetId && target?.id !== targetId) {
          uncertainOutcome = true;
          throw new Error(
            'Browser returned an unverified target; action outcome is unknown. Reconnect tools and inspect before repeating an action.'
          );
        }
        if (
          !response.isError &&
          (name === 'select_page' || name === 'new_page' || name === 'close_page' || explicitTabId !== undefined)
        ) {
          selectedTabId = target?.id;
          legacySelection = !selectedTabId;
        }
        if (target) {
          return {
            ...response,
            // Avoid duplicating the entire snapshot in text and structured JSON.
            structuredContent: { target },
            content: [
              ...(Array.isArray(response.content) ? response.content : []),
              { type: 'text' as const, text: `Browser target: ${JSON.stringify(target)}` },
            ],
          };
        }
        return response;
      } catch (error) {
        if (
          commandStarted &&
          ((error instanceof McpError && error.code === ErrorCode.RequestTimeout) || extra.signal.aborted)
        ) {
          uncertainOutcome = true;
        }
        return {
          content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        };
      }
    });
    tail = result.catch((): void => undefined);
    return result;
  });

  return server;
};

type PendingRequest = {
  resolve: (value: JsonObject) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class CdpBrowserTabController implements BrowserTabController {
  private socket: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(private readonly browserUrl: string) {}

  private async connect(): Promise<WebSocket> {
    if (this.socket?.readyState === WebSocket.OPEN) return this.socket;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const response = await fetch(new URL('/json/version', this.browserUrl), { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`Browser discovery failed with HTTP ${response.status}.`);
      const payload = (await response.json()) as { webSocketDebuggerUrl?: unknown };
      if (typeof payload.webSocketDebuggerUrl !== 'string') {
        throw new Error('Browser discovery did not return a WebSocket debugger URL.');
      }
      const socket = new WebSocket(payload.webSocketDebuggerUrl, { handshakeTimeout: 10_000 });
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as {
          id?: number;
          result?: JsonObject;
          error?: { message?: string };
        };
        if (typeof message.id !== 'number') return;
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error.message || 'Browser command failed.'));
        else request.resolve(message.result || {});
      });
      const disconnect = (): void => {
        if (this.socket === socket) this.socket = null;
        for (const request of this.pending.values()) {
          clearTimeout(request.timer);
          request.reject(new Error('Browser control connection closed.'));
        }
        this.pending.clear();
      };
      socket.once('close', disconnect);
      socket.once('error', disconnect);
      this.socket = socket;
      return socket;
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async request(method: string, params: JsonObject = {}, sessionId?: string): Promise<JsonObject> {
    const socket = await this.connect();
    const id = this.nextId++;
    const result = new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new McpError(
            ErrorCode.RequestTimeout,
            `Browser command ${method} timed out. Its outcome may be unknown; do not replay a mutation blindly.`
          )
        );
      }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
    });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return result;
  }

  async list(): Promise<StableBrowserTab[]> {
    const result = await this.request('Target.getTargets');
    const targetInfos = Array.isArray(result.targetInfos) ? result.targetInfos : [];
    return targetInfos.map((value) => {
      const target = value as JsonObject;
      return {
        id: String(target.targetId || ''),
        title: String(target.title || ''),
        url: String(target.url || 'about:blank'),
        active: target.aionuiActive === true,
      };
    });
  }

  async open(url: string, activate: boolean): Promise<string> {
    const result = await this.request('Target.createTarget', { url, background: !activate });
    if (typeof result.targetId !== 'string') throw new Error('Browser did not return a stable tab ID.');
    return result.targetId;
  }

  async activate(tabId: string): Promise<void> {
    await this.request('Target.activateTarget', { targetId: tabId });
  }

  async navigate(tabId: string, url: string, activate: boolean): Promise<void> {
    const attached = await this.request('Target.attachToTarget', { targetId: tabId, flatten: true });
    if (typeof attached.sessionId !== 'string') throw new Error('Browser did not attach to the requested tab.');
    try {
      await this.request('Page.navigate', { url }, attached.sessionId);
      if (activate) await this.activate(tabId);
    } finally {
      await this.request('Target.detachFromTarget', { sessionId: attached.sessionId }).catch((): void => undefined);
    }
  }

  async close(tabId: string): Promise<void> {
    await this.request('Target.closeTarget', { targetId: tabId });
  }

  async disconnect(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      await new Promise<void>((resolve) => {
        socket.once('close', resolve);
        socket.close();
      });
    }
  }
}
