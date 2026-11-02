import { ipcBridge } from '@/common';
import { isBackendHttpError, isWebUiBrowserMode } from '@/common/adapter/httpBridge';
import type { FigmaConnection, FigmaConnections } from '@/common/adapter/ipcBridge';
import { AION_ADD_BUTTON_CLASS } from '@/renderer/components/base/TalkToButlerButton';
import { Button, Input, Message, Popconfirm, Spin, Tag } from '@arco-design/web-react';
import { Link, Refresh, Unlink } from '@icon-park/react';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PluginAccountMutationController, type PluginAccountMutation } from './pluginAccountMutationController';
import PluginAccountCard from './PluginAccountCard';
import PluginIcon from './PluginIcon';

const FigmaAccounts: React.FC<{ enabled: boolean; onChange?: (value: FigmaConnections) => void }> = ({
  enabled,
  onChange,
}) => {
  const { t } = useTranslation();
  const [value, setValue] = useState<FigmaConnections>({ connections: [] });
  const [token, setToken] = useState('');
  const [reconnectId, setReconnectId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [pending, setPending] = useState<PluginAccountMutation>();
  const controller = useRef(new PluginAccountMutationController<FigmaConnection>()).current;
  const current = useRef(value);
  current.current = value;
  const mounted = useRef(false);
  const generation = useRef(0);
  const publish = (next: FigmaConnections) => {
    current.current = next;
    if (mounted.current) {
      setValue(next);
      setLoadError(false);
      onChange?.(next);
    }
  };
  const load = () => ipcBridge.extensions.getFigmaConnections.invoke();
  const refresh = async () => {
    if (controller.pending) return;
    const request = ++generation.current;
    setLoading(true);
    try {
      const next = await load();
      if (mounted.current && request === generation.current) publish(next);
    } catch {
      if (mounted.current && request === generation.current) setLoadError(true);
    } finally {
      if (mounted.current && request === generation.current) setLoading(false);
    }
  };
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  const run = async (mutation: PluginAccountMutation, mutate: () => Promise<FigmaConnection>) => {
    generation.current++;
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
    if (!mounted.current) return;
    if (outcome.status === 'fulfilled') {
      setToken('');
      setReconnectId(undefined);
    }
    if (outcome.status === 'rejected') {
      Message.error(
        isBackendHttpError(outcome.error) && outcome.error.code === 'FIGMA_AUTH_FAILED' && outcome.error.backendMessage
          ? outcome.error.backendMessage
          : t('settings.figma.failed')
      );
    }
  };
  const busy = loading || !!pending;
  const connect = () => {
    const personal_access_token = token;
    const connection_id = reconnectId;
    return run({ kind: 'connect', connectionId: connection_id }, () =>
      connection_id
        ? ipcBridge.extensions.reconnectFigmaConnection.invoke({ connection_id, personal_access_token })
        : ipcBridge.extensions.connectNewFigmaConnection.invoke({ personal_access_token })
    );
  };
  return (
    <section className='bg-2 border border-border-2 rd-16px p-20px flex flex-col gap-16px'>
      <div className='flex items-center gap-12px'>
        <PluginIcon name='figma' size={36} />
        <div>
          <div className='text-16px font-600 text-t-primary'>{t('settings.figma.accounts')}</div>
          <div className='text-13px text-t-secondary mt-4px'>{t('settings.figma.description')}</div>
        </div>
      </div>
      {!enabled && <div className='text-13px text-t-secondary'>{t('settings.figma.enableFirst')}</div>}
      <div className='border border-border-2 rd-12px p-16px flex flex-col gap-12px'>
        <div className='text-14px font-600 text-t-primary'>
          {reconnectId ? t('settings.figma.reconnect') : t('settings.figma.connect')}
        </div>
        <Input.Password
          value={token}
          autoComplete='off'
          disabled={!enabled || busy}
          aria-label={t('settings.figma.token')}
          placeholder={t('settings.figma.token')}
          onChange={(next) => {
            if (!controller.pending) setToken(next);
          }}
          onPressEnter={() => {
            if (enabled && !busy && token) void connect();
          }}
        />
        <div className='text-12px text-t-secondary'>{t('settings.figma.tokenHelp')}</div>
        <div className='flex justify-end gap-8px'>
          {reconnectId && (
            <Button
              disabled={busy}
              onClick={() => {
                setReconnectId(undefined);
                setToken('');
              }}
            >
              {t('common.cancel')}
            </Button>
          )}
          <Button
            type='primary'
            className={AION_ADD_BUTTON_CLASS}
            disabled={!enabled || busy || !token}
            loading={pending?.kind === 'connect'}
            icon={<Link size={14} />}
            onClick={() => void connect()}
          >
            {reconnectId ? t('settings.figma.reconnect') : t('settings.figma.connect')}
          </Button>
        </div>
      </div>
      {!isWebUiBrowserMode() && (
        <div className='text-12px text-t-secondary bg-fill-2 rd-10px p-12px'>{t('settings.figma.browserHelp')}</div>
      )}
      {loading && <Spin />}
      {loadError && (
        <div role='alert' className='flex justify-between items-center gap-12px'>
          <span className='text-status-error'>{t('settings.figma.loadFailed')}</span>
          <Button disabled={busy} onClick={() => void refresh()}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      {!loading && !loadError && value.connections.length === 0 && (
        <div className='text-t-secondary text-center p-20px'>{t('settings.figma.empty')}</div>
      )}
      {value.connections.map((connection) => (
        <PluginAccountCard
          key={connection.id}
          provider='figma'
          title={connection.label}
          subtitle={connection.identity?.account_email}
          error={connection.last_error}
          status={
            <Tag color={connection.status === 'connected' ? 'green' : connection.status === 'error' ? 'red' : 'gray'}>
              {t(`settings.figma.status.${connection.status}`)}
            </Tag>
          }
          actions={
            <>
              <Button
                size='small'
                disabled={!enabled || busy}
                icon={<Refresh size={14} />}
                onClick={() => {
                  if (!controller.pending) {
                    setReconnectId(connection.id);
                    setToken('');
                  }
                }}
              >
                {t('settings.figma.reconnect')}
              </Button>
              <Popconfirm
                title={t('settings.figma.disconnectConfirm')}
                onOk={() =>
                  run({ kind: 'disconnect', connectionId: connection.id }, () =>
                    ipcBridge.extensions.disconnectFigmaConnection.invoke({ connection_id: connection.id })
                  )
                }
              >
                <Button
                  size='small'
                  status='danger'
                  disabled={busy || connection.status === 'disconnected'}
                  icon={<Unlink size={14} />}
                >
                  {t('settings.figma.disconnect')}
                </Button>
              </Popconfirm>
            </>
          }
        />
      ))}
      <div className='flex justify-end'>
        <Button size='small' disabled={busy} onClick={() => void refresh()}>
          {t('common.refresh')}
        </Button>
      </div>
      <div className='text-12px text-t-secondary'>{t('settings.figma.selectionHelp')}</div>
    </section>
  );
};
export default FigmaAccounts;
