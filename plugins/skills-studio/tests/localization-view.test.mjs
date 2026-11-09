import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {readFile} from 'node:fs/promises';
import {undo} from '@codemirror/commands';
import {openSearchPanel,getSearchQuery} from '@codemirror/search';
import {StudioController} from '../ui/controller.mjs';
import {setLanguage, localizeService, sourceLabel} from '../ui/i18n.mjs';

test('English defaults independently of host locale; live switches preserve editor, filters, reviews and chat', async () => {
 const html=await readFile(new URL('../ui/index.html',import.meta.url),'utf8');
 const dom=new JSDOM(html,{pretendToBeVisual:true}),win=dom.window,doc=win.document;
 Object.defineProperty(win.navigator,'language',{value:'ru-RU'});
 for(const key of ['window','Window','Option','document','navigator','MutationObserver','HTMLElement','Element','Node','getComputedStyle','requestAnimationFrame','cancelAnimationFrame'])Object.defineProperty(globalThis,key,{configurable:true,value:key==='window'?win:typeof win[key]==='function'&&['getComputedStyle','requestAnimationFrame','cancelAnimationFrame'].includes(key)?win[key].bind(win):win[key]});
 win.Range.prototype.getClientRects=()=>[];win.Range.prototype.getBoundingClientRect=()=>({x:0,y:0,left:0,top:0,right:0,bottom:0,width:0,height:0});
 const {mountStudio}=await import('../ui/view.mjs');
 const {createSkillChats}=await import('../ui/skill-chats.mjs');
 const requests=[];let savedLanguage,fail=false;
 const original='# Сохранить\nПользовательский текст';
 const skill={id:'s',name:'Сохранить',scope:'global',source:'Личные',path:'/Проект/Сохранить/SKILL.md',availability:{status:'enabled',reason:'Codex подтвердил исходный файл символьной ссылки.'},health:{fingerprint:'abc',checks:[{code:'DUPLICATE_NAME',severity:'warning',message:'Есть другие навыки с таким именем'}]}};
 const context={checkedAt:'2026-11-09T11:00:00.000Z',metadataTokens:12345,enabledCount:1,entries:[{...skill,metadataTokens:12345,instructionTokens:12345}]};
 const call=async(name,args)=>{
  requests.push({name,args});
  if(name==='open')return {language:savedLanguage,projects:[{id:'p',name:'Проект',roots:['/Проект']}],selectedProjectId:'p',warnings:['Не удалось проверить доступность в Codex.']};
  if(name==='list')return {skills:[skill,{id:'plugin',name:'Имя плагина',scope:'plugin',source:'Проект',plugin:{id:'pl',name:'Проект'}}],context,warnings:[]};
  if(name==='read')return {...skill,content:original,revision:'one'};
  if(name==='update_preferences'){if(fail)throw Error('Не удалось скопировать путь в буфер обмена.');savedLanguage=args.language;return args;}
  throw Error(name);
 };
 const chat=createSkillChats(async(name,args)=>{
  if(name==='chat_open'||name==='chat_poll')return {sessionId:args.skillId||args.sessionId,revision:1,status:'ready',authenticated:true,messages:[{id:'m',role:'user',text:'Сохранить'},{id:'a',role:'assistant',text:'Пользовательский ответ',status:'completed'}],models:[{model:'fixture',displayName:'Сохранить',supportedReasoningEfforts:[{reasoningEffort:'high',description:'Reasoning'}]}]};
  if(name==='chat_close')return {};
  throw Error(name);
 },{pollMs:100000});
 const ui=mountStudio({call,chat});
 const $=id=>doc.getElementById(id);
 try {
  await ui.controller.initialize();
  assert.equal(ui.controller.state.language,'en');assert.equal(doc.documentElement.lang,'en');assert.equal($('language').value,'en');
  assert.equal($('overview-button').textContent,'Catalog overview');assert.equal($('save').title,'Save (⌘ S)');
  assert.match($('context-overview').textContent,/12,345 tokens/);
  assert.equal($('project').textContent,'Проект','project display name is never translated');
  assert.match($('skills').textContent,/Имя плагинаПроект/,'plugin source name is opaque even if it matches a source marker');
  await ui.controller.open('s');$('mode-edit').click();
  ui.editor.dispatch({changes:{from:original.length,insert:'\nЧерновик'},selection:{anchor:2,head:9}});
  const edited=ui.editor.state.doc.toString(),selection=ui.editor.state.selection.toJSON(),editorState=ui.editor.state;
  $('search').value='Сохранить';$('search').dispatchEvent(new win.Event('input'));
  $('status-filter').value='enabled';$('status-filter').dispatchEvent(new win.Event('change'));
  const review=$('skill-details').querySelectorAll('textarea');review[0].value='Сохранить';review[0].dispatchEvent(new win.Event('input'));review[1].value='https://example.com/Проект';review[1].dispatchEvent(new win.Event('input'));
  $('ask').click();await new Promise(r=>setImmediate(r));
  $('ask-question').value='Сохранить мой вопрос';
  $('chat-effort').click();doc.querySelector('#chat-effort-options [role=option]:last-child').click();
  openSearchPanel(ui.editor);
  const find=doc.querySelector('.cm-search input[name=search]');find.value='Черновик';find.dispatchEvent(new win.Event('change'));
  await ui.controller.setLanguage('ru');
  assert.equal(getSearchQuery(ui.editor.state).search,'Черновик');assert.equal(doc.querySelector('.cm-search input[name=search]').placeholder,'Найти');
  assert.equal(savedLanguage,'ru');assert.equal(doc.documentElement.lang,'ru');assert.equal($('overview-button').textContent,'Обзор каталога');assert.equal($('save').title,'Сохранить (⌘ S)');
  assert.equal(ui.editor.state.doc,editorState.doc,'locale changes keep the editor document');assert.deepEqual(ui.editor.state.selection.toJSON(),selection);
  assert.equal($('mode-edit').getAttribute('aria-selected'),'true');assert.equal($('status-filter').value,'enabled');assert.equal($('search').value,'Сохранить');
  assert.equal($('title').textContent,'Сохранить');assert.equal($('path').textContent,skill.path);assert.equal(ui.editor.state.doc.toString(),edited);
  assert.equal($('ask-question').value,'Сохранить мой вопрос');assert.equal($('chat-model').value,'fixture');assert.equal($('chat-effort').value,'high');assert.match($('chat-effort').textContent,/Высокое/);
  assert.equal(doc.querySelector('.chat-user .chat-message-body').textContent,'Сохранить');assert.match(doc.querySelector('.chat-assistant').textContent,/Пользовательский ответ/);
  assert.equal($('skill-details').querySelectorAll('textarea')[0].value,'Сохранить');assert.equal($('skill-details').querySelectorAll('textarea')[1].value,'https://example.com/Проект');
  $('mode-diff').click();await ui.controller.setLanguage('en');
  assert.equal($('mode-diff').getAttribute('aria-selected'),'true');assert.equal($('ask-question').value,'Сохранить мой вопрос');assert.match($('skill-details').textContent,/Other skills have the same name/);assert.equal($('project-filter').getAttribute('aria-label'),'Search projects');
  $('mode-view').click();await ui.controller.setLanguage('ru');assert.equal($('mode-view').getAttribute('aria-selected'),'true');assert.match($('markdown-view').textContent,/Пользовательский текст/);
  fail=true;await assert.rejects(ui.controller.setLanguage('en'));assert.equal($('language').value,'ru');assert.equal(doc.documentElement.lang,'ru');assert.equal(ui.editor.state.doc.toString(),edited);assert.equal($('language').disabled,false);
  fail=false;await ui.controller.setLanguage('en');$('mode-edit').click();undo(ui.editor);assert.equal(ui.editor.state.doc.toString(),original,'undo history survives all language changes');
  assert.ok(requests.filter(x=>x.name==='update_preferences').every(x=>['en','ru'].includes(x.args.language)));
 } finally {await ui.destroy();await new Promise(r=>setTimeout(r,30));win.close();}
});

test('language persistence failure leaves state intact; saved preference restores on reopen',async()=>{
 let saved='ru',fail=false,hold;const call=async(name,args)=>{
  if(name==='open')return {language:saved,projects:[],selectedProjectId:null,warnings:[]};
  if(name==='list')return {skills:[],warnings:[]};
  if(name==='update_preferences'){if(fail)throw Error('Disk unavailable');if(hold)await hold;return {language:saved=args.language};}
 };
 const controller=new StudioController(call);await controller.initialize();assert.equal(controller.state.language,'ru');
 controller.state.current={id:'s',content:'draft'};controller.baseline='saved';controller.originalContent='original';
 fail=true;await assert.rejects(controller.setLanguage('en'),/Disk unavailable/);assert.equal(controller.state.language,'ru');assert.equal(controller.state.current.content,'draft');assert.equal(controller.originalContent,'original');assert.equal(controller.state.languageSaving,false);
 fail=false;await controller.setLanguage('en');const reopened=new StudioController(call);await reopened.initialize();assert.equal(reopened.state.language,'en');
 let release;hold=new Promise(resolve=>{release=resolve;});const pending=controller.setLanguage('ru');assert.equal(controller.state.languageSaving,true);await controller.setLanguage('en');controller.edit('editable while saving');assert.equal(controller.state.current.content,'editable while saving');release();await pending;assert.equal(controller.state.language,'ru');hold=null;await controller.setLanguage('en');
 controller.state.busy='load';await controller.setLanguage('ru');assert.equal(saved,'en');controller.state.busy=false;
 const invalid=new StudioController(async name=>name==='open'?{language:'xx',projects:[],warnings:[]}:{skills:[],warnings:[]});await invalid.initialize();assert.equal(invalid.state.language,'en');
});

test('known service messages translate safely while unknown diagnostics and source names remain intact',()=>{
 setLanguage('en');assert.equal(localizeService('Не найдена локальная ссылка: Сохранить/Проект.md'),'Local reference not found: Сохранить/Проект.md');
 assert.equal(localizeService('Пользовательский диагностический текст'),'Пользовательский диагностический текст');
 assert.equal(sourceLabel({scope:'plugin',source:'Системные'}),'Системные');assert.equal(sourceLabel({scope:'global',source:'Системные'}),'System');
 setLanguage('ru');assert.equal(localizeService('Не найдена локальная ссылка: Сохранить/Проект.md'),'Не найдена локальная ссылка: Сохранить/Проект.md');setLanguage('en');
});


test('context source names remain opaque while explicit local service labels translate', async () => {
 const {mountContextOverview}=await import('../ui/context.mjs');
 const dom=new JSDOM('<section></section>'),target=dom.window.document.querySelector('section');
 const named={id:'named',name:'Named skill',scope:'local',sourceKind:'name',source:'Проект',metadataTokens:10,instructionTokens:20};
 const labeled={...named,id:'labeled',name:'Runtime skill',sourceKind:'label'};
 const legacy={...named,id:'legacy',name:'Legacy skill'};delete legacy.sourceKind;
 const panel=mountContextOverview({document:dom.window.document,target});
 const context={enabledCount:3,metadataTokens:30,entries:[named,labeled,legacy]};
 try {
  for(const language of ['en','ru','en']) {
   setLanguage(language);panel.render(context);
   const sources=[...target.querySelectorAll('tbody small')].map(element=>element.textContent);
   assert.deepEqual(sources,['Проект',language==='en'?'Project':'Проект','Проект']);
   for(const source of ['Проект','Личные','Системные']) {
    assert.equal(sourceLabel({scope:'local',source,sourceKind:'name'}),source);
    assert.equal(sourceLabel({scope:'global',source,sourceKind:'name'}),source);
    assert.equal(sourceLabel({scope:'local',source}),source);
    assert.equal(sourceLabel({scope:'plugin',source}),source);
   }
  }
 } finally {setLanguage('en');dom.window.close();}
});

test('chat fallback effort labels and tooltips follow locale before models are available', async () => {
 const {createSideChat}=await import('../ui/side-chat.mjs');
 const html=await readFile(new URL('../ui/index.html',import.meta.url),'utf8');
 for(const initialLanguage of ['en','ru']) {
  const dom=new JSDOM(html),win=dom.window,doc=win.document;
  Object.defineProperty(globalThis,'window',{configurable:true,value:win});
  Object.defineProperty(globalThis,'document',{configurable:true,value:doc});
  setLanguage(initialLanguage);
  let listener;const state={status:'signed-out',models:[],messages:[],authenticated:false};
  const chat={state,subscribe(fn){listener=fn;fn(state);return ()=>{};},destroy(){}};
  const panel=createSideChat({chat,readSnapshot:()=>null,openExternal:()=>{}});
  const check=language=>{
   const trigger=doc.getElementById('chat-effort');
   assert.equal(trigger.textContent,language==='ru'?'Авто':'Auto');
   assert.equal(trigger.title,language==='ru'?'Усилие из настроек Codex':'Reasoning effort from Codex settings');
   assert.equal(trigger.getAttribute('aria-label'),language==='ru'?'Усилие: Авто':'Reasoning effort: Auto');
   assert.equal(trigger.disabled,true);
  };
  try {
   check(initialLanguage);
   for(const status of ['starting','signed-out','error']) {
    state.status=status;listener(state);
    for(const language of ['ru','en','ru']) {setLanguage(language);panel.refreshLocale();check(language);}
   }
  } finally {await panel.destroy();setLanguage('en');win.close();}
 }
});
