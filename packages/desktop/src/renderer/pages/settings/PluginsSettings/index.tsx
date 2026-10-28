import React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Button } from '@arco-design/web-react';
import { isWebUiBrowserMode } from '@/common/adapter/httpBridge';
import { AION_ADD_BUTTON_CLASS } from '@/renderer/components/base/TalkToButlerButton';
import SettingsPageHeader from '../components/SettingsPageHeader';
import SettingsPageWrapper from '../components/SettingsPageWrapper';
import PluginsContent from './PluginsContent';

const PluginsSettings: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pluginName } = useParams<{ pluginName?: string }>();
  const [searchParams] = useSearchParams();
  const installView = !pluginName && searchParams.get('view') === 'install';
  const canInstall = !isWebUiBrowserMode();
  return (
    <SettingsPageWrapper contentClassName='max-w-1200px'>
      <div className='flex flex-col gap-16px'>
        <SettingsPageHeader
          title={t('settings.plugins')}
          description={t('settings.pluginsDescription')}
          actions={
            !pluginName && !installView && canInstall ? (
              <Button
                type='primary'
                size='small'
                className={AION_ADD_BUTTON_CLASS}
                onClick={() => navigate('/settings/plugins?view=install')}
              >
                {t('settings.pluginInstall')}
              </Button>
            ) : undefined
          }
        />
        <PluginsContent
          selectedPluginName={pluginName}
          installView={installView}
          onInstallViewChange={(open) => navigate(open ? '/settings/plugins?view=install' : '/settings/plugins')}
          onSelectedPluginChange={(name) =>
            navigate(name ? `/settings/plugins/${encodeURIComponent(name)}` : '/settings/plugins')
          }
        />
      </div>
    </SettingsPageWrapper>
  );
};

export default PluginsSettings;
