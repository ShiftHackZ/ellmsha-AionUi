import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SiderFooter from '@/renderer/components/layout/Sider/SiderFooter';
import { setUpdateReadyState } from '@/renderer/components/settings/updateReadyState';
const platform = vi.hoisted(() => ({ desktop: true }));
vi.mock('@/renderer/utils/platform', () => ({ isElectronDesktop: () => platform.desktop }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const props = {
  isMobile: false,
  isSettings: false,
  theme: 'dark',
  siderTooltipProps: {},
  onSettingsClick: vi.fn(),
  onThemeToggle: vi.fn(),
};
beforeEach(() => {
  platform.desktop = true;
  setUpdateReadyState({ ready: false, version: '' });
});
describe('quiet update availability in the footer', () => {
  it('has no update action until a release is known and removes it when availability clears', () => {
    render(<SiderFooter {...props} />);
    expect(screen.queryByRole('button', { name: 'update.availableTitle' })).toBeNull();
    act(() => setUpdateReadyState({ ready: false, available: true, version: 'fixture' }));
    expect(screen.getByRole('button', { name: 'update.availableTitle' })).toBeInTheDocument();
    act(() => setUpdateReadyState({ ready: false, version: '' }));
    expect(screen.queryByRole('button', { name: 'update.availableTitle' })).toBeNull();
  });
  it('places the action after the theme control inside settings and opens the existing update modal', () => {
    setUpdateReadyState({ ready: true, available: true, version: 'fixture' });
    const listener = vi.fn();
    window.addEventListener('aionui-open-update-modal', listener);
    render(<SiderFooter {...props} isSettings />);
    const theme = screen.getByLabelText('settings.lightMode');
    const update = screen.getByRole('button', { name: 'update.availableTitle' });
    expect(theme.compareDocumentPosition(update) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(update);
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener('aionui-open-update-modal', listener);
  });
  it('does not show desktop installer actions in WebUI even when availability is reported', () => {
    platform.desktop = false;
    setUpdateReadyState({ ready: false, available: true, version: 'fixture' });
    render(<SiderFooter {...props} />);
    expect(screen.queryByRole('button', { name: 'update.availableTitle' })).toBeNull();
  });
});
