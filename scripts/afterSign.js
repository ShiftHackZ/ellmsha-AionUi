const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');

// Never replace a failed certificate signature with ad-hoc signing: doing so
// changes the application's macOS privacy identity on every rebuild.
function verifySignature(appPath, run = execFileSync) {
  run('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'pipe' });
}

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  verifySignature(appPath);
  if (process.env.ELLM_SHA_SIGNING_REQUIRED === '1') {
    const expectedTeam = process.env.ELLM_SHA_SIGNING_TEAM;
    if (!expectedTeam) throw new Error('Signed build is missing its expected team');
    for (const bundle of [appPath, path.join(appPath, 'Contents/Resources/open-computer-use/Open Computer Use.app')]) {
      verifySignature(bundle);
      const details = spawnSync('codesign', ['-d', '--verbose=4', bundle], { encoding: 'utf8' });
      if (
        details.status !== 0 ||
        !details.stderr.split('\n').includes(`TeamIdentifier=${expectedTeam}`) ||
        /Signature=adhoc/.test(details.stderr)
      ) {
        throw new Error('Application/helper must have the selected Apple team signature');
      }
      const requirement = spawnSync('codesign', ['-d', '-r-', bundle], { encoding: 'utf8' });
      if (requirement.status !== 0 || /designated => cdhash/.test(requirement.stdout + requirement.stderr)) {
        throw new Error('Application/helper lacks a stable certificate-based designated requirement');
      }
    }
  }
  // electron-builder owns notarization using APPLE_KEYCHAIN_PROFILE. This hook
  // neither reads secrets nor submits a second notarization request.
};

exports.verifySignature = verifySignature;
