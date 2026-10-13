import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserTabCommand } from '@/common/adapter/ipcBridge';
import WebviewHost from '@renderer/components/media/WebviewHost';

const bridge = vi.hoisted(() => ({
  listeners: new Set<(command: BrowserTabCommand) => void>(),
  register: vi.fn().mockResolvedValue({ success: true }),
  failure: vi.fn().mockResolvedValue({ success: true }),
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    application: {
      reportBrowserWebContentsId: { invoke: bridge.register },
      reportBrowserTabCommandFailure: { invoke: bridge.failure },
      browserTabCommand: {
        on: (listener: (command: BrowserTabCommand) => void) => {
          bridge.listeners.add(listener);
          return () => bridge.listeners.delete(listener);
        },
      },
    },
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  bridge.listeners.clear();
});

const fixture = async (active = true) => {
  const { container } = render(<WebviewHost url='about:blank' browserTarget={{ tabId: 'alpha', active }} />);
  const webview = container.querySelector('webview') as Electron.WebviewTag;
  webview.tabIndex = 0;
  webview.getWebContentsId = () => 501;
  webview.executeJavaScript = vi.fn().mockResolvedValue(undefined);
  await act(async () => {
    webview.dispatchEvent(new Event('dom-ready'));
  });
  bridge.register.mockClear();
  return webview;
};
const requestFocus = async (tabId = 'alpha') => {
  await act(async () => {
    for (const listener of bridge.listeners) listener({ action: 'focus', tabId, requestId: 'focus-1' });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
};

describe('exact browser renderer focus', () => {
  it('focuses the owning webview element before acknowledging its request', async () => {
    const webview = await fixture();
    const composer = document.createElement('textarea');
    document.body.append(composer);
    composer.focus();
    const blur = vi.spyOn(composer, 'blur');
    const focus = vi.spyOn(webview, 'focus');
    try {
      await requestFocus();
      expect(blur.mock.invocationCallOrder[0]).toBeLessThan(focus.mock.invocationCallOrder[0]);
      expect(document.activeElement).toBe(webview);
      expect(bridge.register).toHaveBeenCalledExactlyOnceWith({
        tabId: 'alpha',
        webContentsId: 501,
        active: true,
        focusRequestId: 'focus-1',
      });
      expect(bridge.failure).not.toHaveBeenCalled();
    } finally {
      composer.remove();
    }
  });

  it('ignores focus requests for other stable tab ids', async () => {
    const webview = await fixture();
    const focus = vi.spyOn(webview, 'focus');
    await requestFocus('beta');
    expect(focus).not.toHaveBeenCalled();
    expect(bridge.register).not.toHaveBeenCalled();
  });

  it('refuses focus for a background webview without acknowledging it', async () => {
    const webview = await fixture(false);
    const focus = vi.spyOn(webview, 'focus');
    await requestFocus();
    expect(focus).not.toHaveBeenCalled();
    expect(bridge.register).not.toHaveBeenCalled();
    expect(bridge.failure).toHaveBeenCalledExactlyOnceWith({
      tabId: 'alpha',
      reason: 'The exact browser webview could not receive focus. No input was sent.',
    });
  });
});

describe('page-owned navigation', () => {
  it('leaves native forms, SPA click propagation and window.open untouched', async () => {
    const webview = await fixture();
    const scripts = vi
      .mocked(webview.executeJavaScript)
      .mock.calls.map(([script]) => script)
      .join('\n');
    expect(scripts).not.toContain('__WEBVIEW_HOST_NAVIGATE__');
    expect(scripts).not.toContain("addEventListener('submit'");
    expect(scripts).not.toContain("addEventListener('click'");
    expect(scripts).not.toContain('window.open =');
    const originalUrl = webview.getAttribute('src');
    const event = new Event('console-message');
    Object.assign(event, { message: '__WEBVIEW_HOST_NAVIGATE__ {"url":"https://untrusted.example/"}' });
    await act(async () => {
      webview.dispatchEvent(event);
    });
    expect(webview.getAttribute('src')).toBe(originalUrl);
  });
  it('uses presence-only popup permission exclusively for browser-partition guests', () => {
    const { container, rerender } = render(<WebviewHost url='about:blank' partition='persist:aionui-browser' />);
    expect(container.querySelector('webview')).toHaveAttribute('allowpopups');
    rerender(<WebviewHost url='about:blank' partition='persist:extension' />);
    expect(container.querySelector('webview')).not.toHaveAttribute('allowpopups');
  });
});
