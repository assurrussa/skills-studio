import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse } from 'smol-toml';

const execute = promisify(execFile);
const git = (directory, ...args) => execute('git', ['--literal-pathspecs', '-C', directory, ...args], {
  encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024,
  env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
});

// A fresh scan reads both the lockfiles and the current Git index. No metadata is written.
export async function annotateSkills(entries, warnings) {
  const locks = new Map(), repositories = new Map(), groups = new Map();
  const warningSet = new Set();

  function lockfile(path) {
    if (!locks.has(path)) locks.set(path, (async () => {
      try {
        const lock = parse(await readFile(path, 'utf8'));
        if (lock.lockfile_version !== undefined && lock.lockfile_version !== 1) throw new Error('неподдерживаемая версия lock-файла');
        if (lock.skills !== undefined && !Array.isArray(lock.skills)) throw new Error('ожидался список skills');
        return (lock.skills || []).filter(value => value && typeof value.name === 'string');
      } catch (error) {
        if (error.code !== 'ENOENT') warningSet.add(`Не удалось прочитать ${path}: ${error.message}`);
        return [];
      }
    })());
    return locks.get(path);
  }

  function repository(directory) {
    if (!repositories.has(directory)) repositories.set(directory, (async () => {
      try {
        await stat(join(directory, '.git'));
        const { stdout } = await git(directory, 'rev-parse', '--show-toplevel');
        return await realpath(stdout.trim());
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
          warningSet.add(`Не удалось проверить Git в ${directory}: ${error.message}`);
          return null;
        }
        const parent = dirname(directory);
        return parent === directory ? null : repository(parent);
      }
    })());
    return repositories.get(directory);
  }

  await Promise.all(entries.map(async ({ skill, canonical, folderName, lockfile: lockPath }) => {
    skill.agentSkill = null;
    skill.git = null;
    if (lockPath) {
      const names = [folderName, basename(dirname(canonical))];
      const record = (await lockfile(lockPath)).find(value => names.includes(value.name));
      if (record) skill.agentSkill = {
        name: record.name, lockfile: lockPath,
        ...Object.fromEntries(['id', 'source', 'slug'].filter(key => typeof record[key] === 'string').map(key => [key, record[key]])),
      };
    }
    // Keep both the actual file and a potential tracked link to the skill directory.
    const candidates = new Set();
    for (const path of [canonical, skill.path, dirname(skill.path)]) {
      try { candidates.add(join(await realpath(dirname(path)), basename(path))); }
      catch (error) { warningSet.add(`Не удалось проверить Git для ${path}: ${error.message}`); }
    }
    for (const path of candidates) {
      const root = await repository(dirname(path));
      if (!root) continue;
      const trackedPath = relative(root, path).split(sep).join('/');
      if (isAbsolute(trackedPath) || trackedPath === '..' || trackedPath.startsWith('../')) continue;
      if (!groups.has(root)) groups.set(root, new Map());
      const files = groups.get(root);
      if (!files.has(trackedPath)) files.set(trackedPath, new Set());
      files.get(trackedPath).add(skill);
    }
  }));

  await Promise.all([...groups].map(async ([root, files]) => {
    try {
      const { stdout } = await git(root, 'ls-files', '-z', '--', ...files.keys());
      for (const trackedPath of stdout.split('\0').filter(Boolean)) {
        // A tracked README inside the folder does not make an untracked SKILL.md tracked.
        for (const skill of files.get(trackedPath) || []) skill.git ||= { repository: root, trackedPath };
      }
    } catch (error) { warningSet.add(`Не удалось прочитать индекс Git в ${root}: ${error.message}`); }
  }));
  warnings.push(...warningSet);
}
