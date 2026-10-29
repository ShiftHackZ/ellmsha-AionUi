import { contextBridge, ipcRenderer } from 'electron';
import { installSecurityKeyPage } from './browserWebAuthnPage';
import type { SecurityKeyRequest, SecurityKeyResponse } from '@/common/types/browserWebAuthn';

if (process.platform === 'darwin' && process.isMainFrame) {
  contextBridge.exposeInMainWorld('__ellmshaSecurityKey', {
    begin: (request: SecurityKeyRequest): Promise<SecurityKeyResponse> => {
      try {
        if (JSON.stringify(request).length > 100_000) return Promise.resolve({ ok: false, error: 'TypeError' });
        return ipcRenderer.invoke('ellmsha:security-key:get', request);
      } catch {
        return Promise.resolve({ ok: false, error: 'TypeError' });
      }
    },
    cancel: (id: string) => {
      if (typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id)) ipcRenderer.send('ellmsha:security-key:cancel', id);
    },
  });
  // executeInMainWorld preserves sandbox and CSP; isolated-world navigator
  // mutations would not intercept the website's WebAuthn calls.
  contextBridge.executeInMainWorld({ func: installSecurityKeyPage });
}
