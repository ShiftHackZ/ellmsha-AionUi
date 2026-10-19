import React, { useCallback, useEffect, useState } from 'react';
import { Input, Message } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import AionModal from '@/renderer/components/base/AionModal';
import { getRoutingSnapshot } from '@/common/types/agent/routerTypes';
import { useRouterConversation } from '@/renderer/components/agent/AutoRouter/useRouter';
import type { TeamAssistant } from '@/common/types/team/teamTypes';
import type { TeamAssistantInput } from '@/common/adapter/teamMapper';
import { getConversationCreateErrorMessage } from '@renderer/pages/conversation/utils/conversationCreateError';
import { getSendBoxDraftHook } from '@renderer/hooks/chat/useSendBoxDraft';
import { useTeamAssistantOptions } from '../../hooks/useTeamAssistantOptions';
import { useTeamTabs } from '../../hooks/TeamTabsContext';
import type { TeamAssistantOption } from '../assistantSelectUtils';
import { resolveDefaultTeamAgentModel } from '../teamCreateModelResolver';
import TeamAssistantPickerDropdown from './TeamAssistantPickerDropdown';

const useAcpDraft = getSendBoxDraftHook('acp', { _type: 'acp', atPath: [], content: '', uploadFile: [] });
const useAionrsDraft = getSendBoxDraftHook('aionrs', { _type: 'aionrs', atPath: [], content: '', uploadFile: [] });

type Props = {
  children: React.ReactElement;
  disabled?: boolean;
};

const TeamAddMemberPopover: React.FC<Props> = ({ children, disabled = false }) => {
  const { t, i18n } = useTranslation();
  const { assistants } = useTeamAssistantOptions(i18n?.language ?? 'en-US');
  const { addAssistant, switchTab, assistants: teamMembers = [] } = useTeamTabs();
  const [visible, setVisible] = useState(false);
  const [routingAssistant, setRoutingAssistant] = useState<TeamAssistantOption>();
  const [initialTask, setInitialTask] = useState('');
  const [pendingAssistantId, setPendingAssistantId] = useState<string | undefined>();

  // Leader 会话草稿：用于「告诉 Leader」预填提示词。Hook 必须无条件调用，
  // 未知 Leader 会话时传空串（不写入）。按 Leader 后端选 acp/aionrs 草稿。
  const leader = teamMembers.find((m) => m.role === 'leader');
  const leaderConversationId = leader?.conversation_id ?? '';
  const leaderConversation = useRouterConversation(leaderConversationId);
  const routedLeader = Boolean(getRoutingSnapshot(leaderConversation.data?.extra));
  const acpDraft = useAcpDraft(leaderConversationId);
  const aionrsDraft = useAionrsDraft(leaderConversationId);

  useEffect(() => {
    if (disabled) setVisible(false);
  }, [disabled]);

  const handleTellLeader = useCallback(() => {
    if (!leader?.slot_id || !leaderConversationId) return;
    switchTab(leader.slot_id);
    const text = t('team.addMember.tellLeaderPrefill', {
      defaultValue: 'Help me add a member good at ___ to the team',
    });
    if (leader.assistant_backend === 'aionrs') {
      aionrsDraft.mutate((prev) => ({ ...prev, content: text }));
    } else {
      acpDraft.mutate((prev) => ({ ...prev, content: text }));
    }
    setVisible(false);
  }, [leader?.slot_id, leader?.assistant_backend, leaderConversationId, switchTab, t, acpDraft, aionrsDraft]);

  const addMember = async (assistant: TeamAssistantOption, initial_task?: string) => {
    if (disabled || !addAssistant || pendingAssistantId) return;
    setPendingAssistantId(assistant.id);
    try {
      const model = initial_task
        ? undefined
        : await resolveDefaultTeamAgentModel({
            assistant_id: assistant.id,
            assistant_backend: assistant.backend,
          });
      const input: TeamAssistantInput = {
        role: 'teammate',
        assistant_name: assistant.name,
        assistant_id: assistant.id,
        model,
        initial_task,
      };
      const created: TeamAssistant = await addAssistant(input);
      setVisible(false);
      setRoutingAssistant(undefined);
      setInitialTask('');
      switchTab(created.slot_id);
    } catch (error) {
      Message.error(getConversationCreateErrorMessage(error, t));
    } finally {
      setPendingAssistantId(undefined);
    }
  };

  const handleSelect = (assistant: TeamAssistantOption) => {
    if (disabled || pendingAssistantId || leaderConversation.isLoading) return;
    if (leaderConversation.error) {
      Message.error(t('settings.autoRouter.errors.loadFailed'));
      return;
    }
    if (routedLeader || assistant.backend === 'auto-router') {
      setRoutingAssistant(assistant);
      setInitialTask('');
      setVisible(false);
    } else void addMember(assistant);
  };

  return (
    <>
      {routingAssistant && (
        <AionModal
          visible={Boolean(routingAssistant)}
          title={t('settings.autoRouter.initialTask')}
          onCancel={() => {
            if (!pendingAssistantId) setRoutingAssistant(undefined);
          }}
          onOk={() => {
            if (routingAssistant && initialTask.trim()) return addMember(routingAssistant, initialTask.trim());
          }}
          confirmLoading={Boolean(pendingAssistantId)}
          okButtonProps={{ disabled: !initialTask.trim() || disabled }}
        >
          <Input.TextArea
            aria-label={t('settings.autoRouter.initialTask')}
            value={initialTask}
            onChange={setInitialTask}
            placeholder={t('settings.autoRouter.initialTaskPlaceholder')}
            autoSize={{ minRows: 3, maxRows: 8 }}
          />
          <p className='text-12px text-t-secondary'>{t('settings.autoRouter.initialTaskHelp')}</p>
        </AionModal>
      )}
      <TeamAssistantPickerDropdown
        assistants={assistants}
        onSelect={handleSelect}
        visible={visible}
        onVisibleChange={setVisible}
        disabled={disabled || !addAssistant || leaderConversation.isLoading}
        pendingAssistantId={pendingAssistantId}
        testIdPrefix='team-add-member'
        panelTestId='team-add-member-panel'
        title={t('team.addMember.title', { defaultValue: 'Add member' })}
        subtitle={t('team.addMember.subtitle', { defaultValue: 'The same assistant can be added repeatedly' })}
        guidanceFooter={
          leader?.slot_id ? (
            <div className='text-12px leading-18px text-t-tertiary'>
              {t('team.addMember.tellLeaderHint', {
                defaultValue: 'Not a good fit? You can also ask the Leader to arrange it.',
              })}{' '}
              <span
                data-testid='team-add-member-tell-leader'
                className='text-[color:var(--brand)] font-500 cursor-pointer hover:underline'
                onClick={handleTellLeader}
              >
                {t('team.addMember.tellLeaderCta', { defaultValue: 'Tell the Leader →' })}
              </span>
            </div>
          ) : undefined
        }
      >
        {children}
      </TeamAssistantPickerDropdown>
    </>
  );
};

export default TeamAddMemberPopover;
