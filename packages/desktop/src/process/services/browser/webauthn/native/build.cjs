const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');
const prepare = require('./prepare.cjs');
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const run = (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 120000 }).trim();

function verifyNative(directory, arch = process.arch) {
  const manifest = JSON.parse(readFileSync(join(directory, 'provenance.json'), 'utf8'));
  if (manifest.arch !== arch || manifest.libfido2 !== '1.17.0' || manifest.minimumMacOS !== '13.0')
    throw new Error('Wrong security-key native architecture/version');
  const file = join(directory, 'security-key.node');
  if (
    !existsSync(file) ||
    !run('lipo', ['-archs', file])
      .split(' ')
      .includes(arch === 'x64' ? 'x86_64' : arch)
  )
    throw new Error('Invalid security-key native artifact');
  const minimums = [...run('otool', ['-l', file]).matchAll(/\bminos\s+(\d+)\.(\d+)/g)];
  if (!minimums.length || minimums.some((m) => Number(m[1]) > 13 || (Number(m[1]) === 13 && Number(m[2]) > 0)))
    throw new Error('Security-key native code exceeds the macOS13 deployment baseline');
  for (const line of run('otool', ['-L', file]).split('\n').slice(1)) {
    const dependency = line.trim().split(' ')[0];
    if (dependency && !dependency.startsWith('/usr/lib/') && !dependency.startsWith('/System/Library/'))
      throw new Error('Unbundled security-key dependency');
  }
  for (const name of ['libfido2', 'libcbor', 'openssl'])
    if (!existsSync(join(directory, 'licenses', `${name}.txt`)))
      throw new Error('Missing security-key dependency license');
  return manifest;
}

function build(output) {
  if (process.platform !== 'darwin') return;
  const { prefix, target, receipt, sources } = prepare();
  mkdirSync(output, { recursive: true });
  mkdirSync(join(output, 'licenses'), { recursive: true });
  const licenseFiles = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'];
  for (let i = 0; i < sources.length; i++)
    copyFileSync(join(sources[i], licenseFiles[i]), join(output, 'licenses', `${receipt.dependencies[i].name}.txt`));
  const headers = resolve(dirname(realpathSync(process.execPath)), '../include/node');
  if (!existsSync(join(headers, 'node_api.h'))) throw new Error('Node-API headers are required at build time');
  run('xcrun', [
    'clang++',
    '-bundle',
    '-undefined',
    'dynamic_lookup',
    '-std=c++17',
    '-DNAPI_VERSION=8',
    '-Wl,-exported_symbol,_napi_register_module_v1,-exported_symbol,_node_api_module_get_api_version_v1',
    `-mmacosx-version-min=${target}`,
    '-I',
    headers,
    '-I',
    join(prefix, 'include'),
    join(__dirname, 'securityKey.cc'),
    join(prefix, 'lib/libfido2.a'),
    join(prefix, 'lib/libcbor.a'),
    join(prefix, 'lib/libcrypto.a'),
    '-framework',
    'IOKit',
    '-framework',
    'CoreFoundation',
    '-lz',
    '-o',
    join(output, 'security-key.node'),
  ]);
  // Builder replaces the development signature with the selected Developer ID.
  run('codesign', ['--force', '--sign', '-', join(output, 'security-key.node')]);
  writeFileSync(
    join(output, 'provenance.json'),
    JSON.stringify(
      {
        schema: 1,
        arch: process.arch,
        minimumMacOS: target,
        libfido2: '1.17.0',
        inputKind: 'checksum-verified-source-build',
        dependencies: receipt,
        sourceSha256: hash(join(__dirname, 'securityKey.cc')),
        policySha256: hash(join(__dirname, 'credentialPolicy.h')),
      },
      null,
      2
    )
  );
  copyFileSync(join(__dirname, 'dependencies.lock.json'), join(output, 'dependencies.lock.json'));
  verifyNative(output);
}
module.exports = { build, verifyNative };
if (require.main === module)
  build(resolve(process.argv[2] || join(__dirname, '../../../../../../../../out/main/native/security-key')));
