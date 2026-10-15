import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateDownloadProgressEvent } from '@/common/update/updateTypes';
const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  download: vi.fn(),
  cancel: vi.fn(),
  open: vi.fn(),
  auto: vi.fn(),
  shellOpen: vi.fn(),
  progress: null as ((event: UpdateDownloadProgressEvent) => void) | null,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/renderer/components/Markdown', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/renderer/hooks/context/FeedbackContext', () => ({ useFeedback: () => ({ openFeedback: vi.fn() }) }));
vi.mock('@/renderer/utils/platform', () => ({ isElectronDesktop: () => true }));
vi.mock('@/common', () => ({
  ipcBridge: {
    update: {
      check: { invoke: mocks.check },
      download: { invoke: mocks.download },
      cancelDownload: { invoke: mocks.cancel },
      openInstaller: { invoke: mocks.open },
      open: { on: () => () => {} },
      downloadProgress: {
        on: (fn: (event: UpdateDownloadProgressEvent) => void) => {
          mocks.progress = fn;
          return () => {};
        },
      },
    },
    autoUpdate: {
      check: { invoke: mocks.auto },
      download: { invoke: mocks.auto },
      quitAndInstall: { invoke: mocks.auto },
      restoreDownloaded: { invoke: mocks.auto },
    },
    shell: {
      openExternal: { invoke: vi.fn() },
      openFile: { invoke: mocks.shellOpen },
      showItemInFolder: { invoke: vi.fn() },
    },
  },
}));
import { getUpdateReadyState } from '@/renderer/components/settings/updateReadyState';
import UpdateNotificationCard from '@/renderer/components/settings/UpdateNotificationCard';
const latest = {
  tagName: 'v2026.10.13-patch.10',
  version: '2026.10.13-patch.10',
  body: 'Owned release notes',
  htmlUrl: 'https://github.com/ShiftHackZ/ellmsha/releases/tag/v2026.10.13-patch.10',
  assets: [],
  recommendedAsset: {
    name: 'eLLMsha-2026.10.13-patch.10-mac-arm64.dmg',
    url: 'https://github.com/ShiftHackZ/ellmsha/releases/download/v2026.10.13-patch.10/eLLMsha-2026.10.13-patch.10-mac-arm64.dmg',
    size: 100,
  },
  draft: false,
  prerelease: false,
};
const result = (override = {}) => ({
  success: true,
  data: { currentVersion: '2026.10.13-patch.9', updateAvailable: true, latest: { ...latest, ...override } },
});
const openCard = async () => {
  render(<UpdateNotificationCard />);
  act(() => window.dispatchEvent(new Event('aionui-open-update-modal')));
  await screen.findByText('update.downloadButton');
};
const progress = (status: UpdateDownloadProgressEvent['status'], extra = {}) =>
  act(() =>
    mocks.progress?.({
      downloadId: mocks.download.mock.calls[0][0].downloadId,
      status,
      receivedBytes: 50,
      totalBytes: 100,
      percent: 50,
      ...extra,
    })
  );
beforeEach(() => {
  vi.stubGlobal('__APP_VERSION__', '2026.10.13-patch.9');
  vi.clearAllMocks();
  mocks.check.mockResolvedValue(result());
  mocks.download.mockImplementation(async (p) => ({
    success: true,
    data: { downloadId: p.downloadId, file_path: '/owned/installer.dmg' },
  }));
  mocks.cancel.mockResolvedValue({ success: true });
  mocks.open.mockResolvedValue({ success: true });
});
afterEach(() => {
  cleanup();
  document.body.removeAttribute('arco-theme');
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('full installer notification', () => {
  it.each(['available', 'up-to-date', 'failed'])('checks metadata quietly at startup: %s', async (outcome) => {
    vi.useFakeTimers();
    if (outcome === 'up-to-date')
      mocks.check.mockResolvedValue({
        success: true,
        data: { currentVersion: '2026.10.13-patch.9', updateAvailable: false },
      });
    if (outcome === 'failed') mocks.check.mockRejectedValue(new Error('owned network failure'));
    render(<UpdateNotificationCard />);
    expect(mocks.check).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(mocks.check).toHaveBeenCalledOnce();
    expect(Boolean(getUpdateReadyState().available)).toBe(outcome === 'available');
    expect(screen.queryByTestId('update-notification-card')).toBeNull();
    expect(document.querySelector('[data-native-browser-overlay]')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.auto).not.toHaveBeenCalled();
  });
  it.each(['light', 'dark'])(
    'renders the themed release controls in %s without an auto-updater call',
    async (theme) => {
      document.body.setAttribute('arco-theme', theme);
      await openCard();
      expect(screen.getByTestId('update-notification-card')).toHaveAttribute('data-native-browser-overlay');
      expect(screen.getByRole('button', { name: 'update.downloadButton' })).toHaveClass('!rounded-8px');
      expect(mocks.auto).not.toHaveBeenCalled();
      fireEvent.click(screen.getByText('update.releaseLog'));
      expect(await screen.findByText('Owned release notes')).toBeInTheDocument();
    }
  );
  it('keeps progress on reopen, supports minimize/restore and cancellation', async () => {
    await openCard();
    fireEvent.click(screen.getByText('update.downloadButton'));
    await waitFor(() => expect(mocks.download).toHaveBeenCalledOnce());
    progress('downloading');
    fireEvent.click(screen.getByLabelText('update.minimize'));
    expect(screen.getByTestId('update-notification-mini-progress')).toHaveTextContent('50%');
    expect(screen.getByTestId('update-notification-mini-progress')).toHaveAttribute('data-native-browser-bottom-inset');
    expect(document.querySelector('[data-native-browser-overlay]')).toBeNull();
    fireEvent.click(screen.getByLabelText('update.restoreUpdateNotification'));
    act(() => window.dispatchEvent(new Event('aionui-open-update-modal')));
    expect(mocks.check).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByLabelText('update.cancel'));
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledOnce());
  });
  it('releases native browser obstruction when the notification is dismissed', async () => {
    await openCard();
    expect(document.querySelector('[data-native-browser-overlay]')).not.toBeNull();
    fireEvent.click(screen.getByText('update.later'));
    expect(document.querySelector('[data-native-browser-overlay]')).toBeNull();
  });
  it('holds retry until the original download ID and cancellation acknowledgment settle', async () => {
    let resolveDownload!: (value: unknown) => void;
    let resolveCancel!: (value: unknown) => void;
    mocks.download.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDownload = resolve;
        })
    );
    mocks.cancel.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCancel = resolve;
        })
    );
    await openCard();
    fireEvent.click(screen.getByText('update.downloadButton'));
    fireEvent.click(screen.getByLabelText('update.cancel'));
    expect(mocks.cancel).not.toHaveBeenCalled();
    await act(async () =>
      resolveDownload({
        success: true,
        data: { downloadId: mocks.download.mock.calls[0][0].downloadId, file_path: '/owned/installer.dmg' },
      })
    );
    expect(mocks.cancel).toHaveBeenCalledOnce();
    progress('cancelled');
    expect(screen.getByRole('button', { name: 'update.downloadButton' })).toBeDisabled();
    fireEvent.click(screen.getByText('update.downloadButton'));
    expect(mocks.download).toHaveBeenCalledOnce();
    await act(async () => resolveCancel({ success: true }));
    fireEvent.click(screen.getByText('update.downloadButton'));
    await waitFor(() => expect(mocks.download).toHaveBeenCalledTimes(2));
  });
  it('reports a failed cancellation instead of claiming it succeeded', async () => {
    mocks.cancel.mockResolvedValue({ success: false, msg: 'downloadFailed' });
    await openCard();
    fireEvent.click(screen.getByText('update.downloadButton'));
    await waitFor(() => expect(mocks.download).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByLabelText('update.cancel'));
    expect(await screen.findByText('update.downloadFailed')).toBeInTheDocument();
  });
  it('opens the verified download by ID and never calls shell paths or quit-and-install', async () => {
    await openCard();
    fireEvent.click(screen.getByText('update.downloadButton'));
    await waitFor(() => expect(mocks.download).toHaveBeenCalledOnce());
    progress('completed', { file_path: '/owned/installer.dmg', percent: 100 });
    expect(screen.getByText('update.installer.ready')).toBeInTheDocument();
    fireEvent.click(screen.getByText('update.installer.open'));
    await waitFor(() =>
      expect(mocks.open).toHaveBeenCalledWith({ downloadId: mocks.download.mock.calls[0][0].downloadId })
    );
    expect(mocks.auto).not.toHaveBeenCalled();
    expect(mocks.shellOpen).not.toHaveBeenCalled();
  });
  it('keeps unavailable installer distinct from up to date', async () => {
    mocks.check.mockResolvedValue(result({ recommendedAsset: undefined, installUnavailable: 'missingChecksum' }));
    await openCard();
    expect(screen.getByText('update.installer.missingChecksum')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'update.downloadButton' })).toBeDisabled();
    expect(screen.queryByText('update.upToDateTitle')).toBeNull();
  });
  it('shows verification failure and retries the release check', async () => {
    await openCard();
    fireEvent.click(screen.getByText('update.downloadButton'));
    await waitFor(() => expect(mocks.download).toHaveBeenCalledOnce());
    progress('error', { error: 'verificationFailed' });
    expect(screen.getByText('update.installer.verificationFailed')).toBeInTheDocument();
    fireEvent.click(screen.getByText('common.retry'));
    await waitFor(() => expect(mocks.check).toHaveBeenCalledTimes(2));
  });
  it('waits for installer-open response and surfaces its error', async () => {
    let finish!: (result: { success: boolean; msg: string }) => void;
    mocks.open.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    await openCard();
    fireEvent.click(screen.getByText('update.downloadButton'));
    await waitFor(() => expect(mocks.download).toHaveBeenCalledOnce());
    progress('completed');
    fireEvent.click(screen.getByText('update.installer.open'));
    expect(screen.getByRole('button', { name: 'update.installer.open' })).toBeDisabled();
    await act(async () => finish({ success: false, msg: 'openFailed' }));
    expect(screen.getByText('update.installer.openFailed')).toBeInTheDocument();
  });
  it('checks once under repeated clicks and reports network failure truthfully', async () => {
    let finish!: (result: { success: boolean; msg: string }) => void;
    mocks.check.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    render(<UpdateNotificationCard />);
    act(() => {
      window.dispatchEvent(new Event('aionui-open-update-modal'));
      window.dispatchEvent(new Event('aionui-open-update-modal'));
    });
    expect(screen.getByRole('status')).toHaveTextContent('update.checking');
    expect(mocks.check).toHaveBeenCalledOnce();
    await act(async () => finish({ success: false, msg: 'checkFailed' }));
    expect(screen.getByText('update.checkFailed')).toBeInTheDocument();
  });
});
