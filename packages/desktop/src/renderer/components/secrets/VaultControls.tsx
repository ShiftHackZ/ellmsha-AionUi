import { secretErrorKey } from './errorKey';
import React, { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Input, Modal, Space, Upload, Message } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { secretsRequest } from '@/common/adapter/secretsBridge';
import type { VaultStatus } from '@/common/types/secrets';

type Action = 'initialize' | 'unlock' | 'change-passphrase' | 'restore';
export function VaultControls({
  status,
  refresh,
  clear,
}: {
  status?: VaultStatus;
  refresh: () => void;
  clear: () => void;
}) {
  const { t } = useTranslation();
  const [device, setDevice] = useState({ available: false, remembered: false });
  useEffect(() => {
    let active = true;
    void secretsRequest<typeof device>('device/status')
      .then((value) => {
        if (active) setDevice(value);
      })
      .catch((): void => {});
    return () => {
      active = false;
    };
  }, [status]);
  const [remember, setRemember] = useState(false);
  const [action, setAction] = useState<Action>();
  const [passphrase, setPassphrase] = useState('');
  const [nextPassphrase, setNextPassphrase] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [backup, setBackup] = useState<unknown>();
  const uploadEpoch = useRef(0);
  useEffect(
    () => () => {
      uploadEpoch.current++;
    },
    []
  );
  const [busy, setBusy] = useState(false);
  const close = () => {
    uploadEpoch.current++;
    setAction(undefined);
    setPassphrase('');
    setNextPassphrase('');
    setAcknowledged(false);
    setRemember(false);
    setBackup(undefined);
  };
  const save = async () => {
    if (!action) return;
    const epoch = uploadEpoch.current;
    setBusy(true);
    try {
      await secretsRequest(
        `vault/${action}`,
        action === 'change-passphrase'
          ? { current_passphrase: passphrase, new_passphrase: nextPassphrase }
          : action === 'restore'
            ? { backup, passphrase }
            : { passphrase }
      );
      if (epoch !== uploadEpoch.current) return;
      if (remember && (action === 'initialize' || action === 'unlock')) await secretsRequest('device/remember');
      if (epoch !== uploadEpoch.current) return;
      clear();
      close();
      refresh();
    } catch (error) {
      Message.error(t(secretErrorKey(error)));
    } finally {
      setBusy(false);
    }
  };
  const download = async () => {
    try {
      const value = await secretsRequest('vault/backup');
      const url = URL.createObjectURL(new Blob([JSON.stringify(value)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'ellmsha-secrets.encrypted.json';
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      Message.error(t(secretErrorKey(error)));
    }
  };
  return (
    <>
      <Space wrap>
        {device.available && device.remembered && !status?.unlocked && (
          <Button
            onClick={() =>
              void secretsRequest('device/unlock')
                .then(refresh)
                .catch(() => Message.error(t('settings.secrets.operationFailed')))
            }
          >
            {t('settings.secrets.osUnlock')}
          </Button>
        )}
        {device.remembered && (
          <Button
            onClick={() =>
              void secretsRequest('device/forget')
                .then(() => {
                  setDevice((old) => ({ ...old, remembered: false }));
                })
                .catch(() => Message.error(t('settings.secrets.operationFailed')))
            }
          >
            {t('settings.secrets.forgetDevice')}
          </Button>
        )}
        {!status?.initialized ? (
          <Button onClick={() => setAction('initialize')}>{t('settings.secrets.initialize')}</Button>
        ) : status.unlocked ? (
          <Button
            onClick={() => {
              clear();
              void secretsRequest('vault/lock')
                .then(refresh)
                .catch(() => Message.error(t('settings.secrets.operationFailed')));
            }}
          >
            {t('settings.secrets.lock')}
          </Button>
        ) : (
          <Button type='primary' onClick={() => setAction('unlock')}>
            {t('settings.secrets.unlock')}
          </Button>
        )}
        {status?.unlocked && (
          <>
            <Button onClick={() => setAction('change-passphrase')}>{t('settings.secrets.changePassphrase')}</Button>
            <Button onClick={() => void download()}>{t('settings.secrets.backup')}</Button>
          </>
        )}
        <Button onClick={() => setAction('restore')}>{t('settings.secrets.restore')}</Button>
      </Space>
      <Modal
        visible={!!action}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        unmountOnExit
        title={action ? t(`settings.secrets.${action === 'change-passphrase' ? 'changePassphrase' : action}`) : ''}
        onCancel={close}
        onOk={() => void save()}
        confirmLoading={busy}
        okButtonProps={{
          disabled:
            Array.from(passphrase).length < 12 ||
            Array.from(passphrase).length > 1024 ||
            (action === 'initialize' && !acknowledged) ||
            (action === 'change-passphrase' &&
              (Array.from(nextPassphrase).length < 12 || Array.from(nextPassphrase).length > 1024)) ||
            (action === 'restore' && !backup),
        }}
      >
        <div className='flex flex-col gap-12px'>
          <p className='text-t-secondary'>{t('settings.secrets.disclosure')}</p>
          <p className='text-t-secondary'>{t('settings.secrets.retentionDisclosure')}</p>
          {action === 'restore' && (
            <>
              <p>{t('settings.secrets.restoreWarning')}</p>
              <Upload
                autoUpload={false}
                accept='.json'
                limit={1}
                onRemove={() => {
                  uploadEpoch.current++;
                  setBackup(undefined);
                  return true;
                }}
                beforeUpload={async (file) => {
                  const upload = ++uploadEpoch.current;
                  setBackup(undefined);
                  if (file.size > 64 * 1024 * 1024) {
                    Message.error(t('settings.secrets.operationFailed'));
                    return false;
                  }
                  try {
                    const parsed = JSON.parse(await file.text()) as unknown;
                    if (uploadEpoch.current === upload) setBackup(parsed);
                  } catch (error) {
                    Message.error(t(secretErrorKey(error)));
                  }
                  return false;
                }}
              />
            </>
          )}
          <label>
            {t('settings.secrets.passphrase')}
            <Input.Password autoComplete='off' value={passphrase} onChange={setPassphrase} />
          </label>
          {action === 'change-passphrase' && (
            <label>
              {t('settings.secrets.newPassphrase')}
              <Input.Password autoComplete='new-password' value={nextPassphrase} onChange={setNextPassphrase} />
            </label>
          )}
          {device.available && (action === 'initialize' || action === 'unlock') && (
            <Checkbox checked={remember} onChange={setRemember}>
              {t('settings.secrets.remember')}
            </Checkbox>
          )}
          {action === 'initialize' && (
            <Checkbox checked={acknowledged} onChange={setAcknowledged}>
              {t('settings.secrets.acknowledge')}
            </Checkbox>
          )}
        </div>
      </Modal>
    </>
  );
}
