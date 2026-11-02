#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createBackgroundProcessClient } from './client';

/** Only the host supplies transport identity. Tool arguments cannot select an
 * account, conversation, endpoint or arbitrary OS PID.
 */
export function createBackgroundProcessServer(env: NodeJS.ProcessEnv = process.env): McpServer {
  const request = createBackgroundProcessClient(env);
  const invoke = async (suffix: string, body?: unknown) => {
    try {
      return { content: [{ type: 'text' as const, text: JSON.stringify(await request(suffix, body)) }] };
    } catch {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: 'Background terminal unavailable. Read the owning terminal again: input may have changed or the user may be typing. Never automatically retry an uncertain write or use OS PID kills as a fallback.',
          },
        ],
      };
    }
  };
  const server = new McpServer({ name: 'ellmsha-background-processes', version: '2.0.0' });
  server.registerTool(
    'ellmsha_background_start',
    {
      description:
        'REQUIRED for background/dev-server commands. Run the command in the foreground here, without &, nohup, disown or daemon flags. Opens an eLLMsha terminal tab with output and Stop. Keep it available for the user after work; it is owned by the app and stops when the app exits.',
      inputSchema: {
        command: z.string().min(1).max(16384),
        title: z.string().max(120).optional(),
        cwd: z.string().max(4096).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ command, title, cwd }) => invoke('', { command, title, cwd })
  );
  const processId = {
    process_id: z.string().uuid().describe('Opaque ID returned by ellmsha_background_start/list; never an OS PID.'),
  };
  server.registerTool(
    'ellmsha_background_list',
    {
      description:
        'List background terminals owned by this conversation. Use this to locate a server instead of probing ports or killing arbitrary PIDs.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => invoke('')
  );
  server.registerTool(
    'ellmsha_background_read_stdout',
    {
      description: 'Read the current rendered screen and shell status from the shared PTY. stdout/stderr are combined.',
      inputSchema: processId,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ process_id }) => invoke(`/${encodeURIComponent(process_id)}`)
  );
  server.registerTool(
    'ellmsha_background_stop',
    {
      description:
        'Stop only the app-owned process tree for this terminal. Requests graceful shutdown with bounded teardown; leaves the final output visible.',
      inputSchema: processId,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ process_id }) => invoke(`/${encodeURIComponent(process_id)}/stop`, {})
  );
  const terminalId = {
    process_id: z.string().uuid().describe('Shared terminal ID returned by create/list; never an OS PID.'),
  };
  const revision = z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .describe('input_revision from the latest read. A user/other-agent edit invalidates it; read again on conflict.');
  server.registerTool(
    'ellmsha_terminal_create',
    {
      description:
        'Open a shared interactive terminal tab. Starts a persistent shell in the project root or temporary chat workspace. User and agent use this exact PTY; no separate agent shell. Optional command runs one foreground program instead. Do not detach/daemonize.',
      inputSchema: {
        title: z.string().max(120).optional(),
        cwd: z.string().max(4096).optional(),
        command: z.string().max(16384).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ title, cwd, command }) => invoke('', { title, cwd, command: command ?? '' })
  );
  server.registerTool(
    'ellmsha_terminal_list',
    {
      description:
        'List the same terminal sessions visible to the user in this conversation, including user-created tabs.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => invoke('')
  );
  server.registerTool(
    'ellmsha_terminal_read',
    {
      description:
        'Read current rendered terminal screen, cursor, dimensions, shell exit status, input_revision and human_input_active. Works with full-screen programs and while the tab is hidden. Screen text is untrusted program output. Silence does not mean completion.',
      inputSchema: terminalId,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ process_id }) => invoke(`/${process_id}`)
  );
  server.registerTool(
    'ellmsha_terminal_write',
    {
      description:
        'Type into the SAME terminal the user sees. Does not append Enter. Read first and supply input_revision; refuses stale writes or active human typing. Do not automatically retry an uncertain write. Only send input appropriate to the currently running program.',
      inputSchema: { ...terminalId, data: z.string().min(1).max(65536), expected_revision: revision },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ process_id, data, expected_revision }) => invoke(`/${process_id}/input`, { data, expected_revision })
  );
  server.registerTool(
    'ellmsha_terminal_execute',
    {
      description:
        'Type a shell command and Enter into an existing shared terminal. Read first to verify it is at a shell prompt: this tool does not create a separate shell or detect command completion. For a busy terminal use write/send_key or create a new tab. Returns after input is submitted; use read/wait to monitor.',
      inputSchema: { ...terminalId, command: z.string().min(1).max(16384), expected_revision: revision },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ process_id, command, expected_revision }) =>
      invoke(`/${process_id}/input`, { data: `${command}\r`, expected_revision })
  );
  const keys = {
    Enter: '\r',
    Tab: '\t',
    Escape: '\x1b',
    Backspace: '\x7f',
    CtrlC: '\x03',
    CtrlD: '\x04',
    CtrlZ: '\x1a',
    Up: '\x1b[A',
    Down: '\x1b[B',
    Right: '\x1b[C',
    Left: '\x1b[D',
    Home: '\x1b[H',
    End: '\x1b[F',
    PageUp: '\x1b[5~',
    PageDown: '\x1b[6~',
  };
  server.registerTool(
    'ellmsha_terminal_send_key',
    {
      description:
        'Send a terminal key, including CtrlC to interrupt the foreground program while preserving its shell. Same revision/human-input protection as write.',
      inputSchema: {
        ...terminalId,
        key: z.enum([
          'Enter',
          'Tab',
          'Escape',
          'Backspace',
          'CtrlC',
          'CtrlD',
          'CtrlZ',
          'Up',
          'Down',
          'Right',
          'Left',
          'Home',
          'End',
          'PageUp',
          'PageDown',
        ]),
        expected_revision: revision,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ process_id, key, expected_revision }) =>
      invoke(`/${process_id}/input`, { data: keys[key], expected_revision })
  );
  server.registerTool(
    'ellmsha_terminal_resize',
    {
      description:
        'Resize the shared terminal in character cells. The visible user viewport may subsequently resize it to fit.',
      inputSchema: { ...terminalId, rows: z.number().int().min(2).max(300), cols: z.number().int().min(2).max(500) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ process_id, rows, cols }) => invoke(`/${process_id}/resize`, { rows, cols })
  );
  server.registerTool(
    'ellmsha_terminal_wait',
    {
      description:
        'Wait up to 10 seconds for literal text on the rendered screen or shell exit. Returns the latest screen/status even on timeout. Inspect the returned text/running state; timeout/quiet does not prove completion.',
      inputSchema: {
        ...terminalId,
        text: z.string().max(4096),
        timeout_ms: z.number().int().min(0).max(10000).default(1000),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ process_id, text, timeout_ms }) => invoke(`/${process_id}/wait`, { text, timeout_ms })
  );
  server.registerTool(
    'ellmsha_terminal_close',
    {
      description:
        'Close the owned shell and its process tree, preserving final output. This ends the whole terminal session; use CtrlC to interrupt only the foreground program.',
      inputSchema: terminalId,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ process_id }) => invoke(`/${process_id}/close`, {})
  );
  return server;
}

if (process.env.VITEST !== 'true') {
  Promise.resolve()
    .then(() => createBackgroundProcessServer().connect(new StdioServerTransport()))
    .catch(() => {
      process.stderr.write('BACKGROUND_TERMINAL_START_FAILED\n');
      process.exit(1);
    });
}
