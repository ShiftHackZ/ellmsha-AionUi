// The IPC channel closes even when Electron crashes. Services must not become orphans.
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
process.once('disconnect', () => {
  if (process.platform === 'win32')
    spawn('taskkill.exe', ['/pid', String(process.pid), '/T', '/F'], { windowsHide: true });
  else process.kill(-process.pid, 'SIGTERM');
  setTimeout(() => process.exit(1), 5000).unref();
});
const entry = process.argv[2];
process.argv.splice(1, 1);
await import(pathToFileURL(entry).href);
