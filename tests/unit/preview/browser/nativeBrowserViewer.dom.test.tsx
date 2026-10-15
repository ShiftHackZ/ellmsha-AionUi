import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PreviewContextMenu from '@/renderer/pages/conversation/Preview/components/PreviewPanel/PreviewContextMenu';
import NativeBrowserViewer from '@/renderer/pages/conversation/Preview/browser/NativeBrowserViewer';
import BrowserTabLayer from '@/renderer/pages/conversation/Preview/browser/BrowserTabLayer';
import MobileWorkspaceOverlay from '@/renderer/pages/conversation/components/ChatLayout/MobileWorkspaceOverlay';
import { ProjectPanelMobileOverlay } from '@/renderer/components/layout/ProjectPanelMobileOverlay';
import ConversationTitleMinimap from '@/renderer/pages/conversation/components/ConversationTitleMinimap';
import BtwOverlay from '@/renderer/components/chat/BtwOverlay';
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  report: vi.fn(),
  failure: vi.fn(),
  desktop: true,
  minimapVisible: false,
  stateHandlers: new Set<(state: unknown) => void>(),
  command: undefined as ((command: unknown) => void) | undefined,
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    application: {
      browserPopup: { invoke: mocks.invoke },
      reportBrowserWebContentsId: { invoke: mocks.report },
      reportBrowserTabCommandFailure: { invoke: mocks.failure },
      browserPopupState: {
        on: (handler: (state: unknown) => void) => {
          mocks.stateHandlers.add(handler);
          return () => mocks.stateHandlers.delete(handler);
        },
      },
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
vi.mock('@/renderer/utils/platform', () => ({ openExternalUrl: vi.fn(), isElectronDesktop: () => mocks.desktop }));
vi.mock('@/renderer/pages/conversation/Preview/browser/BrowserViewer', () => ({
  default: () => <div data-testid='web-browser' />,
}));
vi.mock('@/renderer/pages/conversation/components/ChatLayout/WorkspacePanelHeader', () => ({
  default: () => <div />,
}));
vi.mock('@/renderer/pages/conversation/explorer/ExplorerContainer', () => ({
  ExplorerContainer: () => <div />,
}));
vi.mock('@/renderer/components/Markdown', () => ({ default: () => <div /> }));
vi.mock('@/renderer/pages/conversation/components/ConversationTitleMinimap/useMinimapPanel', () => ({
  useMinimapPanel: () => ({
    visible: mocks.minimapVisible,
    loading: true,
    items: [],
    filteredItems: [],
    visualStyle: {},
    panelPos: { left: 0, top: 0 },
    panelWidth: 420,
    panelHeight: 200,
    searchKeyword: '',
    normalizedKeyword: '',
  }),
}));
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
  mocks.invoke.mockReset().mockImplementation(async (command) => ({
    success: true,
    data: { ...state, tabId: command.tabId, mountId: command.mountId },
  }));
  mocks.failure.mockReset().mockResolvedValue({ success: true });
  mocks.stateHandlers.clear();
  mocks.desktop = true;
  mocks.minimapVisible = false;
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
  it.each([
    { left: 600, expectedHeight: 310 },
    { left: 700, expectedHeight: 400 },
  ])(
    'keeps native input active with height $expectedHeight for a bottom control at x=$left',
    async ({ left, expectedHeight }) => {
      const control = document.createElement('button');
      control.setAttribute('data-native-browser-bottom-inset', '');
      control.getBoundingClientRect = () => new DOMRect(left, 400, 52, 52);
      document.body.append(control);
      const view = render(<NativeBrowserViewer {...props} />);
      await waitFor(() =>
        expect(mocks.invoke).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'sync',
            active: true,
            bounds: { x: 80, y: 90, width: 600, height: expectedHeight },
          })
        )
      );
      act(() => mocks.command?.({ action: 'focus', tabId: state.tabId, requestId: 'inset-focus' }));
      await waitFor(() =>
        expect(mocks.report).toHaveBeenCalledWith(
          expect.objectContaining({
            active: true,
            focusRequestId: 'inset-focus',
          })
        )
      );
      act(() => control.remove());
      await waitFor(() =>
        expect(mocks.invoke).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'sync',
            active: true,
            bounds: { x: 80, y: 90, width: 600, height: 400 },
          })
        )
      );
      view.unmount();
    }
  );
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
    expect(mocks.invoke).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'dispose', tabId: state.tabId }));
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
  it.each(['workspace', 'project', 'minimap', 'btw'])(
    'hides and restores native content when the actual %s overlay opens and closes',
    async (kind) => {
      const content = (collapsed: boolean) => {
        mocks.minimapVisible = kind === 'minimap' && !collapsed;
        return (
          <>
            {kind === 'workspace' ? (
              <MobileWorkspaceOverlay
                rightSiderCollapsed={collapsed}
                setRightSiderCollapsed={vi.fn()}
                workspaceWidthPx={360}
                mobileWorkspaceHandleRight={360}
                sider={<div />}
              />
            ) : kind === 'project' ? (
              <ProjectPanelMobileOverlay
                projectId='project-one'
                collapsed={collapsed}
                onCollapse={vi.fn()}
                widthPx={360}
              />
            ) : kind === 'minimap' ? (
              <ConversationTitleMinimap hideTrigger />
            ) : (
              <BtwOverlay isOpen={!collapsed} isLoading={false} answer='' question='' onDismiss={vi.fn()} />
            )}
            <NativeBrowserViewer {...props} />
          </>
        );
      };
      const view = render(content(true));
      expect(document.querySelector('[data-native-browser-overlay]')).toBeNull();
      await waitFor(() =>
        expect(mocks.invoke).toHaveBeenCalledWith(expect.objectContaining({ action: 'sync', active: true }))
      );
      mocks.invoke.mockClear();
      view.rerender(content(false));
      expect(document.querySelector('[data-native-browser-overlay]')).not.toBeNull();
      await waitFor(() =>
        expect(mocks.invoke).toHaveBeenCalledWith(expect.objectContaining({ action: 'sync', active: false }))
      );
      mocks.invoke.mockClear();
      view.rerender(content(true));
      expect(document.querySelector('[data-native-browser-overlay]')).toBeNull();
      await waitFor(() =>
        expect(mocks.invoke).toHaveBeenCalledWith(expect.objectContaining({ action: 'sync', active: true }))
      );
      view.unmount();
    }
  );
  it('does not acknowledge a late focus response after the owning tab was unmounted', async () => {
    let finishFocus!: (value: unknown) => void;
    mocks.invoke.mockImplementation(async (command) =>
      command.action === 'focus'
        ? new Promise((resolve) => {
            finishFocus = resolve;
          })
        : { success: true, data: { ...state, mountId: command.mountId } }
    );
    const view = render(<NativeBrowserViewer {...props} />);
    await waitFor(() => expect(mocks.report).toHaveBeenCalled());
    act(() => mocks.command?.({ action: 'focus', tabId: state.tabId, requestId: 'owned-request' }));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(expect.objectContaining({ action: 'focus', tabId: state.tabId }))
    );
    view.unmount();
    await act(async () => finishFocus({ success: true, data: state }));
    expect(mocks.report.mock.calls.some(([registration]) => registration.focusRequestId === 'owned-request')).toBe(
      false
    );
  });
});

describe('native browser creation and rendering', () => {
  it('ensures ordinary tabs before bounds sync and registers the same attachment', async () => {
    const view = render(<NativeBrowserViewer {...props} />);
    await waitFor(() => expect(mocks.report).toHaveBeenCalled());
    expect(mocks.invoke.mock.calls[0][0]).toMatchObject({ action: 'ensure', requireExisting: false, url: props.url });
    expect(mocks.report.mock.calls[0][0].mountId).toBe(mocks.invoke.mock.calls[0][0].mountId);
    view.unmount();
  });

  it('reattaches a live popup without requesting an ordinary replacement', async () => {
    const view = render(<NativeBrowserViewer {...props} requireExisting />);
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(expect.objectContaining({ action: 'ensure', requireExisting: true }))
    );
    view.unmount();
  });

  it('navigates external URL changes once but does not reload its own navigation echo', async () => {
    const view = render(<NativeBrowserViewer {...props} />);
    await waitFor(() => expect(mocks.report).toHaveBeenCalled());
    const mountId = mocks.report.mock.calls[0][0].mountId;
    act(() =>
      mocks.stateHandlers.forEach((handler) => handler({ ...state, mountId, url: 'https://fixture.test/redirect' }))
    );
    view.rerender(<NativeBrowserViewer {...props} url='https://fixture.test/redirect' />);
    await act(async () => {});
    expect(mocks.invoke.mock.calls.filter(([c]) => c.action === 'navigate')).toHaveLength(0);
    view.rerender(<NativeBrowserViewer {...props} url='https://fixture.test/external' />);
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'navigate', url: 'https://fixture.test/external' })
      )
    );
    view.unmount();
  });

  it('ignores late ensure completion after unmount without registering or updating the tab', async () => {
    let finish!: (value: unknown) => void;
    mocks.invoke.mockImplementation((command) =>
      command.action === 'ensure'
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve({ success: true })
    );
    const changed = vi.fn();
    const view = render(<NativeBrowserViewer {...props} onUrlChange={changed} />);
    const mountId = mocks.invoke.mock.calls[0][0].mountId;
    view.unmount();
    await act(async () => finish({ success: true, data: { ...state, mountId, url: 'https://fixture.test/late' } }));
    expect(mocks.report).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });

  it('shows translated failure recovery and reports a failed ensure to waiting agent operations', async () => {
    mocks.invoke.mockResolvedValue({ success: false, msg: 'Creation rejected' });
    const view = render(<NativeBrowserViewer {...props} />);
    await waitFor(() => expect(view.getByRole('status').textContent).toContain('preview.browser.loadFailed'));
    expect(mocks.failure).toHaveBeenCalledWith({ tabId: props.tabId, reason: 'Creation rejected' });
    fireEvent.click(view.getByText('common.retry'));
    await waitFor(() => expect(mocks.invoke.mock.calls.filter(([c]) => c.action === 'ensure')).toHaveLength(2));
    view.unmount();
  });

  it('restores all desktop tab IDs even when none is visible', async () => {
    const tabs = ['restored-a', 'restored-b'].map((id) => ({
      id,
      content: props.url,
      title: id,
      content_type: 'browser' as const,
    }));
    const view = render(<BrowserTabLayer browserTabs={tabs} activeTabId={null} updateTab={vi.fn()} />);
    await waitFor(() => expect(mocks.report).toHaveBeenCalledTimes(2));
    expect(mocks.report.mock.calls.map(([value]) => [value.tabId, value.active])).toEqual([
      ['restored-a', false],
      ['restored-b', false],
    ]);
    view.unmount();
  });

  it('keeps the web renderer path and never requests native creation outside Electron', () => {
    mocks.desktop = false;
    const view = render(
      <BrowserTabLayer
        browserTabs={[{ id: 'web-one', content: props.url, title: 'Web', content_type: 'browser' }]}
        activeTabId='web-one'
        updateTab={vi.fn()}
      />
    );
    expect(view.getByTestId('web-browser')).toBeTruthy();
    expect(mocks.invoke).not.toHaveBeenCalled();
    view.unmount();
  });
});
