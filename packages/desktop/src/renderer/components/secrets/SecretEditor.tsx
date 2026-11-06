import { secretErrorKey } from './errorKey';
import React, { useState } from 'react';
import { Button, Input, Modal, Select, Space, Message } from '@arco-design/web-react';
import { Delete, Plus, Copy } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import type { SecretBinding, SecretField, SecretRead, SecretRecord } from '@/common/types/secrets';

type FieldRow = SecretField & { name: string; key: string };
const emptyBinding = (): SecretBinding => ({
  service: '',
  environment: '',
  tenant: '',
  role: '',
  target: '',
  mfa: 'unknown',
  mfa_method: '',
  mfa_instructions: '',
});

export function SecretEditor({
  initial,
  scopeName,
  readOnly,
  onClose,
  onSave,
}: {
  initial?: SecretRead;
  scopeName: string;
  readOnly?: boolean;
  onClose: () => void;
  onSave: (record: SecretRecord) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(initial?.title ?? '');
  const [kind, setKind] = useState<SecretRecord['kind']>(initial?.kind ?? 'login');
  const [fields, setFields] = useState<FieldRow[]>(
    Object.entries(
      initial?.fields ?? {
        username: { kind: 'text' as const, value: '' },
        password: { kind: 'password' as const, value: '' },
      }
    ).map(([name, field]) => ({ kind: field.kind, value: field.value, name, key: crypto.randomUUID() }))
  );
  const [bindings, setBindings] = useState<SecretBinding[]>(initial?.bindings ?? [emptyBinding()]);
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const changeField = (index: number, patch: Partial<FieldRow>) =>
    setFields((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const save = async () => {
    setBusy(true);
    try {
      await onSave({
        title,
        kind,
        fields: Object.fromEntries(
          fields.map(({ name, kind: fieldKind, value }) => [name, { kind: fieldKind, value }])
        ),
        bindings,
      });
      onClose();
    } catch (error) {
      Message.error(t(secretErrorKey(error)));
    } finally {
      setBusy(false);
    }
  };
  const invalid =
    !title.trim() ||
    fields.some((field) => !field.name.trim()) ||
    new Set(fields.map((field) => field.name)).size !== fields.length;
  return (
    <Modal
      visible
      unmountOnExit
      okText={t(readOnly ? 'common.close' : 'common.save')}
      cancelText={t('common.cancel')}
      title={`${t('settings.secrets.title')} · ${scopeName}`}
      onCancel={onClose}
      onOk={readOnly ? onClose : () => void save()}
      confirmLoading={busy}
      okButtonProps={{ disabled: !readOnly && invalid }}
      style={{ width: 'min(720px, 95vw)' }}
    >
      <div className='flex flex-col gap-16px max-h-65vh overflow-auto text-t-primary'>
        <label>
          {t('settings.secrets.recordTitle')}
          <Input value={title} onChange={setTitle} readOnly={readOnly} maxLength={512} />
        </label>
        <label>
          {t('settings.secrets.kind')}
          <Select value={kind} disabled={readOnly} onChange={setKind}>
            {(['login', 'api_key', 'secure_note', 'structured'] as const).map((value) => (
              <Select.Option key={value} value={value}>
                {t(`settings.secrets.kindLabels.${value}`)}
              </Select.Option>
            ))}
          </Select>
        </label>
        <section className='flex flex-col gap-8px'>
          <h3>{t('settings.secrets.fields')}</h3>
          {fields.map((field, index) => (
            <div key={field.key} className='bg-2 p-12px rd-8px flex flex-col gap-8px'>
              <Space wrap>
                <Input
                  aria-label={t('settings.secrets.fieldName')}
                  value={field.name}
                  onChange={(name) => changeField(index, { name })}
                  readOnly={readOnly}
                />
                <Select
                  aria-label={t('settings.secrets.fieldKind')}
                  value={field.kind}
                  disabled={readOnly}
                  onChange={(value: SecretField['kind']) => changeField(index, { kind: value })}
                  style={{ minWidth: 120 }}
                >
                  {(['text', 'password', 'secret', 'note'] as const).map((value) => (
                    <Select.Option key={value} value={value}>
                      {t(`settings.secrets.fieldKinds.${value}`)}
                    </Select.Option>
                  ))}
                </Select>
                {!readOnly && (
                  <Button
                    aria-label={t('common.delete')}
                    icon={<Delete />}
                    onClick={() => setFields((rows) => rows.filter((_, i) => i !== index))}
                  />
                )}
                <Button
                  aria-label={t('common.copy')}
                  icon={<Copy />}
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(field.value)
                      .catch(() => Message.error(t('settings.secrets.operationFailed')))
                  }
                />
              </Space>
              {field.kind === 'note' ? (
                <>
                  <Button onClick={() => setRevealed((old) => ({ ...old, [field.key]: !old[field.key] }))}>
                    {t(revealed[field.key] ? 'settings.secrets.hide' : 'settings.secrets.reveal')}
                  </Button>
                  {revealed[field.key] ? (
                    <Input.TextArea
                      aria-label={field.name}
                      autoComplete='off'
                      value={field.value}
                      onChange={(value) => changeField(index, { value })}
                      readOnly={readOnly}
                    />
                  ) : (
                    <span aria-label={field.name}>••••••••</span>
                  )}
                </>
              ) : (
                <Input.Password
                  aria-label={field.name}
                  autoComplete='off'
                  value={field.value}
                  onChange={(value) => changeField(index, { value })}
                  readOnly={readOnly}
                />
              )}
            </div>
          ))}
          {!readOnly && (
            <Button
              icon={<Plus />}
              disabled={fields.length >= 64}
              onClick={() =>
                setFields((rows) => [...rows, { name: '', value: '', kind: 'secret', key: crypto.randomUUID() }])
              }
            >
              {t('settings.secrets.addField')}
            </Button>
          )}
        </section>
        <section className='flex flex-col gap-8px'>
          <h3>{t('settings.secrets.bindings')}</h3>
          {bindings.map((binding, index) => (
            <div key={index} className='bg-2 p-12px rd-8px flex flex-col gap-8px'>
              {(['service', 'environment', 'tenant', 'role', 'target', 'mfa_method', 'mfa_instructions'] as const).map(
                (key) => (
                  <label key={key}>
                    {t(`settings.secrets.bindingLabels.${key}`)}
                    <Input
                      value={binding[key]}
                      readOnly={readOnly}
                      onChange={(value) =>
                        setBindings((rows) => rows.map((row, i) => (i === index ? { ...row, [key]: value } : row)))
                      }
                    />
                  </label>
                )
              )}
              <label>
                {t('settings.secrets.mfa')}
                <Select
                  value={binding.mfa}
                  disabled={readOnly}
                  onChange={(value: SecretBinding['mfa']) =>
                    setBindings((rows) => rows.map((row, i) => (i === index ? { ...row, mfa: value } : row)))
                  }
                >
                  {(['unknown', 'required', 'none'] as const).map((value) => (
                    <Select.Option key={value} value={value}>
                      {t(`settings.secrets.mfaLabels.${value}`)}
                    </Select.Option>
                  ))}
                </Select>
              </label>
              {!readOnly && (
                <Button icon={<Delete />} onClick={() => setBindings((rows) => rows.filter((_, i) => i !== index))}>
                  {t('common.delete')}
                </Button>
              )}
            </div>
          ))}
          {!readOnly && (
            <Button
              icon={<Plus />}
              disabled={bindings.length >= 32}
              onClick={() => setBindings((rows) => [...rows, emptyBinding()])}
            >
              {t('settings.secrets.addBinding')}
            </Button>
          )}
        </section>
        <p className='text-t-secondary'>{t('settings.secrets.mfaWarning')}</p>
      </div>
    </Modal>
  );
}
