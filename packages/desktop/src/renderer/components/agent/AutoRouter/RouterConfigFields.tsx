import React, { useEffect, useState } from 'react';
import { Button, Checkbox, Collapse, InputNumber, Message, Select } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import {
  routerTargetKey,
  type RouterConfig,
  type RouterClass,
  type RouterMode,
  type RouterPreset,
  type RouterHint,
  type RouterTarget,
  type RouterTaskKind,
  type RouterSettings,
} from '@/common/types/agent/routerTypes';
import type { RouterOption } from './useRouter';
import RouterDiagram from './RouterDiagram';
import { routerOptionLabel, type RouterClassDraft } from './RouterNodeFields';
import {
  activeRouterConfig,
  routerClassError,
  ROUTER_MODES,
  ROUTER_PRESETS,
  selectRouterSlot,
  updateRouterSlot,
} from './routerConfigState';

const TASKS: RouterTaskKind[] = ['coding', 'review', 'research', 'writing', 'analysis', 'general'];
const MAX_MODEL_ENTRIES = 128;
const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className='flex min-w-0 flex-col gap-6px'>
    <span className='text-13px font-500 text-t-primary'>{label}</span>
    {children}
  </div>
);

/** Shared real form for persisted defaults and per-chat policy overrides. */
const RouterConfigFields: React.FC<{
  value: RouterSettings;
  onChange: (value: RouterSettings) => void;
  options: RouterOption[];
  onIncompleteChange?: (incomplete: boolean) => void;
}> = ({ value: settings, onChange, options, onIncompleteChange }) => {
  const value = activeRouterConfig(settings);
  // Incomplete class rows stay local until valid, so no invalid runtime policy leaves this form.
  const [classDrafts, setClassDrafts] = useState<Record<string, RouterClassDraft[]>>({});
  const slot = `${settings.active_mode}:${settings.active_presets[settings.active_mode]}`;
  const classes = classDrafts[slot] ?? value.classes ?? [];
  const incomplete = Object.keys(classDrafts).length > 0;
  useEffect(() => onIncompleteChange?.(incomplete), [incomplete, onIncompleteChange]);
  const changeClasses = (next: RouterClassDraft[]) => {
    const valid = next.every((entry) => !routerClassError(entry));
    setClassDrafts((current) => {
      const drafts = { ...current };
      if (valid) delete drafts[slot];
      else drafts[slot] = next;
      return drafts;
    });
    onChange(updateRouterSlot(settings, valid ? { ...value, classes: next as RouterClass[] } : value));
  };
  const changeSlot = (mode: RouterMode, preset: RouterPreset = settings.active_presets[mode]) => {
    if (!settings.configurations[mode]?.[preset] && classDrafts[slot]) {
      setClassDrafts((current) => ({ ...current, [`${mode}:${preset}`]: structuredClone(classDrafts[slot]) }));
    }
    onChange(selectRouterSlot(settings, mode, preset));
  };
  const { t } = useTranslation();
  const [hintKey, setHintKey] = useState<string>();
  const update = (patch: Partial<RouterConfig>) => onChange(updateRouterSlot(settings, { ...value, ...patch }));
  const selectedHintOption = options.find((option) => option.key === hintKey);
  const hint = value.hints.find((item) => routerTargetKey(item.target) === hintKey);
  const poolKeys = new Set(value.allowed_targets.map(routerTargetKey));
  const hintKeys = new Set(value.hints.map((item) => routerTargetKey(item.target)));
  const setHint = (patch: Partial<RouterHint>) => {
    if (!selectedHintOption) return;
    if (!hint && value.hints.length >= MAX_MODEL_ENTRIES) {
      Message.warning(t('settings.autoRouter.graph.modelLimit'));
      return;
    }
    const next: RouterHint = {
      target: selectedHintOption.target,
      strengths: [],
      local_inference: false,
      ...hint,
      ...patch,
    };
    update({ hints: [...value.hints.filter((item) => routerTargetKey(item.target) !== hintKey), next] });
  };
  const chooseTarget = (key?: string): RouterTarget | undefined =>
    options.find((item) => item.key === key)?.target ??
    value.allowed_targets.find((target) => routerTargetKey(target) === key);
  const unknown = t('settings.autoRouter.unknown');
  return (
    <div className='flex flex-col gap-16px' data-testid='router-config-fields'>
      <div className='grid grid-cols-1 sm:grid-cols-2 gap-12px'>
        <Field label={t('settings.autoRouter.mode')}>
          <Select
            aria-label={t('settings.autoRouter.mode')}
            value={settings.active_mode}
            onChange={(mode) => changeSlot(mode)}
            options={ROUTER_MODES.map((mode) => ({ value: mode, label: t(`settings.autoRouter.modes.${mode}`) }))}
          />
        </Field>
        <Field label={t('settings.autoRouter.graph.preset')}>
          <Select
            aria-label={t('settings.autoRouter.graph.preset')}
            value={settings.active_presets[settings.active_mode]}
            onChange={(preset) => changeSlot(settings.active_mode, preset)}
            options={ROUTER_PRESETS.map((preset) => ({
              value: preset,
              label: t(
                preset === 'local_only'
                  ? 'settings.autoRouter.graph.local_only'
                  : `settings.autoRouter.profiles.${preset}`
              ),
            }))}
          />
        </Field>
      </div>
      <p className='m-0 text-12px text-t-secondary'>
        {t(`settings.autoRouter.graph.rolePolicies.${settings.active_presets[settings.active_mode]}`)}
      </p>
      <RouterDiagram
        config={value}
        classes={classes}
        options={options}
        onChange={(config) => onChange(updateRouterSlot(settings, config))}
        onClassesChange={changeClasses}
      />
      <p className='m-0 text-12px text-t-secondary'>{t('settings.autoRouter.graph.independent')}</p>
      <Collapse>
        <Collapse.Item name='advanced' header={t('settings.autoRouter.graph.advanced')}>
          <div className='flex flex-col gap-12px'>
            {value.local_only && (
              <p className='m-0 text-12px text-t-secondary'>
                {t('settings.autoRouter.graph.localOptimization', {
                  profile: t(`settings.autoRouter.profiles.${value.profile}`),
                })}
              </p>
            )}
            <Checkbox
              checked={value.allowed_targets.length === 0}
              onChange={(all) => {
                if (!all && !options.length) return;
                update({
                  allowed_targets: all ? [] : options.slice(0, MAX_MODEL_ENTRIES).map((option) => option.target),
                });
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
                  options={options.map((option) => ({
                    value: option.key,
                    label: routerOptionLabel(option),
                    disabled: poolKeys.size >= MAX_MODEL_ENTRIES && !poolKeys.has(option.key),
                  }))}
                  onChange={(keys: string[]) => {
                    if (keys.length > MAX_MODEL_ENTRIES) {
                      Message.warning(t('settings.autoRouter.graph.modelLimit'));
                      return;
                    }
                    if (!keys.length) {
                      Message.warning(t('settings.autoRouter.poolRequired'));
                      return;
                    }
                    update({
                      allowed_targets: keys
                        .map(chooseTarget)
                        .filter((target): target is RouterTarget => Boolean(target)),
                    });
                  }}
                />
                {poolKeys.size >= MAX_MODEL_ENTRIES && (
                  <p className='m-0 text-12px text-t-secondary'>{t('settings.autoRouter.graph.modelLimit')}</p>
                )}
              </Field>
            )}
            <Field label={t('settings.autoRouter.hints')}>
              <Select
                aria-label={t('settings.autoRouter.hints')}
                showSearch
                allowClear
                value={hintKey}
                onChange={setHintKey}
                placeholder={t('settings.autoRouter.selectTarget')}
                options={options.map((option) => ({
                  value: option.key,
                  label: routerOptionLabel(option),
                  disabled: hintKeys.size >= MAX_MODEL_ENTRIES && !hintKeys.has(option.key),
                }))}
              />
              {hintKeys.size >= MAX_MODEL_ENTRIES && (
                <p className='m-0 text-12px text-t-secondary'>{t('settings.autoRouter.graph.modelLimit')}</p>
              )}
            </Field>
            <p className='m-0 text-12px text-t-secondary'>{t('settings.autoRouter.hintsHelp')}</p>
            {hint && (
              <Button
                size='small'
                onClick={() =>
                  update({ hints: value.hints.filter((item) => routerTargetKey(item.target) !== hintKey) })
                }
              >
                {t('common.clear')}
              </Button>
            )}
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
        </Collapse.Item>
      </Collapse>
    </div>
  );
};
export default RouterConfigFields;
