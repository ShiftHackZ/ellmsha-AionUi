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
  process.stderr.write(`[builtin-mcp-browser] ${message}\n`);
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
  const upstreamTransport = new StdioClientTransport({
    command: process.execPath,
    args: [upstreamLauncher, '--browser-url', browserUrl, '--no-usage-statistics'],
    stderr: 'inherit',
  });
  const controller = new CdpBrowserTabController(browserUrl);
  const proxy = createBrowserMcpProxy(upstream, controller);
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

  logDiagnostic(`Connecting browser tools to the in-app bridge at ${browserUrl}`);
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
