'use strict';
const { spawn } = require('node:child_process');
const { readFile, writeFile, mkdir, rm, access } = require('node:fs/promises');
const { join } = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const http = require('node:http');
const { once } = require('node:events');
const { allowed } = require('./transport.cjs');

class CopilotRuntime {
  constructor({ source, state, extension = __dirname, idleMs = 300000, spawnProcess = spawn, log = console.info }) {
    Object.assign(this, { source, state, extension, idleMs, spawnProcess, log });
    this.enabled = false;
    this.child = null;
    this.starting = null;
    this.proxy = null;
    this.active = 0;
    this.models = [];
    this.token = randomBytes(32).toString('hex');
    this.bridgeToken = randomBytes(32).toString('hex');
  }
  status() {
    return {
      enabled: this.enabled,
      running: Boolean(this.child),
      starting: Boolean(this.starting),
      busy: this.active > 0,
      models: this.models.map((m) => m.id),
      runtimeAvailable: Boolean(this.source),
    };
  }
  async initialize() {
    await mkdir(this.state, { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(await readFile(join(this.state, 'settings.json'), 'utf8'));
      this.models = Array.isArray(saved.models) ? saved.models.filter((m) => typeof m.id === 'string') : [];
      this.enabled = saved.enabled === true;
    } catch (e) {
      if (e.code !== 'ENOENT') throw new Error('copilot_settings_unreadable');
    }
    if (this.enabled) await this.listen(); // No child process or authentication here.
    return this.status();
  }
  async save() {
    const file = join(this.state, 'settings.json');
    const { rename } = require('node:fs/promises');
    await writeFile(`${file}.tmp`, JSON.stringify({ enabled: this.enabled, models: this.models }), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }
  async setEnabled(enabled) {
    if (!enabled && this.active) throw new Error('copilot_requests_active');
    if (enabled) {
      await this.listen();
      this.enabled = true;
      await this.save();
    } else {
      // Close admission synchronously before awaiting disk/shutdown, otherwise a
      // request arriving during stop could launch a replacement IDE process.
      this.enabled = false;
      await this.save();
      await this.stop();
    }
    return this.status();
  }
  async listen() {
    if (this.proxy) return;
    const server = http.createServer((req, res) => {
      void this.forward(req, res);
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    this.proxy = server;
  }
  endpoint() {
    if (!this.proxy) throw new Error('copilot_disabled');
    return { baseUrl: `http://127.0.0.1:${this.proxy.address().port}/v1`, apiKey: this.token };
  }
  async ensure(login = false) {
    if (!this.enabled) throw new Error('copilot_disabled');
    if (this.stopping) await this.stopping;
    if (this.starting) return this.starting;
    if (this.child && this.port && !login) return this.port;
    if (login && this.child) await this.stop();
    this.starting = this.launch(login).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }
  async launch(login) {
    if (!this.source) throw new Error('copilot_runtime_missing');
    const product = JSON.parse(await readFile(join(this.source, 'product.json'), 'utf8'));
    if (product.nameShort !== 'Code - OSS' || product.applicationName !== 'code-oss')
      throw new Error('copilot_runtime_identity_mismatch');
    const executable =
      process.platform === 'darwin'
        ? join(this.source, '.build/electron', `${product.nameLong}.app`, 'Contents/MacOS', product.nameShort)
        : process.platform === 'win32'
          ? join(this.source, '.build/electron', `${product.nameShort}.exe`)
          : join(this.source, '.build/electron/code-oss');
    await access(executable);
    if (!(await readFile(join(this.source, 'src/main.ts'), 'utf8')).includes('ELLMSHA_IDE_BACKGROUND'))
      throw new Error('copilot_background_patch_missing');
    for (const part of ['user-data/User', 'extensions', 'shared-data', 'copilot'])
      await mkdir(join(this.state, part), { recursive: true, mode: 0o700 });
    await writeFile(
      join(this.state, 'user-data/User/settings.json'),
      JSON.stringify({
        'telemetry.telemetryLevel': 'off',
        'update.mode': 'none',
        'extensions.autoUpdate': false,
        'extensions.autoCheckUpdates': false,
        'workbench.startupEditor': 'none',
        'github-authentication.preferDeviceCodeFlow': true,
        'chat.agentHost.codexAgent.enabled': false,
        'chat.agentHost.claudeAgent.enabled': false,
      }),
      { mode: 0o600 }
    );
    const instance = randomUUID();
    const ready = join(this.state, 'runtime-ready.json');
    await rm(ready, { force: true });
    if (!process.env.HOME && process.platform !== 'win32') throw new Error('copilot_home_missing');
    const env = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      APPDATA: process.env.APPDATA,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      SystemRoot: process.env.SystemRoot,
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP,
      DISPLAY: process.env.DISPLAY,
      WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
      COPILOT_HOME: join(this.state, 'copilot'),
      XDG_CONFIG_HOME: join(this.state, 'config'),
      NODE_ENV: 'development',
      VSCODE_DEV: '1',
      ELLMSHA_COPILOT_INSTANCE: instance,
      ELLMSHA_COPILOT_READY_FILE: ready,
      ELLMSHA_COPILOT_PROBE_REPORT: join(this.state, 'probe-result.json'),
      ELLMSHA_COPILOT_BRIDGE_TOKEN: this.bridgeToken,
      ELLMSHA_COPILOT_PARENT_PID: String(process.pid),
      ...(login ? { ELLMSHA_COPILOT_LOGIN: '1' } : { ELLMSHA_IDE_BACKGROUND: '1' }),
    };
    const child = this.spawnProcess(
      executable,
      [
        this.source + '/',
        '--new-window',
        '--skip-welcome',
        '--skip-release-notes',
        `--user-data-dir=${join(this.state, 'user-data')}`,
        `--shared-data-dir=${join(this.state, 'shared-data')}`,
        `--extensions-dir=${join(this.state, 'extensions')}`,
        `--extensionDevelopmentPath=${this.extension}`,
        `--extensionDevelopmentPath=${join(this.source, 'extensions/copilot')}`,
        '--disable-extension=vscode.vscode-api-tests',
      ],
      { cwd: this.source, env, stdio: 'ignore', windowsHide: !login }
    );
    this.child = child;
    let failed = false;
    child.once('error', () => {
      failed = true;
      if (this.child === child) {
        this.child = null;
        this.port = null;
      }
    });
    child.once('exit', (code, signal) => {
      if (this.child === child) {
        this.child = null;
        this.port = null;
      }
      this.log('[CopilotIDE] runtime exited', { code, signal });
    });
    this.log('[CopilotIDE] runtime starting', { login });
    try {
      const until = Date.now() + 60000;
      while (Date.now() < until) {
        if (failed || child.exitCode !== null || this.child !== child) throw new Error('copilot_runtime_exited');
        try {
          const value = JSON.parse(await readFile(ready, 'utf8'));
          if (value.instance === instance && Number.isInteger(value.port) && value.port > 0 && value.port < 65536) {
            this.port = value.port;
            this.log('[CopilotIDE] runtime ready');
            this.armIdle();
            return this.port;
          }
        } catch (e) {
          if (e.code !== 'ENOENT') throw new Error('copilot_readiness_invalid');
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('copilot_start_timeout');
    } catch (e) {
      await this.stop(true).catch(() => this.log('[CopilotIDE] Startup cleanup did not complete'));
      throw e;
    }
  }
  armIdle() {
    clearTimeout(this.idle);
    if (this.child && !this.active) {
      this.idle = setTimeout(() => {
        void this.stop().catch(() => this.log('[CopilotIDE] idle shutdown failed'));
      }, this.idleMs);
      this.idle.unref();
    }
  }
  async stop(startupFailure = false) {
    if (this.active && !startupFailure) throw new Error('copilot_requests_active');
    if (this.stopping) return this.stopping;
    clearTimeout(this.idle);
    const child = this.child;
    if (!child) return;
    this.stopping = (async () => {
      const exited = once(child, 'exit');
      child.kill('SIGTERM'); // Owner only; workers shut down normally.
      let timeout;
      try {
        await Promise.race([
          exited,
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error('copilot_stop_timeout')), 8000);
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    })().finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }
  async modelsRefresh() {
    this.active++;
    clearTimeout(this.idle);
    try {
      const port = await this.ensure();
      const response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers: { Authorization: `Bearer ${this.bridgeToken}` },
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error(`copilot_models_${response.status}`);
      const data = await response.json();
      if (!Array.isArray(data.data) || !data.data.length) throw new Error('copilot_sign_in_required');
      this.models = data.data;
      await this.save();
      this.armIdle();
      return this.status();
    } finally {
      this.active--;
      this.armIdle();
    }
  }
  async forward(req, res) {
    const fail = (status, code) => {
      if (res.headersSent) res.destroy();
      else {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: code, code, type: 'copilot_ide_error' } }));
      }
    };
    if (!allowed(req, this.token)) return fail(401, 'unauthorized');
    if (!this.enabled) return fail(503, 'copilot_disabled');
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: this.models }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return fail(404, 'not_found');
    this.active++;
    clearTimeout(this.idle);
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) throw new Error('request_too_large');
        chunks.push(chunk);
      }
      const port = await this.ensure();
      const upstream = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.bridgeToken}`, 'Content-Type': 'application/json' },
        body: Buffer.concat(chunks),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(240000)]),
      });
      res.writeHead(upstream.status, {
        'Content-Type': upstream.headers.get('content-type') || 'application/json',
        'Cache-Control': 'no-store',
      });
      for await (const chunk of upstream.body) {
        if (!res.write(chunk)) await once(res, 'drain', { signal: abort.signal });
      }
      res.end();
    } catch (e) {
      fail(502, /^(copilot_|request_too_large)/.test(e.message) ? e.message : 'copilot_bridge_failed');
    } finally {
      this.active--;
      this.armIdle();
    }
  }
  async dispose() {
    await this.stop();
    if (this.proxy) {
      this.proxy.closeAllConnections();
      await new Promise((resolve) => this.proxy.close(resolve));
      this.proxy = null;
    }
  }
}
module.exports = { CopilotRuntime };
