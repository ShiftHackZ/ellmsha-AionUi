import { ipcBridge } from '@/common';
import type { IComputerUsePermissionStatus } from '@/common/adapter/ipcBridge';
import { AION_ADD_BUTTON_CLASS } from '@/renderer/components/base/TalkToButlerButton';
import { Button, Spin, Tag } from '@arco-design/web-react';
import { CheckOne } from '@icon-park/react';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

type ComputerUseSetupProps = {
  webUiBrowserMode: boolean;
};

const ComputerUseSetup: React.FC<ComputerUseSetupProps> = ({ webUiBrowserMode }) => {
  const { t } = useTranslation();
  const [platform, setPlatform] = useState<string>();
  const [platformLoading, setPlatformLoading] = useState(!webUiBrowserMode);
  const [platformError, setPlatformError] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState(false);
  const [status, setStatus] = useState<IComputerUsePermissionStatus>();

  const loadPlatform = useCallback(async () => {
    if (webUiBrowserMode) return;
    setPlatformLoading(true);
    setPlatformError(false);
    try {
      const info = await ipcBridge.application.systemInfo.invoke();
      setPlatform(info.platform);
    } catch (error) {
      console.error('[ComputerUseSetup] Failed to read platform support:', error);
      setPlatformError(true);
    } finally {
      setPlatformLoading(false);
    }
  }, [webUiBrowserMode]);

  useEffect(() => {
    void loadPlatform();
  }, [loadPlatform]);

  const checkPermissions = async () => {
    setChecking(true);
    setCheckError(false);
    setStatus(undefined);
    try {
      const response = await ipcBridge.application.checkComputerUsePermissions.invoke();
      if (!response.success || !response.data) {
        setCheckError(true);
        return;
      }
      setStatus(response.data);
    } catch (error) {
      console.error('[ComputerUseSetup] Permission check failed:', error);
      setCheckError(true);
    } finally {
      setChecking(false);
    }
  };

  const permissionTag = (value: 'granted' | 'missing' | 'unknown') => (
    <Tag color={value === 'granted' ? 'green' : value === 'missing' ? 'orange' : 'gray'}>
      {t(`settings.computerUsePermissionStatus.${value}`)}
    </Tag>
  );

  return (
    <section className='bg-2 border border-border-2 rd-16px p-20px flex flex-col gap-14px'>
      <div>
        <div className='text-16px font-600 text-t-primary'>{t('settings.computerUseSetupTitle')}</div>
        <div className='text-13px text-t-secondary mt-4px'>{t('settings.computerUseSetupDescription')}</div>
      </div>

      {webUiBrowserMode ? (
        <div role='status' className='text-13px text-t-secondary bg-fill-2 border border-border-2 rd-10px p-12px'>
          {t('settings.computerUseWebUnsupported')}
        </div>
      ) : platformLoading ? (
        <div
          role='status'
          className='min-h-44px flex items-center justify-center gap-8px bg-fill-2 border border-border-2 rd-10px px-12px text-13px text-t-secondary'
          aria-label={t('settings.computerUseCheckingSupport')}
        >
          <Spin size={16} />
          <span>{t('settings.computerUseCheckingSupport')}</span>
        </div>
      ) : platformError ? (
        <div
          role='alert'
          className='flex items-center justify-between gap-12px bg-fill-2 border border-border-2 rd-10px p-12px'
        >
          <span className='text-13px text-status-error'>{t('settings.computerUseSupportError')}</span>
          <Button type='primary' size='small' className={AION_ADD_BUTTON_CLASS} onClick={() => void loadPlatform()}>
            {t('common.retry')}
          </Button>
        </div>
      ) : platform !== 'darwin' ? (
        <div role='status' className='text-13px text-t-secondary bg-fill-2 border border-border-2 rd-10px p-12px'>
          {t('settings.computerUsePlatformUnsupported')}
        </div>
      ) : (
        <>
          <div className='text-13px text-t-secondary'>{t('settings.computerUsePermissionHelp')}</div>

          {status && (
            <div role='status' className='bg-base border border-border-2 rd-10px p-12px flex flex-col gap-10px'>
              <div className='flex items-center justify-between gap-12px'>
                <span className='text-13px text-t-primary'>{t('settings.computerUseAccessibility')}</span>
                {permissionTag(status.accessibility)}
              </div>
              <div className='flex items-center justify-between gap-12px'>
                <span className='text-13px text-t-primary'>{t('settings.computerUseScreenRecording')}</span>
                {permissionTag(status.screenRecording)}
              </div>
              {status.onboardingOpened && (
                <div className='text-12px text-status-warning'>{t('settings.computerUseOnboardingOpened')}</div>
              )}
            </div>
          )}

          {checkError && (
            <div role='alert' className='text-13px text-status-error bg-fill-2 border border-border-2 rd-10px p-12px'>
              {t('settings.computerUseCheckError')}
            </div>
          )}

          <div>
            <Button
              type='primary'
              size='small'
              className={AION_ADD_BUTTON_CLASS}
              disabled={checking}
              aria-busy={checking}
              onClick={() => void checkPermissions()}
            >
              <span className='flex items-center gap-6px'>
                <span className='h-14px w-14px shrink-0 flex items-center justify-center leading-none'>
                  {checking ? <Spin size={14} /> : <CheckOne theme='outline' size={14} fill='currentColor' />}
                </span>
                {status || checkError ? t('settings.computerUseCheckAgain') : t('settings.computerUseCheckPermissions')}
              </span>
            </Button>
          </div>
        </>
      )}
    </section>
  );
};

export default ComputerUseSetup;
