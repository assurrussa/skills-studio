import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillStore } from '../src/store.mjs';

const original = '---\nname: sample\ndescription: Пример навыка\n---\n\n# Пример\nТекст.\n';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'skills-studio-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const codexHome = join(home, '.codex');
  const project = join(root, 'project');
  await mkdir(codexHome, { recursive: true });
  await mkdir(project, { recursive: true });
  const registry = join(codexHome, '.codex-global-state.json');
  await writeFile(registry, JSON.stringify({ 'local-projects': { p1: { id: 'p1', name: 'Project', rootPaths: [project] } }, 'project-order': ['p1'] }));
  async function skill(base, name = 'sample') {
    const folder = join(base, name);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'SKILL.md'), original);
    return join(folder, 'SKILL.md');
  }
  return { root, home, codexHome, project, registry, skill, store: new SkillStore({ home, codexHome, stateDir: join(root, 'studio') }) };
}

test('system visibility excludes .system skills and their personal aliases while retaining user skills', async t => {
  const f = await fixture(t);
  await f.skill(join(f.home, '.agents/skills'), 'personal');
  const systemPath = await f.skill(join(f.codexHome, 'skills/.system'), 'builtin');
  await symlink(join(systemPath, '..'), join(f.home, '.agents/skills/system-alias'));
  const hidden = await f.store.listSkills(null, { includeSystem:false });
  assert.equal(hidden.skills.length, 1);
  assert.equal(hidden.skills[0].system, false);
  const shown = await f.store.listSkills(null, { includeSystem:true });
  assert.equal(shown.skills.length, 2);
  const system = shown.skills.find(skill => skill.system);
  assert.ok(system);
  assert.equal(system.readOnly, true);
  assert.equal(system.source, 'Системные');
  await assert.rejects(f.store.readSkill({ id:system.id, includeSystem:false }), { code:'NOT_FOUND' });
  assert.equal((await f.store.readSkill({ id:system.id, includeSystem:true })).readOnly, true);
});

test('reads project names and every root from the Codex registry', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.store.listProjects()).projects, [{ id: 'p1', name: 'Project', roots: [f.project] }]);
});

test('a corrupt registry is visible and does not erase global skills', async t => {
  const f = await fixture(t);
  await f.skill(join(f.home, '.agents/skills'));
  await writeFile(f.registry, '{broken');
  const result = await f.store.listSkills();
  assert.equal(result.skills.length, 1);
  assert.ok(result.warnings.some(x => x.includes('реестр')));
});

test('groups global and project skills and deduplicates symlink aliases', async t => {
  const f = await fixture(t);
  const file = await f.skill(join(f.home, '.agents/skills'));
  await mkdir(join(f.codexHome, 'skills'), { recursive: true });
  await symlink(join(file, '..'), join(f.codexHome, 'skills/alias'));
  await f.skill(join(f.project, '.agents/skills'), 'local');
  const result = await f.store.listSkills('p1');
  assert.deepEqual(result.skills.map(x => x.scope).sort(), ['global', 'local']);
  assert.equal(result.skills.find(x => x.scope === 'global').name, 'sample');
});

test('reads exact UTF-8 bytes and saves with backup and a changed revision', async t => {
  const f = await fixture(t);
  const path = await f.skill(join(f.home, '.agents/skills'));
  const id = (await f.store.listSkills()).skills[0].id;
  const before = await f.store.readSkill({ id });
  assert.equal(before.content, original);
  const changed = original + '\nИзменено 🦙\n';
  const after = await f.store.saveSkill({ id, content: changed, revision: before.revision });
  assert.notEqual(after.revision, before.revision);
  assert.equal(await readFile(path, 'utf8'), changed);
  assert.equal(await readFile(after.backupPath, 'utf8'), original);
  assert.equal((await readdir(join(path, '..'))).filter(n => n.includes('.tmp')).length, 0);
});

test('rejects stale writes and preserves an external edit', async t => {
  const f = await fixture(t);
  const path = await f.skill(join(f.home, '.agents/skills'));
  const id = (await f.store.listSkills()).skills[0].id;
  const before = await f.store.readSkill({ id });
  await writeFile(path, original + 'EXTERNAL');
  await assert.rejects(f.store.saveSkill({ id, content: original + 'MINE', revision: before.revision }), { code: 'CONFLICT' });
  assert.equal(await readFile(path, 'utf8'), original + 'EXTERNAL');
});

test('rejects arbitrary paths and ids without reading other files', async t => {
  const f = await fixture(t);
  await assert.rejects(f.store.readSkill({ id: '../../auth.json' }), { code: 'NOT_FOUND' });
  await assert.rejects(f.store.listSkills('unknown'), { code: 'PROJECT_NOT_FOUND' });
});

test('a changed symlink invalidates a previously opened skill', async t => {
  const f = await fixture(t);
  const one = await f.skill(join(f.root, 'target-one'));
  const two = await f.skill(join(f.root, 'target-two'));
  await mkdir(join(f.home, '.agents/skills'), { recursive: true });
  const alias = join(f.home, '.agents/skills/alias');
  await symlink(join(one, '..'), alias);
  const id = (await f.store.listSkills()).skills[0].id;
  const before = await f.store.readSkill({ id });
  await rm(alias); await symlink(join(two, '..'), alias);
  await assert.rejects(f.store.saveSkill({ id, revision: before.revision, content: original + 'X' }), { code: 'NOT_FOUND' });
  assert.equal(await readFile(two, 'utf8'), original);
});

test('plugin skills are excluded from the catalog and cannot be opened by an old id', async t => {
  const f = await fixture(t);
  const path = await f.skill(join(f.codexHome, 'plugins/cache/test/demo/1.0/skills'));
  await f.skill(join(f.home, '.agents/skills'), 'personal');
  const result = await f.store.listSkills();
  assert.equal(result.skills.length, 1);
  assert.equal(result.skills[0].path, join(f.home, '.agents/skills/personal/SKILL.md'));
  const { createHash } = await import('node:crypto');
  const id = createHash('sha256').update(await realpath(path)).digest('hex');
  await assert.rejects(f.store.readSkill({ id }), { code: 'NOT_FOUND' });
  assert.equal(await readFile(path, 'utf8'), original);
});

test('invalid front matter cannot break an installed skill on save', async t => {
  const f = await fixture(t);
  const path = await f.skill(join(f.home, '.agents/skills'));
  const id = (await f.store.listSkills()).skills[0].id;
  const before = await f.store.readSkill({ id });
  await assert.rejects(f.store.saveSkill({ id, revision: before.revision, content: '# No front matter' }), { code: 'INVALID_SKILL' });
  assert.equal(await readFile(path, 'utf8'), original);
});

test('two concurrent saves with the same revision cannot overwrite each other', async t => {
  const f = await fixture(t);
  const path = await f.skill(join(f.home, '.agents/skills'));
  const id = (await f.store.listSkills()).skills[0].id;
  const before = await f.store.readSkill({ id });
  const results = await Promise.allSettled(['A', 'B'].map(x => f.store.saveSkill({ id, revision: before.revision, content: original + x })));
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.find(x => x.status === 'rejected').reason.code, 'CONFLICT');
  assert.ok([original + 'A', original + 'B'].includes(await readFile(path, 'utf8')));
});

test('personal and project aliases to plugin skills are excluded', async t => {
  const f = await fixture(t);
  const path = await f.skill(join(f.codexHome, 'plugins/cache/test/demo/1.0/skills'));
  for (const root of [join(f.home, '.agents/skills'), join(f.project, '.agents/skills')]) {
    await mkdir(root, { recursive: true });
    await symlink(join(path, '..'), join(root, 'alias'));
  }
  assert.deepEqual((await f.store.listSkills('p1')).skills, []);
});

test('a similarly named directory outside plugins remains visible', async t => {
  const f = await fixture(t);
  const path = await f.skill(join(f.codexHome, 'plugins-extra/skills'));
  await mkdir(join(f.home, '.agents/skills'), { recursive: true });
  await symlink(join(path, '..'), join(f.home, '.agents/skills/alias'));
  assert.equal((await f.store.listSkills()).skills.length, 1);
});

test('plugin exclusions follow a custom Codex home and its symlink target', async t => {
  const f = await fixture(t);
  const custom = join(f.root, 'custom-codex-home');
  await mkdir(custom, { recursive: true });
  await writeFile(join(custom, '.codex-global-state.json'), JSON.stringify({ 'local-projects': {} }));
  const outside = join(f.root, 'relocated-plugin-storage');
  const path = await f.skill(join(outside, 'cache/test/demo/1.0/skills'));
  await symlink(outside, join(custom, 'plugins'));
  await mkdir(join(f.home, '.agents/skills'), { recursive: true });
  await symlink(join(path, '..'), join(f.home, '.agents/skills/alias'));
  await f.skill(join(f.home, '.agents/skills'), 'personal');
  const store = new SkillStore({ home: f.home, codexHome: custom });
  const result = await store.listSkills();
  assert.equal(result.skills.length, 1);
  assert.equal(result.skills[0].path, join(f.home, '.agents/skills/personal/SKILL.md'));
});

test('separate server instances cannot overwrite the same revision simultaneously', async t => {
  const f = await fixture(t);
  await f.skill(join(f.home, '.agents/skills'));
  const id = (await f.store.listSkills()).skills[0].id;
  const before = await f.store.readSkill({ id });
  const other = new SkillStore({ home:f.home,codexHome:f.codexHome,stateDir:join(f.root,'studio') });
  const results = await Promise.allSettled([f.store,other].map((store,i) => store.saveSkill({id,revision:before.revision,content:original+i})));
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.ok(['BUSY','CONFLICT'].includes(results.find(x=>x.status==='rejected').reason.code));
});

// Badges depend on installation scope and the Git index, not the display name or repository location alone.
test('AgentSkill badges use the home lock for global skills and the project lock for local skills', async t => {
  const f = await fixture(t);
  await f.skill(join(f.home, '.agents/skills'), 'shared');
  await f.skill(join(f.project, '.agents/skills'), 'shared');
  await f.skill(join(f.project, '.agents/skills'), 'local-cli');
  await f.skill(join(f.home, '.agents/skills'), 'manual');
  await writeFile(join(f.home, 'skills.lock.toml'), `lockfile_version = 1\n[[skills]]\nname = "shared"\nid = "home-id"\nsource = "example.test/team/skills"\n`);
  await writeFile(join(f.project, 'skills.lock.toml'), `lockfile_version = 1\n[[skills]]\nname = "local-cli"\nid = "local-id"\n`);
  const {skills} = await f.store.listSkills('p1');
  const global = skills.find(s => s.path === join(f.home, '.agents/skills/shared/SKILL.md'));
  const local = skills.find(s => s.path === join(f.project, '.agents/skills/local-cli/SKILL.md'));
  assert.equal(global.agentSkill?.id, 'home-id');
  assert.equal(global.agentSkill?.lockfile, join(f.home, 'skills.lock.toml'));
  assert.equal(local.agentSkill?.id, 'local-id');
  assert.equal(local.agentSkill?.lockfile, join(f.project, 'skills.lock.toml'));
  assert.equal(skills.find(s => s.path === join(f.project, '.agents/skills/shared/SKILL.md')).agentSkill, null);
  assert.equal(skills.find(s => s.path === join(f.home, '.agents/skills/manual/SKILL.md')).agentSkill, null);
});

test('a malformed AgentSkill lock is reported without hiding installed skills', async t => {
  const f = await fixture(t);
  await f.skill(join(f.home, '.agents/skills'));
  await writeFile(join(f.home, 'skills.lock.toml'), '[[skills]\nname = "sample"');
  const result = await f.store.listSkills();
  assert.equal(result.skills.length, 1);
  assert.equal(result.skills[0].agentSkill, null);
  assert.ok(result.warnings.some(w => w.includes('skills.lock.toml')));
});

async function git(cwd, ...args) {
  const {execFile} = await import('node:child_process');
  const {promisify} = await import('node:util');
  return promisify(execFile)('git', ['-C', cwd, ...args], {env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}});
}

test('Git badges include staged SKILL.md and exclude untracked or ignored skills', async t => {
  const f = await fixture(t);
  await git(f.project, 'init', '--quiet');
  const tracked = await f.skill(join(f.project, '.agents/skills'), 'tracked');
  const manual = await f.skill(join(f.project, '.agents/skills'), 'manual');
  const ignored = await f.skill(join(f.project, '.agents/skills'), 'ignored');
  await writeFile(join(f.project, '.gitignore'), '.agents/skills/ignored/\n');
  await writeFile(join(manual, '../README.md'), 'Tracked helper, untracked SKILL.md');
  await git(f.project, 'add', '--', '.agents/skills/tracked/SKILL.md', '.agents/skills/manual/README.md');
  await writeFile(join(f.project, 'skills.lock.toml'), 'lockfile_version = 1\n[[skills]]\nname = "tracked"\n');
  const {skills} = await f.store.listSkills('p1');
  assert.equal(skills.find(s=>s.path===tracked).git?.trackedPath, '.agents/skills/tracked/SKILL.md');
  assert.ok(skills.find(s=>s.path===tracked).agentSkill);
  assert.equal(skills.find(s=>s.path===manual).git, null);
  assert.equal(skills.find(s=>s.path===ignored).git, null);
  // A removed index entry loses the badge even while the file remains on disk.
  await git(f.project, 'rm', '--cached', '--', '.agents/skills/tracked/SKILL.md');
  assert.equal((await f.store.listSkills('p1')).skills.find(s=>s.path===tracked).git, null);
});

test('Git badges recognize a tracked skill behind a personal symlink', async t => {
  const f = await fixture(t);
  const repository = join(f.root, 'skill-repo');
  const path = await f.skill(repository, 'shared');
  await git(repository, 'init', '--quiet');
  await git(repository, 'add', '--', 'shared/SKILL.md');
  await mkdir(join(f.home, '.agents/skills'), {recursive:true});
  await symlink(join(path, '..'), join(f.home, '.agents/skills/alias'));
  const {skills} = await f.store.listSkills();
  assert.equal(skills[0].git?.trackedPath, 'shared/SKILL.md');
});

test('Git badges recognize a tracked directory symlink without assuming its target is tracked', async t => {
  const f = await fixture(t);
  await git(f.project, 'init', '--quiet');
  const path = await f.skill(join(f.root, 'untracked-skills'));
  const root = join(f.project, '.agents/skills');
  await mkdir(root, {recursive:true});
  await symlink(join(path,'..'), join(root,'alias'));
  await git(f.project, 'add', '--', '.agents/skills/alias');
  const {skills} = await f.store.listSkills('p1');
  assert.equal(skills[0].git?.trackedPath, '.agents/skills/alias');
});

test('plugin skills are opt-in, grouped by plugin and remain read-only', async t => {
  const f = await fixture(t);
  await f.skill(join(f.home,'.agents/skills'),'personal');
  for(const [plugin,version,display] of [['alpha','1.0','Alpha Plugin'],['alpha','2.0','Alpha Plugin'],['beta','1.0','Beta Plugin']]) {
    const root=join(f.codexHome,'plugins/cache/test',plugin,version);
    await f.skill(join(root,'skills'),plugin+'-skill');
    await mkdir(join(root,'.codex-plugin'),{recursive:true});
    await writeFile(join(root,'.codex-plugin/plugin.json'),JSON.stringify({name:plugin,version,interface:{displayName:display}}));
  }
  assert.equal((await f.store.listSkills()).skills.length,1);
  const result=await f.store.listSkills(null,{includePlugins:true});
  assert.equal(result.skills.length,3);
  const plugins=result.skills.filter(s=>s.scope==='plugin');
  assert.deepEqual(plugins.map(s=>s.plugin.name).sort(),['Alpha Plugin','Beta Plugin']);
  const alpha=plugins.find(s=>s.plugin.name==='Alpha Plugin');
  assert.equal(alpha.plugin.version,'2.0');
  assert.equal(alpha.readOnly,true);
  const opened=await f.store.readSkill({id:alpha.id,includePlugins:true});
  assert.equal(opened.content,original);
  await assert.rejects(f.store.saveSkill({id:alpha.id,includePlugins:true,revision:opened.revision,content:original+'X'}),{code:'READ_ONLY'});
  await assert.rejects(f.store.readSkill({id:alpha.id}),{code:'NOT_FOUND'});
});
