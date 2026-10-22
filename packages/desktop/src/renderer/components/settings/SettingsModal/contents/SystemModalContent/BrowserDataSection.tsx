/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { notifyManualRestartRequired } from '@/renderer/utils/appRestart';
import { Alert, Button, Message, Modal, Select, Switch } from '@arco-design/web-react';
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR, { mutate } from 'swr';
import PreferenceRow from './PreferenceRow';

/** Project browser profiles and the independent agent-control switch. */
const BrowserDataSection: React.FC = () => {
  const { t } = useTranslation();
  const { data: profiles, mutate: refreshProfiles } = useSWR('browser.profiles', () =>
    ipcBridge.application.listBrowserProfiles.invoke()
  );
  const [selectedProfile, setSelectedProfile] = useState<string>();
  const selected = profiles?.data?.find((profile) => profile.profileId === selectedProfile) ?? profiles?.data?.[0];
  const [clearing, setClearing] = useState(false);
  const [closingTabs, setClosingTabs] = useState(false);
  const { data: cdpStatus, isLoading } = useSWR('cdp.status', () => ipcBridge.application.getCdpStatus.invoke());
  const [switchLoading, setSwitchLoading] = useState(false);

  const status = cdpStatus?.data;

  /**
   * 开关写的是配置，真正生效要等下次启动 —— 通道随进程创建。两者不一致时提示重启。
   * The switch writes config; it takes effect on the next launch because the bridge is
   * created with the process. Prompt for a restart while the two disagree.
   */
  const agentControlEnabled = status?.configEnabled ?? false;
  const hasPendingChange = !isLoading && status !== undefined && status.configEnabled !== status.enabled;

  const handleToggleAgentControl = useCallback(
    async (checked: boolean) => {
      setSwitchLoading(true);
      try {
        const result = await ipcBridge.application.updateCdpConfig.invoke({ enabled: checked });
        if (result.success) {
          Message.success(t('settings.browserData.agentControlSaved'));
          await mutate('cdp.status');
        } else {
          Message.error(result.msg || t('settings.browserData.agentControlFailed'));
        }
      } catch {
        Message.error(t('settings.browserData.agentControlFailed'));
      } finally {
        setSwitchLoading(false);
      }
    },
    [t]
  );

  const handleRestart = useCallback(async () => {
    try {
      const result = await ipcBridge.application.restart.invoke();
      notifyManualRestartRequired(result, t);
    } catch {
      Message.error(t('common.error'));
    }
  }, [t]);

  const handleClear = useCallback(() => {
    // 二次确认：清掉之后所有网站都要重新登录，且不可撤销
    // Confirm first: this signs out of every site and cannot be undone.
    Modal.confirm({
      title: t('settings.browserData.clearConfirmTitle'),
      content: t('settings.browserData.clearConfirmContent'),
      okButtonProps: { status: 'danger' },
      onOk: async () => {
        setClearing(true);
        try {
          if (!selected) throw new Error('Browser profile unavailable.');
          const result = await ipcBridge.application.clearBrowserData.invoke({ profileToken: selected.token });
          if (result.success) {
            localStorage.removeItem(`ellmsha_browser_profile:${selected.profileId}`);
            await refreshProfiles();
          }
          if (result.success) {
            Message.success(t('settings.browserData.clearSuccess'));
          } else {
            Message.error(result.msg || t('settings.browserData.clearFailed'));
          }
        } catch {
          Message.error(t('settings.browserData.clearFailed'));
        } finally {
          setClearing(false);
        }
      },
    });
  }, [t, selected, refreshProfiles]);

  const handleCloseSuspended = useCallback(() => {
    Modal.confirm({
      title: t('settings.browserData.closeSuspendedTitle'),
      content: t('settings.browserData.closeSuspendedConfirm'),
      okButtonProps: { status: 'warning' },
      onOk: async () => {
        setClosingTabs(true);
        try {
          const result = await ipcBridge.application.closeSuspendedBrowserTabs.invoke();
          if (!result.success) throw new Error('Browser tabs could not be closed.');
          Message.success(t('settings.browserData.closeSuspendedSuccess', { count: result.data?.closedTabs ?? 0 }));
          await refreshProfiles();
        } catch {
          Message.error(t('settings.browserData.closeSuspendedFailed'));
        } finally {
          setClosingTabs(false);
        }
      },
    });
  }, [t, refreshProfiles]);

  return (
    <div className='px-[12px] md:px-[32px] py-16px bg-2 rd-16px'>
      <div className='text-14px font-medium text-t-primary mb-8px'>{t('settings.browserData.title')}</div>

      <PreferenceRow
        label={t('settings.browserData.agentControlLabel')}
        description={t('settings.browserData.agentControlDesc')}
      >
        <Switch
          checked={agentControlEnabled}
          loading={switchLoading || isLoading}
          onChange={handleToggleAgentControl}
        />
      </PreferenceRow>

      {hasPendingChange && (
        <Alert
          type='warning'
          content={
            <div className='flex items-center justify-between gap-12px'>
              <span>{t('settings.browserData.agentControlRestartRequired')}</span>
              <Button size='small' type='primary' onClick={handleRestart}>
                {t('settings.restartNow')}
              </Button>
            </div>
          }
          className='mb-8px'
        />
      )}

      <Alert type='info' content={t('settings.browserData.profileIsolation')} className='mb-12px' />
      <PreferenceRow label={t('settings.browserData.profileLabel')}>
        <Select
          value={selected?.profileId}
          onChange={setSelectedProfile}
          placeholder={t('settings.browserData.profileEmpty')}
          options={(profiles?.data ?? []).map((profile) => ({
            value: profile.profileId,
            label: `${profile.label ?? t('settings.browserData.defaultProfile')} · ${t('settings.browserData.openTabs', { count: profile.openTabCount ?? 0 })}`,
          }))}
        />
      </PreferenceRow>
      <PreferenceRow
        label={t('settings.browserData.closeSuspendedLabel')}
        description={t('settings.browserData.closeSuspendedDesc')}
      >
        <Button size='small' loading={closingTabs} onClick={handleCloseSuspended}>
          {t('settings.browserData.closeSuspendedButton')}
        </Button>
      </PreferenceRow>
      <PreferenceRow label={t('settings.browserData.clearLabel')} description={t('settings.browserData.clearDesc')}>
        <Button size='small' status='danger' loading={clearing} disabled={!selected} onClick={handleClear}>
          {t('common.clear')}
        </Button>
      </PreferenceRow>
    </div>
  );
};

export default BrowserDataSection;
