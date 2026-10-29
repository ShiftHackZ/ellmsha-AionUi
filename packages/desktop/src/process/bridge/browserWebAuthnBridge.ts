import { ipcMain } from 'electron';
import {
  beginSecurityKey,
  cancelSecurityKey,
  respondToSecurityKey,
  securityKeyDialogState,
  reportSecurityKeyDialogStatus,
} from '@process/services/browser/webauthn';

export function initBrowserWebAuthnBridge(): void {
  ipcMain.handle('ellmsha:security-key:get', (event, input: unknown) => beginSecurityKey(event, input));
  ipcMain.on('ellmsha:security-key:cancel', (event, id: unknown) => cancelSecurityKey(event.sender.id, id));
  ipcMain.handle('ellmsha:security-key:dialog-state', (event) =>
    event.senderFrame === event.sender.mainFrame ? securityKeyDialogState(event.sender.id) : undefined
  );
  ipcMain.on('ellmsha:security-key:dialog-action', (event, action: unknown) => {
    if (event.senderFrame === event.sender.mainFrame) respondToSecurityKey(event.sender.id, action);
  });
  ipcMain.on('ellmsha:security-key:dialog-status', (event, status: unknown) => {
    if (event.senderFrame === event.sender.mainFrame) reportSecurityKeyDialogStatus(event.sender.id, status);
  });
}
