/** Build a self-contained, host-native Tencent runtime. Never contains user data. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const appRoot = path.resolve(__dirname, '../..');
const source = path.resolve(appRoot, '../tencentdb-agent-memory');
const target = path.join(appRoot, 'resources/tencent-memory', `${process.platform}-${process.arch}`);
const version = '22.20.0';
const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      PATH: `${path.join(target, 'bin')}${path.delimiter}${process.env.PATH}`,
      ELECTRON_RUN_AS_NODE: '',
      NODE_OPTIONS: '',
    },
  });
async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`);
  fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}
async function main() {
  fs.mkdirSync(path.join(target, 'bin'), { recursive: true });
  const node = path.join(target, 'bin', nodeName);
  if (!fs.existsSync(node)) {
    const base = `https://nodejs.org/dist/v${version}/`;
    const archive =
      process.platform === 'win32'
        ? `win-${process.arch}/node.exe`
        : `node-v${version}-${process.platform}-${process.arch}.tar.gz`;
    const temporary = path.join(target, 'node-download');
    await download(base + archive, temporary);
    const checksums = await (await fetch(base + 'SHASUMS256.txt')).text();
    const expected = checksums
      .split('\n')
      .find((line) => line.trim().endsWith(` ${archive}`))
      ?.split(/\s+/)[0];
    const actual = crypto.createHash('sha256').update(fs.readFileSync(temporary)).digest('hex');
    if (!expected || expected !== actual) throw new Error('Node runtime checksum mismatch');
    if (process.platform === 'win32') fs.renameSync(temporary, node);
    else {
      run('tar', ['-xzf', temporary, '-C', target, `node-v${version}-${process.platform}-${process.arch}/bin/node`]);
      fs.renameSync(path.join(target, `node-v${version}-${process.platform}-${process.arch}/bin/node`), node);
      fs.rmSync(path.join(target, `node-v${version}-${process.platform}-${process.arch}`), { recursive: true });
      fs.rmSync(temporary);
    }
    fs.chmodSync(node, 0o755);
  }
  // Native dependencies must be built with the shipped Node ABI, not Electron's ABI.
  const npmExecutable = execFileSync(
    process.platform === 'win32' ? 'where.exe' : 'which',
    [process.platform === 'win32' ? 'npm.cmd' : 'npm'],
    { encoding: 'utf8' }
  )
    .trim()
    .split(/\r?\n/)[0];
  const npmCli =
    process.platform === 'win32'
      ? path.join(path.dirname(npmExecutable), 'node_modules/npm/bin/npm-cli.js')
      : fs.realpathSync(npmExecutable);
  if (!fs.existsSync(npmCli)) throw new Error('Build requires an npm CLI installation');
  for (const name of ['MemoryCore', 'MemoryKnowledge', 'MemoryPanel']) {
    const src = path.join(source, name),
      dest = path.join(target, name);
    fs.mkdirSync(dest, { recursive: true });
    const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
    delete pkg.devDependencies;
    delete pkg.peerDependencies;
    delete pkg.peerDependenciesMeta;
    delete pkg.scripts;
    pkg.dependencies.tsx = '^4.21.0';
    const manifest = JSON.stringify(pkg, null, 2);
    const stamp = path.join(dest, '.dependency-manifest');
    if (!fs.existsSync(stamp) || fs.readFileSync(stamp, 'utf8') !== manifest) {
      fs.writeFileSync(path.join(dest, 'package.json'), manifest);
      run(node, [npmCli, 'install', '--omit=dev', '--legacy-peer-deps', '--no-audit', '--no-fund'], dest);
      fs.writeFileSync(stamp, manifest);
    }
    for (const entry of ['src', 'index.ts', 'openapi.yaml', 'templates', 'prompts']) {
      if (!fs.existsSync(path.join(src, entry))) continue;
      fs.rmSync(path.join(dest, entry), { recursive: true, force: true });
      fs.cpSync(path.join(src, entry), path.join(dest, entry), {
        recursive: true,
        filter: (file) => !/(?:__tests__|\.test\.[cm]?ts$)/.test(file),
      });
    }
  }
  const web = path.join(source, 'MemoryPanel/web');
  if (!fs.existsSync(path.join(web, 'node_modules'))) run(node, [npmCli, 'install', '--no-audit', '--no-fund'], web);
  run(node, [npmCli, 'run', 'build'], web);
  fs.cpSync(path.join(web, 'dist'), path.join(target, 'MemoryPanel/web/dist'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'runner.mjs'), path.join(target, 'runner.mjs'));
  fs.writeFileSync(
    path.join(target, 'runtime.json'),
    JSON.stringify({ node: version, platform: process.platform, arch: process.arch, format: 1 }) + '\n'
  );
  console.log(`Native Tencent runtime ready: ${target}`);
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
