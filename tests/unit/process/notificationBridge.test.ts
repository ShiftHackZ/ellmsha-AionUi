/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const clickedEmit = vi.fn();
const platformSend = vi.fn();

// Defined via vi.hoisted so the hoisted vi.mock factory can reference the class
// at evaluation time without a temporal-dead-zone error.
const { FakeElectronNotification } = vi.hoisted(() => {
  class FakeNotificationInstance {
    static instances: FakeNotificationInstance[] = [];
    handlers: Record<string, () => void> = {};
    show = vi.fn();
    close = vi.fn();
    constructor(public options: { title: string; body: string; icon?: string }) {
      FakeNotificationInstance.instances.push(this);
    }
    on(event: string, cb: () => void): this {
      this.handlers[event] = cb;
      return this;
    }
  }
  return { FakeElectronNotification: FakeNotificationInstance };
});

vi.mock('@/common', () => ({
  ipcBridge: {
    notification: {
      show: { provider: vi.fn() },
      close: { provider: vi.fn() },
      clicked: { emit: (...args: unknown[]) => clickedEmit(...args) },
    },
  },
}));

vi.mock('@/common/platform', () => ({
  getPlatformServices: () => ({
    paths: { isPackaged: () => false },
    notification: { send: (...args: unknown[]) => platformSend(...args) },
  }),
}));

vi.mock('@/common/electronSafe', () => ({
  electronNotification: FakeElectronNotification,
}));

vi.mock('fs', () => ({ default: { existsSync: () => false }, existsSync: () => false }));

import { closeNotification, showNotification, setNotificationMainWindow } from '@/process/bridge/notificationBridge';

const makeWindow = (focused: boolean) => ({
  isDestroyed: () => false,
  isFocused: () => focused,
  isMinimized: () => false,
  restore: vi.fn(),
  show: vi.fn(),
  focus: vi.fn(),
});

beforeEach(() => {
  clickedEmit.mockClear();
  platformSend.mockClear();
  FakeElectronNotification.instances.length = 0;
});

describe('showNotification', () => {
  it('shows a native notification when the main window is not focused', async () => {
    setNotificationMainWindow(makeWindow(false) as never);
    await showNotification({ title: 'AionUi', body: 'done', conversation_id: 'c1' });
    expect(FakeElectronNotification.instances).toHaveLength(1);
    expect(FakeElectronNotification.instances[0].show).toHaveBeenCalledTimes(1);
  });

  it('does not notify about turn completion when the main window is focused', async () => {
    setNotificationMainWindow(makeWindow(true) as never);
    await showNotification({ title: 'eLLMsha', body: 'done', conversation_id: 'c1', kind: 'turnCompleted' });
    expect(FakeElectronNotification.instances).toHaveLength(0);
  });

  it('notifies about a confirmation when the main window is focused', async () => {
    setNotificationMainWindow(makeWindow(true) as never);
    await showNotification({ title: 'eLLMsha', body: 'confirm', conversation_id: 'c1', kind: 'confirmation' });
    expect(FakeElectronNotification.instances).toHaveLength(1);
  });

  it('focuses the window and emits notification.clicked on click', async () => {
    const win = makeWindow(false);
    setNotificationMainWindow(win as never);
    await showNotification({ title: 'AionUi', body: 'done', conversation_id: 'c1' });

    FakeElectronNotification.instances[0].handlers.click?.();

    expect(win.show).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalledTimes(1);
    expect(clickedEmit).toHaveBeenCalledWith({ conversation_id: 'c1' });
  });

  it('restores a minimized window when the notification is clicked', async () => {
    const win = { ...makeWindow(false), isMinimized: () => true };
    setNotificationMainWindow(win as never);
    await showNotification({ title: 'eLLMsha', body: 'confirm', conversation_id: 'c1', kind: 'confirmation' });

    FakeElectronNotification.instances[0].handlers.click?.();

    expect(win.restore).toHaveBeenCalledTimes(1);
    expect(clickedEmit).toHaveBeenCalledWith({ conversation_id: 'c1' });
  });

  it('closes a keyed confirmation notification after the request is resolved', async () => {
    setNotificationMainWindow(makeWindow(false) as never);
    await showNotification({
      title: 'eLLMsha',
      body: 'confirm',
      conversation_id: 'c1',
      kind: 'confirmation',
      notification_id: 'confirmation-c1-request-1',
    });

    closeNotification('confirmation-c1-request-1');

    expect(FakeElectronNotification.instances[0].close).toHaveBeenCalledTimes(1);
  });
});
