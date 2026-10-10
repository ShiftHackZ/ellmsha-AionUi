#!/usr/bin/env node
/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Lifecycle wrapper for the pinned Chrome DevTools MCP fork build.
 *
 * Its stdio transport does not exit on stdin EOF. The parent MCP proxy uses EOF
 * for normal shutdown, so handle it here to avoid a two-second forced kill and
 * possible orphan on platforms where signals are not forwarded to child trees.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const upstreamEntry = path.join(__dirname, 'chrome-devtools-mcp', 'build', 'src', 'index.js');
if (!existsSync(upstreamEntry)) {
  process.stderr.write(`[builtin-mcp-chrome-devtools] Pinned engine is missing: ${upstreamEntry}\n`);
  process.exit(1);
}

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  process.exit(0);
};
process.stdin.once('end', stop);
process.stdin.once('close', stop);

void import(pathToFileURL(upstreamEntry).href).catch((error: unknown) => {
  process.stderr.write(`[builtin-mcp-chrome-devtools] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
