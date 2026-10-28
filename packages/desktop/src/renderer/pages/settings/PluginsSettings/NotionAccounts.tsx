import { ipcBridge } from '@/common';
import { isBackendHttpError } from '@/common/adapter/httpBridge';
import type { NotionConnection, NotionConnections } from '@/common/adapter/ipcBridge';
import { AION_ADD_BUTTON_CLASS } from '@/renderer/components/base/TalkToButlerButton';
import { Button, Message, Popconfirm, Spin, Tag } from '@arco-design/web-react';
import { Link, Refresh, Unlink } from '@icon-park/react';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PluginAccountMutationController, type PluginAccountMutation } from './pluginAccountMutationController';
import PluginAccountCard from './PluginAccountCard';
import PluginIcon from './PluginIcon';

const NotionAccounts: React.FC<{ enabled: boolean; onChange?: (value: NotionConnections) => void }> = ({
  enabled,
  onChange,
}) => {
  const { t } = useTranslation();
  const [value, setValue] = useState<NotionConnections>({ connections: [] });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [pending, setPending] = useState<PluginAccountMutation>();
  const controller = useRef(new PluginAccountMutationController<NotionConnection>()).current;
  const current = useRef(value);
  current.current = value;
  const mounted = useRef(false);
  const loadGeneration = useRef(0);
  const publish = (next: NotionConnections) => {
    current.current = next;
    if (mounted.current) {
      setValue(next);
      onChange?.(next);
      setLoadError(false);
    }
  };
  const load = () => ipcBridge.extensions.getNotionConnections.invoke();
  const refresh = async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    try {
      const next = await load();
      if (mounted.current && generation === loadGeneration.current) publish(next);
    } catch {
      if (mounted.current && generation === loadGeneration.current) setLoadError(true);
    } finally {
      if (mounted.current && generation === loadGeneration.current) setLoading(false);
    }
  };
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      loadGeneration.current++;
    };
  }, []);

  const run = async (mutation: PluginAccountMutation, mutate: () => Promise<NotionConnection>) => {
    loadGeneration.current++;
    const outcome = await controller.run({
      mutation,
      mutate,
      load,
      current: () => current.current,
      publish,
      onPendingChange: (next) => {
        if (mounted.current) setPending(next);
      },
    });
    if (outcome.status === 'rejected' && mounted.current)
      Message.error(
        isBackendHttpError(outcome.error) &&
          outcome.error.backendMessage &&
          ['NOTION_AUTH_FAILED', 'NOTION_ACCOUNT_CONFLICT'].includes(outcome.error.code ?? '')
          ? outcome.error.backendMessage
          : t('settings.notion.connectionFailed')
      );
  };
  const busy = loading || !!pending;
  return (
    <section className='bg-2 border border-border-2 rd-16px p-20px flex flex-col gap-16px'>
      <div className='flex items-center gap-12px'>
        <PluginIcon name='notion' size={36} />
        <div>
          <div className='text-16px font-600 text-t-primary'>{t('settings.notion.accounts')}</div>
          <div className='text-13px text-t-secondary mt-4px'>{t('settings.notion.description')}</div>
        </div>
      </div>
      {!enabled && (
        <div className='text-13px text-t-secondary bg-fill-2 border border-border-2 rd-10px px-12px py-10px'>
          {t('settings.notion.enableFirst')}
        </div>
      )}
      <div className='border border-border-2 rd-12px p-16px flex flex-col gap-12px'>
        <div className='text-14px font-600 text-t-primary'>{t('settings.notion.connectTitle')}</div>
        <div className='flex items-center justify-between gap-12px flex-wrap'>
          <span className='text-12px text-t-secondary'>{t('settings.notion.connectHelp')}</span>
          <Button
            type='primary'
            size='small'
            className={AION_ADD_BUTTON_CLASS}
            disabled={!enabled || busy}
            aria-busy={pending?.kind === 'connect' && !pending.connectionId}
            onClick={() =>
              void run({ kind: 'connect' }, () => ipcBridge.extensions.connectNewNotionConnection.invoke())
            }
          >
            <span className='flex items-center gap-6px'>
              {pending?.kind === 'connect' && !pending.connectionId ? (
                <Spin size={14} />
              ) : (
                <Link theme='outline' size={14} fill='currentColor' />
              )}
              {t('settings.notion.connect')}
            </span>
          </Button>
        </div>
      </div>
      {pending?.kind === 'connect' && (
        <div role='status' className='text-13px text-t-secondary'>
          {t('settings.notion.authorizing')}
        </div>
      )}
      {loading && <Spin />}
      {loadError && (
        <div
          role='alert'
          className='flex items-center justify-between gap-12px bg-fill-2 border border-border-2 rd-10px px-12px py-10px'
        >
          <span className='text-13px text-status-error'>{t('settings.notion.loadFailed')}</span>
          <Button size='small' disabled={busy} onClick={() => void refresh()}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      {!loading && !loadError && value.connections.length === 0 && (
        <div className='text-14px text-t-secondary border border-dashed border-border-2 rd-12px p-20px text-center'>
          {t('settings.notion.empty')}
        </div>
      )}
      {value.connections.map((connection) => (
        <PluginAccountCard
          key={connection.id}
          provider='notion'
          title={connection.label}
          subtitle={connection.identity?.account_email ?? connection.identity?.account_name}
          error={connection.last_error}
          status={
            <Tag color={connection.status === 'connected' ? 'green' : connection.status === 'error' ? 'red' : 'gray'}>
              {t(`settings.notion.status.${connection.status}`)}
            </Tag>
          }
          actions={
            <>
              <Button
                size='small'
                icon={<Refresh theme='outline' size={14} fill='currentColor' />}
                disabled={!enabled || busy}
                loading={pending?.kind === 'connect' && pending.connectionId === connection.id}
                onClick={() =>
                  void run({ kind: 'connect', connectionId: connection.id }, () =>
                    ipcBridge.extensions.connectNotionConnection.invoke({
                      connection_id: connection.id,
                      reconnect: true,
                    })
                  )
                }
              >
                {t('settings.notion.reconnect')}
              </Button>
              <Popconfirm
                title={t('settings.notion.disconnectConfirm')}
                onOk={() =>
                  run({ kind: 'disconnect', connectionId: connection.id }, () =>
                    ipcBridge.extensions.disconnectNotionConnection.invoke({ connection_id: connection.id })
                  )
                }
              >
                <Button
                  size='small'
                  status='danger'
                  icon={<Unlink theme='outline' size={14} fill='currentColor' />}
                  disabled={busy || connection.status === 'disconnected'}
                  loading={pending?.kind === 'disconnect' && pending.connectionId === connection.id}
                >
                  {t('settings.notion.disconnect')}
                </Button>
              </Popconfirm>
            </>
          }
        >
          {connection.identity && (
            <div className='flex gap-6px flex-wrap'>
              <Tag>{connection.identity.workspace_name || connection.identity.workspace_id}</Tag>
            </div>
          )}
        </PluginAccountCard>
      ))}
      <div className='text-12px text-t-secondary bg-fill-2 rd-10px px-12px py-10px'>
        {t('settings.notion.selectionHelp')}
      </div>
    </section>
  );
};
export default NotionAccounts;
