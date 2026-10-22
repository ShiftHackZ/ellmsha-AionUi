/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 解析应用内浏览器 MCP 该连接的 CDP 地址。
 *
 * 单独成文件是为了可测试：browserServer.ts 是个有顶层副作用的启动脚本（会 spawn
 * 子进程），没法直接在单测里 import。
 *
 * Resolves which CDP endpoint the in-app browser MCP should connect to. Kept in
 * its own module for testability: browserServer.ts is an entry script with
 * top-level side effects (it spawns a child), so it cannot be imported by tests.
 */

const DEFAULT_CDP_HOST = '127.0.0.1';

export type ResolveBrowserUrlDeps = {
  env: NodeJS.ProcessEnv;
};

const toBrowserUrl = (port: number): string | null => {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return `http://${DEFAULT_CDP_HOST}:${port}`;
};

/**
 * 只认自己进程树继承下来的端口。
 *
 * 端口由 Electron 主进程写进 AIONUI_CDP_ACTIVE_PORT，经 aioncore 继承到这里，所以
 * 「拿不到」只有两种情况：CDP 被用户关掉了，或者不是从应用里启动的。两种情况都应当
 * 拒绝启动，而不是去猜一个端口——猜错会把 Agent 连到另一个实例的浏览器上。
 *
 * Only trust the port inherited down this process tree. The Electron main process
 * writes it into AIONUI_CDP_ACTIVE_PORT and aioncore passes it down, so failing to
 * read it means one of two things: the user disabled CDP, or this was not launched by
 * the app. Both must refuse to start rather than guess a port — guessing wrong
 * connects the agent to a *different* instance's browser.
 */
export const resolveBrowserUrl = (deps: ResolveBrowserUrlDeps): string | null => {
  const { env } = deps;

  const rawPort = env.AIONUI_CDP_ACTIVE_PORT?.trim();
  if (rawPort) {
    const fromEnv = toBrowserUrl(Number(rawPort));
    const token = resolveBridgeToken(deps);
    if (fromEnv && token) return `${fromEnv}/scope/${encodeURIComponent(token)}`;
  }

  return null;
};

/** Only a Core-issued owner/conversation/project capability may reach the proxy. */
export const resolveBridgeToken = (deps: ResolveBrowserUrlDeps): string | null => {
  const raw = deps.env.AIONUI_BROWSER_SCOPE_TOKEN?.trim();
  return raw ? raw : null;
};
