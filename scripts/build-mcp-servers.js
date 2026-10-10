#!/usr/bin/env node
/**
 * Build builtin MCP server scripts as fully self-contained CJS bundles.
 *
 * electron-vite's externalizeDepsPlugin leaves all npm packages as require()
 * calls, which works for Electron's main process (ASAR virtual FS patches
 * require()) but fails when an external `node` process runs the script from
 * app.asar.unpacked — there is no ASAR support there.
 *
 * This script uses esbuild's programmatic API (instead of CLI flags) to avoid
 * shell-quoting issues with special characters in --define values.
 */

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INTEGRATION_ROOT = path.resolve(ROOT, '..');

function resolveChromeDevtoolsRuntime(options = {}) {
  const env = options.env ?? process.env;
  const runtimeRoot =
    env.ELLM_SHA_CHROME_DEVTOOLS_MCP_RUNTIME ||
    path.join(INTEGRATION_ROOT, '.data', 'chrome-devtools-mcp-runtime');
  const preparationPath = path.join(INTEGRATION_ROOT, 'scripts', 'prepare-chrome-devtools-mcp.js');
  if (!fs.existsSync(preparationPath)) {
    throw new Error(`Chrome DevTools MCP preparation is missing: ${preparationPath}`);
  }
  const preparation = require(preparationPath);
  const source = env.ELLM_SHA_CHROME_DEVTOOLS_MCP_RUNTIME
    ? undefined
    : preparation.prepareChromeDevtoolsMcpRuntime({ repositoryRoot: INTEGRATION_ROOT });

  preparation.verifyChromeDevtoolsMcpRuntime({
    runtimeRoot,
    sourceCommit: source?.commit,
    sourceDigest: preparation.CHROME_DEVTOOLS_MCP_SOURCE_DIGEST,
  });
  return runtimeRoot;
}

const SHARED_OPTIONS = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  tsconfig: path.join(ROOT, 'tsconfig.json'),
  loader: { '.wasm': 'empty' },
};

async function main() {
  await Promise.all([
    esbuild.build({
      ...SHARED_OPTIONS,
      entryPoints: [path.join(ROOT, 'packages/desktop/src/process/resources/builtinMcp/imageGenServer.ts')],
      outfile: path.join(ROOT, 'out/main/builtin-mcp-image-gen.js'),
    }),
    esbuild.build({
      ...SHARED_OPTIONS,
      entryPoints: [path.join(ROOT, 'packages/desktop/src/process/resources/builtinMcp/browserServer.ts')],
      outfile: path.join(ROOT, 'out/main/builtin-mcp-browser.js'),
    }),
    esbuild.build({
      ...SHARED_OPTIONS,
      entryPoints: [path.join(ROOT, 'packages/desktop/src/process/resources/builtinMcp/chromeDevtoolsServer.ts')],
      outfile: path.join(ROOT, 'out/main/builtin-mcp-chrome-devtools.js'),
    }),
    esbuild.build({
      ...SHARED_OPTIONS,
      entryPoints: [path.join(ROOT, 'packages/desktop/src/process/resources/builtinMcp/tencentMemoryServer.ts')],
      outfile: path.join(ROOT, 'out/main/builtin-mcp-tencent-memory.js'),
    }),
    esbuild.build({
      ...SHARED_OPTIONS,
      entryPoints: [path.join(ROOT, 'packages/desktop/src/process/resources/builtinMcp/chatHistoryServer.ts')],
      outfile: path.join(ROOT, 'out/main/builtin-mcp-chat-history.js'),
    }),
  ]);

  // The browser proxy must be able to start offline from app.asar.unpacked.
  // Copy the pinned, already-bundled upstream engine beside our launcher so
  // runtime startup never invokes npx or touches a user-level npm cache.
  const chromeDevtoolsSource = resolveChromeDevtoolsRuntime();
  const chromeDevtoolsOutput = path.join(ROOT, 'out/main/chrome-devtools-mcp');
  fs.rmSync(chromeDevtoolsOutput, { recursive: true, force: true });
  fs.cpSync(chromeDevtoolsSource, chromeDevtoolsOutput, { recursive: true });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('MCP server build failed:', err);
    process.exit(1);
  });
}

module.exports = { main, resolveChromeDevtoolsRuntime };
