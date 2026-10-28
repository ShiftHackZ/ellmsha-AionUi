import { ipcBridge } from '@/common';
import type { ClockifyConnection, ClockifyConnections, ClockifyRealm } from '@/common/adapter/ipcBridge';
import { AION_ADD_BUTTON_CLASS } from '@/renderer/components/base/TalkToButlerButton';
import { Button, Input, Message, Popconfirm, Select, Spin, Tag } from '@arco-design/web-react';
import { Link, Refresh, Unlink } from '@icon-park/react';
import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PluginAccountMutationController, type PluginAccountMutation } from './pluginAccountMutationController';
import { clockifyConnectError } from './pluginViewModel';
import PluginAccountCard from './PluginAccountCard';
import PluginIcon from './PluginIcon';

type ClockifyAccountsProps = {
  enabled: boolean;
  value: ClockifyConnections;
  loadError: boolean;
  retrying: boolean;
  onRetry: () => void;
  onChange: (value: ClockifyConnections) => void;
};

const REALMS: ClockifyRealm[] = ['global', 'eu', 'us', 'uk', 'au'];

const ClockifyAccounts: React.FC<ClockifyAccountsProps> = ({
  enabled,
  value,
  loadError,
  retrying,
  onRetry,
  onChange,
}) => {
  const { t } = useTranslation();
  const [apiKey, setApiKey] = useState('');
  const [realm, setRealm] = useState<ClockifyRealm>('global');
  const [reconnectId, setReconnectId] = useState<string>();
  const [pending, setPending] = useState<PluginAccountMutation>();
  const mutationController = useRef(new PluginAccountMutationController()).current;
  const valueRef = useRef(value);
  valueRef.current = value;

  const publish = (next: ClockifyConnections) => {
    valueRef.current = next;
    onChange(next);
  };

  const connect = async () => {
    const targetId = reconnectId;
    const submittedApiKey = apiKey;
    const submittedRealm = realm;
    const outcome = await mutationController.run({
      mutation: { kind: 'connect', connectionId: targetId },
      mutate: () =>
        targetId
          ? ipcBridge.extensions.reconnectClockifyConnection.invoke({
              connection_id: targetId,
              api_key: submittedApiKey,
              realm: submittedRealm,
            })
          : ipcBridge.extensions.connectNewClockifyConnection.invoke({
              api_key: submittedApiKey,
              realm: submittedRealm,
            }),
      load: () => ipcBridge.extensions.getClockifyConnections.invoke(),
      current: () => valueRef.current,
      publish,
      onPendingChange: setPending,
    });
    if (outcome.status === 'fulfilled') {
      setApiKey('');
      setReconnectId(undefined);
      Message.success(t('settings.clockifyConnected'));
    } else if (outcome.status === 'rejected') {
      console.error('[ClockifyAccounts] Clockify API-key verification failed:', outcome.error);
      Message.error(clockifyConnectError(outcome.error, t('settings.clockifyConnectError')));
    }
  };

  const disconnect = async (connection: ClockifyConnection) => {
    const outcome = await mutationController.run({
      mutation: { kind: 'disconnect', connectionId: connection.id },
      mutate: () =>
        ipcBridge.extensions.disconnectClockifyConnection.invoke({
          connection_id: connection.id,
        }),
      load: () => ipcBridge.extensions.getClockifyConnections.invoke(),
      current: () => valueRef.current,
      publish,
      onPendingChange: setPending,
    });
    if (outcome.status === 'fulfilled') {
      if (reconnectId === connection.id) {
        setReconnectId(undefined);
        setApiKey('');
      }
      Message.success(t('settings.clockifyDisconnected'));
    } else if (outcome.status === 'rejected') {
      console.error('[ClockifyAccounts] Failed to disconnect Clockify connection:', outcome.error);
      Message.error(t('settings.clockifyDisconnectError'));
    }
  };

  const reconnect = (connection: ClockifyConnection) => {
    if (mutationController.pending) return;
    setReconnectId(connection.id);
    setRealm(connection.realm);
    setApiKey('');
  };

  const cancelReconnect = () => {
    if (mutationController.pending) return;
    setReconnectId(undefined);
    setApiKey('');
  };

  const mutationPending = pending !== undefined;
  const connecting = pending?.kind === 'connect';
  const reconnectTarget = value.connections.find((connection) => connection.id === reconnectId);

  return (
    <section className='bg-2 border border-border-2 rd-16px p-20px flex flex-col gap-16px'>
      <div className='flex items-center gap-12px'>
        <PluginIcon name='clockify' size={36} />
        <div>
          <div className='text-16px font-600 text-t-primary'>{t('settings.clockifyConnectedAccounts')}</div>
          <div className='text-13px text-t-secondary mt-4px'>{t('settings.clockifyConnectedAccountsDescription')}</div>
        </div>
      </div>

      {!enabled && (
        <div className='text-13px text-t-secondary bg-fill-2 border border-border-2 rd-10px px-12px py-10px'>
          {t('settings.clockifyPluginInactive')}
        </div>
      )}

      {loadError && (
        <div className='flex items-center justify-between gap-12px bg-fill-2 border border-border-2 rd-10px px-12px py-10px'>
          <span className='text-13px text-status-error'>{t('settings.clockifyAccountsLoadError')}</span>
          <Button
            size='small'
            loading={retrying}
            disabled={mutationPending}
            onClick={() => {
              if (!mutationController.pending) onRetry();
            }}
          >
            {t('common.retry')}
          </Button>
        </div>
      )}

      <div className='border border-border-2 rd-12px p-16px flex flex-col gap-12px'>
        <div className='text-14px font-600 text-t-primary'>
          {reconnectTarget
            ? t('settings.clockifyReconnectAccount', { name: reconnectTarget.label })
            : t('settings.clockifyConnectAccount')}
        </div>
        <div className='grid grid-cols-[minmax(140px,180px)_minmax(0,1fr)] gap-10px max-sm:grid-cols-1'>
          <Select
            value={realm}
            disabled={mutationPending}
            aria-label={t('settings.clockifyRegionLabel')}
            onChange={(next) => {
              if (!mutationController.pending) setRealm(next as ClockifyRealm);
            }}
          >
            {REALMS.map((item) => (
              <Select.Option key={item} value={item}>
                {t(`settings.clockifyRegion.${item}`)}
              </Select.Option>
            ))}
          </Select>
          <Input.Password
            value={apiKey}
            disabled={mutationPending}
            aria-label={t('settings.clockifyApiKeyLabel')}
            placeholder={t('settings.clockifyApiKeyPlaceholder')}
            autoComplete='off'
            onChange={(next) => {
              if (!mutationController.pending) setApiKey(next);
            }}
            onPressEnter={() => {
              if (apiKey && !mutationPending) void connect();
            }}
          />
        </div>
        <div className='flex items-center justify-between gap-12px flex-wrap'>
          <span className='text-12px text-t-secondary'>{t('settings.clockifyApiKeyHelp')}</span>
          <div className='flex gap-8px'>
            {reconnectTarget && (
              <Button size='small' disabled={mutationPending} onClick={cancelReconnect}>
                {t('common.cancel')}
              </Button>
            )}
            <Button
              type='primary'
              size='small'
              className={AION_ADD_BUTTON_CLASS}
              disabled={!apiKey || mutationPending}
              aria-busy={connecting}
              onClick={() => void connect()}
            >
              <span className='flex items-center gap-6px'>
                {connecting ? <Spin size={14} /> : <Link theme='outline' size={14} fill='currentColor' />}
                {reconnectTarget ? t('settings.clockifyReconnect') : t('settings.clockifyConnect')}
              </span>
            </Button>
          </div>
        </div>
      </div>

      {value.connections.length === 0 ? (
        !loadError && (
          <div className='text-14px text-t-secondary border border-dashed border-border-2 rd-12px p-20px text-center'>
            {t('settings.clockifyNoConnectedAccounts')}
          </div>
        )
      ) : (
        <div className='flex flex-col gap-12px'>
          {value.connections.map((connection) => (
            <PluginAccountCard
              key={connection.id}
              provider='clockify'
              title={connection.label}
              subtitle={connection.identity?.account_email ?? connection.identity?.account_name}
              error={connection.last_error}
              status={
                <>
                  <Tag
                    color={connection.status === 'connected' ? 'green' : connection.status === 'error' ? 'red' : 'gray'}
                  >
                    {t(`settings.clockifyStatus.${connection.status}`)}
                  </Tag>
                  <Tag>{t(`settings.clockifyRegion.${connection.realm}`)}</Tag>
                </>
              }
              actions={
                <>
                  <Button
                    size='small'
                    icon={<Refresh theme='outline' size={14} fill='currentColor' />}
                    loading={pending?.kind === 'connect' && pending.connectionId === connection.id}
                    disabled={mutationPending}
                    onClick={() => reconnect(connection)}
                  >
                    {t('settings.clockifyReconnect')}
                  </Button>
                  <Popconfirm title={t('settings.clockifyDisconnectConfirm')} onOk={() => disconnect(connection)}>
                    <Button
                      size='small'
                      status='danger'
                      icon={<Unlink theme='outline' size={14} fill='currentColor' />}
                      loading={pending?.kind === 'disconnect' && pending.connectionId === connection.id}
                      disabled={mutationPending}
                    >
                      {t('settings.clockifyDisconnect')}
                    </Button>
                  </Popconfirm>
                </>
              }
            >
              {connection.workspaces.length > 0 && (
                <div className='flex gap-6px flex-wrap'>
                  {connection.workspaces.map((workspace) => (
                    <Tag key={workspace.id}>{workspace.name}</Tag>
                  ))}
                </div>
              )}
            </PluginAccountCard>
          ))}
        </div>
      )}

      <div className='text-12px text-t-secondary bg-fill-2 rd-10px px-12px py-10px'>
        {t('settings.clockifyAccountSelectionHelp')}
      </div>
    </section>
  );
};

export default ClockifyAccounts;
