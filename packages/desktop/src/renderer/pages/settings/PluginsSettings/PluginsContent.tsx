import { ipcBridge } from '@/common';
import { isBackendHttpError, isWebUiBrowserMode } from '@/common/adapter/httpBridge';
import type {
  ClockifyConnections,
  IExtensionInfo,
  LinearConnection,
  LinearConnections,
  NotionConnections,
} from '@/common/adapter/ipcBridge';
import { AION_ADD_BUTTON_CLASS } from '@/renderer/components/base/TalkToButlerButton';
import { Button, Empty, Input, Message, Popconfirm, Spin, Switch, Tag } from '@arco-design/web-react';
import { AddUser, ArrowLeft, Login, Right, Search } from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  filterPlugins,
  linearConnectionEmailSubtitle,
  linearConnectionTitle,
  normalizePluginCatalog,
} from './pluginViewModel';
import type { PluginCatalogItem } from './pluginViewModel';
import ClockifyAccounts from './ClockifyAccounts';
import NotionAccounts from './NotionAccounts';
import ComputerUseSetup from './ComputerUseSetup';
import PluginIcon from './PluginIcon';

const EMPTY_LINEAR: LinearConnections = { connections: [] };
const EMPTY_CLOCKIFY: ClockifyConnections = { connections: [] };
const EMPTY_NOTION: NotionConnections = { connections: [] };

const linearConnectError = (error: unknown, fallback: string): string => {
  if (isBackendHttpError(error) && error.code === 'LINEAR_AUTH_FAILED' && error.backendMessage) {
    return error.backendMessage;
  }
  return fallback;
};

type PluginsContentProps = {
  selectedPluginName?: string;
  installView?: boolean;
  onInstallViewChange?: (open: boolean) => void;
  onSelectedPluginChange?: (pluginName?: string) => void;
};

const PluginsContent: React.FC<PluginsContentProps> = ({
  selectedPluginName,
  onSelectedPluginChange,
  installView,
  onInstallViewChange,
}) => {
  const { t } = useTranslation();
  const webUiBrowserMode = isWebUiBrowserMode();
  const canManagePluginPackages = !webUiBrowserMode;
  const [localSelection, setLocalSelection] = useState<string>();
  const [localInstallView, setLocalInstallView] = useState(false);
  const showingInstall = installView ?? localInstallView;
  const changeInstallView = (open: boolean) => {
    if (onInstallViewChange) onInstallViewChange(open);
    else setLocalInstallView(open);
  };
  const [extensions, setExtensions] = useState<PluginCatalogItem[]>([]);
  const [linear, setLinear] = useState<LinearConnections>(EMPTY_LINEAR);
  const [linearLoadError, setLinearLoadError] = useState(false);
  const [linearRetrying, setLinearRetrying] = useState(false);
  const [clockify, setClockify] = useState<ClockifyConnections>(EMPTY_CLOCKIFY);
  const [notion, setNotion] = useState<NotionConnections>(EMPTY_NOTION);
  const [clockifyLoadError, setClockifyLoadError] = useState(false);
  const [clockifyRetrying, setClockifyRetrying] = useState(false);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [catalogLoadError, setCatalogLoadError] = useState(false);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [gitUrl, setGitUrl] = useState('');
  const [gitRef, setGitRef] = useState('');
  const [gitSubdirectory, setGitSubdirectory] = useState('');

  const selectedName = selectedPluginName ?? localSelection;
  const selectedPlugin = extensions.find((extension) => extension.name === selectedName);
  const visiblePlugins = useMemo(() => filterPlugins(extensions, search), [extensions, search]);

  const selectPlugin = useCallback(
    (pluginName?: string) => {
      setLocalInstallView(false);
      if (onSelectedPluginChange) onSelectedPluginChange(pluginName);
      else setLocalSelection(pluginName);
    },
    [onSelectedPluginChange]
  );

  const setActionBusy = useCallback((key: string, value: boolean) => {
    setBusy((current) => ({ ...current, [key]: value }));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const linearConnections = webUiBrowserMode
      ? ipcBridge.extensions.getLinearConnections.invoke()
      : ipcBridge.extensions.migrateLegacyLinearConnection.invoke();
    const [extensionsResult, linearResult, clockifyResult, notionResult] = await Promise.allSettled([
      ipcBridge.extensions.getLoadedExtensions.invoke(),
      linearConnections,
      ipcBridge.extensions.getClockifyConnections.invoke(),
      ipcBridge.extensions.getNotionConnections.invoke(),
    ]);
    if (extensionsResult.status === 'fulfilled') {
      setExtensions(normalizePluginCatalog(extensionsResult.value ?? []));
      setCatalogLoadError(false);
    } else {
      console.error('[PluginsContent] Failed to load extensions:', extensionsResult.reason);
      setCatalogLoadError(true);
    }
    if (linearResult.status === 'fulfilled') {
      setLinear(linearResult.value ?? EMPTY_LINEAR);
      setLinearLoadError(false);
    } else {
      console.error('[PluginsContent] Failed to load Linear connections:', linearResult.reason);
      setLinearLoadError(true);
    }
    if (clockifyResult.status === 'fulfilled') {
      setClockify(clockifyResult.value ?? EMPTY_CLOCKIFY);
      setClockifyLoadError(false);
    } else {
      console.error('[PluginsContent] Failed to load Clockify connections:', clockifyResult.reason);
      setClockifyLoadError(true);
    }
    setNotion(notionResult.status === 'fulfilled' ? (notionResult.value ?? EMPTY_NOTION) : EMPTY_NOTION);
    if ([extensionsResult, linearResult, clockifyResult, notionResult].some((result) => result.status === 'rejected')) {
      Message.error(t('settings.pluginsLoadError'));
    }
    setLoading(false);
  }, [t, webUiBrowserMode]);

  const retryLinear = useCallback(async () => {
    setLinearRetrying(true);
    try {
      const connections = webUiBrowserMode
        ? await ipcBridge.extensions.getLinearConnections.invoke()
        : await ipcBridge.extensions.migrateLegacyLinearConnection.invoke();
      setLinear(connections ?? EMPTY_LINEAR);
      setLinearLoadError(false);
    } catch (error) {
      console.error('[PluginsContent] Failed to reload Linear connections:', error);
      Message.error(t('settings.pluginsLoadError'));
    } finally {
      setLinearRetrying(false);
    }
  }, [t, webUiBrowserMode]);

  const retryClockify = useCallback(async () => {
    setClockifyRetrying(true);
    try {
      const connections = await ipcBridge.extensions.getClockifyConnections.invoke();
      setClockify(connections ?? EMPTY_CLOCKIFY);
      setClockifyLoadError(false);
    } catch (error) {
      console.error('[PluginsContent] Failed to reload Clockify connections:', error);
      Message.error(t('settings.clockifyAccountsLoadError'));
    } finally {
      setClockifyRetrying(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleExtension = async (extension: IExtensionInfo, enabled: boolean) => {
    const key = `extension:${extension.name}`;
    setActionBusy(key, true);
    try {
      if (enabled) {
        await ipcBridge.extensions.enableExtension.invoke({ name: extension.name });
      } else {
        await ipcBridge.extensions.disableExtension.invoke({ name: extension.name });
      }
      setExtensions((current) => current.map((item) => (item.name === extension.name ? { ...item, enabled } : item)));
    } catch (error) {
      console.error('[PluginsContent] Failed to change plugin state:', error);
      Message.error(t('settings.pluginsUpdateError'));
    } finally {
      setActionBusy(key, false);
    }
  };

  const installGitPlugin = async () => {
    const url = gitUrl.trim();
    if (!url) {
      Message.error(t('settings.pluginInstallUrlRequired'));
      return;
    }
    setActionBusy('install-plugin', true);
    try {
      const installed = await ipcBridge.extensions.installPlugin.invoke({
        type: 'git',
        url,
        ...(gitRef.trim() ? { ref: gitRef.trim() } : {}),
        ...(gitSubdirectory.trim() ? { subdirectory: gitSubdirectory.trim() } : {}),
      });
      await load();
      selectPlugin(installed.name);
      Message.success(t('settings.pluginInstalled', { name: installed.name }));
    } catch (error) {
      console.error('[PluginsContent] Failed to install Git plugin:', error);
      Message.error(
        isBackendHttpError(error) && error.backendMessage ? error.backendMessage : t('settings.pluginInstallError')
      );
    } finally {
      setActionBusy('install-plugin', false);
    }
  };

  const updatePlugin = async (name: string) => {
    const key = `update:${name}`;
    setActionBusy(key, true);
    try {
      await ipcBridge.extensions.updatePlugin.invoke({ name });
      await load();
      Message.success(t('settings.pluginUpdated', { name }));
    } catch (error) {
      console.error('[PluginsContent] Failed to update plugin:', error);
      Message.error(
        isBackendHttpError(error) && error.backendMessage ? error.backendMessage : t('settings.pluginUpdateSourceError')
      );
    } finally {
      setActionBusy(key, false);
    }
  };

  const uninstallPlugin = async (name: string) => {
    const key = `uninstall:${name}`;
    setActionBusy(key, true);
    try {
      await ipcBridge.extensions.uninstallPlugin.invoke({ name });
      selectPlugin();
      await load();
      Message.success(t('settings.pluginUninstalled', { name }));
    } catch (error) {
      console.error('[PluginsContent] Failed to uninstall plugin:', error);
      Message.error(
        isBackendHttpError(error) && error.backendMessage ? error.backendMessage : t('settings.pluginUninstallError')
      );
    } finally {
      setActionBusy(key, false);
    }
  };

  const connectNew = async () => {
    setActionBusy('connect-new', true);
    Message.info(t('settings.linearCompleteBrowserLogin'));
    try {
      const connection = await ipcBridge.extensions.connectNewLinearConnection.invoke();
      setLinear((current) => ({ connections: [...current.connections, connection] }));
      Message.success(t('settings.linearConnected'));
    } catch (error) {
      console.error('[PluginsContent] Linear OAuth or identity verification failed:', error);
      Message.error(linearConnectError(error, t('settings.linearConnectError')));
      const latest = await ipcBridge.extensions.getLinearConnections.invoke().catch((): null => null);
      if (latest) setLinear(latest);
    } finally {
      setActionBusy('connect-new', false);
    }
  };

  const connect = async (connection: LinearConnection, reconnect: boolean) => {
    const key = `connect:${connection.id}`;
    setActionBusy(key, true);
    setLinear((current) => ({
      connections: current.connections.map((item) =>
        item.id === connection.id ? { ...item, status: 'connecting', identity: undefined, last_error: undefined } : item
      ),
    }));
    Message.info(t('settings.linearCompleteBrowserLogin'));
    try {
      const updated = await ipcBridge.extensions.connectLinearConnection.invoke({
        connection_id: connection.id,
        reconnect,
      });
      setLinear((current) => ({
        connections: current.connections.map((item) => (item.id === updated.id ? updated : item)),
      }));
      Message.success(t('settings.linearConnected'));
    } catch (error) {
      console.error('[PluginsContent] Linear OAuth or identity verification failed:', error);
      Message.error(linearConnectError(error, t('settings.linearConnectError')));
      const latest = await ipcBridge.extensions.getLinearConnections.invoke().catch((): null => null);
      if (latest) setLinear(latest);
    } finally {
      setActionBusy(key, false);
    }
  };

  const disconnect = async (connection: LinearConnection) => {
    const key = `disconnect:${connection.id}`;
    setActionBusy(key, true);
    try {
      const updated = await ipcBridge.extensions.disconnectLinearConnection.invoke({ connection_id: connection.id });
      setLinear((current) => ({
        connections: current.connections.map((item) => (item.id === updated.id ? updated : item)),
      }));
      Message.success(t('settings.linearDisconnected'));
    } catch (error) {
      console.error('[PluginsContent] Failed to disconnect Linear connection:', error);
      Message.error(t('settings.linearDisconnectError'));
      const latest = await ipcBridge.extensions.getLinearConnections.invoke().catch((): null => null);
      if (latest) setLinear(latest);
    } finally {
      setActionBusy(key, false);
    }
  };

  const statusLabel = (connection: LinearConnection) => t(`settings.linearStatus.${connection.status}`);
  const connectingNew = Boolean(busy['connect-new']);

  if (loading) {
    return (
      <div className='flex flex-col gap-16px pb-20px'>
        <div className='h-32px bg-fill-2 rd-8px' aria-hidden='true' />
        <section className='min-h-208px flex items-center justify-center bg-2 border border-border-2 rd-16px text-t-secondary'>
          <Spin />
        </section>
      </div>
    );
  }

  if (selectedName) {
    if (!selectedPlugin) {
      return (
        <div className='flex flex-col gap-16px pb-20px'>
          <Button type='text' className='self-start !px-0' icon={<ArrowLeft />} onClick={() => selectPlugin()}>
            {t('settings.pluginDetailBack')}
          </Button>
          {catalogLoadError ? (
            <div role='alert' className='bg-2 border border-border-2 rd-16px p-20px text-center'>
              <div className='text-14px text-status-error'>{t('settings.pluginsLoadError')}</div>
              <Button size='small' className='mt-10px' onClick={() => void load()}>
                {t('common.retry')}
              </Button>
            </div>
          ) : (
            <div className='text-14px text-t-secondary'>{t('settings.pluginDetailNotFound')}</div>
          )}
        </div>
      );
    }

    return (
      <div className='flex flex-col gap-16px pb-20px'>
        <div className='flex items-center gap-8px text-13px text-t-secondary'>
          <Button type='text' className='!px-0' icon={<ArrowLeft />} onClick={() => selectPlugin()}>
            {t('settings.pluginDetailBack')}
          </Button>
          <span>/</span>
          <span className='text-t-primary'>{selectedPlugin.display_name || selectedPlugin.name}</span>
        </div>

        <section className='bg-2 border border-border-2 rd-16px p-20px flex flex-col gap-16px'>
          <div className='flex items-start justify-between gap-16px'>
            <div className='flex min-w-0 items-center gap-12px'>
              <PluginIcon name={selectedPlugin.name} size={40} />
              <div className='min-w-0'>
                <div className='text-20px font-600 text-t-primary'>
                  {selectedPlugin.display_name || selectedPlugin.name}
                </div>
                <div className='text-13px text-t-secondary mt-4px'>{selectedPlugin.description}</div>
              </div>
            </div>
            <Switch
              checked={selectedPlugin.enabled}
              loading={busy[`extension:${selectedPlugin.name}`]}
              onChange={(enabled) => void toggleExtension(selectedPlugin, enabled)}
            />
          </div>
          <div className='flex gap-8px flex-wrap'>
            <Tag>{t('settings.pluginVersion', { version: selectedPlugin.version })}</Tag>
            <Tag color={selectedPlugin.enabled ? 'green' : 'gray'}>
              {selectedPlugin.enabled ? t('settings.pluginEnabled') : t('settings.pluginDisabled')}
            </Tag>
            <Tag>{t(`settings.pluginFormat.${selectedPlugin.package_format}`)}</Tag>
          </div>
        </section>

        {selectedPlugin.package_format !== 'native' && (
          <section className='bg-2 border border-border-2 rd-16px p-20px flex flex-col gap-14px'>
            <div>
              <div className='text-16px font-600 text-t-primary'>{t('settings.pluginCompatibility')}</div>
              <div className='text-13px text-t-secondary mt-4px'>{t('settings.pluginImportedApproval')}</div>
            </div>
            <div>
              <div className='text-13px font-500 text-t-primary mb-6px'>{t('settings.pluginSupportedComponents')}</div>
              <div className='flex gap-6px flex-wrap'>
                {selectedPlugin.supported_components.map((component) => (
                  <Tag key={component} color='green'>
                    {t(`settings.pluginComponent.${component}`, { defaultValue: component })}
                  </Tag>
                ))}
              </div>
            </div>
            {selectedPlugin.unsupported_components.length > 0 && (
              <div>
                <div className='text-13px font-500 text-t-primary mb-6px'>
                  {t('settings.pluginUnsupportedComponents')}
                </div>
                <div className='flex flex-col gap-6px'>
                  {selectedPlugin.unsupported_components.map((notice) => (
                    <div key={notice.component} className='text-12px text-status-warning break-words'>
                      <span className='font-500'>
                        {t('settings.pluginUnsupportedComponentDescription', { component: notice.component })}
                      </span>{' '}
                      {notice.message}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {selectedPlugin.compatibility_warnings.map((notice) => (
              <div key={notice.component} className='text-12px text-status-warning break-words'>
                {notice.message}
              </div>
            ))}
          </section>
        )}

        {selectedPlugin.source === 'local' && (
          <section className='bg-2 border border-border-2 rd-16px p-20px flex flex-col gap-14px'>
            <div>
              <div className='text-16px font-600 text-t-primary'>{t('settings.pluginInstallSource')}</div>
              <div className='text-13px text-t-secondary mt-4px'>
                {selectedPlugin.source_provenance?.source_type === 'git'
                  ? t('settings.pluginGitSourceDescription')
                  : t('settings.pluginLocalSourceDescription')}
              </div>
            </div>
            {selectedPlugin.source_provenance && (
              <dl className='grid grid-cols-[minmax(100px,auto)_minmax(0,1fr)] gap-x-12px gap-y-6px text-12px'>
                {selectedPlugin.source_provenance.url && (
                  <>
                    <dt className='text-t-secondary'>{t('settings.pluginGitUrl')}</dt>
                    <dd className='text-t-primary break-all'>{selectedPlugin.source_provenance.url}</dd>
                  </>
                )}
                {selectedPlugin.source_provenance.path && (
                  <>
                    <dt className='text-t-secondary'>{t('settings.pluginLocalPath')}</dt>
                    <dd className='text-t-primary break-all'>{selectedPlugin.source_provenance.path}</dd>
                  </>
                )}
                {selectedPlugin.source_provenance.ref && (
                  <>
                    <dt className='text-t-secondary'>{t('settings.pluginGitRef')}</dt>
                    <dd className='text-t-primary break-all'>{selectedPlugin.source_provenance.ref}</dd>
                  </>
                )}
                {selectedPlugin.source_provenance.subdirectory && (
                  <>
                    <dt className='text-t-secondary'>{t('settings.pluginGitSubdirectory')}</dt>
                    <dd className='text-t-primary break-all'>{selectedPlugin.source_provenance.subdirectory}</dd>
                  </>
                )}
                {selectedPlugin.source_provenance.resolved_revision && (
                  <>
                    <dt className='text-t-secondary'>{t('settings.pluginResolvedRevision')}</dt>
                    <dd className='text-t-primary break-all font-mono'>
                      {selectedPlugin.source_provenance.resolved_revision}
                    </dd>
                  </>
                )}
              </dl>
            )}
            {canManagePluginPackages && (
              <div className='flex gap-8px flex-wrap'>
                {selectedPlugin.source_provenance && (
                  <Button
                    size='small'
                    loading={busy[`update:${selectedPlugin.name}`]}
                    onClick={() => void updatePlugin(selectedPlugin.name)}
                  >
                    {t('settings.pluginUpdateFromSource')}
                  </Button>
                )}
                <Popconfirm
                  title={t('settings.pluginUninstallConfirm', {
                    name: selectedPlugin.display_name || selectedPlugin.name,
                  })}
                  onOk={() => uninstallPlugin(selectedPlugin.name)}
                >
                  <Button size='small' status='danger' loading={busy[`uninstall:${selectedPlugin.name}`]}>
                    {t('settings.pluginUninstall')}
                  </Button>
                </Popconfirm>
              </div>
            )}
          </section>
        )}

        {selectedPlugin.name === 'linear' ? (
          <section className='bg-2 border border-border-2 rd-16px p-20px flex flex-col gap-16px'>
            <div className='flex items-start justify-between gap-16px flex-wrap'>
              <div className='flex items-center gap-12px'>
                <PluginIcon name='linear' size={36} />
                <div>
                  <div className='text-16px font-600 text-t-primary'>{t('settings.linearConnectedAccounts')}</div>
                  <div className='text-13px text-t-secondary mt-4px'>
                    {t('settings.linearConnectedAccountsDescription')}
                  </div>
                </div>
              </div>
              <Button
                type='primary'
                size='small'
                className={AION_ADD_BUTTON_CLASS}
                disabled={connectingNew || linearLoadError || linearRetrying}
                aria-busy={connectingNew}
                onClick={() => void connectNew()}
              >
                <span className='flex items-center gap-6px'>
                  <span className='h-14px w-14px shrink-0 flex items-center justify-center leading-none'>
                    {connectingNew ? <Spin size={14} /> : <AddUser theme='outline' size={14} fill='currentColor' />}
                  </span>
                  {linear.connections.length > 0
                    ? t('settings.linearConnectAnotherAccount')
                    : t('settings.linearConnectAccount')}
                </span>
              </Button>
            </div>

            {!selectedPlugin.enabled && (
              <div className='text-13px text-t-secondary bg-fill-2 border border-border-2 rd-10px px-12px py-10px'>
                {t('settings.linearPluginInactive')}
              </div>
            )}

            {linearLoadError && (
              <div
                role='alert'
                className='flex items-center justify-between gap-12px bg-fill-2 border border-border-2 rd-10px px-12px py-10px'
              >
                <span className='text-13px text-status-error'>{t('settings.pluginsLoadError')}</span>
                <Button size='small' loading={linearRetrying} onClick={() => void retryLinear()}>
                  {t('common.retry')}
                </Button>
              </div>
            )}

            {!linearLoadError && linear.connections.length === 0 ? (
              <div className='text-14px text-t-secondary border border-dashed border-border-2 rd-12px p-20px text-center'>
                {t('settings.linearNoConnectedAccounts')}
              </div>
            ) : !linearLoadError ? (
              <div className='flex flex-col gap-12px'>
                {linear.connections.map((connection) => (
                  <div
                    key={connection.id}
                    className='border border-border-2 bg-base rd-12px px-14px py-10px flex flex-col gap-12px'
                  >
                    <div className='flex items-start justify-between gap-12px'>
                      <div className='flex min-w-0 items-start gap-12px'>
                        <PluginIcon name='linear' account />
                        <div className='min-w-0'>
                          <div className='flex items-center gap-8px flex-wrap'>
                            <span className='text-14px font-600 text-t-primary'>
                              {linearConnectionTitle(connection)}
                            </span>
                            <Tag
                              color={
                                connection.status === 'connected'
                                  ? 'green'
                                  : connection.status === 'error'
                                    ? 'red'
                                    : 'gray'
                              }
                            >
                              {statusLabel(connection)}
                            </Tag>
                            {connection.migrated && <Tag>{t('settings.linearMigrated')}</Tag>}
                          </div>
                          {(linearConnectionEmailSubtitle(connection) || connection.identity?.workspace_name) && (
                            <div className='text-13px text-t-secondary mt-6px flex flex-col gap-2px'>
                              {linearConnectionEmailSubtitle(connection) && (
                                <span>{linearConnectionEmailSubtitle(connection)}</span>
                              )}
                              {connection.identity?.workspace_name && (
                                <span>
                                  {t('settings.linearWorkspaceIdentity', { name: connection.identity.workspace_name })}
                                </span>
                              )}
                            </div>
                          )}
                          {connection.last_error && (
                            <div className='text-12px text-status-error mt-6px break-words'>
                              {connection.last_error}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className='flex gap-8px shrink-0'>
                        {connection.status === 'connected' ? (
                          <>
                            <Button
                              size='small'
                              loading={busy[`connect:${connection.id}`]}
                              onClick={() => void connect(connection, true)}
                            >
                              {t('settings.linearReconnect')}
                            </Button>
                            <Popconfirm
                              title={t('settings.linearDisconnectConfirm')}
                              onOk={() => disconnect(connection)}
                            >
                              <Button size='small' status='danger' loading={busy[`disconnect:${connection.id}`]}>
                                {t('settings.linearDisconnect')}
                              </Button>
                            </Popconfirm>
                          </>
                        ) : (
                          <>
                            <Button
                              size='small'
                              type='primary'
                              icon={<Login theme='outline' size={14} fill='currentColor' />}
                              loading={busy[`connect:${connection.id}`] || connection.status === 'connecting'}
                              onClick={() => void connect(connection, connection.status === 'reconnect_required')}
                            >
                              {connection.status === 'reconnect_required'
                                ? t('settings.linearReconnect')
                                : t('settings.linearConnect')}
                            </Button>
                            {connection.status === 'reconnect_required' && (
                              <Popconfirm
                                title={t('settings.linearDisconnectConfirm')}
                                onOk={() => disconnect(connection)}
                              >
                                <Button size='small' status='danger' loading={busy[`disconnect:${connection.id}`]}>
                                  {t('settings.linearDisconnect')}
                                </Button>
                              </Popconfirm>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                    {connection.identity && (
                      <div className='flex gap-6px flex-wrap'>
                        {connection.capabilities.issues_read && <Tag>{t('settings.linearCapabilityIssuesRead')}</Tag>}
                        {connection.capabilities.issues_write && <Tag>{t('settings.linearCapabilityIssuesWrite')}</Tag>}
                        {connection.capabilities.comments_write && <Tag>{t('settings.linearCapabilityComments')}</Tag>}
                        {connection.capabilities.attachment_metadata && (
                          <Tag>{t('settings.linearCapabilityAttachments')}</Tag>
                        )}
                        {connection.capabilities.attachment_images && <Tag>{t('settings.linearCapabilityImages')}</Tag>}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : null}

            <div className='text-12px text-t-secondary bg-fill-2 rd-10px px-12px py-10px'>
              {t('settings.linearAccountSelectionHelp')}
            </div>
          </section>
        ) : selectedPlugin.name === 'clockify' ? (
          <ClockifyAccounts
            enabled={selectedPlugin.enabled}
            value={clockify}
            loadError={clockifyLoadError}
            retrying={clockifyRetrying}
            onRetry={() => void retryClockify()}
            onChange={(connections) => {
              setClockify(connections);
              setClockifyLoadError(false);
            }}
          />
        ) : selectedPlugin.name === 'notion' ? (
          <NotionAccounts enabled={selectedPlugin.enabled} onChange={setNotion} />
        ) : selectedPlugin.name === 'computer-use' ? (
          <ComputerUseSetup webUiBrowserMode={webUiBrowserMode} />
        ) : (
          <section className='bg-2 border border-border-2 rd-16px p-20px'>
            <div className='text-16px font-600 text-t-primary'>{t('settings.pluginInformation')}</div>
            <div className='text-13px text-t-secondary mt-6px'>
              {selectedPlugin.name === 'mobile'
                ? t('settings.mobilePluginInformation')
                : selectedPlugin.description || t('settings.pluginNoDescription')}
            </div>
          </section>
        )}
      </div>
    );
  }

  if (showingInstall && canManagePluginPackages) {
    return (
      <div className='flex flex-col gap-16px pb-20px'>
        <div className='flex items-center gap-8px text-13px text-t-secondary'>
          <Button
            type='text'
            className='!px-0'
            icon={<ArrowLeft />}
            disabled={busy['install-plugin']}
            onClick={() => changeInstallView(false)}
          >
            {t('settings.pluginDetailBack')}
          </Button>
          <span>/</span>
          <span className='text-t-primary'>{t('settings.pluginInstallGit')}</span>
        </div>
        <section className='bg-2 border border-border-2 rd-16px p-16px flex flex-col gap-12px'>
          <div>
            <div className='text-16px font-600 text-t-primary'>{t('settings.pluginInstallGit')}</div>
            <div className='text-13px text-t-secondary mt-4px'>{t('settings.pluginInstallGitDescription')}</div>
          </div>
          <div className='grid grid-cols-1 md:grid-cols-2 gap-10px'>
            <label className='md:col-span-2 flex flex-col gap-5px text-12px text-t-secondary'>
              {t('settings.pluginGitUrl')}
              <Input value={gitUrl} placeholder={t('settings.pluginGitUrlPlaceholder')} onChange={setGitUrl} />
            </label>
            <label className='flex flex-col gap-5px text-12px text-t-secondary'>
              {t('settings.pluginGitRef')}
              <Input value={gitRef} placeholder={t('settings.pluginGitRefPlaceholder')} onChange={setGitRef} />
            </label>
            <label className='flex flex-col gap-5px text-12px text-t-secondary'>
              {t('settings.pluginGitSubdirectory')}
              <Input
                value={gitSubdirectory}
                placeholder={t('settings.pluginGitSubdirectoryPlaceholder')}
                onChange={setGitSubdirectory}
              />
            </label>
          </div>
          <div className='flex justify-end'>
            <Button
              type='primary'
              className={AION_ADD_BUTTON_CLASS}
              loading={busy['install-plugin']}
              onClick={() => void installGitPlugin()}
            >
              {t('settings.pluginInstall')}
            </Button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className='flex flex-col gap-16px pb-20px'>
      {canManagePluginPackages && !onInstallViewChange && (
        <div className='flex justify-end'>
          <Button type='primary' size='small' className={AION_ADD_BUTTON_CLASS} onClick={() => changeInstallView(true)}>
            {t('settings.pluginInstall')}
          </Button>
        </div>
      )}

      <Input
        value={search}
        allowClear
        prefix={<Search className='text-t-secondary' />}
        placeholder={t('settings.pluginsSearchPlaceholder')}
        onChange={setSearch}
      />

      <section className='bg-2 border border-border-2 rd-16px p-8px md:p-10px flex flex-col gap-8px'>
        <div>
          <div className='px-6px pt-4px text-16px font-600 text-t-primary'>{t('settings.installedPlugins')}</div>
          <div className='px-6px text-13px text-t-secondary mt-4px'>{t('settings.installedPluginsDescription')}</div>
        </div>
        {catalogLoadError ? (
          <div role='alert' className='bg-base border border-border-2 rd-12px px-14px py-16px text-center'>
            <div className='text-14px text-status-error'>{t('settings.pluginsLoadError')}</div>
            <Button size='small' className='mt-10px' onClick={() => void load()}>
              {t('common.retry')}
            </Button>
          </div>
        ) : extensions.length === 0 ? (
          <div className='bg-base border border-transparent rd-12px py-10px'>
            <Empty description={t('settings.pluginsEmpty')} />
          </div>
        ) : visiblePlugins.length === 0 ? (
          <div className='bg-base border border-transparent rd-12px py-10px'>
            <Empty description={t('settings.pluginsNoResults')} />
          </div>
        ) : (
          visiblePlugins.map((extension) => (
            <div
              key={extension.name}
              role='button'
              tabIndex={0}
              className='group flex items-center justify-between gap-12px border border-solid border-transparent bg-base rd-12px px-14px py-10px cursor-pointer transition-all duration-180 hover:border-border-1 hover:bg-fill-1 focus-visible:outline-2 focus-visible:outline-primary'
              onClick={() => selectPlugin(extension.name)}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  selectPlugin(extension.name);
                }
              }}
            >
              <div className={`flex min-w-0 flex-1 items-center gap-12px ${extension.enabled ? '' : 'opacity-50'}`}>
                <PluginIcon name={extension.name} />
                <div className='min-w-0'>
                  <div className='flex items-center gap-8px flex-wrap'>
                    <span className='text-14px font-500 text-t-primary truncate'>
                      {extension.display_name || extension.name}
                    </span>
                    {extension.name === 'linear' && linear.connections.length > 0 && (
                      <Tag>
                        {t('settings.pluginAccountCount', {
                          count: linear.connections.filter((connection) => connection.status === 'connected').length,
                        })}
                      </Tag>
                    )}
                    {extension.name === 'clockify' && clockify.connections.length > 0 && (
                      <Tag>
                        {t('settings.pluginAccountCount', {
                          count: clockify.connections.filter((connection) => connection.status === 'connected').length,
                        })}
                      </Tag>
                    )}
                    {extension.name === 'notion' && notion.connections.length > 0 && (
                      <Tag>
                        {t('settings.pluginAccountCount', {
                          count: notion.connections.filter((connection) => connection.status === 'connected').length,
                        })}
                      </Tag>
                    )}
                    {extension.package_format !== 'native' && (
                      <Tag>{t(`settings.pluginFormat.${extension.package_format}`)}</Tag>
                    )}
                    {extension.unsupported_components.length > 0 && (
                      <Tag color='orange'>
                        {t('settings.pluginUnsupportedCount', { count: extension.unsupported_components.length })}
                      </Tag>
                    )}
                  </div>
                  <div className='text-12px text-t-secondary mt-2px'>
                    {extension.description || extension.name} · {extension.version}
                  </div>
                </div>
              </div>
              <div className='flex items-center gap-12px shrink-0'>
                <Switch
                  checked={extension.enabled}
                  loading={busy[`extension:${extension.name}`]}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(enabled) => void toggleExtension(extension, enabled)}
                />
                <Right className='text-t-secondary' />
              </div>
            </div>
          ))
        )}
      </section>
    </div>
  );
};

export default PluginsContent;
