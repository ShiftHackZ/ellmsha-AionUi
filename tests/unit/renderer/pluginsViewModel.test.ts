import { describe, expect, it } from 'vitest';
import { BackendHttpError } from '@/common/adapter/httpBridge';
import type { IExtensionInfo, LinearConnection } from '@/common/adapter/ipcBridge';
import {
  clockifyConnectError,
  filterPlugins,
  linearConnectionEmailSubtitle,
  linearConnectionTitle,
} from '@/renderer/pages/settings/PluginsSettings/pluginViewModel';

const plugins: IExtensionInfo[] = [
  {
    name: 'linear',
    display_name: 'Linear',
    version: '1.0.0',
    description: 'Issue tracking',
    source: 'bundled',
    enabled: true,
    package_format: 'native',
    supported_components: [],
    unsupported_components: [],
    compatibility_warnings: [],
  },
  {
    name: 'mobile',
    display_name: 'Mobile Next',
    version: '1.0.8',
    description: 'Android and iOS automation',
    source: 'bundled',
    enabled: true,
    package_format: 'native',
    supported_components: [],
    unsupported_components: [],
    compatibility_warnings: [],
  },
];

describe('Plugins settings view models', () => {
  it('searches plugin names, display names, and descriptions without changing source order', () => {
    expect(filterPlugins(plugins, 'LINEAR')).toEqual([plugins[0]]);
    expect(filterPlugins(plugins, 'android')).toEqual([plugins[1]]);
    expect(filterPlugins(plugins, '')).toEqual(plugins);
  });

  it('uses verified identity for an account title and stored identity label after disconnect', () => {
    const connection = {
      id: 'connection-1',
      namespace: 'linear-analytical-engines-ada-example-test-connection-1',
      label: 'Previous verified name',
      status: 'connected',
      identity: {
        account_id: 'account-1',
        account_name: 'Ada Lovelace',
        account_email: 'ada@example.test',
        workspace_id: 'workspace-1',
        workspace_name: 'Analytical Engines',
      },
      capabilities: {
        issues_read: true,
        issues_write: false,
        comments_read: true,
        comments_write: false,
        attachment_metadata: false,
        attachment_images: false,
      },
      migrated: false,
      created_at: 1,
      updated_at: 1,
    } satisfies LinearConnection;

    expect(linearConnectionTitle(connection)).toBe('Ada Lovelace');
    expect(linearConnectionEmailSubtitle(connection)).toBe('ada@example.test');

    const emailOnly = {
      ...connection,
      identity: { ...connection.identity, account_name: '  ' },
    };
    expect(linearConnectionTitle(emailOnly)).toBe('ada@example.test');
    expect(linearConnectionEmailSubtitle(emailOnly)).toBeUndefined();

    const repeatedEmail = {
      ...connection,
      identity: { ...connection.identity, account_name: 'ADA@example.test' },
    };
    expect(linearConnectionTitle(repeatedEmail)).toBe('ADA@example.test');
    expect(linearConnectionEmailSubtitle(repeatedEmail)).toBeUndefined();

    expect(linearConnectionTitle({ ...connection, status: 'disconnected', identity: undefined })).toBe(
      'Previous verified name'
    );
    expect(
      linearConnectionEmailSubtitle({ ...connection, status: 'disconnected', identity: undefined })
    ).toBeUndefined();
  });

  it('shows safe Clockify authentication and bad-request messages but hides server errors', () => {
    const error = (status: number, code: string, message: string) =>
      new BackendHttpError({
        method: 'POST',
        path: '/api/plugins/clockify/connections',
        status,
        body: { code, error: message },
      });

    expect(clockifyConnectError(error(400, 'BAD_REQUEST', 'Reconnect the existing account.'), 'Fallback')).toBe(
      'Reconnect the existing account.'
    );
    expect(clockifyConnectError(error(401, 'CLOCKIFY_AUTH_FAILED', 'Invalid API key.'), 'Fallback')).toBe(
      'Invalid API key.'
    );
    expect(clockifyConnectError(error(500, 'INTERNAL_ERROR', 'Filesystem details'), 'Fallback')).toBe('Fallback');
  });
});
