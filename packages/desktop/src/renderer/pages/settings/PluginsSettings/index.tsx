import React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import SettingsPageHeader from '../components/SettingsPageHeader';
import SettingsPageWrapper from '../components/SettingsPageWrapper';
import PluginsContent from './PluginsContent';

const PluginsSettings: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pluginName } = useParams<{ pluginName?: string }>();
  return (
    <SettingsPageWrapper contentClassName='max-w-1200px'>
      <div className='flex flex-col gap-16px'>
        <SettingsPageHeader title={t('settings.plugins')} description={t('settings.pluginsDescription')} />
        <PluginsContent
          selectedPluginName={pluginName}
          onSelectedPluginChange={(name) =>
            navigate(name ? `/settings/plugins/${encodeURIComponent(name)}` : '/settings/plugins')
          }
        />
      </div>
    </SettingsPageWrapper>
  );
};

export default PluginsSettings;
