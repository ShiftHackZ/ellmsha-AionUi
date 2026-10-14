/**
 * E2E: only current-chat Office outputs may auto-open preview tabs.
 *
 * This exercises the end-to-end watcher flow:
 *   1. open a conversation with a selected workspace
 *   2. backend starts `/api/fs/office-watch/start`
 *   3. an unrelated workspace file emits `workspaceOfficeWatch.fileAdded` but stays closed
 *   4. a real assistant creates a valid Office document through its tools
 *   5. its live reply references the document and the matching tab opens automatically
 *
 * The assistant is installed/authenticated locally; E2E_OFFICE_BACKEND defaults
 * to claude. The shared fixture uses disposable userData and each case owns its
 * temporary workspace. No response-stream or tool-state injections are used.
 * We validate the generated file with officeparser; an officecli install hint
 * in the preview does not prevent checking the automatic tab-opening policy.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseOfficeAsync } from 'officeparser';
import { test, expect } from '../../fixtures';
import { findAssistantIdForBackend, goToGuid, startAutoApprovePermissionMessages, waitForAiReply } from '../../helpers';

async function enableAutoPreviewOfficeFiles(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => {
    const port = (window as Window).__backendPort;
    if (!port) {
      throw new Error('window.__backendPort is not available');
    }

    const response = await fetch(`http://127.0.0.1:${port}/api/settings/client`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoPreviewOfficeFiles: true }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`PUT /api/settings/client failed (${response.status}): ${body}`);
    }
  });
}

async function installWorkspaceOfficeWatchDebug(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const win = window as Window & {
      __backendPort?: number;
      __previewAutoOpenDebug?: {
        status: string;
        events: Array<{ name: string; data: unknown }>;
      };
      __previewAutoOpenDebugWs?: WebSocket;
    };

    if (win.__previewAutoOpenDebugWs) {
      win.__previewAutoOpenDebugWs.close();
    }

    const port = win.__backendPort;
    if (!port) {
      throw new Error('window.__backendPort is not available');
    }

    win.__previewAutoOpenDebug = { status: 'connecting', events: [] };

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    win.__previewAutoOpenDebugWs = ws;

    ws.addEventListener('open', () => {
      if (!win.__previewAutoOpenDebug) return;
      win.__previewAutoOpenDebug.status = 'open';
    });

    ws.addEventListener('close', () => {
      if (!win.__previewAutoOpenDebug) return;
      win.__previewAutoOpenDebug.status = 'closed';
    });

    ws.addEventListener('error', () => {
      if (!win.__previewAutoOpenDebug) return;
      win.__previewAutoOpenDebug.status = 'error';
    });

    ws.addEventListener('message', (event) => {
      if (!win.__previewAutoOpenDebug) return;

      try {
        const parsed = JSON.parse(String(event.data)) as {
          name?: string;
          event?: string;
          data?: unknown;
          payload?: unknown;
        };

        const name = parsed.name ?? parsed.event ?? 'unknown';
        const data = parsed.data ?? parsed.payload;
        win.__previewAutoOpenDebug.events.push({ name, data });
      } catch {
        win.__previewAutoOpenDebug.events.push({ name: 'non-json', data: String(event.data) });
      }
    });
  });
}

async function getWorkspaceOfficeWatchDebug(
  page: import('@playwright/test').Page,
  workspace: string
): Promise<{
  configValue: unknown;
  wsStatus: string;
  workspaceFiles: string[];
  officeEvents: Array<{ name: string; data: unknown }>;
}> {
  return page.evaluate(
    async ({ workspacePath }) => {
      const win = window as Window & {
        __backendPort?: number;
        __previewAutoOpenDebug?: {
          status: string;
          events: Array<{ name: string; data: unknown }>;
        };
      };

      const port = win.__backendPort;
      if (!port) {
        throw new Error('window.__backendPort is not available');
      }

      const [settingsResponse, filesResponse] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/api/settings/client`),
        fetch(`http://127.0.0.1:${port}/api/fs/list`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ root: workspacePath }),
        }),
      ]);

      const settingsText = await settingsResponse.text();
      const filesText = await filesResponse.text();
      const settingsJson = settingsText ? (JSON.parse(settingsText) as { data?: Record<string, unknown> }) : undefined;
      const filesJson = filesText ? (JSON.parse(filesText) as { data?: Array<{ fullPath?: string }> }) : undefined;
      const events = win.__previewAutoOpenDebug?.events ?? [];

      return {
        configValue: settingsJson?.data?.autoPreviewOfficeFiles,
        wsStatus: win.__previewAutoOpenDebug?.status ?? 'missing',
        workspaceFiles: (filesJson?.data ?? []).map((file) => file.fullPath ?? '').filter(Boolean),
        officeEvents: events.filter((event) => event.name === 'workspaceOfficeWatch.fileAdded'),
      };
    },
    { workspacePath: workspace }
  );
}

async function createConversationWithWorkspace(
  page: import('@playwright/test').Page,
  workspace: string
): Promise<string> {
  await goToGuid(page);
  await enableAutoPreviewOfficeFiles(page);
  await installWorkspaceOfficeWatchDebug(page);
  const backend = process.env.E2E_OFFICE_BACKEND || 'claude';
  // Fresh profiles leave CLI health unchecked; reused profiles can retain an
  // old offline result. Recheck either before deciding an installed CLI is absent.
  await page.evaluate(async (selectedBackend) => {
    const base = `http://127.0.0.1:${(window as Window).__backendPort}`;
    const response = await fetch(`${base}/api/assistants`);
    const { data } = (await response.json()) as {
      data: Array<{ agent_id: string; agent_status: string; agent?: { acp_backend?: string } }>;
    };
    const assistant = data.find((item) => item.agent?.acp_backend === selectedBackend);
    if (assistant && assistant.agent_status !== 'online') {
      const check = await fetch(`${base}/api/agents/${encodeURIComponent(assistant.agent_id)}/health-check`, {
        method: 'POST',
        signal: AbortSignal.timeout(45_000),
      });
      if (!check.ok) throw new Error(`CLI health check failed (${check.status})`);
    }
  }, backend);
  const assistantId = await findAssistantIdForBackend(page, backend, { requireAvailable: true });
  test.skip(!assistantId, `No available ${backend} assistant for preview auto-open conversation`);
  if (!assistantId) return '';

  const conversationId = await page.evaluate(
    async ({ selectedAssistantId, workspacePath }) => {
      const port = (window as unknown as { __backendPort?: number }).__backendPort;
      if (!port) {
        throw new Error('window.__backendPort is not available');
      }

      const response = await fetch(`http://127.0.0.1:${port}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `E2E preview auto-open ${Date.now()}`,
          assistant: {
            id: selectedAssistantId,
          },
          extra: {
            workspace: workspacePath,
            custom_workspace: true,
          },
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`POST /api/conversations failed (${response.status}): ${body}`);
      }

      const json = (await response.json()) as { data?: { id?: string } };
      const id = json?.data?.id;
      if (!id) {
        throw new Error('Conversation create response did not include an id');
      }

      window.location.assign(`#/conversation/${id}`);
      return id;
    },
    { selectedAssistantId: assistantId, workspacePath: workspace }
  );

  await page.waitForFunction((id) => window.location.hash === `#/conversation/${id}`, conversationId, {
    timeout: 15_000,
  });

  await expect(page.getByTestId('sendbox-input')).toBeVisible({ timeout: 30_000 });
  return conversationId;
}

async function deleteConversation(page: import('@playwright/test').Page, conversationId: string): Promise<void> {
  await page.evaluate(
    async ({ id }) => {
      const port = (window as unknown as { __backendPort?: number }).__backendPort;
      if (!port) return;

      await fetch(`http://127.0.0.1:${port}/api/conversations/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }).catch(() => {});
    },
    { id: conversationId }
  );
}

test.describe('Preview auto-open for Office files', () => {
  const cases = [
    { ext: 'docx', fileName: 'auto-open-report.docx' },
    { ext: 'pptx', fileName: 'auto-open-slides.pptx' },
    { ext: 'xlsx', fileName: 'auto-open-sheet.xlsx' },
  ] as const;

  for (const { ext, fileName } of cases) {
    test(`.${ext}: unrelated files stay closed and current-chat outputs auto-open`, async ({ page }, testInfo) => {
      test.setTimeout(300_000);

      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `aionui-e2e-office-auto-${ext}-`));
      const browserLogs: string[] = [];
      fs.writeFileSync(path.join(workspace, 'seed.txt'), 'seed');
      let conversationId: string | null = null;
      let stopAutoApprove: (() => void) | undefined;
      const consoleListener = (message: import('@playwright/test').ConsoleMessage) => {
        browserLogs.push(`[${message.type()}] ${message.text()}`);
        if (browserLogs.length > 60) {
          browserLogs.shift();
        }
      };
      page.on('console', consoleListener);

      try {
        conversationId = await createConversationWithWorkspace(page, workspace);
        await expect
          .poll(async () => (await getWorkspaceOfficeWatchDebug(page, workspace)).wsStatus, {
            timeout: 10_000,
          })
          .toBe('open');

        // Give the renderer enough time to start the backend watcher and record
        // the initial baseline before we create the new office file.
        await page.waitForTimeout(2_000);

        const previewPanel = page.locator('.preview-panel');
        try {
          await expect(previewPanel).not.toBeVisible();
          const unrelatedFileName = `unrelated-workspace-file.${ext}`;
          fs.writeFileSync(path.join(workspace, unrelatedFileName), 'unrelated fixture');
          await expect
            .poll(
              async () =>
                (await getWorkspaceOfficeWatchDebug(page, workspace)).officeEvents.some((event) => {
                  const filePath = (event.data as { file_path?: string } | null)?.file_path;
                  return filePath ? path.basename(filePath) === unrelatedFileName : false;
                }),
              { timeout: 20_000, message: 'The unrelated file must reach the real workspace watcher' }
            )
            .toBe(true);
          // Observe beyond the hook's one-second delay after the confirmed event.
          await page.waitForTimeout(2_000);
          await expect(previewPanel).not.toBeVisible();

          const targetFile = path.join(workspace, fileName);
          const marker = 'Preview ownership fixture';
          expect(fs.existsSync(targetFile)).toBe(false);
          stopAutoApprove = startAutoApprovePermissionMessages(page);
          const textarea = page.getByTestId('sendbox-input');
          await textarea.fill(
            [
              `Create a tiny valid ${ext.toUpperCase()} document at ${JSON.stringify(targetFile)} using your tools.`,
              `Put the exact text "${marker}" in one paragraph, slide, or cell as appropriate.`,
              `Work only inside ${JSON.stringify(workspace)}. Do not inspect or modify other files.`,
              'Use an already installed document tool/library, or Python zipfile to write minimal valid OOXML; do not install dependencies or rename plain text.',
              'Verify the file exists, then reply with only this Markdown link after the write is complete:',
              `[${fileName}](<${targetFile}>)`,
            ].join('\n')
          );
          await textarea.press('Enter');
          await waitForAiReply(page, 180_000);
          await expect
            .poll(() => fs.existsSync(targetFile), {
              timeout: 180_000,
              message: 'The real assistant must create its document',
            })
            .toBe(true);
          await expect(page.getByTestId('message-text-left').filter({ hasText: fileName }).last()).toBeVisible({
            timeout: 60_000,
          });
          expect(await parseOfficeAsync(targetFile)).toContain(marker);

          // Never click the file or reply link: the current-chat output must open it.
          await expect(previewPanel).toBeVisible({ timeout: 20_000 });
          await expect(previewPanel.getByText(fileName, { exact: true }).first()).toBeVisible({ timeout: 20_000 });
          await expect(previewPanel.getByText(unrelatedFileName, { exact: true })).not.toBeVisible();
          await testInfo.attach(`current-chat-office-preview-${ext}`, {
            body: await page.screenshot(),
            contentType: 'image/png',
          });
        } catch (error) {
          const debug = await getWorkspaceOfficeWatchDebug(page, workspace);
          throw new Error(
            `Office preview ownership failed for ${fileName}. wsStatus=${debug.wsStatus}; autoPreviewOfficeFiles=${JSON.stringify(debug.configValue)}; workspaceFiles=${JSON.stringify(debug.workspaceFiles)}; officeEvents=${JSON.stringify(debug.officeEvents)}; browserLogs=${JSON.stringify(browserLogs)}; originalError=${String(error)}`,
            { cause: error }
          );
        }
      } finally {
        stopAutoApprove?.();
        page.off('console', consoleListener);
        if (conversationId) {
          await deleteConversation(page, conversationId);
        }
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    });
  }
});
