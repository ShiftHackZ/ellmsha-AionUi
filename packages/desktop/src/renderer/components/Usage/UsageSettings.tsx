import React from 'react';
import Usage from './index';
import SettingsPageWrapper from '@/renderer/pages/settings/components/SettingsPageWrapper';

export default function UsageSettings() {
  return (
    <SettingsPageWrapper className='bg-1'>
      <Usage />
    </SettingsPageWrapper>
  );
}
