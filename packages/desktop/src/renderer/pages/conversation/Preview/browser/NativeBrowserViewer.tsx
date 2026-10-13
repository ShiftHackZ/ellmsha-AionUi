import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, Tooltip } from '@arco-design/web-react';
import { Left, Right, Refresh, Share } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import type { BrowserPopupCommand, BrowserPopupState } from '@/common/adapter/ipcBridge';
import { openExternalUrl } from '@/renderer/utils/platform';
import type { BrowserViewerProps } from './BrowserViewer';
import { resolveAddressBarInput } from './constants';

/** A native child keeps its POST/WindowProxy; the renderer supplies only its tab chrome and bounds. */
const NativeBrowserViewer: React.FC<BrowserViewerProps> = ({ tabId, url, active, onUrlChange, onTitleChange }) => {
  const { t } = useTranslation();
  const area = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<BrowserPopupState>();
  const [address, setAddress] = useState(url);
  useEffect(() => setAddress(url), [url]);
  const receive = useCallback(
    (next: BrowserPopupState) => {
      if (next.tabId !== tabId) return;
      setState(next);
      onUrlChange(tabId, next.url);
      if (next.title) onTitleChange(tabId, next.title);
    },
    [tabId, onUrlChange, onTitleChange]
  );
  const invoke = useCallback(
    async (command: BrowserPopupCommand) => {
      const result = await ipcBridge.application.browserPopup.invoke(command);
      if (result.success && result.data) receive(result.data);
      return result;
    },
    [receive]
  );

  useEffect(() => ipcBridge.application.browserPopupState.on(receive), [receive]);
  useEffect(() => {
    let frame = 0;
    let last = '';
    let disposed = false;
    const sync = async (force = false) => {
      const element = area.current;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      const obstructed = [
        ...document.querySelectorAll(
          '[data-native-browser-overlay], [role="dialog"], [role="menu"], .arco-modal-wrapper, .arco-drawer-wrapper'
        ),
      ].some((modal) => modal.getBoundingClientRect().width > 0 && getComputedStyle(modal).visibility !== 'hidden');
      const visible =
        active &&
        !obstructed &&
        rect.width > 0 &&
        rect.height > 0 &&
        element.checkVisibility({ checkVisibilityCSS: true });
      const command = {
        action: 'sync' as const,
        tabId,
        active: visible,
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      };
      const key = JSON.stringify(command);
      if (!force && key === last) return;
      last = key;
      const result = await invoke(command);
      if (disposed || !result.success || !result.data) return;
      await ipcBridge.application.reportBrowserWebContentsId.invoke({
        tabId,
        webContentsId: result.data.webContentsId,
        active: visible,
      });
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        void sync();
      });
    };
    const resize = new ResizeObserver(schedule);
    if (area.current) resize.observe(area.current);
    // Native views are above renderer DOM: hide them while a modal/drawer covers the page.
    const changes = new MutationObserver(schedule);
    changes.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden'],
    });
    window.addEventListener('resize', schedule);
    void sync(true);
    const unsubscribe = ipcBridge.application.browserTabCommand.on((command) => {
      if (command.action !== 'focus' || command.tabId !== tabId) return;
      void (async () => {
        await sync(true);
        if (disposed) return;
        const result = await invoke({ action: 'focus', tabId });
        if (disposed) return;
        if (result.success && result.data) {
          await ipcBridge.application.reportBrowserWebContentsId.invoke({
            tabId,
            webContentsId: result.data.webContentsId,
            active: true,
            focusRequestId: command.requestId,
          });
        } else
          await ipcBridge.application.reportBrowserTabCommandFailure.invoke({
            tabId,
            reason: result.msg || 'Browser popup is unavailable.',
          });
      })();
    });
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      resize.disconnect();
      changes.disconnect();
      window.removeEventListener('resize', schedule);
      unsubscribe();
    };
  }, [active, tabId, invoke]);
  useEffect(
    () => () => {
      void ipcBridge.application.browserPopup.invoke({ action: 'dispose', tabId });
    },
    [tabId]
  );

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
          onClick={() => void invoke({ action: 'reload', tabId })}
        />
        <Input
          value={address}
          onChange={setAddress}
          placeholder={t('preview.browser.addressPlaceholder')}
          onPressEnter={() => {
            const next = resolveAddressBarInput(address);
            if (next) void invoke({ action: 'navigate', tabId, url: next });
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
      <div ref={area} className='flex-1 min-h-0' />
    </div>
  );
};
export default NativeBrowserViewer;
