import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillStore } from '../src/store.mjs';
import { createServer } from '../src/server.mjs';

test('MCP exposes a sidebar app and serves its editor resource', async t => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ readUI: async () => '<html>Editor</html>' });
  const client = new Client({ name: 'test', version: '1' });
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport); await client.connect(clientTransport);
  const { tools } = await client.listTools();
  const open = tools.find(x => x.name === 'skills_studio.open');
  assert.ok(open._meta['openai/ui'].entrypoints.some(x => x.type === 'global'));
  assert.ok(open._meta['openai/ui'].entrypoints.some(x => x.type === 'thread'));
  assert.deepEqual(open._meta.ui.visibility, ['model', 'app']);
  assert.equal(open.annotations.readOnlyHint, true);
  assert.deepEqual(tools.filter(tool => tool._meta.ui.visibility.includes('model')).map(tool => tool.name), ['skills_studio.open']);
  assert.deepEqual(tools.find(x => x.name === 'skills_studio.save')._meta.ui.visibility, ['app']);
  assert.equal(tools.find(x => x.name === 'skills_studio.save').annotations.readOnlyHint, false);
  assert.deepEqual(tools.find(x => x.name === 'skills_studio.manage')._meta.ui.visibility, ['app']);
  assert.equal(tools.find(x => x.name === 'skills_studio.manage').annotations.readOnlyHint, false);
  for (const name of ['copy_path','open_terminal']) {
    const tool = tools.find(x => x.name === 'skills_studio.' + name);
    assert.deepEqual(tool._meta.ui.visibility, ['app']);
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.equal(tool.annotations.destructiveHint, false);
  }
  const resource = await client.readResource({ uri: open._meta.ui.resourceUri });
  assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.equal(resource.contents[0].text, '<html>Editor</html>');
  assert.deepEqual(resource.contents[0]._meta['openai/ui'].availableDisplayModes, ['fullscreen']);
});

test('MCP reads and saves only a catalogued skill and returns conflict errors', async t => {
  const root = await mkdtemp(join(tmpdir(), 'skills-studio-mcp-'));
  const home = join(root, 'home'); const codexHome = join(home, '.codex');
  await mkdir(join(home, '.agents/skills/sample'), { recursive: true });
  await mkdir(codexHome, { recursive: true });
  const path = join(home, '.agents/skills/sample/SKILL.md');
  const content = '---\nname: sample\ndescription: Example\n---\n# Before\n';
  await writeFile(path, content);
  await writeFile(join(codexHome, '.codex-global-state.json'), JSON.stringify({ 'local-projects': { one: { name: 'One', rootPaths: [root] } } }));
  const store = new SkillStore({ home, codexHome, stateDir: join(root, 'state') });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createServer({ store }); const client = new Client({ name: 'test', version: '1' });
  t.after(async () => { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); });
  await server.connect(st); await client.connect(ct);
  const call = (name, args = {}) => client.callTool({ name: 'skills_studio.' + name, arguments: args });
  assert.equal((await call('projects')).structuredContent.projects[0].name, 'One');
  const items = (await call('list')).structuredContent.skills;
  const before = (await call('read', { id: items[0].id })).structuredContent;
  assert.equal(before.content, content);
  const saved = await call('save', { id: items[0].id, revision: before.revision, content: content + 'Changed' });
  assert.equal(saved.isError, undefined);
  assert.equal(await readFile(path, 'utf8'), content + 'Changed');
  const conflict = await call('save', { id: items[0].id, revision: before.revision, content: content + 'Lost' });
  assert.equal(conflict.isError, true);
  assert.equal(conflict.structuredContent.code, 'CONFLICT');
  assert.equal((await call('open')).structuredContent.hideSystemSkills, true);
  assert.equal((await call('open')).structuredContent.language, 'en');
  await writeFile(join(store.stateDir,'preferences.json'),JSON.stringify({hidePluginSkills:false}));
  assert.equal((await call('open')).structuredContent.hidePluginSkills, false);
  assert.equal((await call('open')).structuredContent.hideSystemSkills, true);
  assert.equal((await call('open')).structuredContent.language, 'en', 'legacy preferences default to English');
  await call('update_preferences', {language:'ru'});
  assert.equal((await call('open')).structuredContent.language, 'ru');
  const invalidLanguage=await call('update_preferences', {language:'de'});
  assert.equal(invalidLanguage.isError, true);
  assert.equal((await call('open')).structuredContent.language, 'ru', 'invalid locale must not overwrite the saved choice');
  await call('update_preferences', {hideSystemSkills:false,collapsedSections:['global','plugin:test/alpha']});
  await call('select_project', { projectId: 'one' });
  const reopened=(await call('open')).structuredContent;
  assert.equal(reopened.selectedProjectId, 'one');
  assert.equal(reopened.hideSystemSkills, false);
  assert.deepEqual(reopened.collapsedSections,['global','plugin:test/alpha']);
  assert.equal(reopened.language,'ru', 'unrelated preference writes retain the language');
  await call('update_preferences', {language:'en'});
  const reopenedEnglish=(await call('open')).structuredContent;
  assert.equal(reopenedEnglish.language,'en');
  assert.equal(reopenedEnglish.selectedProjectId,'one');
  assert.deepEqual(reopenedEnglish.collapsedSections,['global','plugin:test/alpha']);
});

test('context includes hidden plugin/system skills and excludes unavailable records',async t=>{
 const root=await mkdtemp(join(tmpdir(),'context-server-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const source=join(root,'SKILL.md');await writeFile(source,'---\nname: test\ndescription: Test\n---\nBody');
 const records=[{id:'g',scope:'global'},{id:'p',scope:'plugin'},{id:'s',scope:'global',system:true},{id:'d',scope:'global',availability:{status:'disabled'}}].map(record=>({name:record.id,description:'Test',path:source,availability:{status:'enabled'},context:{metadataTokens:20,instructionTokens:200},...record}));
 const calls=[];const store={stateDir:root,codexHome:root,listSkills:async(projectId,args)=>{calls.push(args);return {skills:records,warnings:[]};}};
 const server=createServer({store});const client=new Client({name:'context-test',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();t.after(async()=>{await client.close();await server.close();});await server.connect(b);await client.connect(a);
 const run=async flags=>(await client.callTool({name:'skills_studio.list',arguments:flags})).structuredContent;
 const hidden=await run({includePlugins:false,includeSystem:false});const all=await run({includePlugins:true,includeSystem:true,forceReload:true});
 const {checkedAt:hiddenTime,...hiddenEstimate}=hidden.context,{checkedAt:allTime,...allEstimate}=all.context;
 assert.ok(Number.isFinite(Date.parse(hiddenTime)));assert.ok(Number.isFinite(Date.parse(allTime)));
 assert.equal(hidden.skills.length,2);assert.equal(all.skills.length,4);assert.equal(hidden.context.metadataTokens,60);assert.deepEqual(hiddenEstimate,allEstimate);
 assert.equal(hidden.context.totalCount,4);assert.equal(hidden.context.measuredCount,3);assert.equal(calls.at(-1).forceReload,true);
 assert.equal(hidden.context.excluded.disabled,1);assert.ok(calls.every(args=>args.includePlugins&&args.includeSystem));
});

test('location actions resolve aliases to original skill paths and reject unknown ids before execution', async t => {
  const root = await mkdtemp(join(tmpdir(), 'location-server-'));
  const home = join(root, 'home'), codexHome = join(home, '.codex');
  const original = join(root, 'source "quoted" $(echo nope) $HOME');
  const registration = join(home, '.agents/skills/alias');
  await mkdir(original, {recursive:true});
  await mkdir(join(home, '.agents/skills'), {recursive:true});
  await mkdir(codexHome, {recursive:true});
  const content = '---\nname: original\ndescription: Example\n---\nBody';
  await writeFile(join(original, 'SKILL.md'), content);
  await symlink(original, registration);
  const store = new SkillStore({home, codexHome, stateDir:join(root, 'state')});
  const calls = [];
  const server = createServer({store, copyPath:async path => calls.push(['copy',path]), openTerminal:async path => calls.push(['terminal',path])});
  const client = new Client({name:'location-test',version:'1'});
  const [ct,st] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); await rm(root, {recursive:true,force:true}); });
  await server.connect(st); await client.connect(ct);
  const {tools} = await client.listTools();
  for (const name of ['copy_path','open_terminal']) {
    const tool = tools.find(tool => tool.name === 'skills_studio.' + name);
    assert.deepEqual(tool._meta.ui.visibility, ['app']);
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['id','includePlugins','includeSystem','projectId']);
  }
  const {skills} = await store.listSkills();
  const call = (name,id) => client.callTool({name:'skills_studio.'+name, arguments:{id}});
  const canonical = (await store.resolveSkill({id:skills[0].id})).canonical;
  assert.equal((await call('copy_path',skills[0].id)).structuredContent.path, canonical);
  assert.equal((await call('open_terminal',skills[0].id)).structuredContent.path, canonical.slice(0,-'/SKILL.md'.length));
  assert.deepEqual(calls, [['copy',canonical],['terminal',canonical.slice(0,-'/SKILL.md'.length)]]);
  for (const name of ['copy_path','open_terminal']) {
    assert.equal((await call(name,'0'.repeat(64))).structuredContent.code, 'NOT_FOUND');
  }
  assert.equal(calls.length, 2);
  assert.equal(await readFile(join(original,'SKILL.md'),'utf8'), content);
  for (const [base,name] of [[join(codexHome,'skills/.system'),'builtin'], [join(codexHome,'plugins/cache/test/demo/1.0/skills'),'plugin-skill']]) {
    await mkdir(join(base,name), {recursive:true});
    await writeFile(join(base,name,'SKILL.md'), content);
  }
  const protectedSkills = (await store.listSkills(null,{includePlugins:true,includeSystem:true})).skills.filter(skill => skill.system || skill.scope === 'plugin');
  assert.equal(protectedSkills.length, 2);
  for (const skill of protectedSkills) {
    assert.equal(skill.readOnly, true);
    for (const name of ['copy_path','open_terminal']) {
      const result = await client.callTool({name:'skills_studio.'+name,arguments:{id:skill.id,includePlugins:true,includeSystem:true}});
      assert.equal(result.isError, undefined);
    }
    assert.equal(await readFile(skill.path,'utf8'), content);
  }
  assert.equal(calls.length, 6);
});
