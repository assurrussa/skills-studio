import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { AppServerConnection, discoverCodex } from './app-server.mjs';

const execute = promisify(execFile);
const failure = (code, message) => Object.assign(new Error(message), { code });

// A catalogue connection keeps the user's plugin configuration intact. ChatService
// intentionally disables plugins and must never be used for runtime discovery.
export class RuntimeCatalog {
  constructor({ codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'), env = process.env,
    resolveCLI = () => discoverCodex({ env }), connection = options => new AppServerConnection(options),
    executeCLI = execute, ttl = 15000, timeout = 5000 } = {}) {
    Object.assign(this, { codexHome, env, resolveCLI, connection, executeCLI, ttl, timeout });
    this.cache = new Map();
  }
  async cliInfo() {
    if (!this.discovering) this.discovering = this.bounded(Promise.resolve().then(() => this.resolveCLI())).catch(error => { this.discovering = null; throw error; });
    return this.discovering;
  }
  async connect() {
    if (this.closed) throw failure('RUNTIME_CLOSED', 'Каталог Codex закрыт.');
    if (!this.connecting) this.connecting = (async () => {
      const cli = await this.cliInfo();
      if (this.closed) throw failure('RUNTIME_CLOSED', 'Каталог Codex закрыт.');
      const rpc = this.connection({ path:cli.path, args:cli.args || ['app-server', '--listen', 'stdio://'], cwd:homedir(), env:{ ...this.env, CODEX_HOME:this.codexHome }, timeout:this.timeout });
      this.rpc = rpc; this.cli = cli;
      rpc.on?.('closed', () => { if (this.rpc === rpc) { this.rpc = null; this.connecting = null; } });
      try { await rpc.start(); return rpc; } catch (error) { await rpc.close(); this.rpc = null; throw error; }
    })().catch(error => { this.connecting = null; throw error; });
    return this.connecting;
  }
  async bounded(operation) {
    let timer;
    try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(failure('RPC_TIMEOUT', 'Каталог Codex не ответил вовремя.')), this.timeout); })]); }
    finally { clearTimeout(timer); }
  }
  async snapshot(cwds, { forceReload = false } = {}) {
    const paths = [...new Set(cwds.map(path => resolve(path)))].sort(), key = JSON.stringify(paths);
    const previous = this.cache.get(key);
    if (!forceReload && previous && previous.expires > Date.now()) return previous.promise;
    const promise = (async () => {
      const [skills, plugins] = await Promise.allSettled([
        this.bounded((async () => { const rpc = await this.connect(); return rpc.request('skills/list', { cwds:paths, forceReload:true }); })()),
        this.bounded((async () => { const cli = await this.cliInfo(); return this.executeCLI(cli.path, ['plugin', 'list', '--json'], { env:{ ...this.env, CODEX_HOME:this.codexHome }, timeout:this.timeout, maxBuffer:4 * 1024 * 1024 }); })()),
      ]);
      let installed = null;
      if (plugins.status === 'fulfilled') {
        try { const value = JSON.parse(plugins.value.stdout); if (Array.isArray(value.installed)) installed = value.installed; } catch { /* Cache contents remain visible without runtime confirmation. */ }
      }
      const data = skills.status === 'fulfilled' && Array.isArray(skills.value?.data) ? skills.value.data : [];
      const errors = data.flatMap(item => Array.isArray(item.errors) ? item.errors : []);
      return { data, installed, cwds:paths,
        reason:skills.status === 'rejected' || errors.length ? 'Не удалось полностью проверить доступность в Codex.' : null };
    })();
    this.cache.set(key, { promise, expires:Date.now() + this.ttl });
    return promise;
  }
  async setEnabled(path, enabled) {
    const rpc = await this.bounded(this.connect());
    await this.bounded(rpc.request('skills/config/write', { path, enabled }));
    this.cache.clear();
  }
  async close() { this.closed = true; this.cache.clear(); await this.rpc?.close(); }
}

export function registrationAvailability(registration, snapshot) {
  if (registration.disabled) return { status:'disabled', reason:'Скилл находится в архивной папке disabled-skills.' };
  if (registration.scope === 'plugin' && registration.plugin?.installed && registration.plugin.enabled === false) return { status:'disabled', reason:'Плагин выключен в Codex.' };
  const matches = (snapshot?.data || []).flatMap(item => item.skills || []).filter(item => typeof item.path === 'string' && resolve(item.path) === resolve(registration.path));
  if (matches.length && matches.every(item => item.enabled === true)) return { status:'enabled' };
  if (matches.length && matches.every(item => item.enabled === false)) return { status:'disabled' };
  if (registration.scope === 'plugin') return { status:'cached', reason:'Файлы плагина есть в кэше; доступность скилла в Codex не подтверждена.' };
  return { status:'unknown', reason:snapshot?.reason || 'Codex не подтвердил доступность этой регистрации.' };
}
