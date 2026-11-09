import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SkillStore } from './store.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SkillHealth } from './health.mjs';
import { summarizeContext } from './context.mjs';
import { ChatService } from './app-server.mjs';
import { copyPath as nativeCopyPath, openTerminal as nativeOpenTerminal } from './locations.mjs';

const execute = promisify(execFile);
const revealInFinder = path => execute('/usr/bin/open', ['-R', path], { timeout:10000, maxBuffer:64 * 1024 });

const APP_URI = 'ui://skills-studio/editor';
const icon = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h11v3H7v13H4zM10 10h10v10H10z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="m13 16 2-2 2 2m-2-2v5" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>');
const success = data => ({ content: [], structuredContent: data });

export function createServer({ store = new SkillStore(), readUI = () => readFile(new URL('./assets/app.html', import.meta.url), 'utf8'), reveal = revealInFinder, copyPath = nativeCopyPath, openTerminal = nativeOpenTerminal, chat = new ChatService({stateDir:store.stateDir,codexHome:store.codexHome}) } = {}) {
  const server = new McpServer({ name: 'skills-studio', title: 'Skills Studio', version: '0.2.6', icons: [{ src: icon, mimeType: 'image/svg+xml', sizes: ['any'] }] });
  const health = new SkillHealth({stateDir:store.stateDir});
  const inspect = async skill => ({...skill, health:await health.inspect(skill)});
  const preferenceFile = join(store.stateDir, 'preferences.json');
  let preferenceQueue = Promise.resolve();
  async function readPreferences() {
    let data = {};
    try { data = JSON.parse(await readFile(preferenceFile, 'utf8')); } catch { /* Defaults on first run. */ }
    const hideSystemSkills = typeof data?.hideSystemSkills === 'boolean' ? data.hideSystemSkills : true;
    return { selectedProjectId: typeof data?.selectedProjectId === 'string' ? data.selectedProjectId : null, language:data?.language === 'ru' ? 'ru' : 'en', hideSystemSkills, hidePluginSkills: data.hidePluginSkills === true, collapsedSections: Array.isArray(data?.collapsedSections) ? [...new Set(data.collapsedSections.filter(x => typeof x === 'string'))] : [] };
  }
  function writePreferences(patch) {
    const operation = preferenceQueue.then(async () => {
      const preferences = { ...await readPreferences(), ...patch };
      await mkdir(store.stateDir, { recursive: true, mode: 0o700 });
      const temporary = preferenceFile + '.' + randomUUID() + '.tmp';
      try {
        await writeFile(temporary, JSON.stringify(preferences), { mode: 0o600 });
        await rename(temporary, preferenceFile);
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      return preferences;
    });
    preferenceQueue = operation.catch(() => {});
    return operation;
  }
  const projectId = z.string().min(1).nullable().optional();
  const includePlugins = z.boolean().optional();
  const includeSystem = z.boolean().optional();
  const skillId = z.string().regex(/^[a-f0-9]{64}$/);
  function tool(name, title, inputSchema, run, { readOnly = true, destructive = !readOnly, entrypoint = false, openWorld = false } = {}) {
    server.registerTool('skills_studio.' + name, {
      title, description: entrypoint ? 'Open Skills Studio: a catalogue, availability overview and editor for Codex skills.' : title, inputSchema,
      annotations: { readOnlyHint: readOnly, destructiveHint: destructive, openWorldHint: openWorld },
      _meta: {
        ui: { resourceUri: APP_URI, visibility: entrypoint ? ['model', 'app'] : ['app'] },
        ...(entrypoint ? { 'openai/iconStyle': 'monochrome', 'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] } } : {}),
      },
    }, async args => {
      try { return success(await run(args)); }
      catch (error) {
        return { isError: true, content: [{ type: 'text', text: error.message }], structuredContent: { code: error.code || 'ERROR', message: error.message } };
      }
    });
  }
  tool('open', 'Skills Studio', {}, async () => {
    const preferences = await readPreferences();
    let { selectedProjectId } = preferences;
    const catalog = await store.listProjects();
    if (!catalog.projects.some(p => p.id === selectedProjectId)) selectedProjectId = null;
    return { ...catalog, ...preferences, selectedProjectId };
  }, { entrypoint: true });
  tool('projects', 'List local Codex projects', {}, () => store.listProjects());
  const sessionId = z.string().uuid();
  tool('chat_open', 'Connect the side chat to the local App Server', {skillId:z.string().min(1).max(200).optional()}, args => chat.open(args), {readOnly:false});
  tool('chat_poll', 'Read side chat state and replies', {sessionId,afterRevision:z.number().int().nonnegative().optional()}, args => chat.poll(args));
  tool('chat_login', 'Sign in with ChatGPT for the side chat', {sessionId}, args => chat.login(args), {readOnly:false,openWorld:true});
  tool('chat_send', 'Send a question and editor snapshot to the assistant', {sessionId,requestId:z.string().min(1).max(100),question:z.string().min(1).max(100000),model:z.string().max(200).optional(),effort:z.string().min(1).max(100).optional(),document:z.object({skill:z.object({id:z.string(),name:z.string(),path:z.string()}).passthrough(),versions:z.object({opened:z.string().max(2*1024*1024),saved:z.string().max(2*1024*1024),editor:z.string().max(2*1024*1024)})}).passthrough().nullable()}, args => chat.send(args), {readOnly:false,openWorld:true});
  tool('chat_stop', 'Stop the assistant response', {sessionId}, args => chat.stop(args), {readOnly:false});
  tool('chat_reset', 'Start a new side chat conversation', {sessionId}, args => chat.reset(args), {readOnly:false});
  tool('chat_close', 'Close the side chat session', {sessionId}, args => chat.dispose(args), {readOnly:false});
  tool('list', 'List skills and Codex availability', { projectId, includePlugins, includeSystem, forceReload:z.boolean().optional() }, async args => {
    // Visibility preferences must not pretend to reduce Codex's context.
    const complete = await store.listSkills(args.projectId, {...args, includePlugins:true, includeSystem:true});
    const context = {...summarizeContext(complete.skills), checkedAt:new Date().toISOString()};
    const catalog = {...complete, skills:complete.skills.filter(skill => (args.includePlugins || skill.scope !== 'plugin') && (args.includeSystem !== false || !skill.system))};
    const skills = [];
    for (let i = 0; i < catalog.skills.length; i += 4) skills.push(...await Promise.all(catalog.skills.slice(i,i+4).map(inspect)));
    const names = new Map(), fingerprints = new Map();
    for (const skill of skills) {
      for (const [map,key] of [[names,skill.name],[fingerprints,skill.health.fingerprint]]) {
        if (!key) continue; if (!map.has(key)) map.set(key,[]); map.get(key).push(skill);
      }
    }
    for (const [map,code,message] of [[names,'DUPLICATE_NAME','Есть другие навыки с таким именем'],[fingerprints,'DUPLICATE_CONTENT','Найдена идентичная копия пакета']]) {
      for (const group of map.values()) if (group.length > 1) for (const skill of group) skill.health.checks.push({code,message,severity:'warning'});
    }
    return {...catalog,skills,context};
  });
  tool('read', 'Read SKILL.md', { id: skillId, projectId, includePlugins, includeSystem }, async args => inspect(await store.readSkill(args)));
  tool('save', 'Save SKILL.md with a backup', { id: skillId, projectId, includePlugins, includeSystem, revision: z.string().regex(/^[a-f0-9]{64}$/), content: z.string().max(2 * 1024 * 1024) }, async args => { const result = await store.saveSkill(args); return {...result,health:await health.inspect(await store.readSkill(args))}; }, { readOnly: false });
  tool('manage', 'Manage a skill with backups', { id:skillId, projectId, includePlugins, includeSystem, revision:z.string().regex(/^[a-f0-9]{64}$/), action:z.enum(['rename','copy','move','delete','enable','disable']), name:z.string().min(1).max(200).optional(), scope:z.enum(['global','local']).optional() }, args => store.manageSkill(args.action, args), { readOnly:false });
  const skillArgs = {id:skillId, projectId, includePlugins, includeSystem};
  tool('copy_path', 'Copy the original SKILL.md path', skillArgs, async args => {
    const { canonical } = await store.resolveSkill(args);
    await copyPath(canonical);
    return { path:canonical };
  }, {readOnly:false,destructive:false});
  tool('open_terminal', 'Open the original skill folder in Terminal', skillArgs, async args => {
    const { canonical } = await store.resolveSkill(args);
    const path = dirname(canonical);
    await openTerminal(path);
    return { path };
  }, {readOnly:false,destructive:false});
  tool('set_enabled', 'Change Codex skill availability without moving files', {...skillArgs, enabled:z.boolean(), registrationPath:z.string().min(1).optional()}, args => store.setEnabled(args), {readOnly:false});
  tool('check_source', 'Check the skill source without updating files', skillArgs, async args => {
    const skill = await store.readSkill(args); await health.checkSource(skill); return {health:await health.inspect(skill)};
  }, {readOnly:false,openWorld:true});
  tool('review_save', 'Save a manual skill content review', {...skillArgs, fingerprint:z.string().regex(/^[a-f0-9]{64}$/), note:z.string().min(1).max(10000), evidenceUrls:z.array(z.string().url().max(2000)).max(30)}, async args => {
    const skill = await store.readSkill(args); await health.saveReview(skill,args); return {health:await health.inspect(skill)};
  }, {readOnly:false});
  tool('reveal', 'Reveal SKILL.md in Finder', { id:skillId, projectId, includePlugins, includeSystem }, async args => {
    const { skill } = await store.resolveSkill(args);
    await reveal(skill.path);
    return { path:skill.path };
  });
  tool('select_project', 'Save the selected Skills Studio project', { projectId }, async args => {
    if (args.projectId && !(await store.listProjects()).projects.some(p => p.id === args.projectId)) throw Object.assign(new Error('Проект не найден.'), { code: 'PROJECT_NOT_FOUND' });
    return writePreferences({ selectedProjectId: args.projectId || null });
  }, { readOnly: false });
  tool('update_preferences', 'Save interface language, visibility filters and collapsed sections', { language:z.enum(['en','ru']).optional(), hideSystemSkills:z.boolean().optional(), hidePluginSkills:z.boolean().optional(), collapsedSections:z.array(z.string().min(1).max(300)).max(1000).optional() }, args => {
    return writePreferences(args);
  }, { readOnly:false });
  server.registerResource('skills-studio-editor', APP_URI, { mimeType: 'text/html;profile=mcp-app' }, async () => ({ contents: [{
    uri: APP_URI, mimeType: 'text/html;profile=mcp-app', text: await readUI(),
    _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: false }, 'openai/ui': { availableDisplayModes: ['fullscreen'] } },
  }] }));
  const close = server.close.bind(server);
  server.close = async () => { await chat.close(); await store.close?.(); await close(); };
  const onclose = server.server.onclose;
  server.server.onclose = () => { onclose?.(); void chat.close().catch(()=>{}); void store.close?.().catch(()=>{}); };
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === await realpath(process.argv[1]).catch(() => null)) {
  const server = createServer();
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>{server.close().finally(()=>process.exit(0));});
  await server.connect(new StdioServerTransport());
}
