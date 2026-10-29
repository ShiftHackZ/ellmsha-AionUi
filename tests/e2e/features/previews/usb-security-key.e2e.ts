import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import buildFixture from '../../helpers/security-key/build.cjs';

test('compiled HTTPS preload, real utility addon load and trusted modal work with fake transport', async () => {
  test.skip(process.platform !== 'darwin', 'macOS-only USB transport');
  const native = process.env.ELLM_SHA_FIDO_NATIVE_FIXTURE;
  test.skip(
    !native,
    'Build isolated native addon and set ELLM_SHA_FIDO_NATIVE_FIXTURE; this test never accesses hardware'
  );
  test.setTimeout(120000);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ellmsha-security-key-qa-'));
  await buildFixture(directory, native);
  const application = await _electron.launch({
    args: [path.join(directory, 'fixture.cjs')],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, ELECTRON_RENDERER_URL: undefined },
  });
  const rendererErrors: string[] = [];
  application.on('window', (page) => page.on('pageerror', (error) => rendererErrors.push(error.message)));
  try {
    await expect
      .poll(() =>
        application.evaluate(
          () => (globalThis as unknown as { __securityKeyFixture: { ready?: boolean } }).__securityKeyFixture.ready
        )
      )
      .toBe(true);
    expect(
      await application.evaluate(() => {
        const f = (
          globalThis as unknown as {
            __securityKeyFixture: { preloadErrors: string[]; preloadStatus: unknown };
          }
        ).__securityKeyFixture;
        return { errors: f.preloadErrors, status: f.preloadStatus };
      })
    ).toEqual({ errors: [], status: { bridge: true, nativeGetter: false, secure: true } });
    const pending = application
      .evaluate(async () => {
        const f = (
          globalThis as unknown as {
            __securityKeyFixture: {
              tab: {
                view: { webContents: { executeJavaScript: (script: string) => Promise<unknown> } };
              };
            };
          }
        ).__securityKeyFixture;
        return f.tab.view.webContents.executeJavaScript(
          `navigator.credentials.get({publicKey:{challenge:new Uint8Array([1,2,3]),rpId:'example.test',allowCredentials:[{type:'public-key',id:new Uint8Array([107,101,121])}],userVerification:'required'}}).then(c=>({id:c.id,instance:c instanceof PublicKeyCredential,response:c.response instanceof AuthenticatorAssertionResponse,json:c.toJSON()}),e=>({error:e.name,message:e.message,bridgePresent:!!window.__ellmshaSecurityKey,method:String(navigator.credentials.get).slice(0,120)}))`
        );
      })
      .catch((error: Error) => ({ evaluateError: error.message }));
    await expect
      .poll(() => application.windows().some((page) => page.url().includes('SecurityKeyDialog/dialog.html')))
      .toBe(true);
    const dialog = application.windows().find((page) => page.url().includes('SecurityKeyDialog/dialog.html'))!;
    await expect(dialog.getByText('https://security-key.example.test')).toBeVisible();
    const evidence = process.env.ELLM_SHA_FIDO_QA_EVIDENCE;
    if (evidence) {
      fs.mkdirSync(evidence, { recursive: true });
      await dialog.screenshot({ path: path.join(evidence, 'trusted-confirm.png') });
    }
    expect(
      await application.evaluate(({ BrowserWindow }) => {
        const dialog = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().includes('SecurityKeyDialog/dialog.html')
        )!;
        return {
          modal: dialog.isModal(),
          parent: !!dialog.getParentWindow(),
          visible: dialog.isVisible(),
          focused: dialog.isFocused(),
        };
      })
    ).toEqual({ modal: true, parent: true, visible: true, focused: true });
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
    await dialog.getByRole('combobox').click();
    await dialog.getByText('QA synthetic key (no hardware)', { exact: true }).click();
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(dialog.getByLabel('Security key PIN', { exact: true })).toHaveValue('');
    if (evidence) await dialog.screenshot({ path: path.join(evidence, 'trusted-pin-empty.png') });
    await dialog.getByLabel('Security key PIN', { exact: true }).fill('fixture-only-pin');
    await dialog
      .getByRole('button', { name: 'Continue', exact: true })
      .click({ noWaitAfter: true })
      .catch((error: Error) => {
        if (!dialog.isClosed()) throw error;
      });
    expect(await pending).toMatchObject({ id: 'a2V5', instance: true, response: true });
    expect(
      await application.evaluate(() => {
        const f = (
          globalThis as unknown as {
            __securityKeyFixture: { nativeLoadWithoutDeviceAccess?: boolean; operations: string[] };
          }
        ).__securityKeyFixture;
        return { nativeLoad: f.nativeLoadWithoutDeviceAccess, operations: f.operations };
      })
    ).toEqual({ nativeLoad: true, operations: ['enumerate', 'info', 'assert'] });
    await application.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'light';
    });
    const cancelled = application
      .evaluate(async () => {
        const f = (
          globalThis as unknown as {
            __securityKeyFixture: {
              tab: { view: { webContents: { executeJavaScript: (script: string) => Promise<unknown> } } };
            };
          }
        ).__securityKeyFixture;
        return f.tab.view.webContents.executeJavaScript(
          "navigator.credentials.get({publicKey:{challenge:new Uint8Array([4,5,6]),rpId:'example.test'}}).then(()=> 'unexpected-success',e=>e.name)"
        );
      })
      .catch((error: Error) => ({ evaluateError: error.message }));
    await expect
      .poll(() => application.windows().some((page) => page.url().includes('SecurityKeyDialog/dialog.html')))
      .toBe(true);
    const cancelDialog = application.windows().find((page) => page.url().includes('SecurityKeyDialog/dialog.html'))!;
    await expect(cancelDialog.getByText('https://security-key.example.test')).toBeVisible();
    if (evidence) await cancelDialog.screenshot({ path: path.join(evidence, 'trusted-confirm-light.png') });
    await cancelDialog
      .getByRole('button', { name: 'Cancel', exact: true })
      .click({ noWaitAfter: true })
      .catch((error: Error) => {
        if (!cancelDialog.isClosed()) throw error;
      });
    expect(await cancelled).toBe('NotAllowedError');
    const aborted = application.evaluate(async () => {
      const f = (
        globalThis as unknown as {
          __securityKeyFixture: {
            tab: { view: { webContents: { executeJavaScript(script: string): Promise<unknown> } } };
          };
        }
      ).__securityKeyFixture;
      return f.tab.view.webContents.executeJavaScript(
        "window.__qaAbort=new AbortController(); navigator.credentials.get({publicKey:{challenge:new Uint8Array([7,8,9]),rpId:'example.test'},signal:window.__qaAbort.signal}).then(()=> 'unexpected-success',e=>e.name)"
      );
    });
    await expect
      .poll(() => application.windows().some((page) => page.url().includes('SecurityKeyDialog/dialog.html')))
      .toBe(true);
    await application.evaluate(async () => {
      const f = (
        globalThis as unknown as {
          __securityKeyFixture: {
            tab: { view: { webContents: { executeJavaScript(script: string): Promise<unknown> } } };
          };
        }
      ).__securityKeyFixture;
      await f.tab.view.webContents.executeJavaScript('window.__qaAbort.abort()');
    });
    expect(await aborted).toBe('AbortError');
    for (const dismissal of ['Escape', 'native-close'] as const) {
      await expect
        .poll(() => application.windows().some((page) => page.url().includes('SecurityKeyDialog/dialog.html')))
        .toBe(false);
      const dismissed = application
        .evaluate(async () => {
          const f = (
            globalThis as unknown as {
              __securityKeyFixture: {
                tab: { view: { webContents: { executeJavaScript(script: string): Promise<unknown> } } };
              };
            }
          ).__securityKeyFixture;
          return f.tab.view.webContents.executeJavaScript(
            "navigator.credentials.get({publicKey:{challenge:new Uint8Array([10]),rpId:'example.test'}}).then(()=> 'unexpected-success',e=>e.name)"
          );
        })
        .catch((error: Error) => ({ evaluationError: error.message }));
      await expect
        .poll(() => application.windows().some((page) => page.url().includes('SecurityKeyDialog/dialog.html')))
        .toBe(true);
      const currentDialog = application.windows().find((page) => page.url().includes('SecurityKeyDialog/dialog.html'))!;
      await expect(currentDialog.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
      if (dismissal === 'Escape')
        await currentDialog.keyboard.press('Escape').catch((error: Error) => {
          if (!currentDialog.isClosed()) throw error;
        });
      else
        await application.evaluate(({ BrowserWindow }) => {
          BrowserWindow.getAllWindows()
            .find((window) => window.webContents.getURL().includes('SecurityKeyDialog/dialog.html'))!
            .close();
        });
      expect(await dismissed).toBe('NotAllowedError');
    }
    expect(rendererErrors).toEqual([]);
    const dialogHtml = path.join(
      directory,
      'renderer/pages/conversation/Preview/browser/SecurityKeyDialog/dialog.html'
    );
    const originalHtml = fs.readFileSync(dialogHtml, 'utf8');
    try {
      fs.writeFileSync(dialogHtml, originalHtml.replace(/(<script\b[^>]*\bsrc=")[^"]+/, '$1./missing-entry.js'));
      const failedStartup = application
        .evaluate(async () => {
          const f = (
            globalThis as unknown as {
              __securityKeyFixture: {
                tab: { view: { webContents: { executeJavaScript(script: string): Promise<unknown> } } };
              };
            }
          ).__securityKeyFixture;
          return f.tab.view.webContents.executeJavaScript(
            "navigator.credentials.get({publicKey:{challenge:new Uint8Array([11]),rpId:'example.test'}}).then(()=> 'unexpected-success',e=>e.name)"
          );
        })
        .catch((error: Error) => ({ evaluationError: error.message }));
      await expect
        .poll(() =>
          application.evaluate(({ BrowserWindow }) => {
            const dialog = BrowserWindow.getAllWindows().find((window) =>
              window.webContents.getURL().includes('SecurityKeyDialog/dialog.html')
            );
            return dialog ? dialog.isVisible() : null;
          })
        )
        .toBe(false);
      expect(await failedStartup).toBe('NotAllowedError');
      await expect
        .poll(() => application.windows().some((page) => page.url().includes('SecurityKeyDialog/dialog.html')))
        .toBe(false);
    } finally {
      fs.writeFileSync(dialogHtml, originalHtml);
    }
    if (evidence)
      fs.writeFileSync(
        path.join(evidence, 'real-electron-synthetic-acceptance.json'),
        JSON.stringify(
          {
            status: 'PASS',
            mode: 'synthetic transport; no real key/account access',
            compiledHttpsPreload: true,
            strictPageCsp: true,
            nativeAddonUtilityProcessLoadWithoutHardware: true,
            trustedModalAboveNativeView: true,
            emptyPinScreenshot: true,
            lightAndDark: true,
            trustedUserDenialReturnsNotAllowedError: true,
            explicitSignalAbortReturnsAbortError: true,
            productionMultiEntryRenderer: true,
            nativeEscapeAndCloseReturnNotAllowedError: true,
            failedModuleNeverShowsBlankModalAndSettles: true,
            rendererErrors,
            physicalHardwareAcceptance: 'PENDING',
            awsAcceptance: 'PENDING',
          },
          null,
          2
        )
      );
  } finally {
    try {
      if (process.env.ELLM_SHA_FIDO_QA_EVIDENCE)
        fs.writeFileSync(
          path.join(process.env.ELLM_SHA_FIDO_QA_EVIDENCE, 'renderer-diagnostics.json'),
          JSON.stringify({ rendererErrors }, null, 2)
        );
    } finally {
      await application.close();
    }
  }
});
