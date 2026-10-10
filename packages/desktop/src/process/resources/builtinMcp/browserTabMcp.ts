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
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
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

export const createBrowserMcpProxy = (upstream: Client, controller: BrowserTabController): Server => {
  const server = new Server(
    { name: 'aionui-browser', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'Use browser_tabs_list and browser_tab_* for stable tab lifecycle and exact navigation. ' +
        'Use the DevTools page tools for reading and interacting with page content.',
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const upstreamResult = await upstream.listTools(request.params);
    return { ...upstreamResult, tools: [...upstreamResult.tools.flatMap(splitSnapshotTool), ...STABLE_BROWSER_TOOLS] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (STABLE_BROWSER_TOOLS.some((tool) => tool.name === request.params.name)) {
      try {
        return await callStableBrowserTool(controller, request.params.name, request.params.arguments);
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        };
      }
    }
    if (request.params.name === INLINE_SNAPSHOT_TOOL && request.params.arguments?.filePath !== undefined) {
      return {
        content: [{ type: 'text', text: `Use ${FILE_SNAPSHOT_TOOL} when a snapshot must be saved to disk.` }],
        isError: true,
      };
    }
    if (request.params.name === FILE_SNAPSHOT_TOOL) {
      const filePath = stringArgument(request.params.arguments, 'filePath');
      return upstream.callTool({
        ...request.params,
        name: INLINE_SNAPSHOT_TOOL,
        arguments: { ...request.params.arguments, filePath },
      });
    }
    return upstream.callTool(request.params);
  });

  return server;
};

type PendingRequest = {
  resolve: (value: JsonObject) => void;
  reject: (error: Error) => void;
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
      const response = await fetch(new URL('/json/version', this.browserUrl));
      if (!response.ok) throw new Error(`Browser discovery failed with HTTP ${response.status}.`);
      const payload = (await response.json()) as { webSocketDebuggerUrl?: unknown };
      if (typeof payload.webSocketDebuggerUrl !== 'string') {
        throw new Error('Browser discovery did not return a WebSocket debugger URL.');
      }
      const socket = new WebSocket(payload.webSocketDebuggerUrl);
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
        if (message.error) request.reject(new Error(message.error.message || 'Browser command failed.'));
        else request.resolve(message.result || {});
      });
      const disconnect = (): void => {
        if (this.socket === socket) this.socket = null;
        for (const request of this.pending.values()) request.reject(new Error('Browser control connection closed.'));
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
    const result = new Promise<JsonObject>((resolve, reject) => this.pending.set(id, { resolve, reject }));
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
