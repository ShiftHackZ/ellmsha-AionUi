const { execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, realpathSync, renameSync, rmSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');

if (process.platform === 'darwin') {
  const headers = resolve(dirname(realpathSync(process.execPath)), '../include/node');
  if (!existsSync(join(headers, 'node_api.h'))) {
    throw new Error(`Node-API headers missing at ${headers}; use a Node.js installation with headers`);
  }
  const output = resolve(process.argv[2] ?? join(__dirname, '../../../../../../out/main/native/pet-panel.node'));
  mkdirSync(dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  try {
    // N-API avoids Electron ABI rebuilds; one universal module supports either macOS target.
    execFileSync(
      'xcrun',
      [
        'clang++',
        '-bundle',
        '-undefined',
        'dynamic_lookup',
        '-std=c++17',
        '-fobjc-arc',
        '-arch',
        'arm64',
        '-arch',
        'x86_64',
        '-mmacosx-version-min=11.0',
        '-DNAPI_VERSION=8',
        '-framework',
        'AppKit',
        '-I',
        headers,
        join(__dirname, 'petPanel.mm'),
        '-o',
        temporary,
      ],
      { stdio: 'inherit', timeout: 120000 }
    );
    renameSync(temporary, output);
  } finally {
    rmSync(temporary, { force: true });
  }
}
