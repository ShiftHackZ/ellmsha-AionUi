import React, { useEffect, useState } from 'react';
import { Alert, Button, Message, Spin } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import AionModal from '@/renderer/components/base/AionModal';
import { parseError } from '@/common/utils';
import type { RouterSettings } from '@/common/types/agent/routerTypes';
import RouterConfigFields from './RouterConfigFields';
import { useRouterConfig, useRouterOptions } from './useRouter';
import { activeRouterConfig, cloneRouterSettings, routerReadinessError } from './routerConfigState';

export const RouterPolicyButton: React.FC<{
  value?: RouterSettings;
  onChange: (value: RouterSettings) => void;
  loading?: boolean;
  error?: unknown;
}> = ({ value, onChange, loading, error }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [incomplete, setIncomplete] = useState(false);
  const [draft, setDraft] = useState<RouterSettings>();
  useEffect(() => {
    if (open && !draft && value) setDraft(cloneRouterSettings(value));
  }, [open, draft, value]);
  const catalog = useRouterOptions(draft && activeRouterConfig(draft), open);
  const issue = draft ? routerReadinessError(activeRouterConfig(draft)) : undefined;
  return (
    <>
      <Button
        data-testid='router-policy-button'
        size='small'
        shape='round'
        loading={loading}
        onClick={() => {
          setIncomplete(false);
          setDraft(value && cloneRouterSettings(value));
          setOpen(true);
        }}
      >
        {t('settings.autoRouter.title')}
        {value ? ` · ${t(`settings.autoRouter.modes.${value.active_mode}`)}` : ''}
      </Button>
      <AionModal
        visible={open}
        title={t('settings.autoRouter.title')}
        size='xlarge'
        variant='standard'
        onCancel={() => {
          setOpen(false);
          setDraft(undefined);
        }}
        onOk={() => {
          if (draft && !issue && !incomplete && !error) {
            onChange(cloneRouterSettings(draft));
            setOpen(false);
            setDraft(undefined);
          }
        }}
        okButtonProps={{ disabled: Boolean(issue || incomplete || error || !draft) }}
      >
        {open &&
          (error ? (
            <Alert type='error' content={parseError(error)} />
          ) : draft ? (
            <>
              {catalog.error && <Alert type='error' content={parseError(catalog.error)} />}
              {catalog.loading && <Spin size={16} />}
              <RouterConfigFields
                value={draft}
                onChange={setDraft}
                options={catalog.options}
                onIncompleteChange={setIncomplete}
              />
              {incomplete && (
                <Alert
                  className='mt-12px'
                  type='warning'
                  content={t('settings.autoRouter.graph.errors.incompleteClasses')}
                />
              )}
              {issue && (
                <Alert className='mt-12px' type='warning' content={t(`settings.autoRouter.graph.errors.${issue}`)} />
              )}
            </>
          ) : (
            <Spin />
          ))}
      </AionModal>
    </>
  );
};

const AutoRouterSettings: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const query = useRouterConfig();
  const [value, setValue] = useState<RouterSettings>();
  const [dirty, setDirty] = useState(false);
  const [editorRevision, setEditorRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [incomplete, setIncomplete] = useState(false);
  useEffect(() => {
    if (query.data && !dirty) setValue(cloneRouterSettings(query.data));
  }, [query.data, dirty]);
  const catalog = useRouterOptions(value && activeRouterConfig(value), Boolean(value));
  const issue = value ? routerReadinessError(activeRouterConfig(value)) : undefined;
  return (
    <div className='h-full overflow-y-auto p-20px text-t-primary' data-testid='router-settings-page'>
      <div className='mx-auto flex max-w-960px flex-col gap-16px'>
        <div className='flex items-center justify-between gap-12px'>
          <Button disabled={saving} onClick={() => navigate('/settings/agent')}>
            {t('common.back')}
          </Button>
          <h2 className='m-0 text-20px'>{t('settings.autoRouter.title')}</h2>
        </div>
        <p className='m-0 text-t-secondary'>{t('settings.autoRouter.description')}</p>
        {query.error || catalog.error ? (
          <Alert type='error' content={parseError(query.error || catalog.error)} />
        ) : null}
        {catalog.loading && value && <Spin size={16} />}
        {!value ? (
          <Spin />
        ) : (
          <>
            <fieldset disabled={saving} inert={saving} aria-busy={saving} className='m-0 min-w-0 border-0 p-0'>
              <RouterConfigFields
                key={editorRevision}
                value={value}
                onChange={(next) => {
                  if (saving) return;
                  setValue(next);
                  setDirty(true);
                }}
                options={catalog.options}
                onIncompleteChange={setIncomplete}
              />
            </fieldset>
            {incomplete && <Alert type='warning' content={t('settings.autoRouter.graph.errors.incompleteClasses')} />}
            {issue && <Alert type='warning' content={t(`settings.autoRouter.graph.errors.${issue}`)} />}
            <div className='flex items-center flex-wrap gap-12px'>
              <Button
                type='primary'
                data-testid='router-save'
                loading={saving}
                disabled={Boolean(issue || incomplete || saving || !dirty || query.error)}
                onClick={async () => {
                  setSaving(true);
                  try {
                    await query.save(cloneRouterSettings(value));
                    setDirty(false);
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
              <Button
                disabled={saving}
                onClick={() => {
                  if (query.data) setValue(cloneRouterSettings(query.data));
                  setDirty(false);
                  setIncomplete(false);
                  setEditorRevision((revision) => revision + 1);
                }}
              >
                {t('common.cancel')}
              </Button>
              {dirty && (
                <span role='status' className='text-12px text-t-secondary'>
                  {t('settings.autoRouter.graph.dirty')}
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
export default AutoRouterSettings;
