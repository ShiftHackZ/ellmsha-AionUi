import path from 'node:path';
import { BrowserWindow, nativeTheme, utilityProcess, type IpcMainInvokeEvent, type UtilityProcess } from 'electron';
import type {
  SecurityKeyAction,
  SecurityKeyAssertion,
  SecurityKeyDialogState,
  SecurityKeyResponse,
} from '@/common/types/browserWebAuthn';
import { browserTabLifecycle, getBrowserPopupForContents } from '../popups';
import { getActiveBrowserProfile, validateBrowserToken } from '../profiles';
import { authorizeAppId, validateRequest, WebAuthnError } from './policy';
import i18n from '@process/services/i18n';

type WorkerResult = {
  code: number;
  devices?: { path: string; name: string }[];
  fido2?: boolean;
  pinSet?: boolean;
  uvSet?: boolean;
  retries?: number;
  assertions?: (SecurityKeyAssertion & { name: string })[];
};
type Ceremony = {
  senderId: number;
  requestId: string;
  cancel: (reason?: WebAuthnError) => void;
  dialog?: BrowserWindow;
  state?: SecurityKeyDialogState;
  failure?: WebAuthnError;
  respond?: (action: SecurityKeyAction) => void;
  dialogStatus?: (status: 'ready' | 'failed') => void;
};
let active: Ceremony | undefined;
const mainDirectory = () => (path.basename(__dirname) === 'chunks' ? path.dirname(__dirname) : __dirname);
const cancelled = () => new WebAuthnError('AbortError');
type PreDialogStage =
  | 'platform'
  | 'busy'
  | 'ownership'
  | 'request'
  | 'profile'
  | 'appid'
  | 'dialog-create'
  | 'dialog-load'
  | 'dialog-startup';
// Fixed stages only: never include origin, request data, PINs or exception text.
const logPreDialogFailure = (stage: PreDialogStage): void =>
  console.warn('[BrowserWebAuthn] pre-dialog failure', stage);

export function cancelSecurityKey(senderId: number, requestId: unknown): void {
  if (active?.senderId === senderId && active.requestId === requestId) active.cancel();
}
export function securityKeyDialogState(senderId: number): SecurityKeyDialogState | undefined {
  return active?.dialog?.webContents.id === senderId ? active.state : undefined;
}
export function reportSecurityKeyDialogStatus(senderId: number, status: unknown): void {
  if (active?.dialog?.webContents.id === senderId && (status === 'ready' || status === 'failed'))
    active.dialogStatus?.(status);
}
export function respondToSecurityKey(senderId: number, value: unknown): void {
  if (active?.dialog?.webContents.id !== senderId || !value || typeof value !== 'object') return;
  const action = value as SecurityKeyAction;
  if (
    !['cancel', 'continue', 'refresh', 'select', 'pin'].includes(action.action) ||
    (action.value !== undefined && (typeof action.value !== 'string' || Buffer.byteLength(action.value) > 255))
  )
    return;
  if (action.action === 'cancel') active.cancel(active.failure ?? new WebAuthnError('NotAllowedError'));
  else active.respond?.(action);
}

/** Only this entry point owns hardware. Cancellation kills its disposable worker. */
export async function beginSecurityKey(event: IpcMainInvokeEvent, input: unknown): Promise<SecurityKeyResponse> {
  if (process.platform !== 'darwin') {
    logPreDialogFailure('platform');
    return { ok: false, error: 'NotSupportedError' };
  }
  if (active) {
    logPreDialogFailure('busy');
    return { ok: false, error: 'NotAllowedError' };
  }
  const tab = getBrowserPopupForContents(event.sender.id);
  const frame = event.senderFrame;
  const currentProfile = getActiveBrowserProfile();
  const profile = currentProfile ? { ...currentProfile } : undefined;
  if (
    !tab ||
    !frame ||
    frame !== event.sender.mainFrame ||
    !tab.active ||
    !profile ||
    tab.profileId !== profile.profileId
  ) {
    logPreDialogFailure('ownership');
    return { ok: false, error: 'SecurityError' };
  }
  let preDialogStage: PreDialogStage = 'request';
  let dialogShown = false;
  let worker: UtilityProcess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectAction: ((error: Error) => void) | undefined;
  let workerReject: ((error: Error) => void) | undefined;
  let stopped = false;
  const abort = new AbortController();
  let stopReason = cancelled();
  const wait = <T>(promise: Promise<T>): Promise<T> => {
    if (abort.signal.aborted) return Promise.reject(stopReason);
    return new Promise((resolve, reject) => {
      const stop = () => reject(stopReason);
      abort.signal.addEventListener('abort', stop, { once: true });
      promise.then(resolve, reject).finally(() => abort.signal.removeEventListener('abort', stop));
    });
  };
  let sequence = 0;
  const ceremony: Ceremony = {
    senderId: event.sender.id,
    requestId: '',
    cancel: (reason = cancelled()) => {
      if (stopped) return;
      stopReason = reason;
      stopped = true;
      abort.abort(reason);
      rejectAction?.(reason);
      workerReject?.(reason);
      worker?.kill();
      ceremony.dialog?.close();
    },
  };
  active = ceremony;
  const stillCurrent = () =>
    !stopped &&
    !frame.isDestroyed() &&
    !event.sender.isDestroyed() &&
    frame === event.sender.mainFrame &&
    getBrowserPopupForContents(event.sender.id) === tab &&
    tab.active &&
    !tab.window.isDestroyed() &&
    tab.window.isVisible() &&
    !tab.window.isMinimized() &&
    getActiveBrowserProfile()?.generation === profile.generation &&
    getActiveBrowserProfile()?.profileId === profile.profileId;
  const verify = async () => {
    if (!stillCurrent()) throw stopped ? stopReason : cancelled();
    await wait(validateBrowserToken(profile.token));
    if (!stillCurrent()) throw stopped ? stopReason : cancelled();
  };
  const onChange = () => {
    if (!stillCurrent()) ceremony.cancel();
  };
  const navigate = () => ceremony.cancel();
  const navigation = (_event: Electron.Event, _url: string, _inPlace: boolean, isMainFrame: boolean) => {
    if (isMainFrame) ceremony.cancel();
  };
  const ask = (
    state: Omit<SecurityKeyDialogState, 'origin' | 'rpId' | 'language' | 'dark'>
  ): Promise<SecurityKeyAction> => {
    if (!stillCurrent()) return Promise.reject(stopped ? stopReason : cancelled());
    ceremony.state = { ...ceremony.state!, ...state };
    ceremony.dialog?.webContents.send('ellmsha:security-key:dialog-state', ceremony.state);
    return new Promise((resolve, reject) => {
      rejectAction = reject;
      ceremony.respond = (action) => {
        if (
          (state.step === 'confirm' && action.action === 'continue') ||
          (state.step === 'devices' && action.action === 'select') ||
          (state.step === 'pin' && action.action === 'pin') ||
          (state.step === 'accounts' && action.action === 'select') ||
          (state.step === 'error' && action.action === 'refresh')
        ) {
          ceremony.respond = undefined;
          rejectAction = undefined;
          resolve(action);
        }
      };
    });
  };
  const show = (state: Partial<SecurityKeyDialogState>) => {
    ceremony.state = { ...ceremony.state!, ...state };
    ceremony.dialog?.webContents.send('ellmsha:security-key:dialog-state', ceremony.state);
  };
  const command = async (
    operation: 'enumerate' | 'info' | 'assert',
    data?: Record<string, unknown>
  ): Promise<WorkerResult> => {
    await verify();
    if (!worker) {
      worker = utilityProcess.fork(path.join(mainDirectory(), 'securityKeyWorker.js'), [], {
        serviceName: 'eLLMsha USB Security Key',
        stdio: 'ignore',
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' },
      });
      worker.once('exit', () => {
        worker = undefined;
        // Exit can occur between commands while the human chooses a device or
        // enters a PIN. Never keep UI alive or silently respawn that worker.
        if (!stopped) ceremony.cancel(new WebAuthnError('NotAllowedError'));
      });
    }
    const child = worker;
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const receive = (result: WorkerResult & { id: number }) => {
        if (!result || result.id !== id) return;
        child.removeListener('message', receive);
        workerReject = undefined;
        if (!Number.isInteger(result.code) || Buffer.byteLength(JSON.stringify(result)) > 100_000)
          reject(new WebAuthnError('NotAllowedError'));
        else resolve(result);
      };
      workerReject = (error) => {
        child.removeListener('message', receive);
        reject(error);
      };
      child.on('message', receive);
      child.postMessage({ id, operation, input: data });
    });
  };
  try {
    const request = validateRequest(input, new URL(frame.url).origin);
    ceremony.requestId = request.requestId;
    timer = setTimeout(() => ceremony.cancel(new WebAuthnError('NotAllowedError')), request.timeout);
    event.sender.on('did-start-navigation', navigation);
    event.sender.once('destroyed', navigate);
    tab.window.once('closed', navigate);
    tab.window.on('hide', navigate);
    tab.window.on('minimize', navigate);
    browserTabLifecycle.on('changed', onChange);
    preDialogStage = 'profile';
    await verify();
    preDialogStage = 'appid';
    const appid =
      request.appid === undefined ? undefined : await authorizeAppId(request.appid, request.origin, abort.signal);
    preDialogStage = 'profile';
    await verify();
    preDialogStage = 'dialog-create';
    const dialog = new BrowserWindow({
      parent: tab.window,
      modal: true,
      show: false,
      width: 500,
      height: 430,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      closable: true,
      title: i18n.t('settings.securityKey.title'),
      webPreferences: {
        preload: path.join(mainDirectory(), '../preload/securityKeyPreload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        devTools: false,
      },
    });
    ceremony.dialog = dialog;
    ceremony.state = {
      step: 'confirm',
      origin: request.origin,
      rpId: request.rpId,
      language: i18n.language,
      dark: nativeTheme.shouldUseDarkColors,
    };
    dialog.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    dialog.webContents.on('will-navigate', (e) => e.preventDefault());
    const failDialog = () => ceremony.cancel(ceremony.failure ?? new WebAuthnError('NotAllowedError'));
    dialog.webContents.on('before-input-event', (e, key) => {
      if (key.type === 'keyDown' && key.key === 'Escape') {
        e.preventDefault();
        ceremony.cancel(ceremony.failure ?? new WebAuthnError('NotAllowedError'));
      }
    });
    dialog.webContents.on('did-fail-load', failDialog);
    dialog.webContents.on('render-process-gone', failDialog);
    dialog.on('unresponsive', failDialog);
    // HTML loading/ready-to-show does not prove that its module graph mounted.
    const rendererReady = new Promise<void>((resolve) => {
      ceremony.dialogStatus = (status) => {
        if (status === 'ready') resolve();
        else failDialog();
      };
    });
    startupTimer = setTimeout(failDialog, 10_000);
    dialog.once('closed', () => {
      ceremony.dialog = undefined;
      if (!stopped) ceremony.cancel(ceremony.failure ?? new WebAuthnError('NotAllowedError'));
    });
    preDialogStage = 'dialog-load';
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (devUrl)
      await wait(
        dialog.loadURL(new URL('pages/conversation/Preview/browser/SecurityKeyDialog/dialog.html', devUrl).href)
      );
    else
      await wait(
        dialog.loadFile(
          path.join(mainDirectory(), '../renderer/pages/conversation/Preview/browser/SecurityKeyDialog/dialog.html')
        )
      );
    preDialogStage = 'dialog-startup';
    await wait(rendererReady);
    clearTimeout(startupTimer);
    if (!stillCurrent()) throw stopped ? stopReason : cancelled();
    const confirmation = ask({ step: 'confirm' });
    dialog.show();
    dialogShown = true;
    await confirmation;
    let devices: { path: string; name: string }[] = [];
    while (!devices.length) {
      show({ step: 'touch' });
      const found = await command('enumerate');
      if (found.code !== 0 || !Array.isArray(found.devices) || found.devices.length > 16)
        throw new WebAuthnError('NotAllowedError');
      devices = found.devices;
      if (!devices.length) await ask({ step: 'error', error: 'unavailable', options: [] });
    }
    const selection = await ask({
      step: 'devices',
      options: devices.map((d, i) => ({ id: String(i), name: d.name.slice(0, 256) })),
    });
    const device = devices.find((_d, i) => String(i) === selection.value);
    if (!device) throw cancelled();
    let info = await command('info', { path: device.path });
    if (info.code !== 0) throw new WebAuthnError('NotAllowedError');
    const uv = request.uv === 'required' || (request.uv === 'preferred' && !!(info.pinSet || info.uvSet));
    if (uv && !info.pinSet && !info.uvSet) throw new WebAuthnError('NotSupportedError');
    let needPin = uv && info.pinSet;
    let result: WorkerResult;
    let usedAppId = false;
    while (true) {
      let pin = '';
      if (needPin) {
        const action = await ask({
          step: 'pin',
          retries: info.retries,
          error: ceremony.state?.error === 'invalidPin' ? 'invalidPin' : undefined,
          options: [],
        });
        if (!action.value || Buffer.byteLength(action.value) > 63 || action.value.includes('\0'))
          throw new WebAuthnError('TypeError');
        pin = action.value;
        action.value = '';
      }
      show({ step: 'touch', error: undefined });
      const assertionInput = {
        path: device.path,
        rpId: request.rpId,
        hash: request.hash,
        allowCredentials: request.allowCredentials,
        uv,
        u2f: false,
        pin,
      };
      pin = '';
      try {
        result = await command('assert', assertionInput);
      } finally {
        assertionInput.pin = '';
      }
      if (result.code === 0x36 && info.pinSet) {
        needPin = true;
        continue; // A PIN-required response consumes no guess; wait for the human.
      }
      if (result.code !== 0x31) break;
      info = await command('info', { path: device.path });
      if (info.code !== 0 || !info.pinSet || info.retries === 0) {
        show({ step: 'error', error: 'blockedPin' });
        throw new WebAuthnError('NotAllowedError');
      }
      needPin = true;
      show({ step: 'pin', error: 'invalidPin' });
    }
    if (result.code === 0x2e && appid && request.uv !== 'required') {
      result = await command('assert', {
        path: device.path,
        rpId: appid,
        hash: request.hash,
        allowCredentials: request.allowCredentials,
        uv: false,
        u2f: true,
        pin: '',
      });
      usedAppId = result.code === 0;
    }
    if (result.code !== 0 || !result.assertions?.length) {
      await ask({
        step: 'error',
        error: [0x32, 0x34].includes(result.code)
          ? 'blockedPin'
          : result.code === 0x2e
            ? 'noCredential'
            : 'unavailable',
        options: undefined,
      });
      throw new WebAuthnError('NotAllowedError');
    }
    let assertion = result.assertions[0];
    if (result.assertions.length > 1) {
      const choice = await ask({
        step: 'accounts',
        options: result.assertions.map((a, i) => ({
          id: String(i),
          name: a.name || String(i + 1),
        })),
      });
      assertion = result.assertions.find((_a, i) => String(i) === choice.value)!;
    }
    if (!assertion) throw cancelled();
    await verify();
    return {
      ok: true,
      assertion: {
        id: assertion.id,
        authenticatorData: assertion.authenticatorData,
        signature: assertion.signature,
        userHandle: assertion.userHandle,
      },
      clientDataJSON: request.clientDataJSON,
      ...(request.appid === undefined ? {} : { appid: usedAppId }),
    };
  } catch (error) {
    if (!dialogShown) logPreDialogFailure(preDialogStage);
    if (
      dialogShown &&
      stillCurrent() &&
      ceremony.dialog &&
      !(error instanceof WebAuthnError && error.code === 'AbortError')
    ) {
      // Dismissing this failure must preserve its established API result.
      ceremony.failure = error instanceof WebAuthnError ? error : new WebAuthnError('NotAllowedError');
      try {
        await ask({
          step: 'error',
          error:
            ceremony.state?.error === 'blockedPin'
              ? 'blockedPin'
              : error instanceof WebAuthnError && error.code === 'NotSupportedError'
                ? 'unsupported'
                : 'unavailable',
          options: undefined,
        });
      } catch {
        /* Closing the trusted error dialog completes the failed request. */
      }
    }
    return {
      ok: false,
      error: stopped ? stopReason.code : error instanceof WebAuthnError ? error.code : 'NotAllowedError',
    };
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (startupTimer) clearTimeout(startupTimer);
    worker?.kill();
    event.sender.removeListener('did-start-navigation', navigation);
    event.sender.removeListener('destroyed', navigate);
    tab.window.removeListener('closed', navigate);
    tab.window.removeListener('hide', navigate);
    tab.window.removeListener('minimize', navigate);
    browserTabLifecycle.removeListener('changed', onChange);
    ceremony.respond = undefined;
    ceremony.dialogStatus = undefined;
    ceremony.dialog?.close();
    if (active === ceremony) active = undefined;
  }
}
