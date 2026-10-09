import { app, nativeImage } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';

const durations = [280, 110, 110, 140, 140, 320];

export function startDockMascot(): void {
  if (process.platform !== 'darwin' || !app.dock) return;
  const dir = app.isPackaged
    ? path.join(process.resourcesPath, 'dock')
    : path.join(process.cwd(), 'resources', 'dock');
  const frames = durations.map((_, index) => path.join(dir, `idle-${index}.png`));
  if (!frames.every(existsSync)) return;
  const icons = frames.map((frame) => nativeImage.createFromPath(frame));
  if (icons.some((icon) => icon.isEmpty())) return;

  let index = 0;
  let timer: ReturnType<typeof setTimeout>;
  const advance = () => {
    app.dock.setIcon(icons[index]);
    timer = setTimeout(() => {
      index = (index + 1) % icons.length;
      advance();
    }, durations[index]);
  };
  advance();
  app.once('before-quit', () => clearTimeout(timer));
}
