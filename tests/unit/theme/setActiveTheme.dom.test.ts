import { beforeEach, describe, expect, it, vi } from 'vitest';

const { configGet, configSet, isWebUiBrowserMode, publishTheme } = vi.hoisted(() => ({
  configGet: vi.fn(),
  configSet: vi.fn(),
  isWebUiBrowserMode: vi.fn(),
  publishTheme: vi.fn(),
}));

vi.mock('@/common/config/configService', () => ({
  configService: {
    get: configGet,
    set: configSet,
  },
}));

vi.mock('@/common/adapter/httpBridge', () => ({ isWebUiBrowserMode }));

vi.mock('@/common', () => ({
  ipcBridge: {
    theme: {
      setActive: { invoke: publishTheme },
    },
  },
}));

import { setActiveTheme } from '@/renderer/utils/theme/applyTheme';

describe('setActiveTheme platform contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configGet.mockReturnValue([]);
    configSet.mockResolvedValue(undefined);
    publishTheme.mockResolvedValue(undefined);
    document.documentElement.removeAttribute('data-theme');
    document.body.removeAttribute('arco-theme');
  });

  it('persists and applies a WebUI theme without calling the Electron-only relay', async () => {
    isWebUiBrowserMode.mockReturnValue(true);

    await setActiveTheme('dark');

    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(configSet).toHaveBeenCalledWith('theme.activeId', 'dark');
    expect(publishTheme).not.toHaveBeenCalled();
  });

  it('still rejects a WebUI persistence failure so the UI can report it', async () => {
    isWebUiBrowserMode.mockReturnValue(true);
    configSet.mockRejectedValue(new Error('settings write failed'));

    await expect(setActiveTheme('light')).rejects.toThrow('settings write failed');
    expect(publishTheme).not.toHaveBeenCalled();
  });

  it('persists and publishes the resolved theme through the native relay', async () => {
    isWebUiBrowserMode.mockReturnValue(false);

    await setActiveTheme('dark');

    expect(configSet).toHaveBeenCalledWith('theme.activeId', 'dark');
    expect(publishTheme).toHaveBeenCalledTimes(1);
    expect(publishTheme).toHaveBeenCalledWith(expect.objectContaining({ id: 'dark', appearance: 'dark' }));
  });

  it('preserves native relay failures for the caller', async () => {
    isWebUiBrowserMode.mockReturnValue(false);
    publishTheme.mockRejectedValue(new Error('native relay failed'));

    await expect(setActiveTheme('dark')).rejects.toThrow('native relay failed');
  });
});
