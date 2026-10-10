import { isBackendHttpError } from '@/common/adapter/httpBridge';
import type { IExtensionInfo, LinearConnection } from '@/common/adapter/ipcBridge';

export type PluginCatalogItem = IExtensionInfo & {
  package_format: NonNullable<IExtensionInfo['package_format']>;
  supported_components: string[];
  unsupported_components: Array<{ component: string; message: string }>;
  compatibility_warnings: Array<{ component: string; message: string }>;
};

export const normalizePluginCatalog = (plugins: IExtensionInfo[]): PluginCatalogItem[] =>
  plugins.map((plugin) => ({
    ...plugin,
    package_format: plugin.package_format ?? 'native',
    supported_components: Array.isArray(plugin.supported_components) ? plugin.supported_components : [],
    unsupported_components: Array.isArray(plugin.unsupported_components) ? plugin.unsupported_components : [],
    compatibility_warnings: Array.isArray(plugin.compatibility_warnings) ? plugin.compatibility_warnings : [],
  }));

export const filterPlugins = <T extends IExtensionInfo>(plugins: T[], query: string): T[] => {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return plugins;
  return plugins.filter((plugin) =>
    [plugin.name, plugin.display_name, plugin.description]
      .filter(Boolean)
      .some((value) => value!.toLocaleLowerCase().includes(normalized))
  );
};

export const linearConnectionTitle = (connection: LinearConnection): string => {
  const displayName = connection.identity?.account_name?.trim();
  const email = connection.identity?.account_email.trim();
  return displayName || email || connection.label;
};

export const linearConnectionEmailSubtitle = (connection: LinearConnection): string | undefined => {
  const email = connection.identity?.account_email.trim();
  if (!email || email.toLocaleLowerCase() === linearConnectionTitle(connection).trim().toLocaleLowerCase()) {
    return undefined;
  }
  return email;
};

export const clockifyConnectError = (error: unknown, fallback: string): string => {
  if (
    isBackendHttpError(error) &&
    (error.code === 'CLOCKIFY_AUTH_FAILED' || error.status === 400) &&
    error.backendMessage
  ) {
    return error.backendMessage;
  }
  return fallback;
};
