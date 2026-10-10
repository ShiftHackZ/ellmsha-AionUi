import { join } from 'node:path';

export interface BuiltinPluginsPathOptions {
  configuredPath?: string;
  isPackaged: boolean;
  rendererUrl?: string;
  resourcesPath: string;
}

export interface MobileMcpEntryPathOptions extends BuiltinPluginsPathOptions {
  repositoryRoot: string;
}

export interface OpenComputerUseEntryPathOptions extends MobileMcpEntryPathOptions {
  platform?: NodeJS.Platform;
}

export function resolveBuiltinPluginsPath(options: BuiltinPluginsPathOptions): string | undefined {
  if (options.configuredPath?.trim()) {
    return options.configuredPath;
  }
  if (!options.isPackaged || options.rendererUrl) {
    return undefined;
  }
  return join(options.resourcesPath, 'plugins');
}

export function resolveMobileMcpEntryPath(options: MobileMcpEntryPathOptions): string {
  if (options.configuredPath?.trim()) {
    return options.configuredPath;
  }
  const runtimeRoot =
    options.isPackaged && !options.rendererUrl
      ? join(options.resourcesPath, 'mobile-mcp')
      : join(options.repositoryRoot, '.data', 'mobile-mcp-runtime');
  return join(runtimeRoot, 'lib', 'index.js');
}

export function resolveOpenComputerUseEntryPath(options: OpenComputerUseEntryPathOptions): string {
  if (options.configuredPath?.trim()) {
    return options.configuredPath;
  }
  const platform = options.platform ?? process.platform;
  const entries: Partial<Record<NodeJS.Platform, string>> = {
    darwin: join('Open Computer Use.app', 'Contents', 'MacOS', 'OpenComputerUse'),
    linux: 'open-computer-use',
    win32: 'open-computer-use.exe',
  };
  const relativeEntry = entries[platform];
  if (!relativeEntry) {
    throw new Error(`Open Computer Use does not support target platform ${platform}`);
  }
  const runtimeRoot =
    options.isPackaged && !options.rendererUrl
      ? join(options.resourcesPath, 'open-computer-use')
      : join(options.repositoryRoot, '.data', 'open-computer-use-runtime');
  return join(runtimeRoot, relativeEntry);
}
