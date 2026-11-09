import { chmod, cp, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, rmdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseDocument } from 'yaml';
import { withSkillLock } from './locking.mjs';

const failure = (code, message) => Object.assign(new Error(message), { code });
const digest = content => createHash('sha256').update(content).digest('hex');
const inside = (path, root) => path === root || path.startsWith(root + sep);

function renamedContent(content, name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 200 || /[\r\n\0]/.test(name)) throw failure('INVALID_NAME', 'Введите название длиной от 1 до 200 символов без переноса строки.');
  const front = content.match(/^(\uFEFF?---)(\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/);
  if (!front) throw failure('INVALID_SKILL', 'Для переименования нужен YAML-блок с name и description.');
  const document = parseDocument(front[3], { uniqueKeys:true });
  if (document.errors.length) throw failure('INVALID_SKILL', 'Сначала исправьте YAML в SKILL.md.');
  document.set('name', name.trim());
  const yaml = document.toString({ lineWidth:0 }).replace(/\n$/, '').replaceAll('\n', front[2]);
  return front[1] + front[2] + yaml + front[4] + content.slice(front[0].length);
}

async function canonicalCandidate(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalCandidate(parent), basename(path));
  }
}

async function destinationRoot(store, skill, projectId, scope, copy, disabled, stateChange) {
  if (scope === 'local' && !projectId) throw failure('PROJECT_REQUIRED', 'Для локального скилла выберите проект.');
  const { roots } = await store.roots(projectId);
  const currentRoot = dirname(dirname(skill.path));
  const sibling = join(dirname(currentRoot), disabled ? 'disabled-skills' : 'skills');
  const candidates = roots.filter(item => item.scope === scope && Boolean(item.disabled) === disabled && !item.readOnly);
  const root = stateChange ? candidates.find(item => item.path === sibling)
    : copy && !skill.readOnly && skill.scope === scope ? candidates.find(item => item.path === currentRoot)
    : candidates[0];
  if (!root) throw failure('DEST_NOT_FOUND', 'Не удалось выбрать папку назначения.');
  const candidate = await canonicalCandidate(root.path);
  for (const protectedPath of [join(store.codexHome, 'plugins'), join(store.codexHome, 'skills/.system')]) {
    if (inside(candidate, await canonicalCandidate(protectedPath))) throw failure('READ_ONLY', 'В папку системных или пакетных скиллов нельзя записывать.');
  }
  await mkdir(root.path, { recursive:true });
  const canonical = await realpath(root.path);
  if (canonical !== candidate) throw failure('DEST_CHANGED', 'Папка назначения изменилась. Повторите действие.');
  return canonical;
}

async function reserveDestination(root, folderName, copy) {
  for (let number = 1; number < 10000; number++) {
    const name = copy ? `${folderName}-copy${number === 1 ? '' : '-' + number}` : folderName;
    const path = join(root, name);
    try { await mkdir(path); return { path, info:await lstat(path) }; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!copy) throw failure('DEST_EXISTS', 'В месте назначения уже есть папка с таким именем. Исходный скилл не изменён.');
    }
  }
  throw failure('DEST_EXISTS', 'Не удалось выбрать свободное имя папки для копии.');
}

async function copyFolder(source, destination) {
  let bytes = 0, entries = 0;
  await cp(source, destination, {
    recursive:true, dereference:false, verbatimSymlinks:true, force:false, errorOnExist:true,
    filter:async path => {
      const info = await lstat(path);
      bytes += info.isFile() ? info.size : 0;
      if (++entries > 10000 || bytes > 100 * 1024 * 1024) throw failure('TOO_LARGE', 'Папка скилла превышает 100 МБ или 10 000 файлов.');
      return true;
    },
  });
  await makeWritable(destination);
  async function rewriteLinks(from, to) {
    const info = await lstat(from);
    if (info.isSymbolicLink()) {
      const target = resolve(dirname(from), await readlink(from));
      const adjusted = inside(target, source) ? relative(dirname(to), join(destination, relative(source, target))) || '.' : target;
      await unlink(to); await symlink(adjusted, to);
    } else if (info.isDirectory()) for (const name of await readdir(from)) await rewriteLinks(join(from, name), join(to, name));
  }
  await rewriteLinks(source, destination);
}

async function makeWritable(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return;
  await chmod(path, (info.mode & 0o777) | (info.isDirectory() ? 0o700 : 0o600));
  if (info.isDirectory()) for (const name of await readdir(path)) await makeWritable(join(path, name));
}

async function moveEntry(source, target) {
  try { await rename(source, target); }
  catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await copyFolder(source, target);
    await rm(source, { recursive:true });
  }
}

async function archiveEntry(store, source) {
  const container = join(store.stateDir, 'deleted', randomUUID());
  const entry = join(container, basename(source));
  const temporary = join(dirname(source), `.skills-studio-deleted-${randomUUID()}`);
  await mkdir(container, { recursive:true, mode:0o700 });
  await writeFile(join(container, 'origin.json'), JSON.stringify({ path:source, archivedAt:new Date().toISOString() }), { flag:'wx', mode:0o600 });
  await rename(source, temporary);
  try {
    if ((await lstat(temporary)).isSymbolicLink()) {
      // Archive the link itself, preserving its target after changing folders.
      await symlink(resolve(dirname(temporary), await readlink(temporary)), entry);
      await unlink(temporary);
    } else await moveEntry(temporary, entry);
  } catch (error) {
    try { await rename(temporary, source); }
    catch { throw failure('RECOVERY_REQUIRED', `Не удалось завершить действие. Папка сохранена: ${temporary}. Резервная копия: ${container}`); }
    await rm(container, { recursive:true, force:true });
    throw error;
  }
  return { entry, container, source };
}

async function restoreArchive(archive) {
  try { await lstat(archive.source); throw failure('RECOVERY_REQUIRED', `Путь занят. Исходный скилл сохранён: ${archive.entry}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await moveEntry(archive.entry, archive.source);
  await rm(archive.container, { recursive:true, force:true });
}

export async function manageSkill(store, action, args) {
  if (!['rename','copy','move','delete','enable','disable'].includes(action)) throw failure('INVALID_ACTION', 'Неизвестное действие.');
  const stateChange = action === 'enable' || action === 'disable';
  const before = await store.readSkill(args);
  if (before.revision !== args.revision) throw failure('CONFLICT', 'Файл изменился снаружи. Перечитайте скилл перед действием.');
  if (before.readOnly && action !== 'copy') throw failure('READ_ONLY', 'Этот скилл доступен только для чтения. Можно сделать личную копию.');
  if (stateChange && before.disabled !== (action === 'enable')) throw failure('INVALID_STATE', 'Состояние скилла уже изменилось. Обновите список.');
  if (action === 'rename') {
    const saved = await store.save({ ...args, content:renamedContent(before.content, args.name) });
    return { skill:await store.readSkill(args), backupPath:saved.backupPath };
  }
  return withSkillLock(store, store.skillId(await realpath(before.path)), async () => {
    const { skill, canonical } = await store.resolveSkill(args);
    if (skill.readOnly && action !== 'copy') throw failure('READ_ONLY', 'Этот скилл доступен только для чтения.');
    if (stateChange && skill.disabled !== (action === 'enable')) throw failure('INVALID_STATE', 'Состояние скилла уже изменилось. Обновите список.');
    const checkSource = async () => {
      if (await realpath(skill.path) !== canonical || digest(await readFile(canonical)) !== args.revision) throw failure('CONFLICT', 'Скилл изменился во время действия. Повторите после обновления списка.');
    };
    await checkSource();
    if (action === 'delete') {
      const archive = await archiveEntry(store, dirname(skill.path));
      return { skill:null, backupPath:archive.entry };
    }
    const copy = action === 'copy';
    const scope = stateChange ? skill.scope : copy ? (skill.scope === 'local' ? 'local' : 'global') : args.scope;
    const disabled = stateChange ? action === 'disable' : Boolean(skill.disabled);
    if (!['global','local'].includes(scope) || !copy && !stateChange && scope === skill.scope) throw failure('INVALID_SCOPE', 'Выберите другой раздел: локальный или глобальный.');
    const root = await destinationRoot(store, skill, args.projectId, scope, copy, disabled, stateChange);
    const source = dirname(skill.path), sourceDirectory = await realpath(source);
    // A registered destination inside the source would recursively copy itself.
    if (inside(await realpath(root), sourceDirectory)) throw failure('INVALID_DEST', 'Нельзя копировать папку скилла внутрь неё самой.');
    const reserved = await reserveDestination(root, basename(source), copy);
    const staging = join(root, `.skills-studio-copy-${randomUUID()}`);
    const preserveAlias = stateChange && (await lstat(source)).isSymbolicLink();
    let archive, published = false;
    try {
      if (preserveAlias) {
        const target = resolve(dirname(source), await readlink(source));
        await symlink(relative(root, target) || '.', staging);
      } else {
        await copyFolder(sourceDirectory, staging);
        if (!stateChange) {
          const file = join(staging, 'SKILL.md');
          await unlink(file);
          await writeFile(file, copy ? renamedContent(before.content, args.name) : before.content, { flag:'wx', mode:((await stat(canonical)).mode & 0o777) | 0o600 });
        }
      }
      await checkSource();
      const targetInfo = await lstat(reserved.path);
      if (!targetInfo.isDirectory() || targetInfo.ino !== reserved.info.ino || targetInfo.dev !== reserved.info.dev || (await readdir(reserved.path)).length) throw failure('DEST_CHANGED', 'Папка назначения изменилась во время действия.');
      if (!copy) archive = await archiveEntry(store, source);
      try {
        if (preserveAlias) {
          await rmdir(reserved.path);
          // symlink() rejects an occupied path instead of replacing another entry.
          await symlink(await readlink(staging), reserved.path);
        } else await rename(staging, reserved.path);
        published = true;
      }
      catch (error) { if (archive) await restoreArchive(archive); throw error; }
      const id = store.skillId(await realpath(join(reserved.path, 'SKILL.md')), disabled);
      return { skill:await store.readSkill({ ...args, id }), backupPath:archive?.entry || null };
    } finally {
      await makeWritable(staging).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await rm(staging, { recursive:true, force:true });
      if (!published) await rmdir(reserved.path).catch(error => { if (!['ENOENT','ENOTEMPTY','ENOTDIR'].includes(error.code)) throw error; });
    }
  });
}
