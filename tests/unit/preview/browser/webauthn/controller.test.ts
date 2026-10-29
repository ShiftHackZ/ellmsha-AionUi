import { EventEmitter } from 'node:events';
import * as policy from '@process/services/browser/webauthn/policy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
  dialog: undefined as unknown,
  tab: undefined as unknown,
  profile: { profileId: 'a', token: 'owned', generation: 1 },
  dialogs: [] as unknown[],
  operations: [] as string[],
  failPin: false,
  terminalCode: undefined as number | undefined,
  uv: true,
  workers: [] as Worker[],
  failCreate: false,
  failLoad: false,
  autoReady: true,
  network: vi.fn(),
}));
class Window extends EventEmitter {
  webContents = Object.assign(new EventEmitter(), {
    id: 55,
    send: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  });
  destroyed = false;
  constructor(readonly options: unknown) {
    super();
    if (f.failCreate) throw new Error('private constructor failure');
    f.dialog = this;
    f.dialogs.push(this);
  }
  loadURL = async () => {
    if (f.failLoad) throw new Error('private dialog URL failure');
    this.emit('ready-to-show');
    if (f.autoReady) reportSecurityKeyDialogStatus(55, 'ready');
  };
  loadFile = this.loadURL;
  show = vi.fn();
  close = () => {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit('closed');
    }
  };
}
class Worker extends EventEmitter {
  constructor() {
    super();
    f.workers.push(this);
  }
  kill = vi.fn();
  postMessage = (command: { id: number; operation: string }) => {
    f.operations.push(command.operation);
    const data =
      command.operation === 'enumerate'
        ? { devices: [{ path: 'fake-transport-only', name: 'Fixture key' }] }
        : command.operation === 'info'
          ? { fido2: true, pinSet: f.failPin, uvSet: f.uv, retries: 3 }
          : f.terminalCode !== undefined
            ? { code: f.terminalCode }
            : f.failPin
              ? { code: 0x31 }
              : {
                  assertions: [
                    {
                      id: 'a2V5',
                      authenticatorData: 'YXV0aA',
                      signature: 'c2ln',
                      userHandle: null,
                      name: 'Fixture',
                    },
                  ],
                };
    queueMicrotask(() => this.emit('message', { id: command.id, code: 0, ...data }));
  };
}
const lifecycle = new EventEmitter();
vi.mock('node:dns/promises', () => ({
  Resolver: class {
    resolve4 = f.network;
  },
}));
vi.mock('node:https', () => ({ default: { get: f.network } }));
vi.mock('electron', () => ({
  BrowserWindow: function (options: unknown) {
    return new Window(options);
  },
  nativeTheme: { shouldUseDarkColors: true },
  utilityProcess: { fork: () => new Worker() },
}));
vi.mock('@process/services/browser/popups', () => ({
  getBrowserPopupForContents: () => f.tab,
  browserTabLifecycle: {
    on: (...args: Parameters<typeof lifecycle.on>) => lifecycle.on(...args),
    removeListener: (...args: Parameters<typeof lifecycle.removeListener>) => lifecycle.removeListener(...args),
  },
}));
vi.mock('@process/services/browser/profiles', () => ({
  getActiveBrowserProfile: () => f.profile,
  validateBrowserToken: vi.fn().mockResolvedValue('a'),
}));
vi.mock('@process/services/i18n', () => ({ default: { t: (v: string) => v, language: 'en-US' } }));
import { validateBrowserToken } from '@process/services/browser/profiles';
import {
  beginSecurityKey,
  respondToSecurityKey,
  securityKeyDialogState,
  cancelSecurityKey,
  reportSecurityKeyDialogStatus,
} from '@process/services/browser/webauthn';
const request = {
  requestId: '12345678-1234-1234-1234-123456789abc',
  publicKey: { rpId: 'example.test', challenge: 'Y2hhbGxlbmdl' },
};
const event = () => {
  const frame = { url: 'https://example.test', isDestroyed: () => false };
  const sender = Object.assign(new EventEmitter(), {
    id: 1,
    mainFrame: frame,
    isDestroyed: () => false,
  });
  return { sender, senderFrame: frame };
};
beforeEach(() => {
  f.operations = [];
  f.workers = [];
  f.dialogs = [];
  f.dialog = undefined;
  f.profile.generation = 1;
  f.failPin = false;
  f.terminalCode = undefined;
  f.uv = true;
  f.failCreate = false;
  f.failLoad = false;
  f.autoReady = true;
  f.network.mockReset().mockImplementation(() => {
    throw new Error('unexpected network');
  });
  vi.mocked(validateBrowserToken).mockResolvedValue('a');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  f.tab = {
    active: true,
    profileId: 'a',
    window: Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      isVisible: () => true,
      isMinimized: () => false,
    }),
  };
});
afterEach(() => {
  cancelSecurityKey(1, request.requestId);
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const act = async (step: string, action: 'continue' | 'select' | 'pin', value?: string) => {
  await vi.waitFor(() => expect(securityKeyDialogState(55)?.step).toBe(step));
  respondToSecurityKey(55, { action, value });
};
describe('trusted security-key ceremony', () => {
  it('keeps a failed module graph hidden and releases the global slot after bounded startup', async () => {
    vi.useFakeTimers();
    f.autoReady = false;
    const pending = beginSecurityKey(event() as never, request);
    await vi.advanceTimersByTimeAsync(0);
    expect((f.dialog as Window).show).not.toHaveBeenCalled();
    reportSecurityKeyDialogStatus(999, 'ready');
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await pending).toEqual({ ok: false, error: 'NotAllowedError' });
    expect(f.operations).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith('[BrowserWebAuthn] pre-dialog failure', 'dialog-startup');
    f.autoReady = true;
    const next = beginSecurityKey(event() as never, request);
    await vi.advanceTimersByTimeAsync(0);
    expect((f.dialog as Window).show).toHaveBeenCalledOnce();
    cancelSecurityKey(1, request.requestId);
    expect(await next).toEqual({ ok: false, error: 'AbortError' });
  });
  it('shows a delayed healthy renderer only after its own committed readiness', async () => {
    f.autoReady = false;
    const pending = beginSecurityKey(event() as never, request);
    await vi.waitFor(() => expect(f.dialog).toBeDefined());
    const dialog = f.dialog as Window;
    reportSecurityKeyDialogStatus(999, 'ready');
    expect(dialog.show).not.toHaveBeenCalled();
    reportSecurityKeyDialogStatus(55, 'ready');
    await vi.waitFor(() => expect(dialog.show).toHaveBeenCalledOnce());
    respondToSecurityKey(55, { action: 'cancel' });
    expect(await pending).toEqual({ ok: false, error: 'NotAllowedError' });
  });
  it('disposes a live worker when the visible renderer fails during device selection', async () => {
    const pending = beginSecurityKey(event() as never, request);
    await act('confirm', 'continue');
    await vi.waitFor(() => expect(securityKeyDialogState(55)?.step).toBe('devices'));
    reportSecurityKeyDialogStatus(55, 'failed');
    expect(await pending).toEqual({ ok: false, error: 'NotAllowedError' });
    expect(f.workers[0].kill).toHaveBeenCalled();
    expect((f.dialog as Window).destroyed).toBe(true);
  });
  it.each(['failed', 'did-fail-load', 'render-process-gone', 'unresponsive'])(
    'settles a dialog %s failure without waiting on its renderer',
    async (failure) => {
      f.autoReady = false;
      const pending = beginSecurityKey(event() as never, request);
      await vi.waitFor(() => expect(f.dialog).toBeDefined());
      const dialog = f.dialog as Window;
      if (failure === 'failed') reportSecurityKeyDialogStatus(55, 'failed');
      else if (failure === 'unresponsive') dialog.emit(failure);
      else dialog.webContents.emit(failure);
      expect(await pending).toEqual({ ok: false, error: 'NotAllowedError' });
      expect(dialog.destroyed).toBe(true);
      expect(f.operations).toEqual([]);
    }
  );
  it('allows native Escape while the renderer has not mounted', async () => {
    f.autoReady = false;
    const pending = beginSecurityKey(event() as never, request);
    await vi.waitFor(() => expect(f.dialog).toBeDefined());
    const preventDefault = vi.fn();
    (f.dialog as Window).webContents.emit('before-input-event', { preventDefault }, { type: 'keyDown', key: 'Escape' });
    expect(await pending).toEqual({ ok: false, error: 'NotAllowedError' });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(f.operations).toEqual([]);
  });
  it('reaches trusted confirmation for an AWS-shaped sibling AppID without network or hardware', async () => {
    const e = event();
    e.senderFrame.url = 'https://eu-north-1.signin.aws.amazon.com/oauth';
    const pending = beginSecurityKey(e as never, {
      ...request,
      publicKey: {
        ...request.publicKey,
        rpId: 'signin.aws.amazon.com',
        allowCredentials: [{ type: 'public-key', id: 'a2V5', transports: ['usb'] }],
        extensions: { appid: 'https://signin.aws.amazon.com' },
      },
    });
    await vi.waitFor(() => expect(securityKeyDialogState(55)?.step).toBe('confirm'));
    expect([f.network.mock.calls, f.operations, vi.mocked(console.warn).mock.calls]).toEqual([[], [], []]);
    respondToSecurityKey(55, { action: 'cancel' });
    expect(await pending).toEqual({ ok: false, error: 'NotAllowedError' });
  });
  it.each(['request', 'profile', 'appid', 'dialog-create', 'dialog-load'] as const)(
    'records only a fixed stage for a pre-dialog %s failure and releases the ceremony',
    async (stage) => {
      const e = event();
      let input: unknown = request;
      if (stage === 'request') e.senderFrame.url = 'private-invalid-url';
      if (stage === 'profile')
        vi.mocked(validateBrowserToken).mockRejectedValueOnce(new Error('private token failure'));
      if (stage === 'appid')
        input = {
          ...request,
          publicKey: {
            ...request.publicKey,
            allowCredentials: [{ type: 'public-key', id: 'a2V5' }],
            extensions: { appid: 'https://private-unrelated.test/private-path' },
          },
        };
      f.failCreate = stage === 'dialog-create';
      f.failLoad = stage === 'dialog-load';
      expect(await beginSecurityKey(e as never, input)).toMatchObject({ ok: false });
      expect(console.warn).toHaveBeenCalledExactlyOnceWith('[BrowserWebAuthn] pre-dialog failure', stage);
      expect(f.operations).toEqual([]);
      // A load failure must settle even when its error UI never loaded, releasing the global slot.
      f.failCreate = f.failLoad = false;
      const next = beginSecurityKey(event() as never, request);
      await vi.waitFor(() => expect(securityKeyDialogState(55)?.step).toBe('confirm'));
      cancelSecurityKey(1, request.requestId);
      await next;
    }
  );

  it('requires trusted confirmation before hardware and preserves the original profile', async () => {
    const pending = beginSecurityKey(event() as never, request);
    await vi.waitFor(() => expect(securityKeyDialogState(55)?.step).toBe('confirm'));
    expect(f.operations).toEqual([]);
    await act('confirm', 'continue');
    await act('devices', 'select', '0');
    expect(await pending).toMatchObject({ ok: true, assertion: { id: 'a2V5' } });
  });
  it.each(['cancel', 'close'])('reports trusted human %s as NotAllowedError', async (dismiss) => {
    const pending = beginSecurityKey(event() as never, request);
    await vi.waitFor(() => expect(securityKeyDialogState(55)?.step).toBe('confirm'));
    if (dismiss === 'cancel') respondToSecurityKey(55, { action: 'cancel' });
    else (f.dialog as Window).close();
    expect(await pending).toEqual({ ok: false, error: 'NotAllowedError' });
    expect(f.operations).toEqual([]);
  });
  it.each(['cancel', 'renderer failure'])(
    'preserves NotSupportedError on %s of an unsupported-key failure',
    async (dismissal) => {
      f.uv = false;
      const pending = beginSecurityKey(event() as never, {
        ...request,
        publicKey: { ...request.publicKey, userVerification: 'required' },
      });
      await act('confirm', 'continue');
      await act('devices', 'select', '0');
      await vi.waitFor(() => expect(securityKeyDialogState(55)?.error).toBe('unsupported'));
      if (dismissal === 'cancel') respondToSecurityKey(55, { action: 'cancel' });
      else reportSecurityKeyDialogStatus(55, 'failed');
      expect(await pending).toEqual({ ok: false, error: 'NotSupportedError' });
    }
  );
  it.each([
    [0x2e, 'noCredential'],
    [0x32, 'blockedPin'],
  ] as const)('preserves a terminal native failure%d when the human dismisses it', async (code, display) => {
    f.terminalCode = code;
    const pending = beginSecurityKey(event() as never, request);
    await act('confirm', 'continue');
    await act('devices', 'select', '0');
    await vi.waitFor(() => expect(securityKeyDialogState(55)?.error).toBe(display));
    respondToSecurityKey(55, { action: 'cancel' });
    expect(await pending).toEqual({ ok: false, error: 'NotAllowedError' });
    expect(f.operations.filter((v) => v === 'assert')).toHaveLength(1);
  });
  it('ignores iframe navigation but cancels main-document navigation', async () => {
    const e = event();
    const pending = beginSecurityKey(e as never, request);
    await vi.waitFor(() => expect(securityKeyDialogState(55)?.step).toBe('confirm'));
    e.sender.emit('did-start-navigation', {}, 'https://frame.test', false, false);
    expect(securityKeyDialogState(55)?.step).toBe('confirm');
    e.sender.emit('did-start-navigation', {}, 'https://example.test/next', false, true);
    expect(await pending).toEqual({ ok: false, error: 'AbortError' });
  });
  it('releases the global slot immediately when AppID authorization is aborted', async () => {
    vi.spyOn(policy, 'authorizeAppId').mockImplementation(
      (_appid, _origin, signal) =>
        new Promise((_resolve, reject) => {
          signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
        })
    );
    const e = event();
    const pending = beginSecurityKey(e as never, {
      ...request,
      publicKey: {
        ...request.publicKey,
        allowCredentials: [{ type: 'public-key', id: 'a2V5' }],
        extensions: { appid: 'https://example.test/facets' },
      },
    });
    await vi.waitFor(() => expect(policy.authorizeAppId).toHaveBeenCalledOnce());
    cancelSecurityKey(1, request.requestId);
    expect(await pending).toEqual({ ok: false, error: 'AbortError' });
    const next = beginSecurityKey(e as never, request);
    await vi.waitFor(() => expect(securityKeyDialogState(55)?.step).toBe('confirm'));
    cancelSecurityKey(1, request.requestId);
    expect(await next).toEqual({ ok: false, error: 'AbortError' });
    expect(f.operations).toEqual([]);
  });
  it('reports normal ceremony expiration as NotAllowedError', async () => {
    vi.useFakeTimers();
    const pending = beginSecurityKey(event() as never, {
      ...request,
      publicKey: { ...request.publicKey, timeout: 1000 },
    });
    await vi.advanceTimersByTimeAsync(1001);
    expect(await pending).toEqual({ ok: false, error: 'NotAllowedError' });
    expect(f.operations).toEqual([]);
  });
  it('discards a worker that exits while the human is selecting a device', async () => {
    const pending = beginSecurityKey(event() as never, request);
    await act('confirm', 'continue');
    await vi.waitFor(() => expect(securityKeyDialogState(55)?.step).toBe('devices'));
    f.workers[0].emit('exit', 1);
    expect(await pending).toEqual({ ok: false, error: 'NotAllowedError' });
    expect(f.operations).toEqual(['enumerate']);
  });
  it('discards a worker that exits while the human is entering a PIN', async () => {
    f.failPin = true;
    const pending = beginSecurityKey(event() as never, request);
    await act('confirm', 'continue');
    await act('devices', 'select', '0');
    await vi.waitFor(() => expect(securityKeyDialogState(55)?.step).toBe('pin'));
    f.workers[0].emit('exit', 1);
    expect(await pending).toEqual({ ok: false, error: 'NotAllowedError' });
    expect(f.operations).toEqual(['enumerate', 'info']);
  });
  it('rejects forged frames before opening the dialog', async () => {
    const e = event();
    expect(await beginSecurityKey({ ...e, senderFrame: {} } as never, request)).toEqual({
      ok: false,
      error: 'SecurityError',
    });
    expect(f.dialogs).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledExactlyOnceWith('[BrowserWebAuthn] pre-dialog failure', 'ownership');
  });
  it('does not retry an incorrect PIN without another human submission', async () => {
    f.failPin = true;
    const pending = beginSecurityKey(event() as never, request);
    await act('confirm', 'continue');
    await act('devices', 'select', '0');
    await act('pin', 'pin', 'fixture-pin');
    await vi.waitFor(() => expect(securityKeyDialogState(55)?.error).toBe('invalidPin'));
    expect(f.operations.filter((v) => v === 'assert')).toHaveLength(1);
    cancelSecurityKey(1, request.requestId);
    expect(await pending).toEqual({ ok: false, error: 'AbortError' });
  });
  it('cancels when the project generation changes and blocks concurrent ceremonies', async () => {
    const e = event();
    const pending = beginSecurityKey(e as never, request);
    await vi.waitFor(() => expect(securityKeyDialogState(55)?.step).toBe('confirm'));
    expect(await beginSecurityKey(e as never, request)).toEqual({
      ok: false,
      error: 'NotAllowedError',
    });
    expect(console.warn).toHaveBeenCalledExactlyOnceWith('[BrowserWebAuthn] pre-dialog failure', 'busy');
    f.profile.generation++;
    lifecycle.emit('changed');
    expect(await pending).toEqual({ ok: false, error: 'AbortError' });
  });
});
