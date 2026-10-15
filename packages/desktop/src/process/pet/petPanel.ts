import { createRequire } from 'node:module';
import path from 'node:path';
import { app, type BrowserWindow } from 'electron';

/** Repair Electron's nonactivating panel tag on macOS 27 before showing a pet window. */
export function preventPetPanelActivation(window: BrowserWindow): void {
  if (process.platform !== 'darwin' || Number(process.getSystemVersion().split('.')[0]) < 27) return;

  if (window.isDestroyed()) throw new Error('[Pet] Invalid native panel window number');
  const sourceId = /^window:([1-9]\d*):\d+$/.exec(window.getMediaSourceId());
  const windowNumber = Number(sourceId?.[1]);
  if (!Number.isInteger(windowNumber) || windowNumber > 0x7fffffff) {
    throw new Error('[Pet] Invalid native panel window number');
  }

  const requireNative = createRequire(path.join(app.getAppPath(), 'package.json'));
  const panel = requireNative('./out/main/native/pet-panel.node') as {
    preventActivation: (windowNumber: number) => boolean;
  };
  if (panel.preventActivation(windowNumber) !== true) {
    throw new Error('[Pet] Native panel activation prevention is unavailable');
  }
}
