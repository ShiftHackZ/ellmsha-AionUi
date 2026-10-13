import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PreviewContextMenu from '@/renderer/pages/conversation/Preview/components/PreviewPanel/PreviewContextMenu';
import NativeBrowserViewer from '@/renderer/pages/conversation/Preview/browser/NativeBrowserViewer';
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  report: vi.fn(),
  command: undefined as ((command: unknown) => void) | undefined,
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    application: {
      browserPopup: { invoke: mocks.invoke },
      reportBrowserWebContentsId: { invoke: mocks.report },
      reportBrowserTabCommandFailure: { invoke: vi.fn().mockResolvedValue({ success: true }) },
      browserPopupState: { on: () => () => {} },
      browserTabCommand: {
        on: (handler: (command: unknown) => void) => {
          mocks.command = handler;
          return () => {
            mocks.command = undefined;
          };
        },
      },
    },
  },
}));
vi.mock('@/renderer/utils/platform', () => ({ openExternalUrl: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const state = {
  tabId: 'popup-one',
  webContentsId: 7,
  url: 'https://fixture.test/',
  title: 'Owned',
  loading: false,
  canGoBack: false,
  canGoForward: false,
};
const props = {
  tabId: state.tabId,
  url: state.url,
  active: true,
  onUrlChange: vi.fn(),
  onTitleChange: vi.fn(),
  onFaviconChange: vi.fn(),
};
beforeEach(() => {
  mocks.invoke.mockReset().mockResolvedValue({ success: true, data: state });
  mocks.report.mockReset().mockResolvedValue({ success: true });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 80,
    y: 90,
    width: 600,
    height: 400,
    top: 90,
    left: 80,
    right: 680,
    bottom: 490,
    toJSON: () => ({}),
  });
  Object.defineProperty(HTMLElement.prototype, 'checkVisibility', { configurable: true, value: () => true });
});
describe('native child tab visibility', () => {
  it('hides the native view on inactive tab and disposes only its exact id on unmount', async () => {
    const view = render(<NativeBrowserViewer {...props} />);
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(expect.objectContaining({ action: 'sync', active: true }))
    );
    view.rerender(<NativeBrowserViewer {...props} active={false} />);
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(expect.objectContaining({ action: 'sync', active: false }))
    );
    view.unmount();
    expect(mocks.invoke).toHaveBeenLastCalledWith({ action: 'dispose', tabId: state.tabId });
  });
  it('hides above-renderer content while a modal is visible', async () => {
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    document.body.append(modal);
    const view = render(<NativeBrowserViewer {...props} />);
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(expect.objectContaining({ action: 'sync', active: false }))
    );
    view.unmount();
    modal.remove();
  });
  it('hides the native view under the actual preview tab context menu', async () => {
    const view = render(
      <>
        <PreviewContextMenu
          contextMenu={{ show: true, tabId: 'popup-one', x: 10, y: 20 }}
          tabs={[]}
          currentTheme='light'
          onClose={vi.fn()}
          onCloseLeft={vi.fn()}
          onCloseRight={vi.fn()}
          onCloseOthers={vi.fn()}
          onCloseAll={vi.fn()}
        />
        <NativeBrowserViewer {...props} />
      </>
    );
    expect(document.body.querySelector('[data-native-browser-overlay]')).not.toBeNull();
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(expect.objectContaining({ action: 'sync', active: false }))
    );
    view.unmount();
  });
  it('does not acknowledge a late focus response after the owning tab was unmounted', async () => {
    let finishFocus: (value: unknown) => void = () => {};
    mocks.invoke.mockImplementation(async (command) =>
      command.action === 'focus'
        ? new Promise((resolve) => {
            finishFocus = resolve;
          })
        : { success: true, data: state }
    );
    const view = render(<NativeBrowserViewer {...props} />);
    await waitFor(() => expect(mocks.report).toHaveBeenCalled());
    act(() => mocks.command?.({ action: 'focus', tabId: state.tabId, requestId: 'owned-request' }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith({ action: 'focus', tabId: state.tabId }));
    view.unmount();
    await act(async () => finishFocus({ success: true, data: state }));
    expect(mocks.report.mock.calls.some(([registration]) => registration.focusRequestId === 'owned-request')).toBe(
      false
    );
  });
});
