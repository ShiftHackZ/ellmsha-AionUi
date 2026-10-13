import { act, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ desktop: true, mac: false }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/conversation/test', search: '', hash: '' }),
  useNavigate: () => vi.fn(),
}));
vi.mock('@/common', () => ({
  ipcBridge: { conversation: { get: { invoke: vi.fn() } } },
}));
vi.mock('@/common/config/constants', () => ({ TEAM_MODE_ENABLED: false }));
vi.mock('@renderer/pages/conversation/GroupedHistory/ConversationSearchPopover', () => ({ default: () => null }));
vi.mock('@/renderer/components/layout/Titlebar/MobileConversationBrand', () => ({ default: () => null }));
vi.mock('@/renderer/components/layout/WindowControls', () => ({
  default: () => <div data-testid='window-controls' />,
}));
vi.mock('@/renderer/hooks/context/LayoutContext', () => ({
  useLayoutContext: () => ({ isMobile: false, setSiderCollapsed: vi.fn() }),
}));
vi.mock('@/renderer/hooks/context/NavigationHistoryContext', () => ({
  useNavigationHistory: () => null,
}));
vi.mock('@/renderer/hooks/context/FeedbackContext', () => ({
  useFeedback: () => ({ openFeedback: vi.fn() }),
}));
vi.mock('@/renderer/services/feedback/resolveFeedbackModule', () => ({
  resolveFeedbackModule: () => 'conversation-session',
}));
vi.mock('@/renderer/utils/platform', () => ({
  isElectronDesktop: () => platform.desktop,
  isMacOS: () => platform.mac,
}));

import Titlebar from '@/renderer/components/layout/Titlebar';
import { setUpdateReadyState } from '@/renderer/components/settings/updateReadyState';
import { WORKSPACE_STATE_EVENT } from '@/renderer/utils/workspace/workspaceEvents';

describe('Titlebar workspace toggle', () => {
  beforeEach(() => {
    platform.desktop = true;
    platform.mac = false;
    setUpdateReadyState({ ready: false, version: '' });
  });

  it('places the update action immediately before the sidebar action and opens the existing card', () => {
    const open = vi.fn();
    window.addEventListener('aionui-open-update-modal', open);
    const { container } = render(<Titlebar workspaceAvailable />);
    const update = screen.getByRole('button', { name: 'update.installer.check' });
    const menu = container.querySelector('.app-titlebar__menu')!;
    expect(menu.querySelectorAll('button')[0]).toBe(update);
    expect(menu.querySelectorAll('button')[1]?.querySelector('svg')).toBeTruthy();
    fireEvent.click(update);
    expect(open).toHaveBeenCalledOnce();
    window.removeEventListener('aionui-open-update-modal', open);
  });
  it('shows the quiet availability badge without opening the card', () => {
    const open = vi.fn();
    window.addEventListener('aionui-open-update-modal', open);
    render(<Titlebar workspaceAvailable />);
    const button = screen.getByRole('button', { name: 'update.installer.check' });
    expect(button.querySelector('.arco-badge-dot')).toBeNull();
    act(() => setUpdateReadyState({ ready: false, available: true, version: '2026.10.13-patch.10' }));
    expect(button.querySelector('.arco-badge-dot')).not.toBeNull();
    expect(open).not.toHaveBeenCalled();
    window.removeEventListener('aionui-open-update-modal', open);
  });
  it('does not expose desktop installer controls in WebUI', () => {
    platform.desktop = false;
    render(<Titlebar workspaceAvailable />);
    expect(screen.queryByRole('button', { name: 'update.installer.check' })).toBeNull();
  });

  it('places the Windows workspace toggle before window controls without upstream promotion', () => {
    render(<Titlebar workspaceAvailable />);

    expect(screen.queryByRole('button', { name: 'conversation.welcome.quickActionFeedback' })).not.toBeInTheDocument();
    const workspace = screen.getByRole('button', { name: 'common.expandMore' });

    expect(workspace.parentElement?.firstElementChild).toBe(workspace);
    expect(workspace.nextElementSibling).toBe(screen.getByTestId('window-controls'));
  });

  it.each([
    { runtime: 'macOS desktop', desktop: true, mac: true },
    { runtime: 'WebUI', desktop: false, mac: false },
  ])('keeps the workspace toggle visible without upstream promotion on $runtime', ({ desktop, mac }) => {
    platform.desktop = desktop;
    platform.mac = mac;
    render(<Titlebar workspaceAvailable />);

    expect(screen.queryByRole('button', { name: 'conversation.welcome.quickActionFeedback' })).not.toBeInTheDocument();
    const workspace = screen.getByRole('button', { name: 'common.expandMore' });

    expect(workspace.parentElement?.firstElementChild).toBe(workspace);
    expect(screen.queryByTestId('window-controls')).not.toBeInTheDocument();
  });

  it('updates the workspace action when the panel becomes expanded', () => {
    const { container } = render(<Titlebar workspaceAvailable />);

    act(() => {
      window.dispatchEvent(new CustomEvent(WORKSPACE_STATE_EVENT, { detail: { collapsed: false } }));
    });

    expect(
      within(container.querySelector('.app-titlebar__toolbar')!).getByRole('button', { name: 'common.collapse' })
    ).toBeInTheDocument();
  });

  it('omits the workspace toggle when no workspace is available', () => {
    const { container } = render(<Titlebar workspaceAvailable={false} />);

    expect(screen.queryByRole('button', { name: 'common.expandMore' })).not.toBeInTheDocument();
    expect(
      within(container.querySelector('.app-titlebar__toolbar')!).queryByRole('button', { name: 'common.collapse' })
    ).not.toBeInTheDocument();
  });
});
