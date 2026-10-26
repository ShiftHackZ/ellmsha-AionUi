'use strict';
// Runs only inside the owned Code OSS extension host. GitHub owns OAuth storage.
const vscode = require('vscode');
const fs = require('node:fs/promises');
const { start, discover } = require('./transport.cjs');

exports.activate = async (context) => {
  context.subscriptions.push(
    vscode.commands.registerCommand('ellmsha.copilot.signIn', async () => {
      try {
        // Match Copilot's exact minimum scope-specific session lookup.
        await vscode.authentication.getSession('github', ['user:email'], { createIfNone: true });
        const models = await discover(vscode);
        const model = models.find((m) => m.id === 'gpt-4o-mini') || models[0];
        if (!model) throw Object.assign(new Error(), { code: 'copilot_models_unavailable' });
        // The desktop action is explicitly Sign in and verify. Public vscode.lm
        // owns its separate user-consent prompt; only a harmless phrase is sent.
        const cancellation = new vscode.CancellationTokenSource();
        const timeout = setTimeout(() => cancellation.cancel(), 30000);
        try {
          const response = await model.sendRequest(
            [vscode.LanguageModelChatMessage.User('Reply exactly OK.')],
            { modelOptions: { max_tokens: 16 } },
            cancellation.token
          );
          for await (const _part of response.stream) {
            /* verify completion, no response logging */
          }
        } finally {
          clearTimeout(timeout);
          cancellation.dispose();
        }
        await vscode.window.showInformationMessage('Copilot IDE connected. Refresh models in eLLMsha.');
      } catch (error) {
        const code = /^[a-z_]+$/i.test(error?.code || '') ? error.code : 'copilot_connection_failed';
        await vscode.window.showErrorMessage(`Copilot IDE: ${code}`);
      }
    })
  );
  const owner = Number(process.env.ELLMSHA_COPILOT_PARENT_PID);
  if (Number.isInteger(owner) && owner > 1) {
    const watchdog = setInterval(() => {
      try {
        process.kill(owner, 0);
      } catch (error) {
        if (error.code === 'ESRCH') void vscode.commands.executeCommand('workbench.action.quit');
      }
    }, 3000);
    context.subscriptions.push({ dispose: () => clearInterval(watchdog) });
  }
  const copilot = vscode.extensions.getExtension('GitHub.copilot-chat');
  if (!copilot) throw new Error('copilot_extension_missing');
  await copilot.activate();
  const server = await start(vscode, process.env.ELLMSHA_COPILOT_BRIDGE_TOKEN);
  context.subscriptions.push({ dispose: () => server.close() });
  if (process.env.ELLMSHA_COPILOT_LOGIN === '1') void vscode.commands.executeCommand('ellmsha.copilot.signIn');
  await fs.writeFile(
    `${process.env.ELLMSHA_COPILOT_READY_FILE}.tmp`,
    JSON.stringify({
      instance: process.env.ELLMSHA_COPILOT_INSTANCE,
      app: vscode.env.appName,
      version: vscode.version,
      extensionHostPid: process.pid,
      commandsReady: true,
      port: server.address().port,
    }),
    { mode: 0o600 }
  );
  await fs.rename(`${process.env.ELLMSHA_COPILOT_READY_FILE}.tmp`, process.env.ELLMSHA_COPILOT_READY_FILE);
};
