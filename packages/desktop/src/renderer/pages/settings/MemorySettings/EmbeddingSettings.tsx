import React, { useEffect, useState } from 'react';
import { Alert, Button, Input, Modal, Progress } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import type { MemoryEmbeddingStatus } from '@/common/types/platform/electron';

export default function EmbeddingSettings({ onReady }: { onReady: () => void }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<MemoryEmbeddingStatus>();
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let mounted = true;
    let previous = '';
    const refresh = async () => {
      try {
        const next = await window.electronAPI?.getMemoryEmbedding?.();
        if (!mounted || !next) return;
        setStatus(next);
        if (!previous && next.current) {
          setBaseUrl(next.current.baseUrl);
          setModel(next.current.model);
        }
        if (previous && previous !== next.phase && ['complete', 'failed'].includes(next.phase)) {
          if (next.phase === 'complete' && next.current) {
            setBaseUrl(next.current.baseUrl);
            setModel(next.current.model);
          }
          onReady();
        }
        previous = next.phase;
      } catch {
        if (mounted) setNotice(t('settings.memoryUi.statusError'));
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [onReady, t]);
  if (!status) return null;
  if (!status.available) return <Alert type='info' content={t('settings.memoryUi.external')} />;
  const busy = ['checking', 'reindexing'].includes(status.phase);
  const input = { baseUrl, model, apiKey: apiKey || undefined };
  const check = async () => {
    setChecking(true);
    setNotice('');
    try {
      const result = await window.electronAPI!.probeMemoryEmbedding!(input);
      setNotice(t('settings.memoryUi.valid', { dimensions: result.dimensions }));
    } catch {
      setNotice(t('settings.memoryUi.invalid'));
    } finally {
      setChecking(false);
    }
  };
  const apply = () =>
    Modal.confirm({
      title: t('settings.memoryUi.apply'),
      content: t('settings.memoryUi.confirm'),
      okText: t('settings.memoryUi.apply'),
      cancelText: t('common.cancel'),
      onOk: async () => {
        try {
          await window.electronAPI!.applyMemoryEmbedding!(input);
          setNotice('');
          setApiKey('');
          setStatus({ ...status, phase: 'checking' });
        } catch {
          setNotice(t('settings.memoryUi.invalid'));
        }
      },
    });
  return (
    <section className='rounded-8px border border-solid border-border-2 p-16px flex flex-col gap-12px text-t-primary'>
      <div className='flex flex-wrap items-center justify-between gap-8px'>
        <strong>{t('settings.memoryUi.embedding')}</strong>
        <span className='text-t-secondary text-12px'>
          {status.current?.model} · {status.current?.dimensions} {t('settings.memoryUi.dimensions')}
        </span>
      </div>
      <div className='grid grid-cols-1 md:grid-cols-3 gap-12px'>
        <label className='flex flex-col gap-4px'>
          {t('settings.memoryUi.endpoint')}
          <Input
            aria-label={t('settings.memoryUi.endpoint')}
            value={baseUrl}
            disabled={busy}
            onChange={setBaseUrl}
            placeholder='http://127.0.0.1:11434/v1'
          />
        </label>
        <label className='flex flex-col gap-4px'>
          {t('settings.memoryUi.model')}
          <Input
            aria-label={t('settings.memoryUi.model')}
            value={model}
            disabled={busy}
            onChange={setModel}
            placeholder='bge-m3'
          />
        </label>
        <label className='flex flex-col gap-4px'>
          {t('settings.memoryUi.apiKey')}
          <Input.Password
            autoComplete='off'
            aria-label={t('settings.memoryUi.apiKey')}
            value={apiKey}
            disabled={busy}
            onChange={setApiKey}
            placeholder={t('settings.memoryUi.keyHint')}
          />
        </label>
      </div>
      <div className='flex flex-wrap items-center gap-8px'>
        <Button
          onClick={() => {
            setBaseUrl('http://127.0.0.1:11434/v1');
            setApiKey('');
          }}
          disabled={busy}
        >
          Ollama
        </Button>
        <Button onClick={() => void check()} loading={checking} disabled={busy || !baseUrl || !model}>
          {t('settings.memoryUi.check')}
        </Button>
        <Button type='primary' onClick={apply} disabled={busy || checking || !baseUrl || !model}>
          {t('settings.memoryUi.apply')}
        </Button>
      </div>
      <p className='text-t-secondary text-12px m-0'>{t('settings.memoryUi.hint')}</p>
      {busy && (
        <>
          <span role='status'>
            {t('settings.memoryUi.indexing')} {status.done}/{status.total}
          </span>
          <Progress percent={status.total ? Math.round((100 * status.done) / status.total) : 0} />
        </>
      )}
      {status.phase === 'complete' && <Alert type='success' content={t('settings.memoryUi.complete')} />}
      {['failed', 'unavailable'].includes(status.phase) && (
        <Alert
          type='error'
          content={t(status.phase === 'failed' ? 'settings.memoryUi.failed' : 'settings.memoryUi.unavailable')}
        />
      )}
      {notice && (
        <p role='status' className='m-0 text-12px'>
          {notice}
        </p>
      )}
    </section>
  );
}
