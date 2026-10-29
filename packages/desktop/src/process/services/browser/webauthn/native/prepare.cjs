const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { existsSync, mkdirSync, readFileSync, rmSync, renameSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const lock = require('./dependencies.lock.json');
const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

// These are build tools/dependencies only. No installer or runtime downloads occur.
module.exports = function prepare() {
  const target = '13.0';
  const compiler = execFileSync('xcrun', ['clang', '--version'], { encoding: 'utf8' });
  const key = createHash('sha256')
    .update(
      JSON.stringify([
        { schema: lock.schema, dependencies: lock.dependencies, buildTool: lock.buildTool },
        process.arch,
        target,
        compiler,
      ])
    )
    .digest('hex')
    .slice(0, 20);
  const base = resolve(__dirname, '../../../../../../../../../.data/native/security-key');
  const cache = join(base, key);
  const archives = join(base, 'archives');
  mkdirSync(archives, { recursive: true });
  const prefix = join(cache, 'prefix');
  if (existsSync(join(cache, 'complete.json'))) {
    const receipt = JSON.parse(readFileSync(join(cache, 'complete.json'), 'utf8'));
    if (Object.entries(receipt.files).some(([file, sha]) => digest(join(prefix, 'lib', file)) !== sha))
      throw new Error('Native dependency cache integrity failure');
    return { prefix, target, receipt, sources: lock.dependencies.map((d) => join(cache, d.name)) };
  }
  mkdirSync(cache, { recursive: true });
  const env = {
    ...process.env,
    MACOSX_DEPLOYMENT_TARGET: target,
    CFLAGS: `-mmacosx-version-min=${target}`,
    CXXFLAGS: `-mmacosx-version-min=${target}`,
    LDFLAGS: `-mmacosx-version-min=${target}`,
    PKG_CONFIG_PATH: join(prefix, 'lib/pkgconfig'),
  };
  const run = (file, args, cwd = cache) => execFileSync(file, args, { cwd, env, stdio: 'inherit', timeout: 900000 });
  const archive = (name, url, sha) => {
    const file = join(archives, `${sha}.tar.gz`);
    if (!existsSync(file)) {
      const tmp = `${file}.part`;
      run('/usr/bin/curl', [
        '--fail',
        '--location',
        '--max-redirs',
        '3',
        '--proto',
        '=https',
        '--proto-redir',
        '=https',
        '--connect-timeout',
        '20',
        '--max-time',
        '240',
        '--output',
        tmp,
        url,
      ]);
      if (digest(tmp) !== sha) {
        rmSync(tmp);
        throw new Error(`Checksum mismatch: ${name}`);
      }
      renameSync(tmp, file);
    }
    if (digest(file) !== sha) throw new Error(`Checksum mismatch: ${name}`);
    const folder = join(cache, name);
    if (!existsSync(folder)) {
      mkdirSync(folder);
      run('/usr/bin/tar', ['-xf', file, '--strip-components=1', '-C', folder]);
    }
    return folder;
  };
  const cmakeRoot = archive('cmake', lock.buildTool.source, lock.buildTool.sha256);
  const cmake = join(cmakeRoot, 'CMake.app/Contents/bin/cmake');
  if (!existsSync(cmake)) throw new Error('Pinned CMake layout changed');
  const sources = lock.dependencies.map((d) => archive(d.name, d.source, d.sourceSha256));
  const pkgconf = archive('pkgconf', lock.pkgconf.source, lock.pkgconf.sha256);
  if (!existsSync(join(prefix, 'bin/pkgconf'))) {
    run('/bin/sh', ['configure', `--prefix=${prefix}`], pkgconf);
    run('/usr/bin/make', ['-j2'], pkgconf);
    run('/usr/bin/make', ['install'], pkgconf);
  }
  const sdk = execFileSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8' }).trim();
  const zlib = readFileSync(join(sdk, 'usr/include/zlib.h'), 'utf8').match(/#define ZLIB_VERSION "([^"]+)"/);
  if (!zlib || !existsSync(join(sdk, 'usr/lib/libz.tbd'))) throw new Error('SDK zlib missing');
  mkdirSync(join(prefix, 'lib/pkgconfig'), { recursive: true });
  writeFileSync(
    join(prefix, 'lib/pkgconfig/zlib.pc'),
    `Name: zlib\nDescription: macOS SDK zlib\nVersion: ${zlib[1]}\nLibs: -L${sdk}/usr/lib -lz\nCflags: -I${sdk}/usr/include\n`
  );
  const openssl = sources[2];
  if (!existsSync(join(prefix, 'lib/libcrypto.a')) || !existsSync(join(prefix, 'include/openssl/opensslv.h'))) {
    run(
      '/usr/bin/perl',
      [
        'Configure',
        process.arch === 'arm64' ? 'darwin64-arm64-cc' : 'darwin64-x86_64-cc',
        'no-shared',
        'no-tests',
        'no-apps',
        `--prefix=${prefix}`,
        `--openssldir=${prefix}/ssl`,
      ],
      openssl
    );
    run('/usr/bin/make', ['-j2', 'build_libs'], openssl);
    run('/usr/bin/make', ['install_dev'], openssl);
  }
  const cmakeBuild = (name, source, options) => {
    const build = join(cache, `${name}-build`);
    run(cmake, [
      '-S',
      source,
      '-B',
      build,
      `-DCMAKE_INSTALL_PREFIX=${prefix}`,
      '-DCMAKE_BUILD_TYPE=Release',
      `-DCMAKE_OSX_DEPLOYMENT_TARGET=${target}`,
      `-DCMAKE_OSX_ARCHITECTURES=${process.arch === 'arm64' ? 'arm64' : 'x86_64'}`,
      `-DCMAKE_PREFIX_PATH=${prefix}`,
      `-DPKG_CONFIG_EXECUTABLE=${prefix}/bin/pkgconf`,
      ...options,
    ]);
    run(cmake, ['--build', build, '--parallel', '2']);
    run(cmake, ['--install', build]);
  };
  cmakeBuild('libcbor', sources[1], ['-DBUILD_SHARED_LIBS=OFF', '-DWITH_EXAMPLES=OFF', '-DWITH_TESTS=OFF']);
  cmakeBuild('libfido2', sources[0], [
    '-DBUILD_SHARED_LIBS=OFF',
    '-DBUILD_STATIC_LIBS=ON',
    '-DBUILD_TESTS=OFF',
    '-DBUILD_TOOLS=OFF',
    '-DBUILD_EXAMPLES=OFF',
    '-DBUILD_MANPAGES=OFF',
    `-DCBOR_INCLUDE_DIRS=${prefix}/include`,
    `-DCBOR_LIBRARY_DIRS=${prefix}/lib`,
    `-DCBOR_LIBRARIES=${prefix}/lib/libcbor.a`,
    `-DCRYPTO_INCLUDE_DIRS=${prefix}/include`,
    `-DCRYPTO_LIBRARY_DIRS=${prefix}/lib`,
    `-DCRYPTO_LIBRARIES=${prefix}/lib/libcrypto.a`,
    `-DCMAKE_C_FLAGS=-I${prefix}/include -mmacosx-version-min=${target}`,
  ]);
  const receipt = {
    schema: 1,
    arch: process.arch,
    minimumMacOS: target,
    compiler,
    dependencies: lock.dependencies,
    files: Object.fromEntries(
      ['libfido2.a', 'libcbor.a', 'libcrypto.a'].map((f) => [f, digest(join(prefix, 'lib', f))])
    ),
  };
  writeFileSync(join(cache, 'complete.json'), JSON.stringify(receipt, null, 2));
  return { prefix, target, receipt, sources };
};
