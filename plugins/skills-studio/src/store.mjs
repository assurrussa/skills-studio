import { access, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, basename, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';
import { annotateSkills } from './provenance.mjs';
import { pluginSkillRoots } from './plugins.mjs';
import { RuntimeCatalog, registrationAvailability } from './runtime-catalog.mjs';
import { withSkillLock } from './locking.mjs';
import { manageSkill } from './actions.mjs';
import { measureSkillContext } from './context.mjs';

const MAX_BYTES = 2 * 1024 * 1024;
const digest = value => createHash('sha256').update(value).digest('hex');
function failure(code, message) { return Object.assign(new Error(message), { code }); }
async function directories(path) {
  try {
    const names = await readdir(path, { withFileTypes: true });
    return names.filter(x => x.isDirectory() || x.isSymbolicLink()).map(x => x.name);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
function metadata(content) {
  const front = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!front) throw failure('INVALID_SKILL', 'Нужен YAML-блок с name и description в начале SKILL.md.');
  const document = parseDocument(front[1], { uniqueKeys: true });
  if (document.errors.length) throw failure('INVALID_SKILL', `Ошибка YAML: ${document.errors[0].message}`);
  const data = document.toJS({ maxAliasCount: 30 });
  if (!data || typeof data.name !== 'string' || !data.name.trim() || typeof data.description !== 'string' || !data.description.trim()) {
    throw failure('INVALID_SKILL', 'В YAML нужны непустые строковые поля name и description.');
  }
  return { name: data.name, description: data.description };
}

export class SkillStore {
  constructor({ home = homedir(), codexHome = process.env.CODEX_HOME || join(home, '.codex'), stateDir = join(codexHome, 'skills-studio'), runtime = home === homedir() && codexHome === (process.env.CODEX_HOME || join(home, '.codex')) ? new RuntimeCatalog({ codexHome }) : null } = {}) {
    this.home = home;
    this.codexHome = codexHome;
    this.stateDir = stateDir;
    this.queue = Promise.resolve();
    this.runtime = runtime;
  }

  skillId(canonical, disabled = false) {
    // Keep disabled aliases distinct from an enabled registration of the same file.
    return digest(canonical + (disabled ? '\0disabled' : ''));
  }

  async listProjects() {
    try {
      const state = JSON.parse(await readFile(join(this.codexHome, '.codex-global-state.json'), 'utf8'));
      const values = state['local-projects'];
      if (!values || Array.isArray(values) || typeof values !== 'object') throw new Error('Нет поля local-projects');
      const order = Array.isArray(state['project-order']) ? state['project-order'] : [];
      const projects = Object.entries(values).flatMap(([id, value]) => {
        if (!value || !Array.isArray(value.rootPaths)) return [];
        const roots = value.rootPaths.filter(x => typeof x === 'string' && isAbsolute(x));
        return roots.length ? [{ id, name: typeof value.name === 'string' ? value.name : basename(roots[0]), roots }] : [];
      });
      projects.sort((a, b) => {
        const ai = order.indexOf(a.id), bi = order.indexOf(b.id);
        return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi) || a.name.localeCompare(b.name);
      });
      return { projects, warnings: [] };
    } catch (error) {
      return { projects: [], warnings: [`Не удалось прочитать реестр проектов Codex: ${error.message}`] };
    }
  }

  async roots(projectId) {
    const { projects, warnings } = await this.listProjects();
    const roots = [
      { path: join(this.home, '.agents/skills'), scope: 'global', source: 'Личные', readOnly: false, lockfile: join(this.home, 'skills.lock.toml') },
      { path: join(this.codexHome, 'skills'), scope: 'global', source: 'Личные', readOnly: false, lockfile: join(this.home, 'skills.lock.toml') },
      { path: join(this.codexHome, 'skills/.system'), scope: 'global', source: 'Системные', readOnly: true, system: true },
    ];
    if (projectId) {
      const project = projects.find(x => x.id === projectId);
      if (!project) throw failure('PROJECT_NOT_FOUND', 'Проект больше не найден в Codex. Выберите другой проект.');
      for (const root of project.roots) {
        for (const folder of ['.agents/skills', '.codex/skills']) roots.push({ path: join(root, folder), scope: 'local', source: project.name, readOnly: false, lockfile: join(root, 'skills.lock.toml') });
      }
    }
    return { roots: roots.flatMap(root => root.readOnly ? [root] : [
      { ...root, disabled:false },
      { ...root, path:join(dirname(root.path), 'disabled-skills'), disabled:true },
    ]), warnings };
  }

  async listSkills(projectId, { includePlugins = false, includeSystem = true, forceReload = false } = {}) {
    const { roots, warnings } = await this.roots(projectId);
    const { projects } = await this.listProjects();
    const cwds = projectId ? projects.find(project => project.id === projectId)?.roots || [this.home] : [this.home];
    let runtime;
    try { runtime = await this.runtime?.snapshot(cwds, { forceReload }); }
    catch { runtime = { reason:'Не удалось проверить доступность в Codex.' }; }
    if (runtime?.reason) warnings.push(runtime.reason);
    const runtimeSkills = (runtime?.data || []).flatMap(group => group.skills || []);
    const runtimeFiles = await Promise.all([...new Set(runtimeSkills.map(item => item.path).filter(path => typeof path === 'string' && isAbsolute(path) && basename(path) === 'SKILL.md'))].map(async path => ({path, canonical:await realpath(path).catch(() => null)})));
    if (includePlugins) roots.unshift(...await pluginSkillRoots(this.codexHome, warnings, runtime?.installed));
    const pluginDirectory = resolve(this.codexHome, 'plugins');
    const excludedPaths = [pluginDirectory, await realpath(pluginDirectory).catch(() => null)].filter(Boolean);
    const protectedPaths = (await Promise.all([join(this.codexHome, 'skills/.system')].map(path => realpath(path).catch(() => null)))).filter(Boolean);
    // Runtime can discover nested/repository/administrator roots beyond the two
    // editable user providers. Expose those files read-only; never turn a runtime
    // path into an arbitrary write capability.
    for (const group of runtime?.data || []) {
      for (const item of group.skills || []) {
        if (typeof item.path !== 'string' || !isAbsolute(item.path) || basename(item.path) !== 'SKILL.md') continue;
        const scope = item.scope === 'plugin' || excludedPaths.some(base => resolve(item.path).startsWith(base + sep)) ? 'plugin'
          : ['repo','project','local'].includes(item.scope) ? 'local' : 'global';
        if (scope === 'plugin' && !includePlugins) continue;
        roots.push({ path:dirname(item.path), direct:true, scope, runtimeScope:item.scope,
          source:scope === 'plugin' ? 'Плагин Codex' : ['repo','project','local'].includes(item.scope) ? 'Проект Codex' : 'Codex',
          system:item.scope === 'system' || item.scope === 'admin', readOnly:true });
      }
    }
    const seen = new Map();
    const skills = [];
    const entries = [];
    for (const root of roots) {
      if (root.system && !includeSystem) continue;
      try {
        for (const name of root.direct ? [basename(root.path)] : await directories(root.path)) {
          if (!root.direct && name.startsWith('.')) continue;
          const path = root.direct ? join(root.path, 'SKILL.md') : join(root.path, name, 'SKILL.md');
          let canonical;
          try { canonical = await realpath(path); }
          catch (error) { if (error.code === 'ENOENT') continue; throw error; }
          if (root.scope !== 'plugin' && excludedPaths.some(base => [resolve(path), canonical].some(candidate => candidate === base || candidate.startsWith(base + sep)))) continue;
          const system = Boolean(root.system || protectedPaths.some(base => canonical === base || canonical.startsWith(base + sep)));
          if (system && !includeSystem) continue;
          const disabled = Boolean(root.disabled), id = this.skillId(canonical, disabled);
          const registration = { path, scope:root.scope, source:system ? 'Системные' : root.source, disabled, readOnly:Boolean(root.readOnly || system) };
          if (root.plugin) registration.plugin = root.plugin;
          if (root.runtimeScope) registration.runtimeScope = root.runtimeScope;
          registration.availability = registrationAvailability(registration, runtime);
          // Codex may report the resolved file instead of a personal symlink.
          // Keep exact registrations authoritative when both are reported.
          if (!disabled && registration.availability.status === 'unknown' && resolve(path) !== canonical) {
            const files = runtimeFiles.filter(item => item.canonical === canonical);
            const nativePath = files.length === 1 ? files[0].path : null;
            const matching = runtimeSkills.filter(item => item.path === nativePath);
            const resolved = nativePath ? registrationAvailability({...registration, path:nativePath}, runtime) : {status:'unknown'};
            const hasExact = runtimeSkills.some(item => typeof item.path === 'string' && resolve(item.path) === resolve(path));
            if (!hasExact && ['enabled','disabled'].includes(resolved.status) && !matching.some(item => ['system','admin','plugin'].includes(item.scope))) {
              registration.availability = {...resolved, reason:'Codex подтвердил исходный файл символьной ссылки.'};
              registration.runtimePath = nativePath;
            }
          }
          if (seen.has(id)) {
            const existing = seen.get(id);
            if (!existing.registrations.some(item => item.path === path)) existing.registrations.push(registration);
            continue;
          }
          const info = await stat(canonical);
          if (!info.isFile()) continue;

          let details = { name, description: '' }, validationError = null, content = null;
          if (info.size > MAX_BYTES) validationError = 'Файл больше 2 МБ; редактирование недоступно.';
          else {
            try { content = await readFile(canonical, 'utf8'); details = metadata(content); }
            catch (error) { validationError = error.message; }
          }
          let readOnly = root.readOnly || info.size > MAX_BYTES || system;
          try { await access(canonical, constants.W_OK); } catch { readOnly = true; }
          // Project/plugin names stay opaque; service-owned labels can be localized.
          const sourceKind = system || root.runtimeScope || root.scope === 'global' ? 'label' : 'name';
          const skill = { id, ...details, canonicalPath:canonical, registrations:[registration], path, scope: root.scope, source: system ? 'Системные' : root.source, sourceKind, system, disabled, readOnly, validationError };
          skill.context = measureSkillContext(skill, content);
          if (root.plugin) skill.plugin = root.plugin;
          seen.set(id, skill);
          skills.push(skill);
          entries.push({ skill, canonical, folderName: name, lockfile: root.lockfile });
        }
      } catch (error) { warnings.push(`Не удалось прочитать ${root.path}: ${error.message}`); }
    }
    for (const skill of skills) {
      const statuses = skill.registrations.map(item => item.availability.status);
      skill.availability = statuses.includes('enabled') ? { status:'enabled' }
        : statuses.every(status => status === 'disabled') ? { status:'disabled' }
        : statuses.every(status => status === 'cached') ? skill.registrations[0].availability
        : { status:'unknown', reason:runtime?.reason || 'Доступность всех регистраций не подтверждена.' };
    }
    await annotateSkills(entries, warnings);
    skills.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    return { skills, warnings };
  }

  async resolveSkill({ id, projectId, includePlugins = false, includeSystem = true }) {
    const { skills } = await this.listSkills(projectId, { includePlugins, includeSystem });
    const skill = skills.find(x => x.id === id);
    if (!skill) throw failure('NOT_FOUND', 'Скилл не найден. Обновите список.');
    const canonical = await realpath(skill.path);
    if (this.skillId(canonical, skill.disabled) !== id) throw failure('NOT_FOUND', 'Путь скилла изменился. Обновите список.');
    return { skill, canonical };
  }

  async readSkill(args) {
    const { skill, canonical } = await this.resolveSkill(args);
    const info = await stat(canonical);
    if (info.size > MAX_BYTES) throw failure('TOO_LARGE', 'Файл больше 2 МБ.');
    const content = await readFile(canonical, 'utf8');
    return { ...skill, content, revision: digest(content) };
  }

  async saveSkill(args) {
    const operation = this.queue.then(() => this.save(args));
    this.queue = operation.catch(() => {});
    return operation;
  }

  async manageSkill(action, args) {
    const operation = this.queue.then(() => manageSkill(this, action, args));
    this.queue = operation.catch(() => {});
    return operation;
  }

  async setEnabled(args) {
    const operation = this.queue.then(async () => {
      if (typeof args.enabled !== 'boolean') throw failure('INVALID_STATE', 'Нужно указать enabled: true или false.');
      const { skill, canonical } = await this.resolveSkill(args);
      if (skill.system || skill.scope === 'plugin' || skill.readOnly) throw failure('READ_ONLY', 'Системные и пакетные скиллы доступны только для чтения.');
      if (skill.disabled) throw failure('LEGACY_ARCHIVE', 'Сначала восстановите скилл из disabled-skills.');
      if (!args.registrationPath && skill.registrations.length > 1) throw failure('REGISTRATION_REQUIRED', 'Выберите регистрацию скилла для изменения доступности.');
      const registration = args.registrationPath
        ? skill.registrations.find(item => item.path === args.registrationPath)
        : skill.registrations[0];
      if (!registration) throw failure('NOT_FOUND', 'Регистрация скилла не найдена. Обновите список.');
      if (registration.readOnly || registration.scope === 'plugin') throw failure('READ_ONLY', 'Эта регистрация доступна только для чтения.');
      if (await realpath(registration.path) !== canonical) throw failure('CONFLICT', 'Путь скилла изменился. Обновите список.');
      if (!this.runtime) throw failure('RUNTIME_UNAVAILABLE', 'Подключение к каталогу Codex недоступно.');
      const runtimePath = registration.runtimePath || registration.path;
      if (await realpath(runtimePath) !== canonical) throw failure('CONFLICT', 'Путь Codex изменился. Обновите список.');
      await this.runtime.setEnabled(runtimePath, args.enabled);
      return { skill:await this.readSkill(args) };
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  async close() { await this.runtime?.close?.(); }

  async save({ id, projectId, includePlugins = false, includeSystem = true, revision, content }) {
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_BYTES) throw failure('TOO_LARGE', 'Максимальный размер — 2 МБ.');
    const { skill, canonical } = await this.resolveSkill({ id, projectId, includePlugins, includeSystem });
    if (skill.readOnly) throw failure('READ_ONLY', 'Этот скилл доступен только для чтения.');
    return withSkillLock(this, this.skillId(canonical), async () => {
    const current = await readFile(canonical, 'utf8');
    if (digest(current) !== revision) throw failure('CONFLICT', 'Файл изменился снаружи. Скопируйте свои правки, затем перечитайте файл.');
    metadata(content);
    if (content === current) return { revision, backupPath: null };
    const info = await stat(canonical);
    const backupDir = join(this.stateDir, 'backups', id);
    await mkdir(backupDir, { recursive: true, mode: 0o700 });
    const backupPath = join(backupDir, `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.md`);
    await writeFile(backupPath, current, { mode: 0o600, flag: 'wx' });
    const temporary = join(dirname(canonical), `.SKILL.md.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { flag: 'wx', mode: info.mode & 0o777 });
      if (await realpath(skill.path) !== canonical || digest(await readFile(canonical, 'utf8')) !== revision) {
        throw failure('CONFLICT', 'Файл изменился во время сохранения. Правки не записаны.');
      }
      await rename(temporary, canonical);
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      return { revision: digest(content), backupPath };
    });
  }
}
