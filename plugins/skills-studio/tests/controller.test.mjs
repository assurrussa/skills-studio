import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioController } from '../ui/controller.mjs';

function backend() {
  let disk = 'before'; let revision = 'r1'; let releaseSave;
  return {
    holdSave: false,
    finishSave: () => releaseSave(),
    async call(name, args) {
      if (name === 'open') return { projects: [{ id: 'p', name: 'P' }], selectedProjectId: null, warnings: [] };
      if (name === 'list') return { skills: [{ id: 's', name: 'Skill', scope: 'global', readOnly: false }], warnings: [] };
      if (name === 'select_project') return {};
      if (name === 'read') return { id: args.id, name: 'Skill', content: disk, revision, readOnly: false };
      if (name === 'save') {
        if (this.holdSave) await new Promise(resolve => { releaseSave = resolve; });
        if (args.revision !== revision) throw Object.assign(new Error('Conflict'), { code: 'CONFLICT' });
        disk = args.content; revision = 'r2'; return { revision, backupPath: '/backup' };
      }
    },
  };
}

test('changing project with unsaved edits preserves the document', async () => {
  const b = backend(); const c = new StudioController(b.call.bind(b));
  await c.initialize(); await c.open('s'); c.edit('unsaved');
  await assert.rejects(c.selectProject('p'), { code: 'UNSAVED' });
  await assert.rejects(c.manage('delete', { id:'s' }), { code:'UNSAVED' });
  assert.equal(c.state.current.content, 'unsaved');
  assert.equal(c.state.projectId, null);
});

test('typing while save is pending remains unsaved after the older snapshot is saved', async () => {
  const b = backend(); const c = new StudioController(b.call.bind(b));
  await c.initialize(); await c.open('s'); c.edit('first'); b.holdSave = true;
  assert.equal(c.originalContent, 'before');
  const saved = c.save();
  await new Promise(resolve => setImmediate(resolve));
  c.edit('second'); b.finishSave(); await saved;
  assert.equal(c.state.current.content, 'second');
  assert.equal(c.state.current.revision, 'r2');
  assert.equal(c.dirty, true);
  b.holdSave = false; await c.save();
  assert.equal(c.dirty, false);
  assert.equal(c.originalContent, 'before');
});

test('failed save keeps edits and surfaces the conflict', async () => {
  const b = backend(); const c = new StudioController(b.call.bind(b));
  await c.initialize(); await c.open('s');
  c.state.current.revision = 'stale'; c.edit('mine');
  await assert.rejects(c.save(), { code: 'CONFLICT' });
  assert.equal(c.state.current.content, 'mine');
  assert.equal(c.dirty, true);
  assert.equal(c.state.busy, false);
});

test('location actions preserve unsaved edits and only report success after completion', async () => {
  const b = backend(), calls = [];
  let fail = false, release;
  const c = new StudioController(async (name, args) => {
    if (!['copy_path', 'open_terminal'].includes(name)) return b.call(name, args);
    calls.push({ name, args });
    if (fail) throw new Error('Terminal недоступен');
    await new Promise(resolve => { release = resolve; });
    return { path: '/original/SKILL.md' };
  });
  await c.initialize(); await c.open('s'); c.edit('unsaved');
  const copying = c.locationAction('copy_path');
  assert.ok(c.state.busy);
  assert.notEqual(c.state.status, 'Путь к оригиналу скопирован');
  await c.locationAction('open_terminal');
  assert.equal(calls.length, 1, 'busy actions cannot launch another process');
  release(); await copying;
  assert.equal(c.state.status, 'Путь к оригиналу скопирован');
  assert.deepEqual(calls[0].args, { id:'s', projectId:null, includePlugins:true, includeSystem:false });
  assert.equal(c.state.current.content, 'unsaved'); assert.equal(c.dirty, true);
  assert.equal(c.baseline, 'before');
  fail = true;
  await assert.rejects(c.locationAction('open_terminal'), /Terminal недоступен/);
  assert.notEqual(c.state.status, 'Папка открыта в терминале');
  assert.equal(c.state.busy, false); assert.equal(c.state.current.content, 'unsaved');
});

test('discarding edits explicitly allows selecting another project', async () => {
  const b = backend(); const c = new StudioController(b.call.bind(b));
  await c.initialize(); await c.open('s'); c.edit('mine');
  await c.selectProject('p', { discard: true });
  assert.equal(c.state.projectId, 'p');
  assert.equal(c.state.current, null);
});

test('a document cannot be edited while another document is loading', async () => {
  const b = backend(); let release;
  const call = async (name,args) => {
    if(name==='read' && args.id==='next') await new Promise(resolve=>{release=resolve;});
    return b.call(name,args);
  };
  const c = new StudioController(call);
  await c.initialize();await c.open('s');
  const loading = c.open('next');
  await new Promise(resolve=>setImmediate(resolve));
  c.edit('typed into the old document during navigation');
  assert.equal(c.state.current.content,'before');
  release();await loading;
});

test('plugin visibility is independent from system filtering and changing it preserves unsaved personal edits', async () => {
  const b=backend(),updates=[];
  const c=new StudioController(async(name,args)=>{
    if(name==='update_preferences'){updates.push(args);return args;}
    if(name==='list')return {skills:[{id:'s',name:'Skill',scope:'global'},...(args.includePlugins?[{id:'plugin',scope:'plugin',readOnly:true}]:[]),...(args.includeSystem?[{id:'system',scope:'global',readOnly:true,system:true}]:[])],warnings:[]};
    return b.call(name,args);
  });
  await c.initialize();assert.equal(c.state.hideSystemSkills,true);
  await c.open('s');c.edit('unsaved');
  await c.setHideSystemSkills(false);
  assert.equal(c.state.skills.length,3);assert.equal(c.state.current.content,'unsaved');assert.equal(c.dirty,true);
  assert.deepEqual(updates,[{hideSystemSkills:false}]);
});

test('hiding system skills closes an open packaged or .system document',async()=>{
  const b=backend();
  const c=new StudioController(async(name,args)=>{
    if(name==='update_preferences')return args;
    if(name==='read'&&args.id==='plugin')return {id:'plugin',scope:'plugin',readOnly:true,content:'Plugin',revision:'r1'};
    if(name==='read'&&args.id==='system')return {id:'system',scope:'global',system:true,readOnly:true,content:'System',revision:'r1'};
    return b.call(name,args);
  });
  await c.initialize();
  for (const id of ['system']) {
    await c.setHideSystemSkills(false);await c.open(id);
    await c.setHideSystemSkills(true);
    assert.equal(c.state.current,null);
  }
});

test('section collapse restores preferences and persists without closing the editor',async()=>{
  const b=backend(),updates=[];
  const c=new StudioController(async(name,args)=>{
    if(name==='open')return {...await b.call(name,args),hideSystemSkills:false,collapsedSections:['global']};
    if(name==='update_preferences'){updates.push(args);return args;}
    return b.call(name,args);
  });
  await c.initialize();await c.open('s');c.edit('keep');
  assert.deepEqual(c.state.collapsedSections,['global']);
  await c.toggleSection('global');await c.toggleSection('plugin:test/alpha');
  assert.deepEqual(c.state.collapsedSections,['plugin:test/alpha']);
  assert.deepEqual(updates.at(-1),{collapsedSections:['plugin:test/alpha']});
  assert.equal(c.state.current.content,'keep');assert.equal(c.dirty,true);
});

 test('plugin filter does not hide system skills and preserves an unsaved personal document', async () => {
  const b=backend();const c=new StudioController(async(name,args)=>name==='update_preferences'?args:b.call(name,args));
  await c.initialize();assert.equal(c.state.hidePluginSkills,false);
  await c.open('s');c.edit('keep');await c.setHidePluginSkills(true);
  assert.equal(c.state.hideSystemSkills,true);assert.equal(c.state.current.content,'keep');assert.equal(c.dirty,true);
  await assert.rejects(c.healthAction('review_save'),{code:'UNSAVED'});
  await assert.rejects(c.setEnabled(c.state.current,false),{code:'UNSAVED'});
 });
