import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFile } from 'node:fs/promises';

// Exercise the actual standalone HTML and MCP Apps handshake, without a browser or network.
test('the bundled sidebar app initializes and loads skills through the host bridge', async () => {
  const html = await readFile(new URL('../assets/app.html', import.meta.url), 'utf8');
  const errors = [], calls = [];
  const console = new VirtualConsole();
  console.on('jsdomError', error => errors.push(error));
  const dom = new JSDOM(html, {
    pretendToBeVisual: true, runScripts: 'dangerously', url: 'https://skills-studio.invalid', virtualConsole: console,
    beforeParse(win) {
      const host = { postMessage(message) {
        calls.push(message.method);
        if(message.method==='ui/initialize') calls.push(message.params.appCapabilities.availableDisplayModes);
        let result;
        if (message.method === 'ui/initialize') result = { protocolVersion: message.params.protocolVersion, hostInfo: { name:'test-host', version:'1' }, hostCapabilities: { serverTools:{} }, hostContext: { theme:'dark', displayMode:'inline', availableDisplayModes:['inline','fullscreen'] } };
        else if(message.method==='ui/request-display-mode') result={mode:'fullscreen'};
        else if (message.method === 'tools/call') {
          const name = message.params.name;
          if(name==='skills_studio.open') result = {content:[],structuredContent:{projects:[],selectedProjectId:null,warnings:[]}};
          else if(name==='skills_studio.list') result = {content:[],structuredContent:{skills:[{id:'one',name:'Bundled Skill',scope:'global',source:'Personal',readOnly:false}],warnings:[]}};
          else if(name==='skills_studio.read') result = {content:[],structuredContent:{id:'one',name:'Bundled Skill',path:'/skills/one/SKILL.md',content:'# Preview\n\n**Works**',revision:'r1',readOnly:false}};
        }
        if (result) queueMicrotask(() => win.dispatchEvent(new win.MessageEvent('message',{source:host,data:{jsonrpc:'2.0',id:message.id,result}})));
      } };
      Object.defineProperty(win,'parent',{value:host});
      win.Range.prototype.getClientRects = () => [];
      win.Range.prototype.getBoundingClientRect = () => ({x:0,y:0,left:0,top:0,right:0,bottom:0,width:0,height:0});
    },
  });
  try {
    const deadline=Date.now()+2500;
    while(Date.now()<deadline && !dom.window.document.querySelector('.skill-name') && !errors.length) await new Promise(resolve=>setTimeout(resolve,10));
    assert.deepEqual(errors.map(e=>e.message),[]);
    assert.equal(dom.window.document.querySelector('.skill-name')?.textContent,'Bundled Skill');
    assert.ok(calls.includes('ui/initialize'));
    assert.deepEqual(Array.from(calls.find(Array.isArray)), ['fullscreen']);
    assert.ok(calls.includes('ui/request-display-mode'), 'an inline initial placement is explicitly expanded');
    assert.equal(dom.window.document.querySelector('#project').disabled,false);
    dom.window.document.querySelector('.skill').click();
    const readDeadline = Date.now() + 2500;
    while (dom.window.document.querySelector('#mode-view').disabled && !errors.length && Date.now() < readDeadline) await new Promise(resolve => setTimeout(resolve,10));
    dom.window.document.querySelector('#mode-view').click();
    assert.equal(dom.window.document.querySelector('#markdown-view').hidden, false);
    assert.equal(dom.window.document.querySelector('#markdown-view h1')?.textContent, 'Preview');
    assert.equal(dom.window.document.querySelector('#markdown-view strong')?.textContent, 'Works');
    assert.deepEqual(errors.map(e=>e.message),[]);
  } finally { dom.window.close(); }
});

test('the bundled app uses App Server tools and shows replies in its right panel', async () => {
  const html = await readFile(new URL('../assets/app.html', import.meta.url), 'utf8');
  const errors = [], requests = [];
  const console = new VirtualConsole();
  console.on('jsdomError', error => errors.push(error));
  const dom = new JSDOM(html, {
    pretendToBeVisual: true, runScripts: 'dangerously', url: 'https://skills-studio.invalid', virtualConsole: console,
    beforeParse(win) {
      const host = { postMessage(message) {
        requests.push(message);
        let result;
        if (message.method === 'ui/initialize') result = { protocolVersion: message.params.protocolVersion, hostInfo: { name:'test-host', version:'1' }, hostCapabilities: { serverTools:{}, message:{text:{}}, updateModelContext:{text:{}} }, hostContext: { theme:'dark', displayMode:'fullscreen' } };
        else if (message.method === 'tools/call') {
          const name = message.params.name;
          if (name === 'skills_studio.open') result = { content:[], structuredContent:{ projects:[], selectedProjectId:null, warnings:[] } };
          else if (name === 'skills_studio.list') result = { content:[], structuredContent:{ skills:[{id:'one',name:'Example',scope:'global',readOnly:false}], warnings:[] } };
          else if (name === 'skills_studio.read') result = { content:[], structuredContent:{ id:'one', name:'Example', path:'/skills/example/SKILL.md', content:'# Original\n', revision:'r1', readOnly:false } };
          else if (name === 'skills_studio.chat_open') result = { content:[], structuredContent:{sessionId:'fixture',revision:1,status:'ready',authenticated:true,messages:[],models:[],pending:false} };
          else if (name === 'skills_studio.chat_poll') result = {content:[],structuredContent:{unchanged:true}};
          else if (name === 'skills_studio.chat_send') result = { content:[], structuredContent:{sessionId:'fixture',revision:2,status:'ready',authenticated:true,messages:[{id:'answer',role:'assistant',text:'**App Server works**',status:'completed'}],models:[],pending:false} };
        } else if (['ui/update-model-context', 'ui/message'].includes(message.method)) result = {};
        if (result) queueMicrotask(() => win.dispatchEvent(new win.MessageEvent('message', { source:host, data:{jsonrpc:'2.0',id:message.id,result} })));
      } };
      Object.defineProperty(win, 'parent', { value:host });
      win.Range.prototype.getClientRects = () => [];
      win.Range.prototype.getBoundingClientRect = () => ({x:0,y:0,left:0,top:0,right:0,bottom:0,width:0,height:0});
      win.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
      win.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new win.Event('close')); };
    },
  });
  const waitFor = async condition => {
    const deadline = Date.now() + 2500;
    while (!condition() && !errors.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(errors.map(error => error.message), []);
    assert.ok(condition(), 'UI operation completed');
  };
  try {
    const document = dom.window.document;
    await waitFor(() => document.querySelector('.skill'));
    document.querySelector('.skill').click();
    await waitFor(() => !document.querySelector('#ask').disabled);
    document.querySelector('#ask').click();
    await waitFor(() => !document.querySelector('#ask-send').disabled);
    assert.equal(document.querySelector('#chat-panel').hidden,false);
    assert.equal(document.querySelector('#ask-dialog'),null);
    document.querySelector('#ask-question').value = 'Помоги улучшить скилл';
    document.querySelector('#ask-send').click();
    await waitFor(() => document.querySelector('#chat-messages strong'));
    const request = requests.find(request => request.params?.name === 'skills_studio.chat_send');
    const context=request.params.arguments.document;
    assert.equal(context.versions.opened, '# Original\n');
    assert.equal(context.versions.editor, '# Original\n');
    assert.equal(context.skill.path, '/skills/example/SKILL.md');
    assert.equal(context.selection, null);
    assert.equal(document.querySelector('#chat-messages strong').textContent,'App Server works');
    assert.equal(request.params.arguments.question,'Помоги улучшить скилл');
    assert.equal(requests.some(request=>request.method==='ui/message'),false);
  } finally { dom.window.close(); }
});
