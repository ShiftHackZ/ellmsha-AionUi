import React from 'react';
import { Alert, Input, Select } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import type { RouterClass, RouterTarget } from '@/common/types/agent/routerTypes';
import { routerTargetKey } from '@/common/types/agent/routerTypes';
import type { RouterOption } from './useRouter';
import { routerClassError } from './routerConfigState';

export type RouterClassDraft = Pick<RouterClass, 'id'> & Partial<Omit<RouterClass, 'id'>>;
export const routerOptionLabel = (option: RouterOption): string => `${option.label} · ${option.target.model}`;
export const RouterTargetPicker: React.FC<{
  role: 'root' | 'child' | 'classifier';
  target?: RouterTarget | null;
  options: RouterOption[];
  localOnly?: boolean;
  active?: boolean;
  onChange: (target?: RouterTarget) => void;
}> = ({ role, target, options, localOnly = false, active = true, onChange }) => {
  const { t } = useTranslation();
  const selected = target && options.find((option) => option.key === routerTargetKey(target));
  const reason = (code?: string) =>
    t(`settings.autoRouter.graph.reasons.${code}`, { defaultValue: t('settings.autoRouter.graph.unknownReason') });
  return (
    <div className='flex flex-col gap-8px'>
      <Select
        aria-label={t('settings.autoRouter.graph.model')}
        showSearch
        allowClear
        value={target ? routerTargetKey(target) : undefined}
        placeholder={t('settings.autoRouter.selectTarget')}
        renderFormat={(_option, key) => {
          const entry = options.find((option) => option.key === key);
          return entry ? routerOptionLabel(entry) : (target?.model ?? '');
        }}
        filterOption={(input, option) =>
          String((option.props as { extra?: string }).extra ?? '')
            .toLowerCase()
            .includes(input.toLowerCase())
        }
        onChange={(key?: string) => onChange(options.find((option) => option.key === key)?.target)}
      >
        {options.map((option) => (
          <Select.Option
            key={option.key}
            value={option.key}
            disabled={!option[role].supported}
            extra={`${option.label} ${option.target.model} ${option.backend} ${option.target.kind}`}
          >
            <div className='flex flex-col py-4px'>
              <span>{routerOptionLabel(option)}</span>
              <span className='text-12px text-t-secondary'>
                {t(`settings.autoRouter.graph.${option.target.kind === 'provider' ? 'api' : 'cli'}`)} · {option.backend}
                {!option[role].supported ? ` · ${reason(option[role].reason)}` : ''}
              </span>
            </div>
          </Select.Option>
        ))}
      </Select>
      {active && selected && !selected[role].supported && (
        <Alert
          type='warning'
          content={`${t(role === 'classifier' && !(localOnly && !selected.local) ? 'settings.autoRouter.graph.classifierFallback' : 'settings.autoRouter.graph.conflict')} ${reason(selected[role].reason)}`}
        />
      )}
    </div>
  );
};

/** Inline fields belong to their class card; the host owns Save/Cancel. */
const RouterClassFields: React.FC<{
  value: RouterClassDraft;
  options: RouterOption[];
  onChange: (value: RouterClassDraft) => void;
}> = ({ value, options, onChange }) => {
  const { t } = useTranslation();
  const issue = routerClassError(value);
  return (
    <div className='flex min-w-0 flex-col gap-8px'>
      <Input
        aria-label={t('settings.autoRouter.graph.className')}
        placeholder={t('settings.autoRouter.graph.className')}
        value={value.name ?? ''}
        onChange={(name) => onChange({ ...value, name })}
      />
      <Input.TextArea
        aria-label={t('settings.autoRouter.graph.classDescription')}
        placeholder={t('settings.autoRouter.graph.classDescription')}
        value={value.description ?? ''}
        onChange={(description) => onChange({ ...value, description })}
        autoSize={{ minRows: 2, maxRows: 5 }}
      />
      <RouterTargetPicker
        role='child'
        target={value.target}
        options={options}
        onChange={(target) => onChange({ ...value, target })}
      />
      {issue && (
        <span role='status' className='text-12px text-t-secondary'>
          {t(`settings.autoRouter.graph.errors.${issue}`)}
        </span>
      )}
    </div>
  );
};
export default RouterClassFields;
