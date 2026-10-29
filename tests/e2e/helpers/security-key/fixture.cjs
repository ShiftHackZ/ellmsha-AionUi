const { app, BrowserWindow, WebContentsView, session, utilityProcess, nativeTheme } = require('electron');
const { EventEmitter } = require('node:events');
const path = require('node:path');
app.setPath('userData', path.join(__dirname, 'private-fixture-profile'));
app.disableHardwareAcceleration();
app.setName('eLLMsha USB QA — fake transport');
nativeTheme.themeSource = 'dark';
const f = (globalThis.__securityKeyFixture = {
  profile: { profileId: 'fixture-only', generation: 1, token: 'not-a-production-token' },
  lifecycle: new EventEmitter(),
  operations: [],
  utilityProcess: { fork: () => new FakeWorker() },
});
class FakeWorker extends EventEmitter {
  kill() {}
  postMessage({ id, operation }) {
    f.operations.push(operation);
    const result =
      operation === 'enumerate'
        ? {
            devices: [{ path: 'fixture-not-a-real-device', name: 'QA synthetic key (no hardware)' }],
          }
        : operation === 'info'
          ? { fido2: true, pinSet: true, uvSet: false, retries: 3 }
          : {
              assertions: [
                {
                  id: 'a2V5',
                  authenticatorData: Buffer.alloc(37, 5).toString('base64url'),
                  signature: Buffer.from('synthetic-signature-not-valid-on-server').toString('base64url'),
                  userHandle: null,
                  name: 'QA synthetic account',
                },
              ],
            };
    queueMicrotask(() => this.emit('message', { id, code: 0, ...result }));
  }
}
app
  .whenReady()
  .then(async () => {
    // Real Electron utility process loads the actual addon, then rejects malformed
    // input before a device is enumerated/opened. All later transport is synthetic.
    const child = utilityProcess.fork(path.join(__dirname, 'main/securityKeyWorker.js'), [], {
      stdio: 'ignore',
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('Utility addon load timed out'));
      }, 10000);
      child.once('message', (data) => {
        clearTimeout(timer);
        child.kill();
        if (data.code !== -1 || data.nativeLoaded !== true)
          reject(new Error('Invalid native probe result or addon failed to load'));
        else {
          f.nativeLoadWithoutDeviceAccess = true;
          resolve();
        }
      });
      child.once('exit', (code) => {
        if (!f.nativeLoadWithoutDeviceAccess) {
          clearTimeout(timer);
          reject(new Error(`Utility addon load failed: ${code}`));
        }
      });
      child.postMessage({
        id: 1,
        operation: 'assert',
        input: {
          hash: Buffer.alloc(32).toString('base64url'),
          allowCredentials: [],
          uv: false,
          u2f: false,
          pin: '',
        },
      });
    });
    const browserSession = session.fromPartition('security-key-fixture-only');
    browserSession.protocol.handle(
      'https',
      () =>
        new Response(
          '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"></head><body><h1>USB security-key QA — synthetic transport only</h1></body></html>',
          { headers: { 'content-type': 'text/html' } }
        )
    );
    const host = new BrowserWindow({
      width: 900,
      height: 650,
      title: 'eLLMsha USB QA — no hardware',
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    const view = new WebContentsView({
      webPreferences: {
        session: browserSession,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        preload: path.join(__dirname, 'preload/browserWebAuthnPreload.js'),
      },
    });
    host.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 900, height: 600 });
    f.tab = { view, window: host, profileId: 'fixture-only', active: true };
    f.preloadErrors = [];
    view.webContents.on('preload-error', (_event, _file, error) => f.preloadErrors.push(error.message));
    require('./main/bridge.cjs').initBrowserWebAuthnBridge();
    await view.webContents.loadURL('https://security-key.example.test/login');
    f.preloadStatus = await view.webContents.executeJavaScript(
      '({bridge:!!window.__ellmshaSecurityKey,nativeGetter:String(navigator.credentials.get).includes("[native code]"),secure:window.isSecureContext})'
    );
    f.ready = true;
  })
  .catch((error) => {
    console.error(error.message);
    app.exit(1);
  });
app.on('window-all-closed', () => app.quit());
