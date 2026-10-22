import React from 'react';
import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ context: {} as Record<string, unknown> }));
vi.mock('@/renderer/pages/conversation/Preview/context/PreviewContext', () => ({
  usePreviewContext: () => fixture.context,
}));
vi.mock('@/renderer/hooks/context/LayoutContext', () => ({ useLayoutContext: () => ({ isMobile: false }) }));
vi.mock('@/renderer/hooks/ui/useResizableSplit', () => ({
  useResizableSplit: () => ({ splitRatio: 0.5, createDragHandle: () => null }),
}));
vi.mock('@/renderer/utils/platform', () => ({ isElectronDesktop: () => true }));
vi.mock('@/renderer/pages/conversation/Preview/browser/BrowserTabLayer', () => ({
  default: ({ browserTabs }: { browserTabs: Array<{ id: string }> }) => (
    <div data-testid='browser-tabs'>{browserTabs.map((tab) => tab.id).join(',')}</div>
  ),
}));
vi.mock('@/renderer/pages/conversation/Preview/hooks', () => ({
  useThemeDetection: () => 'dark',
  useTabOverflow: () => ({ tabsContainerRef: { current: null }, tabFadeState: {} }),
  useScrollSync: () => ({}),
  usePreviewKeyboardShortcuts: () => undefined,
  usePreviewHistory: () => ({
    historyVersions: [],
    messageApi: { error: vi.fn(), success: vi.fn() },
    messageContextHolder: null,
  }),
}));
vi.mock('@/renderer/pages/conversation/Preview/components/PreviewPanel/index', () => ({
  PreviewTabs: () => null,
  PreviewToolbar: () => null,
  PreviewContextMenu: () => null,
  PreviewConfirmModals: () => null,
  PreviewHistoryDropdown: () => null,
}));
vi.mock('@/common', () => ({ ipcBridge: { shell: { openFile: { invoke: vi.fn() } } } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import PreviewPanel from '@/renderer/pages/conversation/Preview/components/PreviewPanel/PreviewPanel';
it('renders empty → project A browser → empty/cleared → project B without changing hook order', () => {
  fixture.context = { isOpen: false, tabs: [], activeTab: null, activeTabId: null };
  const view = render(<PreviewPanel />);
  expect(view.container).toBeEmptyDOMElement();
  const open = (id: string) => {
    const tab = { id, content_type: 'browser', content: 'https://fixture.test/', title: id };
    fixture.context = { isOpen: true, tabs: [tab], activeTab: tab, activeTabId: id };
    view.rerender(<PreviewPanel />);
  };
  open('project-a');
  expect(screen.getByTestId('browser-tabs')).toHaveTextContent('project-a');
  fixture.context = { isOpen: false, tabs: [], activeTab: null, activeTabId: null };
  view.rerender(<PreviewPanel />);
  expect(view.container).toBeEmptyDOMElement();
  open('project-b');
  expect(screen.getByTestId('browser-tabs')).toHaveTextContent('project-b');
});
