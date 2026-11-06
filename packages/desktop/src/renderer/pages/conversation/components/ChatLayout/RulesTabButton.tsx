import { usePreviewContext } from '@/renderer/pages/conversation/Preview';
import { Button, Tooltip } from '@arco-design/web-react';
import { Agreement, Key } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';

export const RulesTabButton = ({ onOpen }: { onOpen?: () => void }) => {
  const { t } = useTranslation();
  const { openPreview, activeTab, isOpen } = usePreviewContext();
  const selected = isOpen && activeTab?.content_type === 'rules';
  const title = t('conversation.rules.title');
  return (
    <Tooltip content={title} mini>
      <Button
        type='text'
        size='small'
        className={`!h-28px !w-28px !min-w-28px lt-sm:!h-44px lt-sm:!w-44px lt-sm:!min-w-44px !p-0 inline-flex items-center justify-center ${selected ? '!text-t-primary !bg-2' : '!text-t-secondary'}`}
        aria-label={title}
        aria-pressed={Boolean(selected)}
        icon={<Agreement theme='outline' size={16} />}
        onClick={() => {
          openPreview('', 'rules', { title });
          onOpen?.();
        }}
      />
    </Tooltip>
  );
};

export const SecretsTabButton = ({ onOpen }: { onOpen?: () => void }) => {
  const { t } = useTranslation();
  const { openPreview, activeTab, isOpen } = usePreviewContext();
  const title = t('settings.secrets.title');
  return (
    <Tooltip content={title} mini>
      <Button
        type='text'
        size='small'
        className='!h-28px !w-28px !min-w-28px lt-sm:!h-44px lt-sm:!w-44px !p-0 inline-flex items-center justify-center'
        aria-label={title}
        aria-pressed={isOpen && activeTab?.content_type === 'secrets'}
        icon={<Key size={16} />}
        onClick={() => {
          openPreview('', 'secrets', { title });
          onOpen?.();
        }}
      />
    </Tooltip>
  );
};
