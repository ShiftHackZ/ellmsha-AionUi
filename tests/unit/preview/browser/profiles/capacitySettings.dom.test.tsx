import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Message, Modal } from '@arco-design/web-react';
import { afterEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  close: vi.fn().mockResolvedValue({ success: true, data: { closedTabs: 3 } }),
  clear: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    application: { closeSuspendedBrowserTabs: { invoke: fixture.close }, clearBrowserData: { invoke: fixture.clear } },
  },
}));
vi.mock('swr', () => ({
  default: (key: string) =>
    key === 'browser.profiles'
      ? { data: { success: true, data: [] }, mutate: fixture.refresh }
      : { data: { data: { enabled: true, configEnabled: true } }, isLoading: false },
  mutate: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import BrowserDataSection from '@/renderer/components/settings/SettingsModal/contents/SystemModalContent/BrowserDataSection';
afterEach(() => {
  vi.restoreAllMocks();
  fixture.close.mockClear();
  fixture.clear.mockClear();
});
it('offers explicit suspended-tab recovery even without a surviving catalog entry and requires confirmation', async () => {
  vi.spyOn(Message, 'success').mockReturnValue({} as never);
  const confirm = vi.spyOn(Modal, 'confirm').mockReturnValue({} as never);
  render(<BrowserDataSection />);
  const button = screen.getByRole('button', { name: 'settings.browserData.closeSuspendedButton' });
  expect(button).not.toBeDisabled();
  fireEvent.click(button);
  expect(fixture.close).not.toHaveBeenCalled();
  expect(confirm).toHaveBeenCalledWith(
    expect.objectContaining({ content: 'settings.browserData.closeSuspendedConfirm' })
  );
  await act(async () => {
    await confirm.mock.calls[0][0].onOk?.();
  });
  expect(fixture.close).toHaveBeenCalledTimes(1);
  expect(fixture.clear).not.toHaveBeenCalled();
  expect(fixture.refresh).toHaveBeenCalled();
});
