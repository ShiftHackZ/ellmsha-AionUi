import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/renderer/utils/platform', () => ({ isElectronDesktop: () => false }));
vi.mock('@renderer/hooks/context/ThemeContext', () => ({
  useThemeContext: () => ({ theme: 'dark', activeTheme: null }),
}));
vi.mock('@/renderer/pages/settings/components/SettingsPageWrapper', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/renderer/pages/settings/MemorySettings/EmbeddingSettings', () => ({
  default: () => <div>EMBEDDING_FIXTURE</div>,
}));
vi.mock('@/renderer/components/media/WebviewHost', () => ({ default: () => null }));
import MemorySettings from '@/renderer/pages/settings/MemorySettings';
describe('Memory settings tabs', () => {
  it('uses the shared skills-style tabs and retains the embedded panel across tab changes', () => {
    render(<MemorySettings />);
    const panel = screen.getByTitle('TencentDB Agent Memory Panel');
    expect(panel).toBeVisible();
    expect(screen.getByText('EMBEDDING_FIXTURE')).not.toBeVisible();
    fireEvent.keyDown(screen.getByRole('tab', { name: 'settings.memoryUi.library' }), { key: 'ArrowRight' });
    expect(panel).not.toBeVisible();
    expect(screen.getByText('EMBEDDING_FIXTURE')).toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: 'settings.memoryUi.library' }));
    expect(screen.getByTitle('TencentDB Agent Memory Panel')).toBe(panel);
    expect(panel).toBeVisible();
  });
  it('keeps tabs usable when the desktop panel URL lookup fails', async () => {
    const original = window.electronAPI;
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { getMemoryPanelUrl: vi.fn().mockRejectedValue(new Error('offline fixture')) },
    });
    try {
      render(<MemorySettings />);
      await waitFor(() => expect(error).toHaveBeenCalled());
      expect(screen.getByTitle('TencentDB Agent Memory Panel').getAttribute('src')).toContain('127.0.0.1:8125');
      fireEvent.click(screen.getByRole('tab', { name: 'settings.memoryUi.embedding' }));
      expect(screen.getByText('EMBEDDING_FIXTURE')).toBeVisible();
    } finally {
      Object.defineProperty(window, 'electronAPI', { configurable: true, value: original });
      error.mockRestore();
    }
  });
});
