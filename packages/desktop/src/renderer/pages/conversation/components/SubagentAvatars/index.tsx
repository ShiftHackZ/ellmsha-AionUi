/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TChatConversation } from '@/common/config/storage';
import { Button, Tooltip } from '@arco-design/web-react';
import classNames from 'classnames';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { getSubagentMetadata, isSubagentRunning } from '../../GroupedHistory/types';
import { useContainerWidth } from '../../hooks/useContainerWidth';
import styles from './SubagentAvatars.module.css';

const AVATAR_SIZE = 28;
const AVATAR_GAP = 8;

const SubagentAvatars: React.FC<{ conversations: TChatConversation[] }> = ({ conversations }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { containerRef, containerWidth } = useContainerWidth();
  const capacity = Math.max(1, Math.floor((containerWidth + AVATAR_GAP) / (AVATAR_SIZE + AVATAR_GAP)));
  const visibleCount = capacity >= conversations.length ? conversations.length : capacity - 1;
  const hidden = conversations.slice(visibleCount);
  const describe = (child: TChatConversation) => {
    const metadata = getSubagentMetadata(child)!;
    const status = metadata.status ?? 'running';
    return `${metadata.label ?? child.name} · ${t(`conversation.history.subagentStatus.${status}`)}`;
  };

  return (
    <div
      ref={containerRef}
      className={styles.strip}
      style={{ width: conversations.length * (AVATAR_SIZE + AVATAR_GAP) - AVATAR_GAP }}
    >
      {conversations.slice(0, visibleCount).map((child) => {
        const metadata = getSubagentMetadata(child)!;
        const label = metadata.label ?? child.name;
        const status = metadata.status ?? 'running';
        return (
          <Tooltip key={child.id} content={describe(child)} trigger={['hover', 'focus']}>
            <Button
              size='mini'
              type='secondary'
              shape='circle'
              aria-label={describe(child)}
              className={classNames(styles.avatar, {
                [styles.running]: isSubagentRunning(child),
                '!border-[rgb(var(--success-6))]': status === 'completed',
                '!border-[rgb(var(--danger-6))]': status === 'errored',
                '!border-[rgb(var(--warning-6))]': status === 'waiting_for_user' || status === 'waiting_for_approval',
              })}
              onClick={() => void navigate(`/conversation/${child.id}`)}
            >
              {label.trim().slice(0, 2).toLocaleUpperCase()}
            </Button>
          </Tooltip>
        );
      })}
      {hidden.length > 0 && (
        <Tooltip
          trigger={['hover', 'focus', 'click']}
          content={
            <div className='flex flex-col gap-4px max-w-320px max-h-60vh overflow-y-auto break-words'>
              {hidden.map((child) => (
                <div key={child.id}>{describe(child)}</div>
              ))}
            </div>
          }
        >
          <Button size='mini' type='secondary' shape='circle' className={styles.avatar} aria-label={t('common.more')}>
            …
          </Button>
        </Tooltip>
      )}
    </div>
  );
};

export default SubagentAvatars;
