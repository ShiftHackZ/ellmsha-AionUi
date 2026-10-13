import React, { useState } from 'react';
import { Alert, Button, Message, Spin } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import { ipcBridge } from '@/common';

/** Exact-tool grants are listed without credentials or arguments; revocation is immediate. */
export default function McpApprovals() {
  const { t } = useTranslation();
  const [revoking, setRevoking] = useState<string | null>(null);
  const { data, error, isLoading, mutate } = useSWR('settings/mcp-approvals', () =>
    ipcBridge.mcpService.listApprovals.invoke()
  );
  const revoke = async (id: string) => {
    setRevoking(id);
    try {
      await ipcBridge.mcpService.revokeApproval.invoke({ id });
      await mutate((current) => current?.filter((item) => item.id !== id), { revalidate: false });
    } catch {
      Message.error(t('tools.approvals.revokeFailed'));
    } finally {
      setRevoking(null);
    }
  };
  return (
    <section className='rounded-16px bg-bg-2 p-16px flex flex-col gap-12px'>
      <div className='flex items-center justify-between gap-12px'>
        <h3 className='text-14px font-medium text-t-primary m-0'>{t('tools.approvals.title')}</h3>
        <Button size='small' className='!rounded-8px' loading={isLoading} onClick={() => void mutate()}>
          {t('common.refresh')}
        </Button>
      </div>
      {error ? (
        <Alert type='error' content={t('tools.approvals.loadFailed')} />
      ) : isLoading ? (
        <Spin />
      ) : !data?.length ? (
        <p className='text-12px text-t-secondary m-0'>{t('tools.approvals.empty')}</p>
      ) : (
        <ul className='list-none p-0 m-0 flex flex-col gap-8px'>
          {data.map((item) => (
            <li key={item.id} className='flex items-center justify-between gap-12px'>
              <span className='min-w-0 break-all text-13px text-t-primary'>
                <span className='text-t-secondary'>{item.server}</span> · {item.tool}
              </span>
              <Button
                size='small'
                className='!rounded-8px flex-shrink-0'
                disabled={revoking !== null && revoking !== item.id}
                loading={revoking === item.id}
                onClick={() => void revoke(item.id)}
              >
                {t('tools.approvals.revoke')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
