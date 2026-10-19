import React, { useState } from 'react';
import { Alert, Checkbox, InputNumber, Message, Select } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import {
  routerTargetKey,
  type RouterConfig,
  type RouterHint,
  type RouterTarget,
  type RouterTaskKind,
} from '@/common/types/agent/routerTypes';
import type { RouterOption } from './useRouter';

const TASKS: RouterTaskKind[] = ['coding', 'review', 'research', 'writing', 'analysis', 'general'];
const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className='flex min-w-0 flex-col gap-6px'>
    <span className='text-13px font-500 text-t-primary'>{label}</span>
    {children}
  </div>
);

/** Shared real form for persisted defaults and per-chat policy overrides. */
const RouterConfigFields: React.FC<{
  value: RouterConfig;
  onChange: (value: RouterConfig) => void;
  options: RouterOption[];
}> = ({ value, onChange, options }) => {
  const { t } = useTranslation();
  const [hintKey, setHintKey] = useState<string>();
  const update = (patch: Partial<RouterConfig>) => onChange({ ...value, ...patch });
  const selectedHintOption = options.find((option) => option.key === hintKey);
  const hint = value.hints.find((item) => routerTargetKey(item.target) === hintKey);
  const setHint = (patch: Partial<RouterHint>) => {
    if (!selectedHintOption) return;
    const next: RouterHint = {
      target: selectedHintOption.target,
      strengths: [],
      local_inference: false,
      ...hint,
      ...patch,
    };
    update({ hints: [...value.hints.filter((item) => routerTargetKey(item.target) !== hintKey), next] });
  };
  const chooseTarget = (key?: string): RouterTarget | undefined => options.find((item) => item.key === key)?.target;
  const targetPicker = (
    label: string,
    target: RouterTarget | null | undefined,
    changed: (target?: RouterTarget) => void,
    providerOnly = false
  ) => (
    <Field label={label}>
      <Select
        aria-label={label}
        showSearch
        allowClear
        value={target ? routerTargetKey(target) : undefined}
        placeholder={t('settings.autoRouter.selectTarget')}
        onChange={(key: string | undefined) => changed(chooseTarget(key))}
        options={options
          .filter((option) => !providerOnly || option.target.kind === 'provider')
          .map(({ key, label: text }) => ({ value: key, label: text }))}
      />
    </Field>
  );
  const unknown = t('settings.autoRouter.unknown');
  return (
    <div className='flex flex-col gap-16px' data-testid='router-config-fields'>
      <Field label={t('settings.autoRouter.mode')}>
        <Select
          aria-label={t('settings.autoRouter.mode')}
          value={value.mode}
          onChange={(mode) => update({ mode })}
          options={(['auto', 'semi_auto', 'manual'] as const).map((mode) => ({
            value: mode,
            label: t(`settings.autoRouter.modes.${mode}`),
          }))}
        />
      </Field>
      <p className='m-0 text-12px text-t-secondary'>{t(`settings.autoRouter.modeHelp.${value.mode}`)}</p>
      {value.mode !== 'auto' &&
        targetPicker(t('settings.autoRouter.root'), value.root_target, (root_target) => update({ root_target }))}
      {value.mode === 'manual' &&
        targetPicker(t('settings.autoRouter.child'), value.child_target, (child_target) => update({ child_target }))}
      {value.mode !== 'manual' && (
        <Field label={t('settings.autoRouter.profile')}>
          <Select
            aria-label={t('settings.autoRouter.profile')}
            value={value.profile}
            onChange={(profile) => update({ profile })}
            options={(['cost', 'speed', 'quality', 'balanced'] as const).map((profile) => ({
              value: profile,
              label: t(`settings.autoRouter.profiles.${profile}`),
            }))}
          />
        </Field>
      )}
      <Checkbox checked={value.local_only} onChange={(local_only) => update({ local_only })}>
        {t('settings.autoRouter.localOnly')}
      </Checkbox>
      <p className='m-0 text-12px text-t-secondary'>{t('settings.autoRouter.localHelp')}</p>
      <Checkbox
        checked={value.allowed_targets.length === 0}
        onChange={(all) => {
          if (!all && !options.length) return;
          update({ allowed_targets: all ? [] : options.slice(0, 128).map((option) => option.target) });
        }}
      >
        {t('settings.autoRouter.allTargets')}
      </Checkbox>
      {value.allowed_targets.length > 0 && (
        <Field label={t('settings.autoRouter.pool')}>
          <Select
            aria-label={t('settings.autoRouter.pool')}
            mode='multiple'
            showSearch
            value={value.allowed_targets.map(routerTargetKey)}
            options={options.map(({ key, label }) => ({ value: key, label }))}
            onChange={(keys: string[]) => {
              if (!keys.length) {
                Message.warning(t('settings.autoRouter.poolRequired'));
                return;
              }
              update({
                allowed_targets: keys.map(chooseTarget).filter((target): target is RouterTarget => Boolean(target)),
              });
            }}
          />
        </Field>
      )}
      {targetPicker(
        t('settings.autoRouter.classifier'),
        value.classifier_target,
        (classifier_target) => update({ classifier_target }),
        true
      )}
      <p className='m-0 text-12px text-t-secondary'>{t('settings.autoRouter.classifierHelp')}</p>
      <Alert type='info' content={t('settings.autoRouter.childScopeHelp')} />
      <Field label={t('settings.autoRouter.hints')}>
        <Select
          aria-label={t('settings.autoRouter.hints')}
          showSearch
          allowClear
          value={hintKey}
          onChange={setHintKey}
          placeholder={t('settings.autoRouter.selectTarget')}
          options={options.map(({ key, label }) => ({ value: key, label }))}
        />
      </Field>
      <p className='m-0 text-12px text-t-secondary'>{t('settings.autoRouter.hintsHelp')}</p>
      {selectedHintOption && (
        <div className='grid grid-cols-1 sm:grid-cols-2 gap-12px rounded-8px bg-fill-1 p-12px'>
          {(
            [
              'input_usd_per_million',
              'output_usd_per_million',
              'expected_latency_ms',
              'context_tokens',
              'quality_tier',
            ] as const
          ).map((key) => (
            <Field key={key} label={t(`settings.autoRouter.metrics.${key}`)}>
              <InputNumber
                aria-label={t(`settings.autoRouter.metrics.${key}`)}
                value={hint?.[key] ?? undefined}
                placeholder={unknown}
                min={key === 'quality_tier' || key === 'context_tokens' ? 1 : 0}
                max={key === 'quality_tier' ? 5 : key === 'context_tokens' ? 4294967295 : 1000000000}
                precision={key === 'quality_tier' || key === 'context_tokens' ? 0 : undefined}
                onChange={(number) => setHint({ [key]: number })}
              />
            </Field>
          ))}
          {(['supports_tools', 'supports_vision'] as const).map((key) => (
            <Field key={key} label={t(`settings.autoRouter.metrics.${key}`)}>
              <Select
                aria-label={t(`settings.autoRouter.metrics.${key}`)}
                value={hint?.[key] == null ? 'unknown' : String(hint[key])}
                options={[
                  { value: 'unknown', label: unknown },
                  { value: 'true', label: t('common.yes') },
                  { value: 'false', label: t('common.no') },
                ]}
                onChange={(answer) => setHint({ [key]: answer === 'unknown' ? undefined : answer === 'true' })}
              />
            </Field>
          ))}
          <Field label={t('settings.autoRouter.strengths')}>
            <Select
              aria-label={t('settings.autoRouter.strengths')}
              mode='multiple'
              value={hint?.strengths ?? []}
              options={TASKS.map((task) => ({ value: task, label: t(`settings.autoRouter.tasks.${task}`) }))}
              onChange={(strengths: RouterTaskKind[]) => setHint({ strengths })}
            />
          </Field>
          <Checkbox
            disabled={!selectedHintOption.loopback}
            checked={hint?.local_inference ?? false}
            onChange={(local_inference) => setHint({ local_inference })}
          >
            {t('settings.autoRouter.declareLocal')}
          </Checkbox>
        </div>
      )}
    </div>
  );
};
export default RouterConfigFields;
