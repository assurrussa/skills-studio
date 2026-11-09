import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, lstat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SkillStore } from '../src/store.mjs';

const content = '---\n# Keep this comment\nname: sample\ndescription: Example\n---\n\n# Body\nText.\n';
async function fixture(t, { system = false, linked = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'skills-studio-actions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), codexHome = join(home, '.codex'), project = join(root, 'project');
  const source = join(system ? join(codexHome, 'skills/.system') : join(home, '.agents/skills'), 'sample');
  const actual = linked ? join(root, 'external/sample') : source;
  await mkdir(join(actual, 'scripts'), { recursive: true });
  await writeFile(join(actual, 'SKILL.md'), content);
  await writeFile(join(actual, 'scripts/tool.sh'), '#!/bin/sh\necho example\n', { mode: 0o755 });
  await mkdir(codexHome, { recursive: true }); await mkdir(project, { recursive: true });
  if (linked) { await mkdir(dirname(source), { recursive: true }); await symlink(actual, source); }
  await writeFile(join(codexHome, '.codex-global-state.json'), JSON.stringify({ 'local-projects': { p: { name:'Project', rootPaths:[project] } } }));
  const store = new SkillStore({ home, codexHome, stateDir: join(root, 'state') });
  const skill = await store.readSkill({ id: (await store.listSkills('p')).skills[0].id, projectId: 'p' });
  return { root, home, project, source, actual, store, args:{ id:skill.id, revision:skill.revision, projectId:'p' } };
}

test('rename changes the displayed YAML name while preserving body, comments and backup', async t => {
  const f = await fixture(t);
  assert.equal(typeof f.store.manageSkill, 'function');
  const result = await f.store.manageSkill('rename', { ...f.args, name:'Новое имя' });
  assert.equal(result.skill.name, 'Новое имя');
  assert.equal(result.skill.path, join(f.source, 'SKILL.md'));
  assert.match(result.skill.content, /# Keep this comment/);
  assert.ok(result.skill.content.endsWith('\n# Body\nText.\n'));
  assert.equal(await readFile(result.backupPath, 'utf8'), content);
});

test('copy includes resources, creates an independent file and never overwrites an existing copy', async t => {
  const f = await fixture(t, { linked:true });
  assert.equal(typeof f.store.manageSkill, 'function');
  const first = await f.store.manageSkill('copy', { ...f.args, name:'First copy' });
  const second = await f.store.manageSkill('copy', { ...f.args, name:'Second copy' });
  assert.notEqual(first.skill.id, f.args.id);
  assert.notEqual(first.skill.path, second.skill.path);
  assert.equal((await lstat(first.skill.path)).isSymbolicLink(), false);
  assert.equal(await readFile(join(dirname(first.skill.path), 'scripts/tool.sh'), 'utf8'), '#!/bin/sh\necho example\n');
  assert.equal(await readFile(join(f.actual, 'SKILL.md'), 'utf8'), content);
  assert.equal((await f.store.readSkill({ id:first.skill.id, projectId:'p' })).name, 'First copy');
});

test('move switches scope with the whole folder and rejects a target-name collision', async t => {
  const f = await fixture(t);
  assert.equal(typeof f.store.manageSkill, 'function');
  await symlink('scripts/tool.sh', join(f.source, 'tool-link'));
  const moved = await f.store.manageSkill('move', { ...f.args, scope:'local' });
  assert.equal(moved.skill.scope, 'local');
  assert.equal(moved.skill.path, join(f.project, '.agents/skills/sample/SKILL.md'));
  await assert.rejects(lstat(f.source), { code:'ENOENT' });
  assert.equal(await readFile(join(dirname(moved.skill.path), 'scripts/tool.sh'), 'utf8'), '#!/bin/sh\necho example\n');
  assert.equal(await readFile(join(dirname(moved.skill.path), 'tool-link'), 'utf8'), '#!/bin/sh\necho example\n');
  await mkdir(f.source, { recursive:true }); await writeFile(join(f.source, 'SKILL.md'), content + 'Existing');
  await assert.rejects(f.store.manageSkill('move', { id:moved.skill.id, revision:moved.skill.revision, projectId:'p', scope:'global' }), { code:'DEST_EXISTS' });
  assert.equal(await readFile(join(f.source, 'SKILL.md'), 'utf8'), content + 'Existing');
  assert.equal(await readFile(moved.skill.path, 'utf8'), content);
});

test('delete archives the whole skill and deleting an alias preserves its external target', async t => {
  const f = await fixture(t);
  assert.equal(typeof f.store.manageSkill, 'function');
  const deleted = await f.store.manageSkill('delete', f.args);
  await assert.rejects(lstat(f.source), { code:'ENOENT' });
  assert.equal(await readFile(join(deleted.backupPath, 'SKILL.md'), 'utf8'), content);
  assert.equal((await f.store.listSkills('p')).skills.length, 0);
  const linked = await fixture(t, { linked:true });
  const archived = await linked.store.manageSkill('delete', linked.args);
  await assert.rejects(lstat(linked.source), { code:'ENOENT' });
  assert.equal(await readFile(join(linked.actual, 'SKILL.md'), 'utf8'), content);
  assert.equal(await readFile(join(archived.backupPath, 'SKILL.md'), 'utf8'), content);
});

test('read-only skills allow copies but reject changes to the original, including its enabled state', async t => {
  const f = await fixture(t, { system:true });
  assert.equal(typeof f.store.manageSkill, 'function');
  for (const action of ['rename','move','delete','disable','enable']) await assert.rejects(f.store.manageSkill(action, { ...f.args, name:'Changed', scope:'local' }), { code:'READ_ONLY' });
  const copied = await f.store.manageSkill('copy', { ...f.args, name:'Personal copy' });
  assert.equal(copied.skill.scope, 'global'); assert.equal(copied.skill.readOnly, false);
  assert.equal(await readFile(join(f.source, 'SKILL.md'), 'utf8'), content);
});

test('stale revisions and a missing project reject actions without touching the source', async t => {
  const f = await fixture(t);
  assert.equal(typeof f.store.manageSkill, 'function');
  await assert.rejects(f.store.manageSkill('move', { ...f.args, projectId:null, scope:'local' }), { code:'PROJECT_REQUIRED' });
  await writeFile(join(f.source, 'SKILL.md'), content + 'External change');
  for (const action of ['rename','copy','move','delete','enable','disable']) await assert.rejects(f.store.manageSkill(action, { ...f.args, name:'Changed', scope:'local' }), { code:'CONFLICT' });
  assert.equal(await readFile(join(f.source, 'SKILL.md'), 'utf8'), content + 'External change');
});

test('a copied SKILL.md file link becomes independent and protected destination aliases are rejected', async t => {
  const f = await fixture(t);
  const external = join(f.root, 'external.md');
  await writeFile(external, content); await unlink(join(f.source, 'SKILL.md')); await symlink(external, join(f.source, 'SKILL.md'));
  const source = await f.store.readSkill({ id:(await f.store.listSkills('p')).skills[0].id, projectId:'p' });
  const args = { id:source.id, revision:source.revision, projectId:'p' };
  const copy = await f.store.manageSkill('copy', { ...args, name:'Independent' });
  assert.equal((await lstat(copy.skill.path)).isSymbolicLink(), false);
  assert.equal(await readFile(external, 'utf8'), content);
  const plugins = join(f.home, '.codex/plugins');
  await mkdir(plugins, { recursive:true }); await mkdir(join(f.project,'.agents'), {recursive:true});
  await symlink(plugins, join(f.project,'.agents/skills'));
  await assert.rejects(f.store.manageSkill('move', { ...args, scope:'local' }), { code:'READ_ONLY' });
  assert.equal(await readFile(join(f.source,'SKILL.md'),'utf8'), content);
});
