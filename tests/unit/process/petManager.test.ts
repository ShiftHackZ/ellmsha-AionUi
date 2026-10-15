import { EventEmitter } from 'node:events';
import type { BrowserWindowConstructorOptions } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  cursor: { x: 1040, y: 640 },
  ozonePlatform: '',
  activate: vi.fn(),
  preventPanelActivation: vi.fn(),
}));

const ipcMain = new EventEmitter();
const windows: PetWindow[] = [];
class PetWindow {
  private destroyed = false;
  private position: number[];
  webContents = { send: vi.fn() };
  show = vi.fn(() => native.activate());
  focus = vi.fn(() => native.activate());
  showInactive = vi.fn();
  hide = vi.fn();
  setAlwaysOnTop = vi.fn();
  setIgnoreMouseEvents = vi.fn();
  loadFile = vi.fn().mockResolvedValue(undefined);
  on = vi.fn();
  setPosition = vi.fn((x: number, y: number) => {
    this.position = [x, y];
  });
  constructor(readonly options: BrowserWindowConstructorOptions) {
    this.position = [options.x!, options.y!];
    windows.push(this);
    if (options.show !== false) native.activate();
  }
  static getAllWindows(): PetWindow[] {
    return windows.filter((window) => !window.isDestroyed());
  }
  getPosition(): number[] {
    return this.position;
  }
  getSize(): number[] {
    return [this.options.width!, this.options.height!];
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

vi.mock('electron', () => ({
  BrowserWindow: PetWindow,
  ipcMain,
  Menu: { buildFromTemplate: vi.fn() },
  app: { commandLine: { getSwitchValue: () => native.ozonePlatform } },
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } }),
    getCursorScreenPoint: () => native.cursor,
  },
}));
vi.mock('@process/services/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('@/common/adapter/main', () => ({ setPetNotifyHook: vi.fn() }));
vi.mock('@/process/pet/petConfirmManager', () => ({
  initPetConfirmManager: vi.fn(),
  updateAnchorBounds: vi.fn(),
  destroyPetConfirmManager: vi.fn(),
  unhookPetConfirm: vi.fn(),
}));
vi.mock('@/process/pet/petPanel', () => ({ preventPetPanelActivation: native.preventPanelActivation }));

const originalPlatform = process.platform;
let pet: typeof import('@/process/pet/petManager');

beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  windows.length = 0;
  native.cursor = { x: 1040, y: 640 };
  native.ozonePlatform = '';
  native.preventPanelActivation.mockReset();
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  pet = await import('@/process/pet/petManager');
});

afterEach(() => {
  pet.destroyPetWindow();
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  vi.useRealTimers();
});

describe('desktop pet focus', () => {
  it('configures both native panels while neither is visible or listening for drag input', () => {
    native.preventPanelActivation.mockImplementation(() => {
      expect(windows.every((window) => window.showInactive.mock.calls.length === 0)).toBe(true);
      expect(ipcMain.listenerCount('pet:drag-start')).toBe(0);
    });
    pet.createPetWindow();
    expect(native.preventPanelActivation.mock.calls.map(([window]) => window)).toEqual(windows);
  });

  it.each([1, 2])('removes both hidden panels when native setup fails on panel %s', (failedPanel) => {
    native.preventPanelActivation.mockImplementation((window) => {
      if (window === windows[failedPanel - 1]) throw new Error('Native setup failed');
    });
    expect(() => pet.createPetWindow()).toThrow('Native setup failed');
    expect(windows.every((window) => window.isDestroyed() && !window.showInactive.mock.calls.length)).toBe(true);
    expect(ipcMain.listenerCount('pet:drag-start')).toBe(0);
  });

  it('can retry creation after failed native setup without retaining a partial pet', () => {
    native.preventPanelActivation.mockImplementationOnce(() => {
      throw new Error('Native setup failed');
    });
    expect(() => pet.createPetWindow()).toThrow('Native setup failed');
    pet.createPetWindow();
    expect(PetWindow.getAllWindows()).toHaveLength(2);
    expect(PetWindow.getAllWindows().every((window) => window.showInactive.mock.calls.length === 1)).toBe(true);
  });

  it('creates nonactivating macOS panels that accept the first drag from another app', () => {
    pet.createPetWindow();
    expect(windows.map((window) => window.options)).toMatchObject([
      { type: 'panel', focusable: false, show: false },
      { type: 'panel', focusable: false, show: false, acceptFirstMouse: true },
    ]);
    expect(windows.every((window) => window.showInactive.mock.calls.length === 1)).toBe(true);
    expect(native.activate).not.toHaveBeenCalled();
  });

  it('reveals both hidden windows without activating when enabling an existing pet or using the tray', () => {
    pet.createPetWindow();
    pet.hidePetWindow();
    pet.createPetWindow();
    pet.showPetWindow();
    expect(windows).toHaveLength(2);
    expect(windows.every((window) => window.showInactive.mock.calls.length === 3)).toBe(true);
    expect(native.activate).not.toHaveBeenCalled();
  });

  it('moves both windows without activation and stops following the cursor after release', () => {
    pet.createPetWindow();
    ipcMain.emit('pet:drag-start');
    native.cursor = { x: 1120, y: 680 };
    vi.advanceTimersByTime(16);
    expect(windows.map((window) => window.getPosition())).toEqual([
      [980, 540],
      [1036, 596],
    ]);
    ipcMain.emit('pet:drag-end');
    native.cursor = { x: 100, y: 100 };
    vi.advanceTimersByTime(32);
    expect(windows.every((window) => window.setPosition.mock.calls.length === 1)).toBe(true);
    expect(native.activate).not.toHaveBeenCalled();
  });

  it('recovers when the renderer loses drag release without activating the application', () => {
    pet.createPetWindow();
    ipcMain.emit('pet:drag-start');
    vi.advanceTimersByTime(8000);
    expect(windows[1].webContents.send).toHaveBeenCalledWith('pet:hit-reset');
    const lastPosition = windows[0].getPosition();
    native.cursor = { x: 100, y: 100 };
    vi.advanceTimersByTime(32);
    expect(windows[0].getPosition()).toEqual(lastPosition);
    expect(native.activate).not.toHaveBeenCalled();
  });

  it.each(['win32', 'linux'])('keeps native panel options off %s', (platform) => {
    Object.defineProperty(process, 'platform', { value: platform });
    pet.createPetWindow();
    expect(windows.every((window) => window.options.type === undefined)).toBe(true);
    expect(windows.every((window) => window.options.acceptFirstMouse === undefined)).toBe(true);
    expect(native.activate).not.toHaveBeenCalled();
  });

  it('does not create windows in unsupported Linux headless sessions', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    native.ozonePlatform = 'headless';
    pet.createPetWindow();
    expect(windows).toHaveLength(0);
    expect(native.activate).not.toHaveBeenCalled();
  });
});
