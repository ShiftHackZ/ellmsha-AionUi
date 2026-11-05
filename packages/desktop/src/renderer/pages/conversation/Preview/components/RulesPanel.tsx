/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { isBackendHttpError } from '@/common/adapter/httpBridge';
import type {
  ChatRule,
  ChatRuleMutation,
  ChatRules,
  ProjectRuleFile,
  ProjectFileMutation,
} from '@/common/types/agent/chatRules';
import { useProjectSkillCatalog } from '@/renderer/hooks/chat/useProjectSkills';
import SettingsPageHeader from '@/renderer/pages/settings/components/SettingsPageHeader';
import { Button, Input, Modal, Spin } from '@arco-design/web-react';
import { Delete, Edit, Plus, Refresh } from '@icon-park/react';
import React, { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR, { SWRConfig } from 'swr';

type RuleAction = { action: 'add'; scope: ChatRule['scope'] } | { action: 'edit' | 'delete'; rule: ChatRule };
type Dialog = RuleAction & {
  trigger: HTMLElement;
  file?: Pick<ProjectRuleFile, 'id' | 'path' | 'revision' | 'rootLabel'>;
};

const accessDenied = (error: unknown) => isBackendHttpError(error) && [401, 403, 404].includes(error.status);

const iconButton = '!text-t-secondary !min-w-32px !h-32px lt-sm:!min-w-44px lt-sm:!h-44px';

export function RulesPanel({ conversationId }: { conversationId: string }) {
  // A reopened tab must authorize a fresh read before displaying sensitive rule bodies.
  return (
    <SWRConfig key={conversationId} value={{ provider: () => new Map() }}>
      <RulesContent conversationId={conversationId} />
    </SWRConfig>
  );
}

function RulesContent({ conversationId }: { conversationId: string }) {
  const { t } = useTranslation();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const { data, error, isLoading, isValidating, mutate } = useSWR(
    ['chat-rules', conversationId],
    async () => {
      try {
        return await ipcBridge.conversation.getRules.invoke({ conversation_id: conversationId });
      } catch (err) {
        // Replace sensitive cached rows when access is revoked; a transient error retains the last response.
        if (accessDenied(err)) return null;
        throw err;
      }
    },
    // Agent memory writes also originate outside the renderer. This tab polls only while mounted and visible.
    { refreshInterval: (rules) => (rules === null ? 0 : 3000) }
  );
  const repository = useSWR(
    ['project-rule-files', conversationId],
    async () => {
      try {
        return await ipcBridge.conversation.getProjectRuleFiles.invoke({ conversation_id: conversationId });
      } catch (err) {
        if (accessDenied(err)) return null;
        throw err;
      }
    },
    { refreshInterval: (files) => (files === null ? 0 : 3000) }
  );
  const projectId = repository.data?.projectId;
  const skills = useProjectSkillCatalog(projectId, true);
  useEffect(() => {
    setDialog((draft) => {
      if (!draft) return draft;
      return draft.file
        ? repository.data === null
          ? null
          : draft
        : data === null || data?.enabled === false
          ? null
          : draft;
    });
  }, [data, repository.data]);
  const file = dialog?.file;
  const currentFile = file && repository.data?.files.find((item) => item.id === file.id);
  const editorData = file
    ? {
        enabled: true,
        projectAvailable: true,
        overBudget: false,
        writable: currentFile?.writable === true && file.revision === currentFile.revision,
        rules: currentFile ? fileRows(currentFile) : [],
      }
    : data;
  const refresh = (): void => {
    void mutate();
    void repository.mutate();
    if (projectId) void skills.mutate();
  };
  const openDialog = (action: RuleAction, event: Event, source?: ProjectRuleFile): void => {
    if (event.currentTarget instanceof HTMLElement)
      setDialog({
        ...action,
        trigger: event.currentTarget,
        file: source && { id: source.id, path: source.path, revision: source.revision, rootLabel: source.rootLabel },
      });
  };
  return (
    <section className='box-border h-full min-h-0 overflow-auto p-16px md:p-24px text-t-primary'>
      <SettingsPageHeader
        sticky={false}
        title={t('conversation.rules.title')}
        description={data?.enabled ? t(data.writable ? 'conversation.rules.nextTurn' : 'common.readOnly') : undefined}
        actions={
          <Button
            type='text'
            className={iconButton}
            icon={<Refresh />}
            aria-label={t('common.refresh')}
            loading={isValidating && !isLoading}
            onClick={refresh}
          />
        }
      />
      {isLoading && <Spin className='mt-16px' />}
      {(error || data === null) && (
        <div role='alert' className='flex items-center gap-8px mt-16px'>
          {data === null
            ? t('conversation.rules.unavailable')
            : data
              ? t('conversation.rules.staleList')
              : t('conversation.rules.loadFailed')}
          <Button size='small' onClick={refresh}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      {data && !data.enabled && <p className='text-t-secondary'>{t('conversation.rules.disabled')}</p>}
      {data?.enabled && data.overBudget && (
        <p role='alert' className='text-t-primary'>
          {t('conversation.rules.overBudget')}
        </p>
      )}
      {data?.enabled &&
        (['global', 'project'] as const).map((scope) => {
          const isGlobal = scope === 'global';
          const available = isGlobal || data.projectAvailable;
          const rules = data.rules.filter((rule) => rule.scope === scope);
          const heading = isGlobal ? t('conversation.rules.global') : t('conversation.rules.project');
          return (
            <RuleSection
              key={scope}
              scope={scope}
              heading={heading}
              rules={rules}
              canAdd={available && data.writable}
              writable={data.writable}
              blocked={Boolean(error)}
              overBudget={data.overBudget}
              openDialog={openDialog}
              addLabel={t(isGlobal ? 'conversation.rules.addGlobal' : 'conversation.rules.addProject')}
              empty={t(
                !available
                  ? 'conversation.rules.noProject'
                  : isGlobal
                    ? 'conversation.rules.emptyGlobal'
                    : 'conversation.rules.emptyProject'
              )}
            />
          );
        })}
      {repository.error && (
        <p role='alert'>
          {t('conversation.rules.fileLoadFailed')}{' '}
          <Button size='small' onClick={() => void repository.mutate()}>
            {t('common.retry')}
          </Button>
        </p>
      )}
      {repository.data?.files.map((source) => (
        <RuleSection
          key={source.id}
          scope='project'
          heading={t('conversation.rules.fileHeading', { path: source.path })}
          caption={[source.rootLabel, source.condition].filter(Boolean).join(' · ')}
          rules={fileRows(source)}
          canAdd={source.writable}
          writable={source.writable}
          blocked={Boolean(repository.error)}
          overBudget={false}
          addLabel={t('conversation.rules.addFile', { path: source.path })}
          empty={t('conversation.rules.emptyProject')}
          openDialog={(action, event) => openDialog(action, event, source)}
        />
      ))}
      {projectId && skills.error && (
        <p role='alert'>
          {t('conversation.rules.skillsLoadFailed')}{' '}
          <Button size='small' onClick={() => void skills.mutate()}>
            {t('common.retry')}
          </Button>
        </p>
      )}
      {projectId && !skills.error && Boolean(skills.data?.length) && (
        <section className='mt-20px'>
          <h2 className='text-16px font-semibold mb-8px'>{t('conversation.rules.projectSkills')}</h2>
          <ul className='list-none m-0 px-12px border border-[var(--border-base)] rounded-lg'>
            {skills.data?.map((skill) => (
              <li key={skill.name} className='py-10px border-b border-[var(--border-base)] last:border-b-0 break-words'>
                <strong>/{skill.name}</strong>
                <p className='m-0 mt-4px text-t-secondary'>{skill.description}</p>
                <code className='text-12px'>{skill.source}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
      {dialog && editorData?.enabled && (
        <RuleDialog
          conversationId={conversationId}
          dialog={dialog}
          data={editorData}
          onClose={() => setDialog(null)}
          refresh={refresh}
          staleList={file ? Boolean(repository.error) : Boolean(error)}
          denyAccess={() => {
            setDialog(null);
            if (file) void repository.mutate(null, false);
            else void mutate(null, false);
          }}
        />
      )}
    </section>
  );
}

function fileRows(file: ProjectRuleFile): ChatRule[] {
  return file.rules.map((rule) => ({
    path: rule.id,
    scope: 'project',
    revision: file.revision,
    title: rule.title,
    content: rule.content,
    editable: file.writable,
  }));
}

function RuleSection({
  heading,
  caption,
  scope,
  rules,
  canAdd,
  writable,
  blocked,
  overBudget,
  addLabel,
  empty,
  openDialog,
}: {
  heading: string;
  caption?: string;
  scope: ChatRule['scope'];
  rules: ChatRule[];
  canAdd: boolean;
  writable: boolean;
  blocked: boolean;
  overBudget: boolean;
  addLabel: string;
  empty: string;
  openDialog: (action: RuleAction, event: Event) => void;
}) {
  const { t } = useTranslation();
  return (
    <section aria-label={heading} className='mt-20px'>
      <div className='flex items-center justify-between gap-8px mb-8px'>
        <h2 className='text-16px font-semibold m-0 min-w-0 break-words'>{heading}</h2>
        {canAdd && (
          <Button
            size='small'
            className='lt-sm:!h-44px'
            disabled={blocked || overBudget}
            icon={<Plus size={14} />}
            aria-label={addLabel}
            onClick={(event) => openDialog({ action: 'add', scope }, event)}
          >
            {t('common.add')}
          </Button>
        )}
      </div>
      {caption && <p className='text-12px text-t-secondary mt-0 mb-8px break-words'>{caption}</p>}
      {rules.length === 0 ? (
        <p className='m-0 text-13px text-t-secondary'>{empty}</p>
      ) : (
        <ul className='list-none m-0 px-12px bg-base border border-[var(--border-base)] rounded-lg'>
          {rules.map((rule) => (
            <li key={rule.path} className='py-12px border-b border-[var(--border-base)] last:border-b-0'>
              <div className='flex items-start justify-between gap-8px'>
                <h3 className='min-w-0 m-0 text-14px font-semibold break-words'>{rule.title}</h3>
                {rule.editable && writable ? (
                  <div className='flex shrink-0 gap-4px'>
                    <Button
                      type='text'
                      size='small'
                      icon={<Edit size={15} />}
                      aria-label={t('conversation.rules.editNamed', { title: rule.title })}
                      className={iconButton}
                      disabled={blocked}
                      onClick={(event) => openDialog({ action: 'edit', rule }, event)}
                    />
                    <Button
                      type='text'
                      size='small'
                      icon={<Delete size={15} />}
                      aria-label={t('conversation.rules.deleteNamed', { title: rule.title })}
                      className={iconButton}
                      disabled={blocked}
                      onClick={(event) => openDialog({ action: 'delete', rule }, event)}
                    />
                  </div>
                ) : (
                  <span className='text-12px text-t-secondary'>{t('common.readOnly')}</span>
                )}
              </div>
              <p className='m-0 mt-4px whitespace-pre-wrap break-words text-14px leading-relaxed text-t-secondary'>
                {rule.content}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RuleDialog({
  conversationId,
  dialog,
  data,
  onClose,
  refresh,
  denyAccess,
  staleList,
}: {
  conversationId: string;
  dialog: Dialog;
  data: ChatRules;
  onClose: () => void;
  refresh: () => void;
  denyAccess: () => void;
  staleList: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const rule = dialog.action === 'add' ? undefined : dialog.rule;
  const scope = dialog.action === 'add' ? dialog.scope : dialog.rule.scope;
  const [title, setTitle] = useState(rule?.title ?? '');
  const [content, setContent] = useState(rule?.content ?? '');
  const [saving, setSaving] = useState(false);
  const removed = useRef(false);
  useEffect(() => {
    const trigger = dialog.trigger;
    const sectionAdd = trigger.closest('section')?.querySelector('button');
    return () => {
      const target = !removed.current && trigger.isConnected ? trigger : sectionAdd;
      if (target?.isConnected) target.focus();
    };
  }, [dialog.trigger]);
  const [failure, setFailure] = useState<'conflict' | 'duplicate' | 'write'>();
  const current = rule && data.rules.find((item) => item.path === rule.path && item.scope === scope);
  // Polling updates the list, never the user's draft or the revision captured when the dialog opened.
  const stale =
    failure === 'conflict' ||
    !data.enabled ||
    !data.writable ||
    (scope === 'project' && !data.projectAvailable) ||
    (rule && (!current?.editable || current.revision !== rule.revision));
  const deleting = dialog.action === 'delete';
  const canSave =
    !stale &&
    !staleList &&
    !saving &&
    !(dialog.action === 'add' && data.overBudget) &&
    (deleting || (title.trim().length > 0 && content.trim().length > 0));
  const submit = async () => {
    if (!canSave) return;
    const fields = { title: title.trim(), content: content.trim() };
    let mutation: ChatRuleMutation;
    if (dialog.action === 'add') mutation = { action: 'add', scope, ...fields };
    else {
      const identity = { scope, path: dialog.rule.path, revision: dialog.rule.revision };
      mutation =
        dialog.action === 'delete' ? { action: 'delete', ...identity } : { action: 'edit', ...identity, ...fields };
    }
    setSaving(true);
    setFailure(undefined);
    try {
      if (dialog.file) {
        const { id: fileId, revision } = dialog.file;
        const change: ProjectFileMutation =
          dialog.action === 'add'
            ? { action: 'add', fileId, revision, ...fields }
            : dialog.action === 'edit'
              ? { action: 'edit', fileId, revision, ruleId: dialog.rule.path, ...fields }
              : { action: 'delete', fileId, revision, ruleId: dialog.rule.path };
        await ipcBridge.conversation.mutateProjectRuleFile.invoke({
          conversation_id: conversationId,
          mutation: change,
        });
      } else await ipcBridge.conversation.mutateRule.invoke({ conversation_id: conversationId, mutation });
      removed.current = deleting;
      onClose();
      refresh();
    } catch (err) {
      if (accessDenied(err)) {
        denyAccess();
        return;
      }
      if (isBackendHttpError(err) && err.status === 409) {
        setFailure(dialog.action === 'add' && !dialog.file ? 'duplicate' : 'conflict');
      } else setFailure('write');
      refresh();
    } finally {
      setSaving(false);
    }
  };
  const dialogTitle = deleting
    ? t('conversation.rules.deleteRule')
    : dialog.action === 'edit'
      ? t('conversation.rules.editRule')
      : scope === 'global'
        ? t('conversation.rules.addGlobal')
        : t('conversation.rules.addProject');
  return (
    <Modal
      visible
      title={dialogTitle}
      className='!max-w-90vw'
      onCancel={() => {
        if (!saving) onClose();
      }}
      onOk={submit}
      okText={deleting ? t('common.delete') : t('common.save')}
      cancelText={t('common.cancel')}
      okButtonProps={{ disabled: !canSave, status: deleting ? 'danger' : undefined, className: 'lt-sm:!h-44px' }}
      cancelButtonProps={{ disabled: saving, className: 'lt-sm:!h-44px' }}
      confirmLoading={saving}
      maskClosable={false}
      autoFocus
      focusLock
    >
      {deleting ? (
        <p className='m-0 break-words'>
          {dialog.file
            ? t('conversation.rules.deleteFile', {
                title: rule?.title,
                path: [dialog.file.rootLabel, dialog.file.path].filter(Boolean).join(' / '),
              })
            : scope === 'global'
              ? t('conversation.rules.deleteGlobal', { title: rule?.title })
              : t('conversation.rules.deleteProject', { title: rule?.title })}
        </p>
      ) : (
        <div className='flex flex-col gap-12px'>
          <p className='m-0 text-13px text-t-secondary'>
            {dialog.file
              ? t('conversation.rules.fileApplies', {
                  path: [dialog.file.rootLabel, dialog.file.path].filter(Boolean).join(' / '),
                })
              : scope === 'global'
                ? t('conversation.rules.globalApplies')
                : t('conversation.rules.projectApplies')}
          </p>
          <div>
            <label htmlFor={`${id}-title`} className='block mb-4px'>
              {t('conversation.rules.ruleTitle')}
            </label>
            <Input id={`${id}-title`} autoFocus value={title} onChange={setTitle} maxLength={160} disabled={saving} />
          </div>
          <div>
            <label htmlFor={`${id}-content`} className='block mb-4px'>
              {t('conversation.rules.instruction')}
            </label>
            <Input.TextArea
              id={`${id}-content`}
              value={content}
              onChange={setContent}
              maxLength={20_000}
              rows={6}
              disabled={saving}
            />
          </div>
        </div>
      )}
      {staleList && (
        <div role='alert' className='mt-12px flex items-center gap-8px'>
          {t('conversation.rules.staleList')}
          <Button size='small' onClick={refresh}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      {data.overBudget && <p className='text-t-secondary'>{t('conversation.rules.overBudget')}</p>}
      {(stale || failure) && (
        <p role='alert' className='mb-0 text-[var(--color-danger-6)]'>
          {stale
            ? t('conversation.rules.stale')
            : failure === 'duplicate'
              ? t('conversation.rules.duplicateTitle')
              : deleting
                ? t('common.deleteFailed')
                : t('common.saveFailed')}
        </p>
      )}
    </Modal>
  );
}
