/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Tag, Tooltip, Typography } from '@arco-design/web-react';
import { Github } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { harnessRelease, harnessVersion } from '@/common/branding';
import { openExternalUrl } from '@/renderer/utils/platform';

const AboutModalContent: React.FC = () => {
  const { t } = useTranslation();
  return (
    <div className='w-full max-w-720px mx-auto px-24px pb-24px'>
      <div className='flex flex-col items-center text-center pt-16px pb-32px'>
        <Typography.Title heading={2} className='text-t-primary mb-8px'>
          eLLMsha
        </Typography.Title>
        <Typography.Text className='text-t-secondary mb-16px'>{t('settings.appDescription')}</Typography.Text>
        <Tag size='large' className='font-600'>
          {harnessVersion}
        </Tag>
      </div>
      <div className='mb-16px'>
        <Typography.Title heading={5} className='text-t-primary mb-4px'>
          {t('settings.upstreamComponents')}
        </Typography.Title>
        <Typography.Text className='text-t-secondary text-13px'>
          {t('settings.upstreamComponentsDescription')}
        </Typography.Text>
      </div>
      <div className='flex flex-col gap-10px'>
        {harnessRelease.components.map((component) => (
          <div
            key={component.name}
            className='flex items-center justify-between flex-wrap gap-12px p-16px rd-12px bg-fill-2'
          >
            <Button
              type='text'
              className='!text-t-primary !px-0'
              icon={<Github size={18} className='mr-8px' />}
              onClick={() => void openExternalUrl(component.forkUrl ?? component.url)}
            >
              {component.name}
            </Button>
            <div className='flex items-center gap-8px'>
              <Tooltip content={component.commit}>
                {component.forkUrl ? (
                  <Button type='text' size='mini' className='!px-0' onClick={() => void openExternalUrl(component.url)}>
                    <Tag bordered>{t('settings.upstreamVersion', { version: component.upstream })}</Tag>
                  </Button>
                ) : (
                  <Tag bordered>{t('settings.upstreamVersion', { version: component.upstream })}</Tag>
                )}
              </Tooltip>
              {component.patch > 0 && <Tag bordered>{t('settings.componentPatch', { patch: component.patch })}</Tag>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default AboutModalContent;
