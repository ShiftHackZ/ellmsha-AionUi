#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { InitializeRequestSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import { createDiscoveryProxy } from './proxy';
const headers = z.record(z.string(), z.string()).default({});
const configSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: headers,
  }),
  z.object({ type: z.enum(['http', 'streamable_http', 'sse']), url: z.string().url(), headers }),
]);
const main = async (): Promise<void> => {
  const raw = process.env.AIONUI_MCP_DISCOVERY_CONFIG;
  delete process.env.AIONUI_MCP_DISCOVERY_CONFIG;
  if (!raw || raw.length > 1024 * 1024) throw new Error('Invalid discovery configuration');
  const config = configSchema.parse(JSON.parse(raw));
  const transport =
    config.type === 'stdio'
      ? new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: { ...getDefaultEnvironment(), ...config.env },
          stderr: 'inherit',
        })
      : config.type === 'sse'
        ? new SSEClientTransport(new URL(config.url), { requestInit: { headers: config.headers } })
        : new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
  // Read only the initialization frame before connecting upstream, so callback
  // capabilities (roots, sampling, elicitation) remain those of the real client.
  const downstream = new StdioServerTransport();
  const pending: JSONRPCMessage[] = [];
  const first = await new Promise<JSONRPCMessage>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('MCP initialize timeout')), 30_000);
    downstream.onmessage = (message): void => {
      clearTimeout(timer);
      downstream.onmessage = (next): void => {
        pending.push(next);
      };
      resolve(message);
    };
    downstream.onclose = (): void => {
      clearTimeout(timer);
      reject(new Error('MCP client closed'));
    };
    downstream.onerror = (error): void => {
      clearTimeout(timer);
      reject(error);
    };
    void downstream.start().catch(reject);
  });
  const initialization = InitializeRequestSchema.parse(first);
  const upstream = new Client(
    { name: 'ellmsha-mcp-discovery', version: '1.0.0' },
    { capabilities: initialization.params.capabilities }
  );
  let closing = false;
  let proxy: Awaited<ReturnType<typeof createDiscoveryProxy>> | undefined;
  const close = async (code: number): Promise<void> => {
    if (closing) return;
    closing = true;
    await Promise.allSettled([proxy?.close(), upstream.close()]);
    process.exit(code);
  };
  process.stdin.once('end', () => {
    void close(0);
  });
  process.stdin.once('close', () => {
    void close(0);
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      void close(0);
    });
  upstream.onclose = () => {
    void close(closing ? 0 : 1);
  };
  try {
    await upstream.connect(transport);
    proxy = await createDiscoveryProxy(upstream);
    // The SDK owns all subsequent framing and protocol handling. Its transport
    // starts once; this adapter replays the single buffered initialize frame.
    const started: Transport = {
      start: async (): Promise<void> => undefined,
      send: (message) => downstream.send(message),
      close: () => downstream.close(),
      get onmessage() {
        return downstream.onmessage;
      },
      set onmessage(value) {
        downstream.onmessage = value;
      },
      get onclose() {
        return downstream.onclose;
      },
      set onclose(value) {
        downstream.onclose = value;
      },
      get onerror() {
        return downstream.onerror;
      },
      set onerror(value) {
        downstream.onerror = value;
      },
    };
    // Protocol.connect chains pre-existing callbacks. Drop the temporary
    // buffer callback before ownership changes, or replay would re-buffer itself.
    downstream.onmessage = undefined;
    downstream.onclose = undefined;
    downstream.onerror = undefined;
    await proxy.connect(started);
    downstream.onmessage?.(first);
    for (const message of pending.splice(0)) downstream.onmessage?.(message);
  } catch {
    process.stderr.write('MCP_DISCOVERY_START_FAILED\n');
    await close(1);
  }
};
main().catch(() => {
  process.stderr.write('MCP_DISCOVERY_START_FAILED\n');
  process.exit(1);
});
