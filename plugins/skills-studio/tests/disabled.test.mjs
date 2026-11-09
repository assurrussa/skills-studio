import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, symlink, realpath, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { SkillStore } from '../src/store.mjs';

const text = '---\nname: Demo\ndescription: Example\n---\n# Body\n';
async function fixture(t, location = 'global-agents') {
  const root = await mkdtemp(join(tmpdir(), 'skills-studio-disabled-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const home = join(root,'home'), codexHome = join(root,'custom-codex'), project = join(root,'project'), second = join(root,'second');
  await mkdir(codexHome, {recursive:true}); await mkdir(project, {recursive:true}); await mkdir(second, {recursive:true});
  await writeFile(join(codexHome,'.codex-global-state.json'), JSON.stringify({'local-projects':{p:{name:'Project',rootPaths:[project,second]}}}));
  const provider = {
    'global-agents':join(home,'.agents'), 'global-codex':codexHome,
    'local-agents':join(project,'.agents'), 'local-codex':join(project,'.codex'),
    'second-root':join(second,'.codex'),
  }[location];
  const source = join(provider,'skills/demo'), disabled = join(provider,'disabled-skills/demo');
  await mkdir(join(source,'assets'), {recursive:true});
  await writeFile(join(source,'SKILL.md'),text); await writeFile(join(source,'assets/data.txt'),'Resource');
  const store = new SkillStore({home,codexHome,stateDir:join(root,'state')});
  const skill = (await store.listSkills('p')).skills[0];
  const args = {id:skill.id,revision:(await store.readSkill({id:skill.id,projectId:'p'})).revision,projectId:'p'};
  return {root,home,codexHome,project,provider,source,disabled,store,args};
}

for (const location of ['global-agents','global-codex','local-agents','local-codex','second-root']) {
  test(`disable and enable preserve the provider, scope, content and resources: ${location}`, async t => {
    const f = await fixture(t, location);
    await symlink('assets/data.txt',join(f.source,'resource-link'));
    const off = await f.store.manageSkill('disable',f.args);
    assert.equal(off.skill.disabled,true);
    assert.equal(off.skill.scope,location.startsWith('global')?'global':'local');
    assert.equal(off.skill.path,join(f.disabled,'SKILL.md'));
    await assert.rejects(lstat(f.source),{code:'ENOENT'});
    assert.equal(await readFile(join(f.disabled,'resource-link'),'utf8'),'Resource');
    assert.equal(await readFile(off.backupPath + '/SKILL.md','utf8'),text);
    assert.equal((await f.store.listSkills('p')).skills[0].disabled,true);
    const on = await f.store.manageSkill('enable',{id:off.skill.id,revision:off.skill.revision,projectId:'p'});
    assert.equal(on.skill.disabled,false);
    assert.equal(on.skill.path,join(f.source,'SKILL.md'));
    assert.equal(on.skill.content,text);
    await assert.rejects(lstat(f.disabled),{code:'ENOENT'});
  });
}

test('existing disabled folders are discovered without metadata and remain editable with AgentSkill badges', async t => {
  const f = await fixture(t);
  await mkdir(dirname(f.disabled),{recursive:true}); await rename(f.source,f.disabled);
  await writeFile(join(f.home,'skills.lock.toml'),'lockfile_version = 1\n[[skills]]\nname = "demo"\nsource = "team/skills"\n');
  const skill = (await f.store.listSkills('p')).skills[0];
  assert.equal(skill.disabled,true); assert.equal(skill.readOnly,false); assert.equal(skill.agentSkill.source,'team/skills');
  const opened = await f.store.readSkill({id:skill.id,projectId:'p'});
  await f.store.saveSkill({id:skill.id,revision:opened.revision,projectId:'p',content:text+'Changed\n'});
  assert.equal(await readFile(join(f.disabled,'SKILL.md'),'utf8'),text+'Changed\n');
});

test('state changes reject collisions and stale state without overwriting either skill', async t => {
  const f = await fixture(t);
  await mkdir(f.disabled,{recursive:true}); await writeFile(join(f.disabled,'SKILL.md'),text+'Other\n');
  await assert.rejects(f.store.manageSkill('disable',f.args),{code:'DEST_EXISTS'});
  assert.equal(await readFile(join(f.source,'SKILL.md'),'utf8'),text);
  assert.equal(await readFile(join(f.disabled,'SKILL.md'),'utf8'),text+'Other\n');
  await assert.rejects(f.store.manageSkill('enable',f.args),{code:'INVALID_STATE'});
  const other = (await f.store.listSkills('p')).skills.find(skill=>skill.disabled);
  const opened = await f.store.readSkill({id:other.id,projectId:'p'});
  await assert.rejects(f.store.manageSkill('enable',{id:opened.id,revision:opened.revision,projectId:'p'}),{code:'DEST_EXISTS'});
});

test('copying and changing scope preserve the disabled state', async t => {
  const f = await fixture(t,'local-codex');
  const off = await f.store.manageSkill('disable',f.args);
  const args = {id:off.skill.id,revision:off.skill.revision,projectId:'p'};
  const copied = await f.store.manageSkill('copy',{...args,name:'Copy'});
  assert.equal(copied.skill.disabled,true);
  assert.equal(copied.skill.path,join(f.project,'.codex/disabled-skills/demo-copy/SKILL.md'));
  const moved = await f.store.manageSkill('move',{...args,scope:'global'});
  assert.equal(moved.skill.disabled,true);
  assert.equal(moved.skill.scope,'global');
  assert.equal(moved.skill.path,join(f.home,'.agents/disabled-skills/demo/SKILL.md'));
});

test('relative directory aliases keep their targets and disabled aliases do not hide enabled registrations', async t => {
  const f = await fixture(t);
  const external = join(f.root,'external'); await rename(f.source,external);
  await symlink(relative(dirname(f.source),external),f.source);
  await mkdir(join(f.codexHome,'skills'),{recursive:true}); await symlink(external,join(f.codexHome,'skills/other'));
  const opened = await f.store.readSkill({id:(await f.store.listSkills('p')).skills[0].id,projectId:'p'});
  const off = await f.store.manageSkill('disable',{id:opened.id,revision:opened.revision,projectId:'p'});
  assert.equal((await lstat(f.disabled)).isSymbolicLink(),true);
  assert.equal(await realpath(f.disabled),await realpath(external));
  const states = (await f.store.listSkills('p')).skills.map(skill=>skill.disabled).sort();
  assert.deepEqual(states,[false,true]);
  assert.equal((await f.store.readSkill({id:off.skill.id,projectId:'p'})).disabled,true);
  const on = await f.store.manageSkill('enable',{id:off.skill.id,revision:off.skill.revision,projectId:'p'});
  assert.equal(on.skill.disabled,false); assert.equal(await realpath(f.source),await realpath(external));
  assert.equal((await lstat(f.source)).isSymbolicLink(),true);
  assert.equal(await readFile(join(external,'SKILL.md'),'utf8'),text);
});

test('disabled destination aliases into plugin directories cannot receive personal skills', async t => {
  const f = await fixture(t);
  const protectedRoot = join(f.codexHome,'plugins'); await mkdir(protectedRoot,{recursive:true});
  await symlink(protectedRoot,dirname(f.disabled));
  await assert.rejects(f.store.manageSkill('disable',f.args),{code:'READ_ONLY'});
  assert.equal(await readFile(join(f.source,'SKILL.md'),'utf8'),text);
});

test('enabled and disabled aliases share the same write lock for their underlying file', async t => {
  const f = await fixture(t);
  await mkdir(dirname(f.disabled),{recursive:true}); await symlink(f.source,f.disabled);
  const catalog = (await f.store.listSkills('p')).skills;
  const active = catalog.find(skill=>!skill.disabled), disabled = catalog.find(skill=>skill.disabled);
  assert.ok(disabled,'both registrations are visible');
  const opened = await f.store.readSkill({id:disabled.id,projectId:'p'});
  await mkdir(join(f.store.stateDir,'locks'),{recursive:true});
  await writeFile(join(f.store.stateDir,'locks',active.id+'.lock'),'');
  const args = {id:disabled.id,revision:opened.revision,projectId:'p'};
  await assert.rejects(f.store.saveSkill({...args,content:text+'Changed'}),{code:'BUSY'});
  await assert.rejects(f.store.manageSkill('enable',args),{code:'BUSY'});
  assert.equal(await readFile(join(f.source,'SKILL.md'),'utf8'),text);
});
