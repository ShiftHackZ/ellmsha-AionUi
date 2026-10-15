import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, Tooltip } from '@arco-design/web-react';
import { Left, Right, Refresh, Share } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import type { BrowserPopupCommand, BrowserPopupState } from '@/common/adapter/ipcBridge';
import { openExternalUrl } from '@/renderer/utils/platform';
import { InternalNavTracker } from '@/renderer/components/media/webviewHistory';
import type { BrowserViewerProps } from './BrowserViewer';
import { browserTabLabelFromUrl, resolveAddressBarInput } from './constants';

type Attachment = {
  mountId: string;
  alive: boolean;
  ready: Promise<boolean>;
  sync: () => Promise<boolean>;
};

/** Main owns the page; this component owns its toolbar, visible bounds and attachment lease. */
const NativeBrowserViewer: React.FC<BrowserViewerProps & { requireExisting?: boolean }> = (props) => {
  const { tabId, url, active } = props;
  const { t } = useTranslation();
  const area = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const attachment = useRef<Attachment | undefined>(undefined);
  const navigation = useRef(new InternalNavTracker());
  const lastPropUrl = useRef(url);
  const lastReportedUrl = useRef(url);
  const [state, setState] = useState<BrowserPopupState>();
  const [failure, setFailure] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [address, setAddress] = useState(url);

  const receive = useCallback((next: BrowserPopupState) => {
    const owner = attachment.current;
    if (!owner?.alive || next.tabId !== latest.current.tabId || next.mountId !== owner.mountId) return;
    setState(next);
    setFailure(Boolean(next.error));
    if (next.url !== lastReportedUrl.current) {
      lastReportedUrl.current = next.url;
      navigation.current.record(next.url);
      setAddress(next.url);
      latest.current.onUrlChange(next.tabId, next.url);
    }
    latest.current.onTitleChange(next.tabId, next.title.trim() || browserTabLabelFromUrl(next.url));
    if (next.favicon !== undefined) latest.current.onFaviconChange(next.tabId, next.favicon);
  }, []);

  const invoke = useCallback(
    async (command: BrowserPopupCommand) => {
      const owner = attachment.current;
      if (!owner || !(await owner.ready) || !owner.alive || attachment.current !== owner) return;
      try {
        const result = await ipcBridge.application.browserPopup.invoke({ ...command, mountId: owner.mountId });
        if (!owner.alive || attachment.current !== owner) return;
        if (result.success && result.data) receive(result.data);
        else setFailure(true);
        return result;
      } catch {
        if (owner.alive && attachment.current === owner) setFailure(true);
        return;
      }
    },
    [receive]
  );

  useEffect(() => {
    let frame = 0;
    let lastBounds = '';
    const owner: Attachment = {
      mountId: crypto.randomUUID(),
      alive: true,
      ready: Promise.resolve(false),
      sync: async () => false,
    };
    attachment.current = owner;
    setState(undefined);
    setFailure(false);
    navigation.current.clear();
    lastPropUrl.current = latest.current.url;
    lastReportedUrl.current = latest.current.url;
    const isCurrent = () => owner.alive && attachment.current === owner;
    const fail = async (reason: string) => {
      if (!isCurrent()) return;
      setFailure(true);
      await ipcBridge.application.reportBrowserTabCommandFailure.invoke({ tabId, reason }).catch(() => {});
    };
    const ensure = async (): Promise<boolean> => {
      try {
        const result = await ipcBridge.application.browserPopup.invoke({
          action: 'ensure',
          tabId,
          url: latest.current.url,
          requireExisting: latest.current.requireExisting === true,
          mountId: owner.mountId,
        });
        if (!isCurrent()) return false;
        if (!result.success || !result.data) {
          await fail(result.msg || 'Browser tab unavailable.');
          return false;
        }
        receive(result.data);
        return true;
      } catch {
        await fail('Browser tab creation failed.');
        return false;
      }
    };
    owner.ready = ensure();
    owner.sync = async () => {
      if (!(await owner.ready) || !isCurrent()) return false;
      const element = area.current;
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const obstructed = [
        ...document.querySelectorAll(
          '[data-native-browser-overlay], [role="dialog"], [role="menu"], .arco-modal-wrapper, .arco-drawer-wrapper'
        ),
      ].some((modal) => modal.getBoundingClientRect().width > 0 && getComputedStyle(modal).visibility !== 'hidden');
      let height = rect.height;
      for (const control of document.querySelectorAll<HTMLElement>('[data-native-browser-bottom-inset]')) {
        const bounds = control.getBoundingClientRect();
        if (
          control.checkVisibility({ checkVisibilityCSS: true }) &&
          bounds.width > 0 &&
          bounds.height > 0 &&
          bounds.left < rect.right &&
          bounds.right > rect.left &&
          bounds.top < rect.bottom &&
          bounds.bottom > rect.top
        )
          height = Math.max(0, Math.min(height, bounds.top - rect.top));
      }
      const visible =
        latest.current.active &&
        !obstructed &&
        rect.width > 0 &&
        height > 0 &&
        element.checkVisibility({ checkVisibilityCSS: true });
      const command = {
        action: 'sync' as const,
        tabId,
        active: visible,
        bounds: { x: rect.x, y: rect.y, width: rect.width, height },
      };
      const key = JSON.stringify(command);
      if (lastBounds === key) return visible;
      lastBounds = key;
      const result = await invoke(command);
      if (!isCurrent() || !result?.success || !result.data) {
        if (lastBounds === key) lastBounds = '';
        return false;
      }
      await ipcBridge.application.reportBrowserWebContentsId
        .invoke({
          tabId,
          webContentsId: result.data.webContentsId,
          mountId: owner.mountId,
          active: visible,
        })
        .catch(() => {});
      return isCurrent() && visible;
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        void owner.sync();
      });
    };
    const resize = new ResizeObserver(schedule);
    if (area.current) resize.observe(area.current);
    const changes = new MutationObserver(schedule);
    changes.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden'],
    });
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    const unsubscribeState = ipcBridge.application.browserPopupState.on(receive);
    const unsubscribeCommand = ipcBridge.application.browserTabCommand.on((command) => {
      if (command.action !== 'focus' || command.tabId !== tabId) return;
      void (async () => {
        lastBounds = '';
        if (!(await owner.sync()) || !isCurrent()) {
          if (isCurrent())
            await ipcBridge.application.reportBrowserTabCommandFailure.invoke({
              tabId,
              reason: 'Browser tab is hidden or obstructed. No input was sent.',
            });
          return;
        }
        const result = await invoke({ action: 'focus', tabId });
        if (!isCurrent()) return;
        if (result?.success && result.data) {
          await ipcBridge.application.reportBrowserWebContentsId.invoke({
            tabId,
            webContentsId: result.data.webContentsId,
            mountId: owner.mountId,
            active: true,
            focusRequestId: command.requestId,
          });
        } else
          await ipcBridge.application.reportBrowserTabCommandFailure.invoke({
            tabId,
            reason: 'Browser tab could not receive focus.',
          });
      })().catch(() => {});
    });
    void owner.sync();
    return () => {
      owner.alive = false;
      cancelAnimationFrame(frame);
      resize.disconnect();
      changes.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      unsubscribeState();
      unsubscribeCommand();
      void ipcBridge.application.browserPopup
        .invoke({ action: 'dispose', tabId, mountId: owner.mountId })
        .catch(() => {});
    };
  }, [tabId, attempt, invoke, receive]);

  useEffect(() => {
    void attachment.current?.sync();
  }, [active]);
  useEffect(() => {
    if (lastPropUrl.current === url) return;
    lastPropUrl.current = url;
    setAddress(url);
    if (navigation.current.consumeEcho(url)) return;
    navigation.current.clear();
    void invoke({ action: 'navigate', tabId, url });
  }, [url, tabId, invoke]);

  const retry = () => {
    if (state) void invoke({ action: 'reload', tabId });
    else setAttempt((value) => value + 1);
  };
  return (
    <div className='flex flex-col flex-1 min-h-0 bg-bg-1'>
      <div className='flex items-center gap-6px h-40px px-10px bg-bg-2 border-b border-border-1 flex-shrink-0'>
        <Button
          size='mini'
          type='text'
          icon={<Left size={16} />}
          aria-label={t('common.historyBack')}
          disabled={!state?.canGoBack}
          onClick={() => void invoke({ action: 'back', tabId })}
        />
        <Button
          size='mini'
          type='text'
          icon={<Right size={16} />}
          aria-label={t('common.forward')}
          disabled={!state?.canGoForward}
          onClick={() => void invoke({ action: 'forward', tabId })}
        />
        <Button
          size='mini'
          type='text'
          icon={<Refresh size={16} />}
          loading={state?.loading}
          aria-label={t('common.refresh')}
          onClick={retry}
        />
        <Input
          value={address}
          onChange={setAddress}
          placeholder={t('preview.browser.addressPlaceholder')}
          onPressEnter={() => {
            const next = resolveAddressBarInput(address);
            if (!next) return;
            if (state) void invoke({ action: 'navigate', tabId, url: next });
            else {
              latest.current.onUrlChange(tabId, next);
              setAttempt((value) => value + 1);
            }
          }}
        />
        <Tooltip content={t('preview.browser.externalAuthHelp')}>
          <Button
            size='mini'
            className='!rounded-10px flex-shrink-0'
            icon={<Share size={16} />}
            aria-label={t('preview.browser.openExternal')}
            disabled={!/^https?:\/\//i.test(url)}
            onClick={() => void openExternalUrl(url)}
          />
        </Tooltip>
      </div>
      {failure && (
        <div role='status' className='flex items-center gap-8px px-10px py-6px text-t-secondary'>
          <span>{t('preview.browser.loadFailed')}</span>
          <Button size='mini' onClick={retry}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      <div ref={area} className='flex-1 min-h-0' />
    </div>
  );
};
export default NativeBrowserViewer;
