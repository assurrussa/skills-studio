import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, symlink, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeCatalog } from '../src/runtime-catalog.mjs';
import { SkillStore } from '../src/store.mjs';

const content = '---\nname: sample\ndescription: Example\n---\nText\n';
async function fixture(t, runtime) {
  const home = await mkdtemp(join(tmpdir(), 'runtime-catalog-'));
  t.after(() => rm(home, { recursive:true, force:true }));
  const codexHome = join(home, '.codex');
  await mkdir(join(home, '.agents/skills/sample'), { recursive:true });
  const path = join(home, '.agents/skills/sample/SKILL.md');
  await writeFile(path, content);
  return { home, codexHome, path, store:new SkillStore({ home, codexHome, runtime }) };
}

test('separate catalogue connection retains plugin settings and caches bounded RPC snapshots', async () => {
  const calls = [], rpc = new EventEmitter();
  rpc.start = async () => calls.push('start'); rpc.close = async () => calls.push('close');
  rpc.request = async (method, params) => { calls.push({ method, params }); return { data:[{ cwd:'/project', skills:[{path:'/skills/demo/SKILL.md',enabled:true}], errors:[] }] }; };
  let options, cliCalls = 0;
  const runtime = new RuntimeCatalog({ resolveCLI:async () => ({ path:'/codex' }), connection:value => { options = value; return rpc; }, executeCLI:async (path,args) => { cliCalls++; assert.deepEqual(args,['plugin','list','--json']); return { stdout:JSON.stringify({installed:[{name:'demo',version:'1.0'}]}) }; } });
  const first = await runtime.snapshot(['/project']);
  assert.deepEqual(options.args, ['app-server','--listen','stdio://']);
  assert.equal(first.installed[0].version,'1.0');
  await runtime.snapshot(['/project']);
  assert.equal(cliCalls,1);
  await runtime.setEnabled('/skills/demo/SKILL.md',false);
  assert.deepEqual(calls.at(-1),{method:'skills/config/write',params:{path:'/skills/demo/SKILL.md',enabled:false}});
  await runtime.snapshot(['/project']); assert.equal(cliCalls,2);
  await runtime.snapshot(['/project'], {forceReload:true}); assert.equal(cliCalls,3);
  await runtime.close(); assert.equal(calls.at(-1),'close');
});

test('timeout returns unknown runtime state and backs off repeated lookups', async () => {
  let calls = 0;
  const runtime = new RuntimeCatalog({ timeout:10, resolveCLI:() => { calls++; return new Promise(() => {}); } });
  assert.ok((await runtime.snapshot(['/project'])).reason);
  assert.ok((await runtime.snapshot(['/project'])).reason);
  assert.equal(calls,1); await runtime.close();
});

test('canonical dedup preserves aliases with separate availability; toggles exact catalogued registration without moving', async t => {
  const writes = [];
  let f, enabled = true;
  const runtime = { snapshot:async () => ({ data:[{skills:[{ path:f.path, enabled },{ path:join(f.codexHome,'skills/alias/SKILL.md'),enabled:false }]}] }), setEnabled:async (path,value) => { writes.push([path,value]); enabled = value; } };
  f = await fixture(t,runtime);
  await mkdir(join(f.codexHome,'skills'),{recursive:true});
  await symlink(join(f.path,'..'),join(f.codexHome,'skills/alias'));
  const {skills} = await f.store.listSkills();
  assert.equal(skills.length,1); const [skill] = skills;
  assert.equal(skill.canonicalPath,await realpath(f.path));
  assert.equal(skill.registrations.length,2);
  assert.deepEqual(skill.registrations.map(x => x.availability.status),['enabled','disabled']);
  assert.equal(skill.availability.status,'enabled');
  await assert.rejects(f.store.setEnabled({id:skill.id,enabled:false}),{code:'REGISTRATION_REQUIRED'});
  await assert.rejects(f.store.setEnabled({id:skill.id,enabled:false,registrationPath:'/arbitrary/SKILL.md'}),{code:'NOT_FOUND'});
  const result = await f.store.setEnabled({id:skill.id,enabled:false,registrationPath:f.path});
  assert.equal(result.skill.availability.status,'disabled');
  assert.deepEqual(writes,[[f.path,false]]);
  assert.equal(await readFile(f.path,'utf8'),content);
  assert.equal(result.skill.disabled,false);
});

test('runtime failure preserves filesystem skills with unknown state; custom homes stay offline by default', async t => {
  const f = await fixture(t,undefined);
  assert.equal(f.store.runtime,null);
  const [skill] = (await f.store.listSkills()).skills;
  assert.equal(skill.availability.status,'unknown');
  await assert.rejects(f.store.setEnabled({id:skill.id,enabled:false}),{code:'RUNTIME_UNAVAILABLE'});
  f.store.runtime = {snapshot:async () => {throw new Error('unavailable');}};
  const result = await f.store.listSkills();
  assert.equal(result.skills.length,1); assert.equal(result.skills[0].availability.status,'unknown');
  assert.ok(result.warnings.some(value => value.includes('доступность')));
});

test('plugin cache selects installed version and does not imply enabled runtime skills', async t => {
  const f = await fixture(t,{snapshot:async () => ({data:[],installed:[{pluginId:'demo@market',name:'demo',marketplaceName:'market',version:'1.0',enabled:true}]})});
  for (const version of ['1.0','2.0']) {
    const root = join(f.codexHome,'plugins/cache/market/demo',version,'skills/example');
    await mkdir(root,{recursive:true}); await writeFile(join(root,'SKILL.md'),content);
  }
  const plugin = (await f.store.listSkills(null,{includePlugins:true})).skills.find(x => x.scope === 'plugin');
  assert.equal(plugin.plugin.version,'1.0'); assert.equal(plugin.availability.status,'cached');
  await assert.rejects(f.store.setEnabled({id:plugin.id,enabled:false,includePlugins:true}),{code:'READ_ONLY'});
});


test('runtime toggles refuse system originals and legacy archives', async t => {
  const writes = [];
  const f = await fixture(t,{snapshot:async () => ({data:[]}),setEnabled:async (...args) => writes.push(args)});
  for (const folder of ['skills/.system/builtin','disabled-skills/archived']) {
    await mkdir(join(f.codexHome,folder),{recursive:true});
    await writeFile(join(f.codexHome,folder,'SKILL.md'),content);
  }
  const {skills} = await f.store.listSkills();
  await assert.rejects(f.store.setEnabled({id:skills.find(skill => skill.system).id,enabled:false}),{code:'READ_ONLY'});
  await assert.rejects(f.store.setEnabled({id:skills.find(skill => skill.disabled).id,enabled:true}),{code:'LEGACY_ARCHIVE'});
  assert.equal(writes.length,0);
});

test('plugin CLI result survives an independent App Server timeout', async () => {
  const rpc = new EventEmitter(); rpc.start = () => new Promise(() => {}); rpc.close = async () => {};
  const runtime = new RuntimeCatalog({timeout:15,resolveCLI:async () => ({path:'/codex'}),connection:() => rpc,
    executeCLI:async () => ({stdout:JSON.stringify({installed:[{name:'demo',version:'1.0',enabled:false}]})})});
  const result = await runtime.snapshot(['/project']);
  assert.equal(result.installed[0].enabled,false); assert.equal(result.installed[0].version,'1.0');
  assert.ok(result.reason); await runtime.close();
});

test('runtime-discovered nested skills are visible and read-only; partial errors remain visible', async t => {
  let path;
  const f = await fixture(t,{snapshot:async () => ({data:[{cwd:'/project',skills:[{path,enabled:true,scope:'repo'}],errors:[{message:'unreadable skill'}]}],reason:'Не удалось полностью проверить доступность в Codex.'})});
  path = join(f.home,'project/.agents/skills/team/nested/SKILL.md');
  await mkdir(join(path,'..'),{recursive:true}); await writeFile(path,content);
  const {skills,warnings} = await f.store.listSkills();
  const nested = skills.find(skill => skill.path === path);
  assert.ok(nested); assert.equal(nested.scope,'local'); assert.equal(nested.readOnly,true);
  assert.equal(nested.registrations[0].runtimeScope,'repo'); assert.equal(nested.availability.status,'enabled');
  assert.ok(warnings.length);
  await assert.rejects(f.store.setEnabled({id:nested.id,enabled:false}),{code:'READ_ONLY'});
});

test('installed disabled plugin cache is disabled, with its installed version', async t => {
  const f = await fixture(t,{snapshot:async () => ({data:[],installed:[{name:'demo',marketplaceName:'market',version:'1.0',enabled:false}]})});
  const path = join(f.codexHome,'plugins/cache/market/demo/1.0/skills/example');
  await mkdir(path,{recursive:true}); await writeFile(join(path,'SKILL.md'),content);
  const plugin = (await f.store.listSkills(null,{includePlugins:true})).skills.find(skill => skill.scope === 'plugin');
  assert.equal(plugin.availability.status,'disabled');
  assert.equal(plugin.registrations[0].plugin.enabled,false);
});

test('personal symlink inherits canonical runtime status and toggles the reported path',async t=>{
 let f,enabled=true;const writes=[];
 const runtime={snapshot:async()=>({data:[{skills:[{path:join(f.home,'source/SKILL.md'),enabled,scope:'user'}]}]}),setEnabled:async(path,value)=>{writes.push([path,value]);enabled=value;}};
 f=await fixture(t,runtime);
 const source=join(f.home,'source');await mkdir(source);await writeFile(join(source,'SKILL.md'),content);
 await rm(join(f.path,'..'),{recursive:true});await symlink(source,join(f.path,'..'));
 const [skill]=(await f.store.listSkills()).skills;
 const registration=skill.registrations.find(r=>r.path===f.path);
 assert.equal(registration.availability.status,'enabled');assert.equal(registration.runtimePath,join(source,'SKILL.md'));assert.equal(registration.readOnly,false);
 const result=await f.store.setEnabled({id:skill.id,registrationPath:f.path,enabled:false});
 assert.deepEqual(writes,[[join(source,'SKILL.md'),false]]);assert.equal(result.skill.availability.status,'disabled');assert.equal(await readFile(f.path,'utf8'),content);
});
test('canonical fallback does not override conflicting exact registrations or protected scopes',async t=>{
 let f;
 const runtime={snapshot:async()=>({data:[{skills:[{path:f.path,enabled:true},{path:f.path,enabled:false},{path:join(f.home,'source/SKILL.md'),enabled:true,scope:'user'}]}]})};
 f=await fixture(t,runtime);const source=join(f.home,'source');await mkdir(source);await writeFile(join(source,'SKILL.md'),content);
 await rm(join(f.path,'..'),{recursive:true});await symlink(source,join(f.path,'..'));
 const reg=() => f.store.listSkills().then(x=>x.skills[0].registrations.find(r=>r.path===f.path));
 assert.equal((await reg()).availability.status,'unknown');assert.equal((await reg()).runtimePath,undefined);
 runtime.snapshot=async()=>({data:[{skills:[{path:join(source,'SKILL.md'),enabled:true,scope:'admin'}]}]});
 assert.equal((await reg()).runtimePath,undefined);
});
