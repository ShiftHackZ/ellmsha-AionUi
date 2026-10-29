import React, { useEffect, useState } from 'react';
import { Alert, Button, Input, Select, Space, Spin, Typography } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import type { SecurityKeyAction, SecurityKeyDialogState } from '@/common/types/browserWebAuthn';
import styles from './SecurityKeyDialog.module.css';

export default function SecurityKeyDialog({
  state,
  respond,
  onReady,
}: {
  state: SecurityKeyDialogState;
  respond: (value: SecurityKeyAction) => void;
  onReady: () => void;
}) {
  const { t } = useTranslation();
  const [selection, setSelection] = useState<string>();
  const [pin, setPin] = useState('');
  useEffect(onReady, [onReady]);
  useEffect(() => {
    setSelection(undefined);
    setPin('');
  }, [state.step, state.error, state.retries]);
  const submit = () => {
    if (state.step === 'pin') {
      respond({ action: 'pin', value: pin });
      setPin('');
    } else if (state.step === 'devices' || state.step === 'accounts') respond({ action: 'select', value: selection });
    else respond({ action: 'continue' });
  };
  return (
    <main className={styles.content}>
      <Space direction='vertical' size={20} style={{ width: '100%' }}>
        <Typography.Title heading={5}>{t('settings.securityKey.title')}</Typography.Title>
        <Typography.Paragraph>
          {state.origin}
          <br />
          <Typography.Text type='secondary'>
            {t('settings.securityKey.relyingParty', { domain: state.rpId })}
          </Typography.Text>
        </Typography.Paragraph>
        {state.error && <Alert type='warning' content={t(`settings.securityKey.${state.error}`)} />}
        {state.step === 'confirm' && <Typography.Paragraph>{t('settings.securityKey.confirm')}</Typography.Paragraph>}
        {(state.step === 'devices' || state.step === 'accounts') && (
          <Select
            aria-label={t(state.step === 'devices' ? 'settings.securityKey.device' : 'settings.securityKey.account')}
            placeholder={t(state.step === 'devices' ? 'settings.securityKey.device' : 'settings.securityKey.account')}
            value={selection}
            onChange={setSelection}
            options={state.options?.map((o) => ({ value: o.id, label: o.name }))}
          />
        )}
        {state.step === 'pin' && (
          <Space direction='vertical' style={{ width: '100%' }}>
            <Typography.Text>{t('settings.securityKey.pin')}</Typography.Text>
            <Input.Password
              autoComplete='off'
              visibility={false}
              value={pin}
              onChange={setPin}
              onPressEnter={() => {
                if (pin) submit();
              }}
              maxLength={63}
              aria-label={t('settings.securityKey.pin')}
              autoFocus
            />
            {state.retries !== undefined && state.retries >= 0 && (
              <Typography.Text type='secondary'>
                {t('settings.securityKey.retries', { count: state.retries })}
              </Typography.Text>
            )}
          </Space>
        )}
        {state.step === 'touch' && (
          <Space>
            <Spin />
            <Typography.Text>{t('settings.securityKey.touch')}</Typography.Text>
          </Space>
        )}
        <Space className={styles.actions}>
          <Button
            onClick={() => {
              setPin('');
              respond({ action: 'cancel' });
            }}
          >
            {t('settings.securityKey.cancel')}
          </Button>
          {state.step === 'error' && state.options && (
            <Button type='primary' onClick={() => respond({ action: 'refresh' })}>
              {t('settings.securityKey.refresh')}
            </Button>
          )}
          {state.step !== 'touch' && state.step !== 'error' && (
            <Button
              type='primary'
              disabled={
                (state.step === 'pin' && !pin) ||
                ((state.step === 'devices' || state.step === 'accounts') && selection === undefined)
              }
              onClick={submit}
            >
              {t('settings.securityKey.continue')}
            </Button>
          )}
        </Space>
      </Space>
    </main>
  );
}
