import path from 'node:path';

/** Resolve only application-owned resources; packaged builds ignore dev overrides. */
export function copilotPaths(options: {
  appPath: string;
  resourcesPath: string;
  packaged: boolean;
  developmentSource?: string;
}) {
  return {
    extension: options.packaged
      ? path.join(options.resourcesPath, 'copilot-ide', 'extension')
      : path.join(options.appPath, 'packages/desktop/src/process/resources/copilot-ide'),
    source: options.packaged
      ? path.join(options.resourcesPath, 'copilot-ide', 'runtime')
      : options.developmentSource ||
        path.join(path.resolve(options.appPath, '..'), '.data/acceptance/copilot-embedded-runtime-2026-10-22/upstream'),
  };
}
