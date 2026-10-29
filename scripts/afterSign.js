const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');

// Never replace a failed certificate signature with ad-hoc signing: doing so
// changes the application's macOS privacy identity on every rebuild.
function verifySignature(appPath, run = execFileSync) {
  run('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'pipe' });
}

function verifyApplicationSignature(appPath, env = process.env, run = execFileSync, inspect = spawnSync) {
  verifySignature(appPath, run);
  if (env.ELLM_SHA_SIGNING_REQUIRED === '1') {
    const expectedTeam = env.ELLM_SHA_SIGNING_TEAM;
    const expectedIdentity = env.ELLM_SHA_SIGNING_IDENTITY;
    if (!expectedTeam || !expectedIdentity) throw new Error('Signed build is missing its expected team or identity');
    for (const bundle of [appPath, path.join(appPath, 'Contents/Resources/open-computer-use/Open Computer Use.app')]) {
      verifySignature(bundle, run);
      const details = inspect('codesign', ['-d', '--verbose=4', bundle], { encoding: 'utf8' });
      if (
        details.status !== 0 ||
        !details.stderr.split('\n').includes(`TeamIdentifier=${expectedTeam}`) ||
        !details.stderr.split('\n').includes(`Authority=${expectedIdentity}`) ||
        /Signature=adhoc/.test(details.stderr)
      ) {
        throw new Error('Application/helper must have the exact selected Apple certificate and team signature');
      }
      const requirement = inspect('codesign', ['-d', '-r-', bundle], { encoding: 'utf8' });
      if (requirement.status !== 0 || /designated => cdhash/.test(requirement.stdout + requirement.stderr)) {
        throw new Error('Application/helper lacks a stable certificate-based designated requirement');
      }
    }
    const keyAddon = path.join(
      appPath,
      'Contents/Resources/app.asar.unpacked/out/main/native/security-key/security-key.node'
    );
    verifySignature(keyAddon, run);
    const keyDetails = inspect('codesign', ['-d', '--verbose=4', keyAddon], { encoding: 'utf8' });
    if (
      keyDetails.status !== 0 ||
      !keyDetails.stderr.split('\n').includes(`TeamIdentifier=${expectedTeam}`) ||
      !keyDetails.stderr.split('\n').includes(`Authority=${expectedIdentity}`) ||
      /Signature=adhoc/.test(keyDetails.stderr)
    )
      throw new Error('Security-key native addon lacks the selected Developer ID signature');
  }
}

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  verifyApplicationSignature(appPath);
  // electron-builder owns notarization using APPLE_KEYCHAIN_PROFILE. This hook
  // neither reads secrets nor submits a second notarization request.
};

exports.verifySignature = verifySignature;
exports.verifyApplicationSignature = verifyApplicationSignature;
