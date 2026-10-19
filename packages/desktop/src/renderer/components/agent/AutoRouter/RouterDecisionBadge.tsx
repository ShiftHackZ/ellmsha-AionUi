import React, { useCallback, useState, useSyncExternalStore } from 'react';
import useSWR from 'swr';
import { Button, Message, Tooltip } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { httpRequest } from '@/common/adapter/httpBridge';
import { parseError } from '@/common/utils';
import type { IMessageText, TMessage } from '@/common/chat/chatLib';
import { getRoutingSnapshot, routerTargetKey, type RouterSnapshot } from '@/common/types/agent/routerTypes';
import { useRouterConversation, useRouterOptions } from './useRouter';
import {
  getConversationRuntimeViewSnapshot,
  subscribeConversationRuntimeView,
} from '@/renderer/pages/conversation/runtime/conversationRuntimeViewStore';

export const RouterDecisionBadge: React.FC<{ snapshot: RouterSnapshot }> = ({ snapshot }) => {
  const { t } = useTranslation();
  const { options } = useRouterOptions();
  const target = snapshot.decision.target;
  const label =
    options.find((option) => option.key === routerTargetKey(target))?.label ??
    `${target.kind === 'provider' ? target.provider_id : target.agent_id} · ${target.model}`;
  return (
    <Tooltip
      trigger={['hover', 'click', 'focus']}
      content={
        <div className='max-w-360px flex flex-col gap-6px'>
          <strong>{label}</strong>
          <span>{t('settings.autoRouter.pinned')}</span>
          <span>
            {t(`settings.autoRouter.modes.${snapshot.config.mode}`)} ·{' '}
            {t(`settings.autoRouter.profiles.${snapshot.config.profile}`)}
          </span>
          <span>
            {t(
              snapshot.decision.managed_children
                ? 'settings.autoRouter.managedChildren'
                : 'settings.autoRouter.cliChildren'
            )}
          </span>
          {snapshot.decision.reasons.map((reason) => (
            <span key={reason}>
              {t(`settings.autoRouter.reasons.${reason}`, { defaultValue: t('settings.autoRouter.otherReason') })}
            </span>
          ))}
        </div>
      }
    >
      <Button
        size='small'
        shape='round'
        data-testid='router-decision-badge'
        aria-label={`${t('settings.autoRouter.title')} · ${label}`}
        className='max-w-240px !text-t-primary'
      >
        <span className='truncate'>
          {t('settings.autoRouter.title')} · {target.model}
        </span>
      </Button>
    </Tooltip>
  );
};

/** Human review is tied to a real completed assistant message, never inferred. */
export const RouterReview: React.FC<{ message: IMessageText }> = ({ message }) => {
  const { data: conversation } = useRouterConversation(message.conversation_id);
  if (
    !getRoutingSnapshot(conversation?.extra) ||
    (conversation?.extra as { subagent?: unknown } | undefined)?.subagent ||
    message.position !== 'left' ||
    message.hidden
  )
    return null;
  return <RoutedAnswerReview message={message} />;
};

const RoutedAnswerReview: React.FC<{ message: IMessageText }> = ({ message }) => {
  const { t } = useTranslation();
  const getSnapshot = useCallback(
    () => getConversationRuntimeViewSnapshot(message.conversation_id),
    [message.conversation_id]
  );
  // MessageList owns runtime hydration. Historical answer reviews only observe
  // its shared state; mounting a review must never reset the send/stop gate.
  const runtime = useSyncExternalStore(subscribeConversationRuntimeView, getSnapshot, getSnapshot);
  const [saving, setSaving] = useState(false);
  const [recorded, setRecorded] = useState<boolean>();
  const eligible = runtime.hydrated && !runtime.isProcessing && !runtime.activeTurnId;
  // Streamed rows have a client UUID and no finished status. Read the owned,
  // persisted row after completion before offering a review of that answer.
  const messageId = message.msg_id ?? message.id;
  const { data: completed } = useSWR<TMessage>(
    eligible
      ? `/api/conversations/${encodeURIComponent(message.conversation_id)}/messages/${encodeURIComponent(messageId)}`
      : null,
    (path: string) => httpRequest<TMessage>('GET', path),
    { revalidateOnFocus: false, errorRetryCount: 2 }
  );
  if (
    !eligible ||
    !completed ||
    completed.conversation_id !== message.conversation_id ||
    completed.type !== 'text' ||
    completed.position !== 'left' ||
    completed.status !== 'finish' ||
    completed.hidden
  )
    return null;
  const review = async (accepted: boolean) => {
    setSaving(true);
    try {
      await httpRequest('POST', `/api/conversations/${encodeURIComponent(message.conversation_id)}/routing/outcome`, {
        accepted,
        message_id: completed.id,
      });
      setRecorded(accepted);
      Message.success(t('settings.autoRouter.reviewSaved'));
    } catch (error) {
      Message.error(parseError(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className='my-6px flex flex-wrap items-center gap-8px' data-testid='router-review'>
      <span className='text-12px text-t-secondary'>{t('settings.autoRouter.reviewLabel')}</span>
      <Button
        size='mini'
        loading={saving}
        type={recorded === true ? 'primary' : 'outline'}
        onClick={() => void review(true)}
      >
        {t('settings.autoRouter.accept')}
      </Button>
      <Button
        size='mini'
        disabled={saving}
        type={recorded === false ? 'primary' : 'outline'}
        onClick={() => void review(false)}
      >
        {t('settings.autoRouter.reject')}
      </Button>
    </div>
  );
};
