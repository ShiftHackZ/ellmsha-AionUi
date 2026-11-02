import { Alert, Button, Spin } from '@arco-design/web-react';
import { PauseOne, Refresh, Terminal } from '@icon-park/react';
import React, { useState } from 'react';
import { useTerminal } from './useTerminal';
import { useTranslation } from 'react-i18next';
import { useBackgroundProcess } from './useBackgroundProcess';

export default function TerminalViewer({ conversationId, processId }: { conversationId: string; processId: string }) {
  const { t } = useTranslation();
  const { snapshot, failed, stopping, stop, refresh } = useBackgroundProcess(conversationId, processId);
  const [terminalFailed, setTerminalFailed] = useState(false);
  const [generation, setGeneration] = useState(0);
  const output = useTerminal(conversationId, processId, generation, () => setTerminalFailed(true));
  return (
    <div className='flex flex-col min-h-0 h-full bg-1 text-t-primary' data-testid='background-terminal'>
      <div className='flex items-center gap-8px p-12px border-b border-border-2 shrink-0'>
        <Terminal size={18} aria-hidden />
        <span className='text-13px' role='status'>
          {snapshot
            ? t(snapshot.running ? 'preview.terminal.running' : 'preview.terminal.exited', {
                code: snapshot.exit_code ?? '—',
              })
            : t('common.loading')}
        </span>
        {snapshot && (
          <span className='text-12px text-t-secondary'>{t('preview.terminal.pid', { pid: snapshot.pid })}</span>
        )}
        <Button
          className='ml-auto'
          size='small'
          type='outline'
          status='danger'
          loading={stopping}
          disabled={!snapshot?.running || stopping}
          onClick={() => void stop()}
          icon={<PauseOne aria-hidden />}
        >
          {t('preview.terminal.stop')}
        </Button>
      </div>
      {(failed || terminalFailed) && (
        <Alert
          type='error'
          content={t('preview.terminal.unavailable')}
          action={
            <Button
              type='text'
              onClick={() => {
                setTerminalFailed(false);
                setGeneration((value) => value + 1);
                void refresh();
              }}
              icon={<Refresh aria-hidden />}
            >
              {t('common.retry')}
            </Button>
          }
        />
      )}
      {!snapshot && !failed && <Spin className='m-24px' />}
      {snapshot && (
        <>
          <div className='p-12px text-12px bg-2 border-b border-border-2 shrink-0 break-all'>
            <code>{snapshot.command}</code>
            <div className='mt-4px text-t-secondary'>{snapshot.cwd}</div>
          </div>
          <div className='text-12px px-12px py-4px text-t-secondary'>{t('preview.terminal.shared')}</div>
        </>
      )}
      <div
        ref={output}
        className='flex-1 min-h-0 p-8px overflow-hidden bg-base'
        role='region'
        aria-label={t('conversation.workspace.openWith.terminal')}
      />
    </div>
  );
}
