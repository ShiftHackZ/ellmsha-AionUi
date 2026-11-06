import { secretErrorKey } from './errorKey';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, Message, Modal, Space, Spin, Tag, Tooltip } from '@arco-design/web-react';
import { Delete, Edit, PreviewOpen, Plus, Refresh } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { secretsRequest } from '@/common/adapter/secretsBridge';
import { secrets, extensions } from '@/common/adapter/ipcBridge';
import type {
  SecretGroup,
  SecretList,
  SecretMetadata,
  SecretRead,
  SecretRecord,
  VaultStatus,
} from '@/common/types/secrets';
import { SecretEditor } from './SecretEditor';
import { VaultControls } from './VaultControls';

type Group = SecretGroup & SecretList;
type Dialog = {
  group: SecretGroup;
  record?: SecretRead;
  readOnly?: boolean;
  operationId: string;
  epoch: number;
  trigger: HTMLElement | null;
};

/** A keyed boundary guarantees no raw editor state survives a chat switch or tab close. */
export function SecretsPanel({ conversationId }: { conversationId?: string }) {
  return <SecretsContent key={conversationId ?? 'settings'} conversationId={conversationId} />;
}

function SecretsContent({ conversationId }: { conversationId?: string }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<VaultStatus>();
  const [groups, setGroups] = useState<Group[]>([]);
  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState<Dialog>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const epoch = useRef(0);
  const [reset, setReset] = useState(0);
  const scopeSet = useRef<string | undefined>(undefined);
  const expectedProject = useRef<string | null>(null);
  const wasUnlocked = useRef(false);
  const incarnation = useRef<string | null>(null);
  const pagination = useRef(new Set<string>());
  const chatContext = () =>
    conversationId ? { conversation_id: conversationId, expected_project_id: expectedProject.current } : {};

  const [confirmation, setConfirmation] = useState<{
    group: SecretGroup;
    record: SecretMetadata;
    operationId: string;
    epoch: number;
  }>();
  const pageDepth = useRef<Record<string, number>>({});
  const clear = useCallback(() => {
    epoch.current++;
    setReset((value) => value + 1);
    pagination.current.clear();
    setConfirmation(undefined);
    setDialog(undefined);
    setGroups([]);
  }, []);
  const refresh = useCallback(async () => {
    let current = epoch.current;
    try {
      const vaultStatus = await secretsRequest<VaultStatus>('status');
      if (epoch.current !== current) return;
      if (incarnation.current && vaultStatus.incarnation !== incarnation.current) {
        clear();
        current = epoch.current;
      }
      incarnation.current = vaultStatus.incarnation;
      setStatus(vaultStatus);
      setFailed(false);
      if (!vaultStatus.unlocked) {
        if (wasUnlocked.current) clear();
        wasUnlocked.current = false;
        return;
      }
      wasUnlocked.current = true;
      const available = await secretsRequest<SecretGroup[]>('records/groups', {
        conversation_id: conversationId ?? null,
      });
      if (epoch.current !== current || document.visibilityState === 'hidden') return;
      const signature = JSON.stringify(available.map((group) => group.scope.project_id ?? null).sort());
      if (scopeSet.current !== undefined && scopeSet.current !== signature) {
        clear();
        current = epoch.current;
        pageDepth.current = {};
      }
      scopeSet.current = signature;
      expectedProject.current = available.find((group) => group.scope.project_id)?.scope.project_id ?? null;
      const context = conversationId
        ? { conversation_id: conversationId, expected_project_id: expectedProject.current }
        : {};
      const loaded = await Promise.all(
        available.map(async (group) => {
          try {
            const result = await secretsRequest<SecretList>('records/list', { ...context, scope: group.scope, query });
            const depth = pageDepth.current[group.scope.project_id ?? 'global'] ?? 1;
            for (let page = 1; page < depth && result.cursor; page++) {
              // Each opaque cursor depends on the preceding response.
              // eslint-disable-next-line no-await-in-loop
              const next = await secretsRequest<SecretList>('records/list', {
                ...context,
                scope: group.scope,
                query,
                cursor: result.cursor,
              });
              result.records.push(...next.records);
              result.cursor = next.cursor;
            }
            return {
              scope: group.scope,
              name: group.name,
              retained: group.retained,
              records: result.records,
              cursor: result.cursor,
            };
          } catch {
            return null;
          }
        })
      );
      if (epoch.current !== current) return;
      if (conversationId && loaded.some((group) => group === null)) {
        clear();
        setFailed(true);
        return;
      }
      const accepted = loaded.filter((group): group is Group => group !== null);
      setGroups(accepted);
      setDialog((open) =>
        open && !accepted.some((group) => group.scope.project_id === open.group.scope.project_id) ? undefined : open
      );
    } catch {
      if (epoch.current === current) {
        clear();
        setStatus(undefined);
        setFailed(true);
      }
    }
  }, [clear, conversationId, query]);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 3000);
    const visibility = () => {
      if (document.visibilityState === 'hidden') {
        clear();
        setStatus(undefined);
      } else {
        void refresh();
      }
    };
    document.addEventListener('visibilitychange', visibility);
    const offDisabled = extensions.stateChanged.on((event) => {
      if (event.name === 'secrets' && !event.enabled) {
        clear();
        setStatus((old) => old && { ...old, unlocked: false });
      }
    });
    const off = secrets.locked.on(() => {
      clear();
      setStatus((old) => old && { ...old, unlocked: false });
    });
    return () => {
      epoch.current++;

      document.removeEventListener('visibilitychange', visibility);
      clearInterval(timer);
      off();
      offDisabled();
    };
  }, [clear, refresh]);
  const close = () => {
    const trigger = dialog?.trigger;
    setDialog(undefined);
    trigger?.focus();
  };
  const name = (group: SecretGroup) => (group.scope.project_id ? group.name : t('settings.secrets.global'));
  const open = async (group: SecretGroup, record: SecretMetadata, readOnly: boolean) => {
    const current = epoch.current;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setBusy(true);
    try {
      const value = await secretsRequest<SecretRead>('records/read', {
        ...chatContext(),
        scope: group.scope,
        id: record.id,
      });
      if (epoch.current === current)
        setDialog({ group, record: value, readOnly, epoch: current, operationId: crypto.randomUUID(), trigger });
    } catch (error) {
      Message.error(t(secretErrorKey(error)));
      clear();
    } finally {
      setBusy(false);
    }
  };
  const save = async (record: SecretRecord) => {
    const selected = dialog;
    if (!selected || selected.epoch !== epoch.current) return;
    const original = selected.record;
    const fields: Record<string, SecretRecord['fields'][string] | null> = Object.assign(
      Object.create(null),
      record.fields
    );
    for (const key of Object.keys(original?.fields ?? {})) if (!Object.hasOwn(fields, key)) fields[key] = null;
    await secretsRequest('records/write', {
      ...chatContext(),
      scope: selected.group.scope,
      operation_id: selected.operationId,
      id: original?.id ?? null,
      expected_revision: original?.revision ?? null,
      expected_incarnation: original?.incarnation ?? null,
      record: original ? null : record,
      patch: original ? { ...record, fields } : null,
    });
    await refresh();
  };
  const remove = (group: SecretGroup, record: SecretMetadata) => {
    setConfirmation({ group, record, operationId: crypto.randomUUID(), epoch: epoch.current });
  };
  const confirmRemove = async () => {
    const selected = confirmation;
    if (!selected || selected.epoch !== epoch.current) return;
    try {
      await secretsRequest('records/delete', {
        ...chatContext(),
        scope: selected.group.scope,
        id: selected.record.id,
        expected_revision: selected.record.revision,
        expected_incarnation: selected.record.incarnation,
        operation_id: selected.operationId,
      });
      setConfirmation(undefined);
      await refresh();
    } catch (error) {
      Message.error(t(secretErrorKey(error)));
      throw new Error('SECRETS_DELETE_FAILED', { cause: error });
    }
  };
  return (
    <section className='h-full min-h-0 overflow-auto p-16px text-t-primary flex flex-col gap-16px'>
      <div className='flex items-center justify-between'>
        <h2>{t('settings.secrets.title')}</h2>
        <Button icon={<Refresh />} aria-label={t('common.refresh')} onClick={() => void refresh()} />
      </div>
      <p className='text-t-secondary'>{t('settings.secrets.disclosure')}</p>
      <VaultControls key={reset} status={status} refresh={() => void refresh()} clear={clear} />
      {failed && <p role='alert'>{t('settings.secrets.operationFailed')}</p>}
      {!status?.unlocked && <p>{t('settings.secrets.locked')}</p>}
      {status?.unlocked && (
        <Input.Search
          aria-label={t('settings.secrets.search')}
          placeholder={t('settings.secrets.search')}
          value={query}
          onChange={(value) => {
            pageDepth.current = {};
            setQuery(value);
          }}
          allowClear
        />
      )}
      <Spin loading={busy}>
        {groups.map((group) => (
          <section key={group.scope.project_id ?? 'global'} className='border border-border-2 rd-12px p-12px mb-12px'>
            <div className='flex justify-between items-center gap-8px'>
              <h3>{name(group)}</h3>
              {group.retained && <Tag>{t('settings.secrets.retained')}</Tag>}
              <Button
                icon={<Plus />}
                onClick={() =>
                  setDialog({
                    group,
                    epoch: epoch.current,
                    operationId: crypto.randomUUID(),
                    trigger: document.activeElement instanceof HTMLElement ? document.activeElement : null,
                  })
                }
              >
                {t('settings.secrets.add')}
              </Button>
            </div>
            {!group.records.length && <p className='text-t-secondary'>{t('settings.secrets.empty')}</p>}
            {group.records.map((record) => (
              <div key={record.id} className='border-b border-border-2 py-12px flex flex-col gap-8px'>
                <div className='flex justify-between gap-8px items-center'>
                  <span className='font-500 break-words'>{record.title}</span>
                  <Space>
                    <Tooltip content={t('settings.secrets.reveal')}>
                      <Button
                        icon={<PreviewOpen />}
                        aria-label={t('settings.secrets.reveal')}
                        onClick={() => void open(group, record, true)}
                      />
                    </Tooltip>
                    <Tooltip content={t('common.edit')}>
                      <Button
                        icon={<Edit />}
                        aria-label={t('common.edit')}
                        onClick={() => void open(group, record, false)}
                      />
                    </Tooltip>
                    <Tooltip content={t('common.delete')}>
                      <Button icon={<Delete />} aria-label={t('common.delete')} onClick={() => remove(group, record)} />
                    </Tooltip>
                  </Space>
                </div>
                <Space wrap>
                  {record.bindings.map((binding, index) => (
                    <Tag key={index}>
                      {[binding.service, binding.environment, binding.tenant, binding.role].filter(Boolean).join(' · ')}{' '}
                      · {t(`settings.secrets.mfaLabels.${binding.mfa}`)}
                    </Tag>
                  ))}
                </Space>
              </div>
            ))}
            {group.cursor && (
              <Button
                onClick={async () => {
                  const current = epoch.current;
                  const pageKey = `${group.scope.project_id ?? 'global'}:${group.cursor}`;
                  if (pagination.current.has(pageKey)) return;
                  pagination.current.add(pageKey);
                  try {
                    const more = await secretsRequest<SecretList>('records/list', {
                      ...chatContext(),
                      scope: group.scope,
                      query,
                      cursor: group.cursor,
                    });
                    if (current === epoch.current) {
                      pageDepth.current[group.scope.project_id ?? 'global'] =
                        (pageDepth.current[group.scope.project_id ?? 'global'] ?? 1) + 1;
                      setGroups((rows) =>
                        rows.map((row) =>
                          row.scope.project_id === group.scope.project_id
                            ? {
                                ...row,
                                records: [
                                  ...new Map(
                                    [...row.records, ...more.records].map((record) => [record.id, record])
                                  ).values(),
                                ],
                                cursor: more.cursor,
                              }
                            : row
                        )
                      );
                    }
                  } catch (error) {
                    Message.error(t(secretErrorKey(error)));
                  } finally {
                    pagination.current.delete(pageKey);
                  }
                }}
              >
                {t('settings.secrets.more')}
              </Button>
            )}
          </section>
        ))}
      </Spin>
      {confirmation && (
        <Modal
          visible
          title={t('settings.secrets.deleteTitle')}
          okText={t('common.delete')}
          cancelText={t('common.cancel')}
          okButtonProps={{ status: 'danger' }}
          onOk={confirmRemove}
          onCancel={() => setConfirmation(undefined)}
        >
          {t('settings.secrets.deleteWarning', { title: confirmation.record.title })}
        </Modal>
      )}
      {dialog && (
        <SecretEditor
          key={dialog.operationId}
          initial={dialog.record}
          scopeName={name(dialog.group)}
          readOnly={dialog.readOnly}
          onClose={close}
          onSave={save}
        />
      )}
    </section>
  );
}
