import { contextBridge, ipcRenderer } from 'electron';
import type { SecurityKeyAction, SecurityKeyDialogState } from '@/common/types/browserWebAuthn';

contextBridge.exposeInMainWorld('securityKeyAPI', {
  status: (status: 'ready' | 'failed') => ipcRenderer.send('ellmsha:security-key:dialog-status', status),
  state: (): Promise<SecurityKeyDialogState> => ipcRenderer.invoke('ellmsha:security-key:dialog-state'),
  onState: (listener: (state: SecurityKeyDialogState) => void) => {
    const handle = (_event: Electron.IpcRendererEvent, state: SecurityKeyDialogState) => listener(state);
    ipcRenderer.on('ellmsha:security-key:dialog-state', handle);
    return () => ipcRenderer.removeListener('ellmsha:security-key:dialog-state', handle);
  },
  respond: (action: SecurityKeyAction) => ipcRenderer.send('ellmsha:security-key:dialog-action', action),
});
