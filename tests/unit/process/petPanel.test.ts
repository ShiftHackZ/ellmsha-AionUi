import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  preventActivation: vi.fn(),
  load: vi.fn(),
  systemVersion: vi.fn(),
}));
vi.mock('node:module', () => ({ createRequire: () => native.load }));
vi.mock('electron', () => ({ app: { getAppPath: () => '/owned/app.asar' } }));

import { preventPetPanelActivation } from '@/process/pet/petPanel';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const systemVersion = Object.getOwnPropertyDescriptor(process, 'getSystemVersion');
const window = (id = 'window:123:0', destroyed = false) =>
  ({ getMediaSourceId: () => id, isDestroyed: () => destroyed }) as BrowserWindow;

beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  Object.defineProperty(process, 'getSystemVersion', { configurable: true, value: native.systemVersion });
  native.systemVersion.mockReturnValue('27.0.1');
  native.load.mockReturnValue({ preventActivation: native.preventActivation });
  native.preventActivation.mockReturnValue(true);
});

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
  if (systemVersion) Object.defineProperty(process, 'getSystemVersion', systemVersion);
  else Reflect.deleteProperty(process, 'getSystemVersion');
});

describe('native pet activation guard', () => {
  it.each(['win32', 'linux'])('does not load AppKit code or query the OS version on %s', (platform) => {
    Object.defineProperty(process, 'platform', { value: platform });
    preventPetPanelActivation(window());
    expect(native.load).not.toHaveBeenCalled();
    expect(native.systemVersion).not.toHaveBeenCalled();
  });

  it.each(['15.7', '26.6.2'])('retains the existing panel path on macOS %s', (version) => {
    native.systemVersion.mockReturnValue(version);
    preventPetPanelActivation(window());
    expect(native.load).not.toHaveBeenCalled();
  });

  it.each(['27.0', '28.0'])('applies native prevention to the owned window on macOS %s', (version) => {
    native.systemVersion.mockReturnValue(version);
    preventPetPanelActivation(window());
    expect(native.load).toHaveBeenCalledWith('./out/main/native/pet-panel.node');
    expect(native.preventActivation).toHaveBeenCalledWith(123);
  });

  it.each(['window:0:0', 'window:-1:0', 'window:1.5:0', 'window:2147483648:0', 'screen:123:0', 'window:123:0tail'])(
    'rejects invalid native source ID %s before loading native code',
    (id) => {
      expect(() => preventPetPanelActivation(window(id))).toThrow('Invalid native panel');
      expect(native.load).not.toHaveBeenCalled();
    }
  );

  it('rejects a destroyed window before loading native code', () => {
    expect(() => preventPetPanelActivation(window('window:123:0', true))).toThrow('Invalid native panel');
    expect(native.load).not.toHaveBeenCalled();
  });

  it('fails closed when the native module is missing', () => {
    native.load.mockImplementation(() => {
      throw new Error('Module missing');
    });
    expect(() => preventPetPanelActivation(window())).toThrow('Module missing');
  });

  it('fails closed when the OS cannot apply activation prevention', () => {
    native.preventActivation.mockReturnValue(false);
    expect(() => preventPetPanelActivation(window())).toThrow('activation prevention is unavailable');
  });
});
