import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

type ChromeDevtoolsPreparation = {
  CHROME_DEVTOOLS_MCP_COMMIT: string;
  CHROME_DEVTOOLS_MCP_ORIGIN: string;
  CHROME_DEVTOOLS_MCP_SOURCE_DIGEST: string;
  CHROME_DEVTOOLS_MCP_TAG: string;
  CHROME_DEVTOOLS_MCP_UPSTREAM: string;
  hashBuildInputs(checkout: string): string;
  inspectChromeDevtoolsMcpCheckout(options: {
    checkout: string;
    runGit(args: string[]): string;
    expectedPatchFiles?: Record<string, string>;
    expectedSourceDigest?: string;
  }): {
    commit: string;
    version: string;
  };
  normalizeRemote(value: string): string;
  verifyChromeDevtoolsMcpRuntime(options: { runtimeRoot: string; sourceCommit?: string; sourceDigest?: string }): {
    checked: string[];
  };
};

type McpServerBuilder = {
  resolveChromeDevtoolsRuntime(options: { env: NodeJS.ProcessEnv }): string;
};

const require = createRequire(import.meta.url);
const repoRoot = resolve(__dirname, '../../..');
const preparation = require(
  resolve(repoRoot, '../scripts/prepare-chrome-devtools-mcp.js')
) as ChromeDevtoolsPreparation;
const mcpServerBuilder = require(resolve(repoRoot, 'scripts/build-mcp-servers.js')) as McpServerBuilder;
const tempDirs: string[] = [];

function checkout(version = '0.16.0'): string {
  const directory = mkdtempSync(join(tmpdir(), 'ellmsha-chrome-devtools-mcp-test-'));
  tempDirs.push(directory);
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ version }));
  writeFileSync(join(directory, 'package-lock.json'), JSON.stringify({ packages: { '': { version } } }));
  writeFileSync(join(directory, 'LICENSE'), 'Apache License 2.0\n');
  return directory;
}

function pinnedGit(args: string[]): string {
  const command = args.join(' ');
  if (command === 'rev-parse HEAD') return preparation.CHROME_DEVTOOLS_MCP_COMMIT;
  if (command === `rev-parse ${preparation.CHROME_DEVTOOLS_MCP_TAG}^{commit}`) {
    return preparation.CHROME_DEVTOOLS_MCP_COMMIT;
  }
  if (command === 'remote get-url origin') return preparation.CHROME_DEVTOOLS_MCP_ORIGIN;
  if (command === 'remote get-url upstream') return preparation.CHROME_DEVTOOLS_MCP_UPSTREAM;
  throw new Error(`Unexpected git command: ${command}`);
}

function inspectExact(directory: string, runGit = pinnedGit, expectedPatchFiles: Record<string, string> = {}) {
  return preparation.inspectChromeDevtoolsMcpCheckout({
    checkout: directory,
    runGit,
    expectedPatchFiles,
    expectedSourceDigest: preparation.hashBuildInputs(directory),
  });
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Chrome DevTools MCP runtime preparation', () => {
  it('accepts only the exact fork checkout and upstream tag pin', () => {
    expect(inspectExact(checkout())).toMatchObject({
      commit: preparation.CHROME_DEVTOOLS_MCP_COMMIT,
      version: '0.16.0',
    });
    expect(preparation.normalizeRemote('git@github.com:ShiftHackZ/ellmsha-chrome-devtools-mcp.git')).toBe(
      'https://github.com/ShiftHackZ/ellmsha-chrome-devtools-mcp'
    );
  });

  it('rejects an implicit upstream version upgrade or unexpected source content', () => {
    const upgraded = checkout('1.10.0');
    expect(() => inspectExact(upgraded)).toThrow('source package version 1.10.0; expected 0.16.0');

    const directory = checkout();
    const expectedSourceDigest = preparation.hashBuildInputs(directory);
    writeFileSync(join(directory, 'src.ts'), 'unexpected\n');
    expect(() =>
      preparation.inspectChromeDevtoolsMcpCheckout({
        checkout: directory,
        runGit: pinnedGit,
        expectedPatchFiles: {},
        expectedSourceDigest,
      })
    ).toThrow('source digest');
  });

  it('accepts the exact eLLMsha source patch in a clean checkout', () => {
    const directory = checkout();
    writeFileSync(join(directory, 'package.json'), '{"version":"0.16.0","patched":true}');
    const expectedPatchFiles = {
      'package.json': createHash('sha256').update('{"version":"0.16.0","patched":true}').digest('hex'),
    };
    const expectedSourceDigest = preparation.hashBuildInputs(directory);
    expect(
      preparation.inspectChromeDevtoolsMcpCheckout({
        checkout: directory,
        runGit: pinnedGit,
        expectedPatchFiles,
        expectedSourceDigest,
      })
    ).toMatchObject({ version: '0.16.0' });

    writeFileSync(join(directory, 'package.json'), '{"version":"0.16.0","patched":false}');
    expect(() =>
      preparation.inspectChromeDevtoolsMcpCheckout({
        checkout: directory,
        runGit: pinnedGit,
        expectedPatchFiles,
        expectedSourceDigest,
      })
    ).toThrow('source patch digest mismatch: package.json');
  });

  it('accepts identical approved content after a descendant release commit', () => {
    const directory = checkout();
    const releaseCommit = '1111111111111111111111111111111111111111';
    const releaseGit = (args: string[]): string => {
      const command = args.join(' ');
      if (command === 'rev-parse HEAD') return releaseCommit;
      if (command === `merge-base --is-ancestor ${preparation.CHROME_DEVTOOLS_MCP_COMMIT} ${releaseCommit}`) return '';
      return pinnedGit(args);
    };
    expect(inspectExact(directory, releaseGit)).toMatchObject({ commit: releaseCommit, version: '0.16.0' });

    const unrelatedGit = (args: string[]): string => {
      if (args.join(' ') === 'rev-parse HEAD') return releaseCommit;
      if (args[0] === 'merge-base') throw new Error('not an ancestor');
      return pinnedGit(args);
    };
    expect(() => inspectExact(directory, unrelatedGit)).toThrow('does not descend from pinned upstream');
  });

  it('accepts a clean recursive clone without mutating missing remote or tag metadata', () => {
    const directory = checkout();
    const sourceDigest = preparation.hashBuildInputs(directory);
    writeFileSync(join(directory, '.git'), 'gitdir: ../.git/modules/chrome-devtools-mcp\n');
    const commands: string[] = [];
    const runGit = (args: string[]): string => {
      const command = args.join(' ');
      commands.push(command);
      if (command === 'rev-parse HEAD') return preparation.CHROME_DEVTOOLS_MCP_COMMIT;
      if (command === 'remote get-url origin') return preparation.CHROME_DEVTOOLS_MCP_ORIGIN;
      if (
        command === 'remote get-url upstream' ||
        command === `rev-parse ${preparation.CHROME_DEVTOOLS_MCP_TAG}^{commit}`
      ) {
        throw new Error('missing local metadata');
      }
      if (command === `rev-parse ${preparation.CHROME_DEVTOOLS_MCP_COMMIT}^{commit}`) {
        return preparation.CHROME_DEVTOOLS_MCP_COMMIT;
      }
      throw new Error(`Unexpected git command: ${command}`);
    };

    expect(preparation.hashBuildInputs(directory)).toBe(sourceDigest);
    expect(inspectExact(directory, runGit)).toMatchObject({
      commit: preparation.CHROME_DEVTOOLS_MCP_COMMIT,
      version: '0.16.0',
    });
    expect(commands).toContain(`rev-parse ${preparation.CHROME_DEVTOOLS_MCP_COMMIT}^{commit}`);
    expect(commands.some((command) => command.startsWith('remote add ') || command.startsWith('fetch '))).toBe(false);
  });

  it('changes the runtime cache identity when a fork build input changes', () => {
    const directory = checkout();
    const before = preparation.hashBuildInputs(directory);
    writeFileSync(join(directory, 'source.ts'), 'export const patch = 1;\n');
    expect(preparation.hashBuildInputs(directory)).not.toBe(before);
  });

  it('keeps get-uri compatible with the patched basic-ftp major', async () => {
    const getUri = require(resolve(repoRoot, '../chrome-devtools-mcp/node_modules/get-uri')).getUri as (
      uri: string
    ) => Promise<NodeJS.ReadableStream>;
    const body = 'sd08-ftp-fixture';
    let dataServer: Server | undefined;
    let dataSocket: Socket | undefined;
    const controlServer = createServer((controlSocket) => {
      // basic-ftp may close its control socket immediately after the data stream ends.
      controlSocket.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ECONNRESET') throw error;
      });
      controlSocket.setEncoding('utf8');
      controlSocket.write('220 fixture ready\r\n');
      let buffered = '';
      controlSocket.on('data', (chunk: string) => {
        buffered += chunk;
        while (buffered.includes('\r\n')) {
          const boundary = buffered.indexOf('\r\n');
          const line = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          const command = line.split(' ', 1)[0];
          if (command === 'USER') controlSocket.write('331 password required\r\n');
          else if (command === 'PASS') controlSocket.write('230 logged in\r\n');
          else if (command === 'OPTS' || command === 'TYPE' || command === 'STRU') {
            controlSocket.write('200 okay\r\n');
          } else if (command === 'FEAT') controlSocket.write('211 no features\r\n');
          else if (command === 'MDTM') controlSocket.write('213 20260102030405\r\n');
          else if (command === 'EPSV') {
            const server = createServer((socket) => {
              dataSocket = socket;
            });
            dataServer = server;
            server.listen(0, '127.0.0.1', () => {
              const port = (server.address() as AddressInfo).port;
              controlSocket.write(`229 Entering Extended Passive Mode (|||${port}|)\r\n`);
            });
          } else if (command === 'RETR') {
            controlSocket.write('150 opening data\r\n');
            const transfer = () => {
              dataSocket?.end(body, () => controlSocket.write('226 transfer complete\r\n'));
            };
            if (dataSocket) transfer();
            else dataServer?.once('connection', transfer);
          } else if (command === 'QUIT') controlSocket.end('221 bye\r\n');
          else controlSocket.write('502 unsupported\r\n');
        }
      });
    });
    await new Promise<void>((resolveListen, reject) => {
      controlServer.once('error', reject);
      controlServer.listen(0, '127.0.0.1', resolveListen);
    });

    try {
      const port = (controlServer.address() as AddressInfo).port;
      const stream = await getUri(`ftp://127.0.0.1:${port}/fixture.txt`);
      let received = '';
      for await (const chunk of stream) received += chunk.toString();
      expect(received).toBe(body);
    } finally {
      controlServer.close();
      if (dataServer?.listening) dataServer.close();
    }
  });

  it('verifies the packaged entrypoint, license, and exact provenance marker', () => {
    const runtimeRoot = checkout();
    mkdirSync(join(runtimeRoot, 'build', 'src'), { recursive: true });
    writeFileSync(join(runtimeRoot, 'build', 'src', 'index.js'), 'export {};\n');
    writeFileSync(
      join(runtimeRoot, '.ellmsha-chrome-devtools-mcp-pin.json'),
      JSON.stringify({
        sourceCommit: preparation.CHROME_DEVTOOLS_MCP_COMMIT,
        sourceDigest: preparation.CHROME_DEVTOOLS_MCP_SOURCE_DIGEST,
        tag: preparation.CHROME_DEVTOOLS_MCP_TAG,
        upstreamCommit: preparation.CHROME_DEVTOOLS_MCP_COMMIT,
        version: '0.16.0',
      })
    );
    expect(
      preparation.verifyChromeDevtoolsMcpRuntime({
        runtimeRoot,
        sourceCommit: preparation.CHROME_DEVTOOLS_MCP_COMMIT,
      }).checked
    ).toHaveLength(5);
    expect(() =>
      preparation.verifyChromeDevtoolsMcpRuntime({
        runtimeRoot,
        sourceCommit: '1111111111111111111111111111111111111111',
      })
    ).toThrow('different source commit');

    writeFileSync(
      join(runtimeRoot, '.ellmsha-chrome-devtools-mcp-pin.json'),
      JSON.stringify({
        sourceCommit: preparation.CHROME_DEVTOOLS_MCP_COMMIT,
        sourceDigest: 'unexpected',
        tag: preparation.CHROME_DEVTOOLS_MCP_TAG,
        upstreamCommit: preparation.CHROME_DEVTOOLS_MCP_COMMIT,
        version: '0.16.0',
      })
    );
    expect(() => preparation.verifyChromeDevtoolsMcpRuntime({ runtimeRoot })).toThrow('stale checkout contents');
  });

  it('resolves the current marker contract through the actual MCP build consumer', () => {
    const runtimeRoot = checkout();
    mkdirSync(join(runtimeRoot, 'build', 'src'), { recursive: true });
    writeFileSync(join(runtimeRoot, 'build', 'src', 'index.js'), 'export {};\n');
    const markerPath = join(runtimeRoot, '.ellmsha-chrome-devtools-mcp-pin.json');
    writeFileSync(
      markerPath,
      JSON.stringify({
        sourceDigest: preparation.CHROME_DEVTOOLS_MCP_SOURCE_DIGEST,
        tag: preparation.CHROME_DEVTOOLS_MCP_TAG,
        upstreamCommit: preparation.CHROME_DEVTOOLS_MCP_COMMIT,
        version: '0.16.0',
      })
    );

    expect(
      mcpServerBuilder.resolveChromeDevtoolsRuntime({
        env: { ELLM_SHA_CHROME_DEVTOOLS_MCP_RUNTIME: runtimeRoot },
      })
    ).toBe(runtimeRoot);

    writeFileSync(
      markerPath,
      JSON.stringify({
        sourceDigest: 'unexpected',
        tag: preparation.CHROME_DEVTOOLS_MCP_TAG,
        upstreamCommit: preparation.CHROME_DEVTOOLS_MCP_COMMIT,
        version: '0.16.0',
      })
    );
    expect(() =>
      mcpServerBuilder.resolveChromeDevtoolsRuntime({
        env: { ELLM_SHA_CHROME_DEVTOOLS_MCP_RUNTIME: runtimeRoot },
      })
    ).toThrow('stale checkout contents');
  });
});
