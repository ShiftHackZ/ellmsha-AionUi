const { build } = require('esbuild');
const { cpSync, mkdirSync } = require('node:fs');
const path = require('node:path');

/** Build real bridge/preloads/UI against a fake transport; never launches the app. */
module.exports = async function buildFixture(output, nativeDirectory) {
  const root = path.resolve(__dirname, '../../../..');
  const src = path.join(root, 'packages/desktop/src');
  mkdirSync(output, { recursive: true });
  const common = {
    absWorkingDir: root,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    tsconfig: path.join(root, 'tsconfig.json'),
    logLevel: 'warning',
  };
  await build({
    ...common,
    entryPoints: [path.join(src, 'preload/browserWebAuthnPreload.ts'), path.join(src, 'preload/securityKeyPreload.ts')],
    outdir: path.join(output, 'preload'),
    external: ['electron'],
  });
  await build({
    ...common,
    entryPoints: {
      securityKeyWorker: path.join(src, 'process/services/browser/webauthn/worker.ts'),
    },
    outdir: path.join(output, 'main'),
    external: ['electron'],
  });
  cpSync(nativeDirectory, path.join(output, 'main/native/security-key'), { recursive: true });
  await build({
    ...common,
    entryPoints: [path.join(src, 'process/bridge/browserWebAuthnBridge.ts')],
    outfile: path.join(output, 'main/bridge.cjs'),
    plugins: [
      {
        name: 'fake-transport-only',
        setup(builder) {
          builder.onResolve({ filter: /^electron$/ }, (args) =>
            args.namespace === 'fixture'
              ? { path: 'electron', external: true }
              : { path: 'electron', namespace: 'fixture' }
          );
          builder.onResolve({ filter: /^(\.\.\/popups|@process\/services\/browser\/popups)$/ }, () => ({
            path: 'tabs',
            namespace: 'fixture',
          }));
          builder.onResolve({ filter: /^\.\.\/profiles$/ }, () => ({
            path: 'profiles',
            namespace: 'fixture',
          }));
          builder.onResolve({ filter: /^@process\/services\/i18n$/ }, () => ({
            path: 'i18n',
            namespace: 'fixture',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path: name }) => ({
            contents:
              name === 'electron'
                ? "const e=require('electron'); exports.BrowserWindow=e.BrowserWindow; exports.nativeTheme=e.nativeTheme; exports.ipcMain=e.ipcMain; exports.utilityProcess=globalThis.__securityKeyFixture.utilityProcess;"
                : name === 'tabs'
                  ? 'exports.getBrowserPopupForContents=(id)=>globalThis.__securityKeyFixture.tab?.view.webContents.id===id?globalThis.__securityKeyFixture.tab:undefined; exports.browserTabLifecycle=globalThis.__securityKeyFixture.lifecycle;'
                  : name === 'profiles'
                    ? 'exports.getActiveBrowserProfile=()=>globalThis.__securityKeyFixture.profile; exports.validateBrowserToken=async()=>globalThis.__securityKeyFixture.profile.profileId;'
                    : "module.exports={language:'en-US',t:(k)=>k};",
          }));
        },
      },
    ],
  });
  // Exercise the same multi-entry chunk graph as local and CI builds. A separate
  // single-entry Vite build hides dependency cycles in production manualChunks.
  const { build: viteBuild, loadConfigFromFile } = await import('vite');
  const previousDirectory = process.cwd();
  const previousSentryToken = process.env.SENTRY_AUTH_TOKEN;
  try {
    process.chdir(root);
    // Keep production chunking, but never upload source maps from a QA fixture.
    delete process.env.SENTRY_AUTH_TOKEN;
    const loaded = await loadConfigFromFile(
      { command: 'build', mode: 'production' },
      path.join(root, 'packages/desktop/electron.vite.config.ts')
    );
    const renderer = loaded?.config.renderer;
    if (!renderer) throw new Error('Production renderer configuration is missing');
    await viteBuild({
      ...renderer,
      configFile: false,
      logLevel: 'warn',
      build: { ...renderer.build, outDir: path.join(output, 'renderer'), emptyOutDir: true },
    });
  } finally {
    process.chdir(previousDirectory);
    if (previousSentryToken === undefined) delete process.env.SENTRY_AUTH_TOKEN;
    else process.env.SENTRY_AUTH_TOKEN = previousSentryToken;
  }
  cpSync(path.join(__dirname, 'fixture.cjs'), path.join(output, 'fixture.cjs'));
};
