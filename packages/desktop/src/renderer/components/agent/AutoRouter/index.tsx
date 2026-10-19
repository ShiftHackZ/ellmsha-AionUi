import React, { useEffect, useState } from 'react';
import { Alert, Button, Message, Spin } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import AionModal from '@/renderer/components/base/AionModal';
import { parseError } from '@/common/utils';
import type { RouterConfig } from '@/common/types/agent/routerTypes';
import RouterConfigFields from './RouterConfigFields';
import { routerConfigError, useRouterConfig, useRouterOptions } from './useRouter';

export const RouterPolicyButton: React.FC<{
  value?: RouterConfig;
  onChange: (value: RouterConfig) => void;
  loading?: boolean;
  error?: unknown;
}> = ({ value, onChange, loading, error }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<RouterConfig>();
  useEffect(() => {
    if (open && !draft && value) setDraft(value);
  }, [open, draft, value]);
  const { options } = useRouterOptions();
  const issue = draft ? routerConfigError(draft, options, true) : undefined;
  return (
    <>
      <Button
        data-testid='router-policy-button'
        size='small'
        shape='round'
        loading={loading}
        onClick={() => {
          setDraft(value);
          setOpen(true);
        }}
      >
        {t('settings.autoRouter.title')}
        {value ? ` · ${t(`settings.autoRouter.modes.${value.mode}`)}` : ''}
      </Button>
      <AionModal
        visible={open}
        title={t('settings.autoRouter.title')}
        onCancel={() => setOpen(false)}
        onOk={() => {
          if (draft && !issue && !error) {
            onChange(draft);
            setOpen(false);
          }
        }}
        okButtonProps={{ disabled: Boolean(issue || error || !draft) }}
      >
        {error ? (
          <Alert type='error' content={parseError(error)} />
        ) : draft ? (
          <>
            <RouterConfigFields value={draft} onChange={setDraft} options={options} />
            {issue && <Alert className='mt-12px' type='warning' content={t(`settings.autoRouter.errors.${issue}`)} />}
          </>
        ) : (
          <Spin />
        )}
      </AionModal>
    </>
  );
};

const AutoRouterSettings: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const query = useRouterConfig();
  const catalog = useRouterOptions();
  const [value, setValue] = useState<RouterConfig>();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (query.data) setValue(query.data);
  }, [query.data]);
  const issue = value ? routerConfigError(value, catalog.options) : undefined;
  return (
    <div className='h-full overflow-y-auto p-20px text-t-primary' data-testid='router-settings-page'>
      <div className='mx-auto flex max-w-680px flex-col gap-16px'>
        <div className='flex items-center justify-between gap-12px'>
          <Button onClick={() => navigate('/settings/agent')}>{t('common.back')}</Button>
          <h2 className='m-0 text-20px'>{t('settings.autoRouter.title')}</h2>
        </div>
        <p className='m-0 text-t-secondary'>{t('settings.autoRouter.description')}</p>
        {query.error || catalog.error ? (
          <Alert type='error' content={parseError(query.error || catalog.error)} />
        ) : null}
        {!value || catalog.loading ? (
          <Spin />
        ) : (
          <>
            <RouterConfigFields value={value} onChange={setValue} options={catalog.options} />
            {issue && <Alert type='warning' content={t(`settings.autoRouter.errors.${issue}`)} />}
            <Button
              type='primary'
              data-testid='router-save'
              loading={saving}
              disabled={Boolean(issue)}
              onClick={async () => {
                setSaving(true);
                try {
                  await query.save(value);
                  Message.success(t('settings.autoRouter.saved'));
                } catch (error) {
                  Message.error(parseError(error));
                } finally {
                  setSaving(false);
                }
              }}
            >
              {t('common.save')}
            </Button>
          </>
        )}
      </div>
    </div>
  );
};
export default AutoRouterSettings;
