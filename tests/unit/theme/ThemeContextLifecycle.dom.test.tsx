import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { configStore, configSet, pendingWrites, publishTheme, systemAppearance, writeControl } = vi.hoisted(() => {
  const store = new Map<string, unknown>([
    ['theme.activeId', 'light'],
    ['theme.userThemes', []],
  ]);
  type PendingWrite = { key: string; value: unknown; resolve: () => void };
  const pending: PendingWrite[] = [];
  const control = { deferred: false };
  return {
    configStore: store,
    configSet: vi.fn((key: string, value: unknown) => {
      if (!control.deferred) {
        store.set(key, value);
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        pending.push({
          key,
          value,
          resolve: () => {
            store.set(key, value);
            resolve();
          },
        });
      });
    }),
    pendingWrites: pending,
    publishTheme: vi.fn().mockResolvedValue(undefined),
    systemAppearance: {
      dark: false,
      listeners: new Set<() => void>(),
    },
    writeControl: control,
  };
});

vi.mock('@/common/config/configService', () => ({
  configService: {
    whenReady: vi.fn().mockResolvedValue(undefined),
    get: vi.fn((key: string) => configStore.get(key)),
    set: configSet,
    subscribe: vi.fn(() => () => {}),
  },
}));

vi.mock('@/common/adapter/httpBridge', () => ({ isWebUiBrowserMode: () => true }));

vi.mock('@/common', () => ({
  ipcBridge: {
    theme: {
      changed: { on: vi.fn(() => () => {}) },
      setActive: { invoke: publishTheme },
    },
  },
}));

vi.mock('@/renderer/utils/theme/systemAppearance', () => ({
  getSystemPrefersDark: () => systemAppearance.dark,
  watchSystemPrefersDark: (listener: () => void) => {
    systemAppearance.listeners.add(listener);
    return () => systemAppearance.listeners.delete(listener);
  },
}));

vi.mock('@/renderer/hooks/ui/useFontScale', () => ({
  default: () => [1, vi.fn()],
}));

vi.mock('@/renderer/hooks/ui/useFontSizes', () => ({
  default: () => ({ fontSizes: {}, setFontSize: vi.fn() }),
}));

import { ThemeProvider, useThemeContext } from '@/renderer/hooks/context/ThemeContext';

const ThemeProbe = () => {
  const { theme, activeTheme, activeId, selectTheme } = useThemeContext();
  return (
    <div>
      <output data-testid='appearance'>{theme}</output>
      <output data-testid='active-theme'>{activeTheme?.id ?? 'none'}</output>
      <output data-testid='active-id'>{activeId ?? 'none'}</output>
      <button type='button' onClick={() => void selectTheme('dark')}>
        Select dark
      </button>
      <button type='button' onClick={() => void selectTheme('light')}>
        Select light
      </button>
      <button type='button' onClick={() => void selectTheme('system')}>
        Follow system
      </button>
    </div>
  );
};

describe('ThemeProvider WebUI lifecycle', () => {
  beforeEach(() => {
    configStore.set('theme.activeId', 'light');
    configStore.set('theme.userThemes', []);
    configSet.mockClear();
    pendingWrites.splice(0);
    publishTheme.mockClear();
    systemAppearance.dark = false;
    systemAppearance.listeners.clear();
    writeControl.deferred = false;
  });

  it('updates activeTheme for direct selection and subsequent Follow System changes', async () => {
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>
    );

    await waitFor(() => expect(screen.getByTestId('active-theme')).toHaveTextContent('light'));
    expect(screen.getByTestId('appearance')).toHaveTextContent('light');

    fireEvent.click(screen.getByRole('button', { name: 'Select dark' }));
    await waitFor(() => expect(screen.getByTestId('active-theme')).toHaveTextContent('dark'));
    expect(screen.getByTestId('appearance')).toHaveTextContent('dark');
    expect(screen.getByTestId('active-id')).toHaveTextContent('dark');

    fireEvent.click(screen.getByRole('button', { name: 'Follow system' }));
    await waitFor(() => expect(screen.getByTestId('active-theme')).toHaveTextContent('light'));
    expect(screen.getByTestId('active-id')).toHaveTextContent('system');

    await act(async () => {
      systemAppearance.dark = true;
      systemAppearance.listeners.forEach((listener) => listener());
    });

    await waitFor(() => expect(screen.getByTestId('active-theme')).toHaveTextContent('dark'));
    expect(screen.getByTestId('appearance')).toHaveTextContent('dark');
    expect(screen.getByTestId('active-id')).toHaveTextContent('system');
    expect(publishTheme).not.toHaveBeenCalled();
  });

  it('keeps an older direct selection from overwriting a newer intent', async () => {
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>
    );
    await waitFor(() => expect(screen.getByTestId('active-theme')).toHaveTextContent('light'));
    writeControl.deferred = true;

    fireEvent.click(screen.getByRole('button', { name: 'Select dark' }));
    await waitFor(() => expect(pendingWrites).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Select light' }));

    await act(async () => pendingWrites.shift()?.resolve());
    await waitFor(() => expect(pendingWrites).toHaveLength(1));
    expect(screen.getByTestId('active-theme')).toHaveTextContent('light');
    expect(screen.getByTestId('active-id')).toHaveTextContent('light');

    await act(async () => pendingWrites.shift()?.resolve());
    await waitFor(() => expect(configStore.get('theme.activeId')).toBe('light'));
    expect(screen.getByTestId('active-theme')).toHaveTextContent('light');
    expect(screen.getByTestId('active-id')).toHaveTextContent('light');
  });

  it('keeps an older system update from overwriting a newer direct selection', async () => {
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>
    );
    await waitFor(() => expect(screen.getByTestId('active-theme')).toHaveTextContent('light'));

    fireEvent.click(screen.getByRole('button', { name: 'Follow system' }));
    await waitFor(() => expect(screen.getByTestId('active-id')).toHaveTextContent('system'));
    writeControl.deferred = true;

    act(() => {
      systemAppearance.dark = true;
      systemAppearance.listeners.forEach((listener) => listener());
    });
    await waitFor(() => expect(pendingWrites).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Select light' }));

    await act(async () => pendingWrites.shift()?.resolve());
    await waitFor(() => expect(pendingWrites).toHaveLength(1));
    expect(screen.getByTestId('active-theme')).toHaveTextContent('light');
    expect(screen.getByTestId('active-id')).toHaveTextContent('system');

    await act(async () => pendingWrites.shift()?.resolve());
    await waitFor(() => expect(screen.getByTestId('active-id')).toHaveTextContent('light'));
    expect(screen.getByTestId('active-theme')).toHaveTextContent('light');
    expect(configStore.get('theme.activeId')).toBe('light');
  });

  it('does not enqueue a second system update after a newer direct intent', async () => {
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>
    );
    await waitFor(() => expect(screen.getByTestId('active-theme')).toHaveTextContent('light'));

    fireEvent.click(screen.getByRole('button', { name: 'Follow system' }));
    await waitFor(() => expect(screen.getByTestId('active-id')).toHaveTextContent('system'));
    writeControl.deferred = true;

    act(() => {
      systemAppearance.dark = true;
      systemAppearance.listeners.forEach((listener) => listener());
    });
    await waitFor(() => expect(pendingWrites).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Select light' }));

    act(() => {
      systemAppearance.dark = false;
      systemAppearance.listeners.forEach((listener) => listener());
    });
    expect(pendingWrites).toHaveLength(1);

    await act(async () => pendingWrites.shift()?.resolve());
    await waitFor(() => expect(pendingWrites).toHaveLength(1));
    await act(async () => pendingWrites.shift()?.resolve());

    await waitFor(() => expect(screen.getByTestId('active-id')).toHaveTextContent('light'));
    expect(screen.getByTestId('active-theme')).toHaveTextContent('light');
    expect(configStore.get('theme.activeId')).toBe('light');
    expect(pendingWrites).toHaveLength(0);
  });
});
