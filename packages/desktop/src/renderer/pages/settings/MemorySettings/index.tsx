import { Button, Input } from '@arco-design/web-react';
import { useThemeContext } from '@renderer/hooks/context/ThemeContext';
import EmbeddingSettings from './EmbeddingSettings';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import WebviewHost from '@/renderer/components/media/WebviewHost';
import { isElectronDesktop } from '@/renderer/utils/platform';
import SettingsPageWrapper from '../components/SettingsPageWrapper';
import { createMemoryThemePayload } from './memoryTheme';

const defaultPanelUrl =
  (import.meta as ImportMeta & { env: { VITE_TDAI_PANEL_URL?: string } }).env.VITE_TDAI_PANEL_URL ||
  'http://127.0.0.1:8125/';

const MemorySettings: React.FC = () => {
  const { t } = useTranslation();
  const { theme, activeTheme } = useThemeContext();
  const initialTheme = useRef(theme);
  const [panelUrl, setPanelUrl] = useState(defaultPanelUrl);
  useEffect(() => {
    void window.electronAPI?.getMemoryPanelUrl?.().then(setPanelUrl).catch(console.error);
  }, []);
  const panelOrigin = new URL(panelUrl).origin;
  const localPanel = ['127.0.0.1', 'localhost'].includes(new URL(panelUrl).hostname);
  const webviewRef = useRef<Electron.WebviewTag | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const currentThemePayload = useCallback(() => createMemoryThemePayload(theme), [activeTheme, theme]);
  const syncTheme = useCallback(
    (webview: Electron.WebviewTag) => {
      if (new URL(webview.getURL()).origin !== panelOrigin) return;
      void webview
        .executeJavaScript(
          `window.dispatchEvent(new CustomEvent('ellmsha-theme', { detail: ${JSON.stringify(currentThemePayload())} }))`
        )
        .catch(console.error);
    },
    [currentThemePayload, panelOrigin]
  );
  useEffect(() => {
    if (webviewRef.current) syncTheme(webviewRef.current);
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'ellmsha-theme', detail: currentThemePayload() },
      panelOrigin
    );
  }, [currentThemePayload, panelOrigin, syncTheme]);
  const refreshPanel = useCallback(() => webviewRef.current?.reload(), []);
  const initialPanelUrl = new URL(panelUrl);
  initialPanelUrl.searchParams.set('theme', initialTheme.current);
  const [userKey, setUserKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const connect = useCallback(
    async (key: string) => {
      const webview = webviewRef.current;
      if (!webview || new URL(webview.getURL()).origin !== panelOrigin) {
        throw new Error('Memory Hub is not ready');
      }
      const identity = await window.electronAPI?.verifyMemoryKey?.(key);
      if (!identity) throw new Error('Memory identity bridge is unavailable');

      // TencentDB Panel owns this session format. Write only to its isolated, trusted webview origin.
      const script = `(() => {
      if (location.origin !== ${JSON.stringify(panelOrigin)}) throw new Error('Unexpected Memory Hub origin');
      return fetch('/api/v1/meta/instances', { credentials: 'include' }).then(async response => {
        if (!response.ok) throw new Error('Memory Hub is unavailable');
        const data = await response.json();
        const instance = data.instances?.find(item => item.instance_id === ${JSON.stringify(identity.instanceId)});
        if (!instance) throw new Error('Configured memory instance is missing from Memory Hub');
        localStorage.setItem('tdai-panel.session', JSON.stringify({
          authMethod: 'user_key',
          instanceId: instance.instance_id,
          instanceName: instance.name,
          userKey: ${JSON.stringify(key.trim())},
          user: ${JSON.stringify(identity.user)}
        }));
        return true;
      });
    })()`;
      await webview.executeJavaScript(script);
      webview.reload();
    },
    [panelOrigin]
  );

  const submit = async (key: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await connect(key);
      setUserKey('');
      setMessage(t('settings.memoryUi.connected'));
    } catch {
      setMessage(t('settings.memoryUi.connectError'));
    } finally {
      setBusy(false);
    }
  };

  const connectLocal = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const key = await window.electronAPI?.getLocalMemoryKey?.();
      if (!key) throw new Error('No local memory identity is available. Enter the key assigned by your administrator.');
      await connect(key);
      setMessage(t('settings.memoryUi.connected'));
    } catch {
      setMessage(t('settings.memoryUi.connectError'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsPageWrapper contentClassName='!max-w-none'>
      <div className='flex flex-col gap-16px min-h-500px text-t-primary'>
        <div>
          <h1 className='text-20px font-semibold text-t-primary'>{t('settings.memoryUi.title')}</h1>
          <p className='text-t-secondary text-13px'>TencentDB Agent Memory Panel · {panelUrl}</p>
          <p className='text-t-secondary text-13px'>{t('settings.memoryGenerationModel')}</p>
        </div>
        <EmbeddingSettings onReady={refreshPanel} />
        {isElectronDesktop() && (
          <div className='rounded-8px border border-solid border-border-2 p-12px flex flex-col gap-8px'>
            <strong className='text-14px'>{t('settings.memoryUi.account')}</strong>
            <p className='text-t-secondary text-12px m-0'>{t('settings.memoryUi.accountHint')}</p>
            <form
              className='flex gap-8px'
              onSubmit={(event) => {
                event.preventDefault();
                void submit(userKey);
              }}
            >
              <Input.Password
                autoComplete='off'
                aria-label={t('settings.memoryUi.userKey')}
                placeholder='sk-mem-…'
                value={userKey}
                onChange={setUserKey}
                className='flex-1 min-w-0'
              />
              <Button htmlType='submit' type='primary' disabled={busy || !userKey.trim()}>
                {t('settings.memoryUi.connect')}
              </Button>
              {localPanel && (
                <Button onClick={() => void connectLocal()} disabled={busy}>
                  {t('settings.memoryUi.localIdentity')}
                </Button>
              )}
            </form>
            {message && (
              <p role='status' className='text-12px m-0'>
                {message}
              </p>
            )}
          </div>
        )}
        <div className='h-600px min-h-400px shrink-0 overflow-hidden rounded-8px border border-solid border-border-2'>
          {isElectronDesktop() ? (
            <WebviewHost
              url={initialPanelUrl.toString()}
              id='tdai-memory-panel'
              partition='persist:tdai-memory-panel'
              onDidFinishLoad={(webview) => {
                webviewRef.current = webview;
                syncTheme(webview);
              }}
            />
          ) : (
            <iframe
              ref={iframeRef}
              title='TencentDB Agent Memory Panel'
              src={initialPanelUrl.toString()}
              onLoad={() => {
                iframeRef.current?.contentWindow?.postMessage(
                  { type: 'ellmsha-theme', detail: currentThemePayload() },
                  panelOrigin
                );
              }}
              className='w-full h-full border-0'
            />
          )}
        </div>
      </div>
    </SettingsPageWrapper>
  );
};

export default MemorySettings;
