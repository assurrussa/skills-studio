import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, realpath, readdir, readFile, readlink, mkdir, writeFile, rename, rm, mkdtemp } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute, posix } from 'node:path';
import { tmpdir } from 'node:os';

const execute = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message) => Object.assign(new Error(message), { code });
const excluded = new Set(['.git']);
const limits = { maxFiles: 2000, maxBytes: 16 * 1024 * 1024, maxDepth: 32 };

// Content, relative names, executable bits and symlink targets all belong to a review.
async function snapshot(skill, bounds) {
  const checks = [], entries = [], markdown = [];
  let bytes = 0, count = 0, complete = true;
  const problem = message => { complete = false; checks.push({ code: 'INCOMPLETE_CONTENT', severity: 'warning', message }); };
  let root;
  try { root = dirname(await realpath(skill.canonicalPath || skill.path)); }
  catch { return { fingerprint: null, checks: [{ code: 'UNREADABLE_CONTENT', severity: 'error', message: 'Не удалось прочитать каталог скилла.' }] }; }
  async function visit(path, name, ancestors, depth) {
    if (++count > bounds.maxFiles || depth > bounds.maxDepth) throw new Error('Превышен предел числа файлов или глубины каталогов.');
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      entries.push([name, 'link', await readlink(path)]);
      const target = await realpath(path);
      if (ancestors.has(target)) throw new Error('Обнаружен цикл символических ссылок.');
      return visit(target, `${name}/@target`, ancestors, depth + 1);
    }
    if (info.isDirectory()) {
      const canonical = await realpath(path);
      if (ancestors.has(canonical)) throw new Error('Обнаружен цикл каталогов.');
      const next = new Set([...ancestors, canonical]);
      entries.push([name, 'directory']);
      for (const child of (await readdir(path)).sort()) if (!excluded.has(child)) await visit(join(path, child), name ? `${name}/${child}` : child, next, depth + 1);
    } else if (info.isFile()) {
      bytes += info.size;
      if (bytes > bounds.maxBytes) throw new Error('Превышен предел общего размера файлов скилла.');
      const content = await readFile(path);
      bytes += Math.max(0, content.length - info.size);
      if (bytes > bounds.maxBytes) throw new Error('Превышен предел общего размера файлов скилла.');
      entries.push([name, 'file', Boolean(info.mode & 0o111), hash(content)]);
      if (/\.md$/i.test(path)) markdown.push({ path, content: content.toString('utf8') });
    } else throw new Error('Неподдерживаемый тип файла в каталоге скилла.');
  }
  try { await visit(root, '', new Set(), 0); } catch (error) { problem(error.message); }
  for (const { path, content } of markdown) {
    // Check explicit Markdown destinations only; plain prose/code paths are not contracts.
    const destinations = [...content.matchAll(/\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)/g), ...content.matchAll(/^\s*\[[^\]]+\]:\s*(<[^>]+>|\S+)/gm)];
    for (const match of destinations) {
      let target = match[1].replace(/^<|>$/g, '').split('#')[0].split('?')[0];
      if (!target || /^(?:[a-z][a-z\d+.-]*:|\/\/|\/)/i.test(target)) continue;
      try { target = decodeURIComponent(target); await realpath(resolve(dirname(path), target)); }
      catch { checks.push({ code: 'MISSING_REFERENCE', severity: 'warning', message: `Не найдена локальная ссылка: ${target.slice(0, 240)}` }); }
    }
  }
  if (skill.validationError) checks.push({ code: 'INVALID_SKILL', severity: 'error', message: skill.validationError });
  return { fingerprint: complete ? hash(JSON.stringify(entries)) : null, checks, root };
}

export class SkillHealth {
  constructor({ stateDir, exec = execute, pluginProvider = null, ...bounds } = {}) {
    if (!stateDir) throw new Error('SkillHealth requires stateDir');
    this.directory = join(stateDir, 'health');
    this.exec = exec;
    this.pluginProvider = pluginProvider;
    this.bounds = { ...limits, ...Object.fromEntries(Object.keys(limits).filter(key => Number.isInteger(bounds[key]) && bounds[key] > 0).map(key => [key, bounds[key]])) };
    this.pending = new Map();
  }
  file(skill) {
    if (typeof skill.id !== 'string' || !skill.id) throw fail('INVALID_SKILL', 'Нужен идентификатор скилла.');
    return join(this.directory, `${hash(skill.id)}.json`);
  }
  async record(skill) {
    try { return JSON.parse(await readFile(this.file(skill), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return {}; throw error; }
  }
  async persist(skill, key, value) {
    const file = this.file(skill), previous = this.pending.get(file) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const record = await this.record(skill);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ ...record, [key]: value }), { flag: 'wx', mode: 0o600 });
        await rename(temporary, file);
      } finally { await rm(temporary, { force: true }); }
    });
    this.pending.set(file, operation);
    try { await operation; } finally { if (this.pending.get(file) === operation) this.pending.delete(file); }
    return value;
  }
  async inspect(skill) {
    const [{ fingerprint, checks }, record] = await Promise.all([snapshot(skill, this.bounds), this.record(skill)]);
    const review = record.review ? { ...record.review, state: fingerprint && record.review.fingerprint === fingerprint ? 'reviewed' : 'changed' } : null;
    return { fingerprint, checks, sourceCheck: record.sourceCheck || null, review };
  }
  async saveReview(skill, { fingerprint, note, evidenceUrls = [] } = {}) {
    if (typeof note !== 'string' || !note.trim() || note.length > 20000) throw fail('INVALID_REVIEW', 'Нужна непустая заметка проверки (до 20000 символов).');
    if (!Array.isArray(evidenceUrls) || evidenceUrls.length > 30 || evidenceUrls.some(value => {
      try { const url = new URL(value); return typeof value !== 'string' || value.length > 2048 || !['https:', 'http:'].includes(url.protocol) || Boolean(url.username || url.password); } catch { return true; }
    })) throw fail('INVALID_REVIEW', 'Источники должны быть HTTP/HTTPS-ссылками без учётных данных.');
    const current = await snapshot(skill, this.bounds);
    if (!current.fingerprint || fingerprint !== current.fingerprint) throw fail('CONFLICT', 'Содержимое изменилось или прочитано не полностью. Перечитайте скилл перед проверкой.');
    const review = { fingerprint, note: note.trim(), evidenceUrls, reviewedAt: new Date().toISOString() };
    await this.persist(skill, 'review', review);
    return { ...review, state: 'reviewed' };
  }
  async git(cwd, args, extra = {}) {
    const { stdout } = await this.exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never', ...args], {
      cwd, timeout: 20000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', ...extra,
      env: { PATH: process.env.PATH, HOME: tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_SSH_COMMAND: 'ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes', GIT_ALLOW_PROTOCOL: 'https:http:ssh:git:file' },
    });
    return stdout.trimEnd();
  }
  async checkSource(skill) {
    const { fingerprint } = await snapshot(skill, this.bounds);
    let result = { status: 'unknown', checkedAt: new Date().toISOString(), fingerprint, reason: 'Источник с проверяемой актуальной версией не установлен.' };
    try {
      if (!fingerprint) result.reason = 'Содержимое скилла недоступно или прочитано не полностью.';
      else if (skill.git) result = { ...result, ...await this.checkGit(skill) };
      else if (skill.plugin && this.pluginProvider) {
        const latest = await this.pluginProvider(skill.plugin);
        if (latest && latest.pluginId === skill.plugin.id && typeof latest.version === 'string' && skill.plugin.version) result = { ...result, status: latest.version === skill.plugin.version ? 'current' : 'update-available', version: latest.version, reason: 'Версия сопоставлена с доступной версией плагина.' };
      } else if (skill.plugin) result.reason = 'Доступная версия плагина не подтверждена; установленная версия не доказывает актуальность.';
    } catch { result = { ...result, status: 'unknown', reason: 'Не удалось проверить источник: сеть, upstream или данные источника недоступны.' }; }
    if ((await snapshot(skill, this.bounds)).fingerprint !== fingerprint) result = { ...result, status: 'unknown', reason: 'Содержимое изменилось во время проверки источника.' };
    return this.persist(skill, 'sourceCheck', result);
  }
  async checkGit(skill) {
    const { repository, trackedPath } = skill.git;
    if (typeof repository !== 'string' || typeof trackedPath !== 'string' || isAbsolute(trackedPath) || trackedPath.split('/').includes('..')) throw new Error('Invalid Git source');
    const branch = await this.git(repository, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const remote = await this.git(repository, ['config', '--get', `branch.${branch}.remote`]);
    const ref = await this.git(repository, ['config', '--get', `branch.${branch}.merge`]);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(remote) || !/^refs\/heads\/.+/.test(ref)) throw new Error('No remote upstream');
    const url = await this.git(repository, ['remote', 'get-url', remote]);
    if (!/^(?:https?:\/\/|ssh:\/\/|git:\/\/|[\w.-]+@[\w.-]+:|\/)/.test(url) || url.includes('\n')) throw new Error('Unsupported remote');
    const subtree = posix.basename(trackedPath) === 'SKILL.md' ? posix.dirname(trackedPath) : trackedPath;
    const format = await this.git(repository, ['rev-parse', '--show-object-format']);
    const installedTree = await this.git(repository, ['ls-tree', '-r', '-z', 'HEAD', '--', subtree]);
    const installed = new Map();
    for (const entry of installedTree.split('\0').filter(Boolean)) {
      const match = entry.match(/^(\d+) (\w+) ([a-f\d]+)\t([\s\S]+)$/);
      if (!match || match[2] !== 'blob') throw new Error('Unsupported installed Git subtree');
      installed.set(match[4], `${match[1]}:${match[3]}`);
    }
    if (!installed.size) throw new Error('No installed baseline');
    // Read raw bytes instead of git status/diff, which can invoke repository
    // fsmonitor hooks and clean/process filters even for a read-only operation.
    const working = new Map(); let count = 0, bytes = 0;
    const walk = async (path, depth = 0) => {
      if (++count > this.bounds.maxFiles || depth > this.bounds.maxDepth) throw new Error('Content limit');
      const info = await lstat(path);
      if (info.isDirectory()) {
        for (const name of await readdir(path)) if (!excluded.has(name)) await walk(join(path, name), depth + 1);
        return;
      }
      if (!info.isFile() && !info.isSymbolicLink()) throw new Error('Unsupported file');
      bytes += info.size; if (bytes > this.bounds.maxBytes) throw new Error('Content limit');
      const content = info.isSymbolicLink() ? Buffer.from(await readlink(path)) : await readFile(path);
      bytes += Math.max(0, content.length - info.size); if (bytes > this.bounds.maxBytes) throw new Error('Content limit');
      const oid = createHash(format).update(`blob ${content.length}\0`).update(content).digest('hex');
      working.set(relative(repository, path).split('\\').join('/'), `${info.isSymbolicLink() ? '120000' : info.mode & 0o111 ? '100755' : '100644'}:${oid}`);
    };
    await walk(resolve(repository, subtree));
    const dirty = installed.size !== working.size || [...installed].some(([path, value]) => working.get(path) !== value);
    const temporary = await mkdtemp(join(tmpdir(), 'skill-source-'));
    try {
      await this.git(temporary, ['init', '--bare', `--object-format=${format}`, '.']);
      await this.git(temporary, ['fetch', '--no-tags', '--depth=1', '--no-recurse-submodules', '--', url, ref]);
      const commit = await this.git(temporary, ['rev-parse', 'FETCH_HEAD']);
      const tree = await this.git(temporary, ['ls-tree', '-r', '-z', 'FETCH_HEAD', '--', subtree]);
      const expected = new Map();
      for (const entry of tree.split('\0').filter(Boolean)) {
        const match = entry.match(/^(\d+) (\w+) ([a-f\d]+)\t([\s\S]+)$/);
        if (!match || match[2] !== 'blob') throw new Error('Unsupported Git subtree');
        expected.set(match[4], `${match[1]}:${match[3]}`);
      }
      if (!expected.size) return { status: 'unknown', dirty, remote, ref, commit, reason: 'Каталог скилла отсутствует в актуальном дереве источника.' };
      // The source update belongs to the installed Git revision. Local edits are
      // reported independently and must never masquerade as upstream changes.
      const equal = expected.size === installed.size && [...expected].every(([path, value]) => installed.get(path) === value);
      return { status: equal ? 'current' : 'update-available', dirty, remote, ref, commit, reason: equal
        ? dirty ? 'Источник совпадает с установленной Git-ревизией; есть локальные изменения.' : 'Источник совпадает с установленной Git-ревизией скилла.'
        : 'Дерево скилла в источнике отличается от установленной Git-ревизии.' };
    } catch {
      return { status: 'unknown', dirty, remote, ref, reason: 'Не удалось сравнить каталог с актуальным деревом источника.' };
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
}
