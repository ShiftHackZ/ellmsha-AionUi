import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from '@icon-park/react';
import { Button, Tag, Typography } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { useCopilotIde } from './useCopilotIde';

/** Desktop provider setup. Status polling never starts the IDE runtime. */
export default function CopilotIdeSetup() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { status, busy, error, act, available } = useCopilotIde();
  if (!available) return null;
  return (
    <div className='flex h-full min-h-0 flex-col overflow-hidden bg-transparent' data-testid='copilot-ide-setup'>
      <div className='sticky top-0 z-10 flex h-48px flex-shrink-0 items-center gap-10px border-b border-border-2 bg-bg-0 px-18px'>
        <Button
          type='text'
          icon={<ArrowLeft size={16} />}
          onClick={() => navigate('/settings/agent')}
          className='!rounded-8px !px-6px !text-t-primary'
        >
          {t('common.goBack')}
        </Button>
        <div className='truncate text-14px font-600 text-t-primary'>Copilot IDE</div>
      </div>
      <div className='min-h-0 flex-1 overflow-auto px-18px py-18px pb-24px'>
        <div className='mx-auto flex w-full max-w-760px flex-col gap-16px'>
          <Typography.Text type='secondary'>{t('settings.copilotIde.description')}</Typography.Text>
          <Typography.Text type='secondary'>
            {t(status?.running ? 'settings.copilotIde.running' : 'settings.copilotIde.sleeping')}
            {status?.models.length ? ` · ${status.models.length}` : ''}
          </Typography.Text>
          {status && !status.runtimeAvailable && (
            <Typography.Text type='warning'>{t('settings.copilotIde.missing')}</Typography.Text>
          )}
          {error && <Typography.Text type='error'>{error}</Typography.Text>}
          <div className='flex flex-wrap gap-8px'>
            <Button
              type='outline'
              size='small'
              className='!h-30px !rounded-8px !border-border-2 !bg-base !px-10px !text-12px !font-500 !text-t-primary hover:!border-border-1 hover:!bg-fill-1'
              loading={busy}
              disabled={!status || status.busy || (!status.enabled && !status.runtimeAvailable)}
              onClick={() => void act(status?.enabled ? 'disable' : 'enable')}
            >
              {t(status?.enabled ? 'settings.copilotIde.disable' : 'settings.copilotIde.enable')}
            </Button>
            <Button
              type='outline'
              size='small'
              className='!h-30px !rounded-8px !border-border-2 !bg-base !px-10px !text-12px !font-500 !text-t-primary hover:!border-border-1 hover:!bg-fill-1'
              disabled={busy || !status?.enabled || status.busy}
              onClick={() => void act('login')}
            >
              {t('settings.copilotIde.login')}
            </Button>
            <Button
              type='outline'
              size='small'
              className='!h-30px !rounded-8px !border-border-2 !bg-base !px-10px !text-12px !font-500 !text-t-primary hover:!border-border-1 hover:!bg-fill-1'
              disabled={busy || !status?.enabled}
              onClick={() => void act('refresh')}
            >
              {t('settings.copilotIde.refresh')}
            </Button>
            <Button
              type='outline'
              size='small'
              className='!h-30px !rounded-8px !border-border-2 !bg-base !px-10px !text-12px !font-500 !text-t-primary hover:!border-border-1 hover:!bg-fill-1'
              disabled={busy || !status?.running || status.busy}
              onClick={() => void act('stop')}
            >
              {t('settings.copilotIde.stop')}
            </Button>
          </div>
          <Typography.Text type='secondary'>{t('settings.copilotIde.modelsHint')}</Typography.Text>
          <div className='flex flex-wrap gap-8px'>
            {status?.models.map((model) => (
              <Tag key={model}>{model}</Tag>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
