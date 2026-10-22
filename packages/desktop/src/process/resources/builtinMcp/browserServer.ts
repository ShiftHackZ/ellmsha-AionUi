#!/usr/bin/env node
/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * In-app browser MCP proxy.
 *
 * The pinned upstream server keeps its mature inspect/click/type/screenshot
 * tools. This process adds stable renderer-tab lifecycle tools and forwards
 * every other tool unchanged. Both tool sets use the same authenticated,
 * loopback-only CDP bridge.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { CdpBrowserTabController, createBrowserMcpProxy } from './browserTabMcp';
import { resolveBridgeToken, resolveBrowserUrl } from './browserServerPort';

const logDiagnostic = (message: string): void => {
  process.stderr.write(`[builtin-mcp-browser] ${message.replace(/\/scope\/[^/\s]+/g, '/scope/[redacted]')}\n`);
};

const main = async (): Promise<void> => {
  const browserUrl = resolveBrowserUrl({ env: process.env });
  const bridgeToken = resolveBridgeToken({ env: process.env });
  if (!browserUrl || !bridgeToken) {
    throw new Error('CDP bridge port or token is unavailable; refusing to start so no hidden browser can be launched.');
  }

  const upstream = new Client({ name: 'aionui-browser-proxy', version: '1.0.0' });
  const upstreamLauncher = path.join(__dirname, 'builtin-mcp-chrome-devtools.js');
  if (!existsSync(upstreamLauncher)) {
    throw new Error(`Pinned Chrome DevTools MCP launcher is missing from the application bundle: ${upstreamLauncher}`);
  }
  const discovery = await fetch(`${browserUrl}/json/version`, { signal: AbortSignal.timeout(10_000) });
  if (!discovery.ok) throw new Error('Scoped browser discovery unavailable.');
  const { webSocketDebuggerUrl } = (await discovery.json()) as { webSocketDebuggerUrl?: unknown };
  if (
    typeof webSocketDebuggerUrl !== 'string' ||
    !webSocketDebuggerUrl.startsWith(browserUrl.replace('http:', 'ws:') + '/')
  )
    throw new Error('Invalid scoped browser endpoint.');
  const upstreamTransport = new StdioClientTransport({
    command: process.execPath,
    args: [
      upstreamLauncher,
      '--ws-endpoint',
      webSocketDebuggerUrl,
      '--no-usage-statistics',
      '--experimental-structured-content',
    ],
    stderr: 'pipe',
  });
  // Diagnostics can split a capability URL across stream chunks; never forward raw upstream stderr.
  upstreamTransport.stderr?.on('data', () => logDiagnostic('Browser engine emitted a diagnostic (payload withheld).'));
  const controller = new CdpBrowserTabController(browserUrl);
  const proxy = createBrowserMcpProxy(upstream, controller, bridgeToken);
  let shutdownPromise: Promise<void> | null = null;
  let exitRequested = false;

  const shutdown = (): Promise<void> => {
    shutdownPromise ??= Promise.allSettled([proxy.close(), upstream.close(), controller.disconnect()]).then(
      (): void => undefined
    );
    return shutdownPromise;
  };
  const exitAfterShutdown = (code: number): void => {
    if (exitRequested) return;
    exitRequested = true;
    void shutdown().finally(() => {
      logDiagnostic('Browser proxy stopped cleanly.');
      process.exit(code);
    });
  };

  // Install every cleanup path before spawning the nested engine. Stdio clients
  // normally close by ending stdin; relying on a later SIGTERM can orphan the
  // engine on Windows and adds the SDK's two-second forced-termination delay.
  process.stdin.once('end', () => exitAfterShutdown(0));
  process.stdin.once('close', () => exitAfterShutdown(0));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => exitAfterShutdown(0));
  }
  upstream.onclose = () => {
    if (!shutdownPromise) exitAfterShutdown(1);
  };

  logDiagnostic('Connecting browser tools to the scoped in-app bridge.');
  try {
    await upstream.connect(upstreamTransport);
    await proxy.connect(new StdioServerTransport());
  } catch (error) {
    await shutdown();
    throw error;
  }
};

main().catch((error) => {
  logDiagnostic(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
