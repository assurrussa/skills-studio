import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppServerConnection, ChatService, discoverCodex } from '../src/app-server.mjs';

const fixture = fileURLToPath(new URL('./fixtures/app-server.mjs', import.meta.url));
const waitFor = async fn => { const end=Date.now()+3000; while (!await fn()) { assert.ok(Date.now()<end,'operation finished'); await new Promise(r=>setTimeout(r,20)); } };
async function setup(t, signedOut=false) {
  const stateDir = await mkdtemp(join(tmpdir(),'studio-chat-')), log = join(stateDir,'requests');
  const service = new ChatService({ stateDir, resolveCLI:async () => ({ path:process.execPath, version:'fixture', source:'test', args:[fixture] }), env:{ ...process.env, STUDIO_TEST_LOG:log, STUDIO_TEST_SIGNED_OUT:signedOut?'1':'0' } });
  t.after(async()=>{await service.close();await rm(stateDir,{recursive:true,force:true});});
  return {service, log};
}
const document = { skill:{id:'one',name:'Example',path:'/skills/example/SKILL.md'}, versions:{opened:'old',saved:'saved',editor:'new'},selection:{ranges:[{text:'new',from:0,to:3}]},dirty:true };

test('CLI discovery falls back from an unusable override to a compatible executable without a shell', async()=>{
  const tried=[];
  const found=await discoverCodex({env:{SKILLS_STUDIO_CODEX_PATH:'/missing/codex',PATH:'/custom/bin'},platform:'linux',home:'/test/home',probe:async path=>{tried.push(path);if(path==='/custom/bin/codex')return 'codex-cli 0.163.0';throw Error('missing');}});
  assert.equal(found.path,'/custom/bin/codex'); assert.equal(found.version,'0.163.0'); assert.equal(tried[0],'/missing/codex');
  await assert.rejects(discoverCodex({env:{PATH:''},platform:'linux',home:'/missing',probe:async()=>{throw Error('missing');}}),{code:'CLI_NOT_FOUND'});
});
test('stdio connection rejects server approval requests and cleans pending RPCs after a crash', async t=>{
  const root=await mkdtemp(join(tmpdir(),'studio-rpc-')),log=join(root,'log');
  const rpc=new AppServerConnection({path:process.execPath,args:[fixture],env:{...process.env,STUDIO_TEST_LOG:log}});
  t.after(async()=>{await rpc.close();await rm(root,{recursive:true,force:true});});
  await rpc.start(); await rpc.request('fixture/approval',{});
  await waitFor(async()=> (await readFile(log,'utf8')).includes('decline'));
  await assert.rejects(rpc.request('fixture/crash',{}),{code:'APP_SERVER_CLOSED'});
});
test('chat starts lazily, streams exact context, deduplicates sends and retains its transcript', async t=>{
  const {service,log}=await setup(t), opened=await service.open();
  assert.equal(opened.authenticated,true); assert.equal(opened.models[0].model,'fixture-model');
  const params={sessionId:opened.sessionId,requestId:'request-one',question:'Improve this',document,model:'fixture-model'};
  const started=await service.send(params); assert.equal(started.pending,true);
  await service.send(params);
  await assert.rejects(service.send({...params,requestId:'different'}),{code:'CHAT_BUSY'});
  await waitFor(()=>!service.poll({sessionId:opened.sessionId}).pending);
  const done=service.poll({sessionId:opened.sessionId});
  assert.equal(done.messages[0].text,'Improve this'); assert.equal(done.messages[1].text,'Hello **world**');
  assert.equal(done.messages[1].status,'completed'); assert.equal(done.messages.length,2);
  assert.equal(service.poll({sessionId:opened.sessionId,afterRevision:done.revision}).unchanged,true);
  const requests=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(requests.filter(r=>r.method==='turn/start').length,1);
  const thread=requests.find(r=>r.method==='thread/start').params;
  assert.equal(thread.ephemeral,true); assert.equal(thread.sandbox,'read-only'); assert.equal(thread.approvalPolicy,'never');
  const turn=requests.find(r=>r.method==='turn/start').params;
  assert.equal(JSON.parse(turn.input[1].text).document.versions.opened,'old');
  assert.equal(JSON.parse(turn.input[1].text).document.versions.editor,'new');
  assert.equal(JSON.parse(turn.input[1].text).document.selection.ranges[0].text,'new');
  await assert.rejects(service.send({...params,question:'different payload'}),{code:'REQUEST_REUSED'});
});
test('browser login refreshes authentication without returning credentials', async t=>{
  const {service}=await setup(t,true), state=await service.open();
  assert.equal(state.authenticated,false);
  await assert.rejects(service.send({sessionId:state.sessionId,requestId:'no-login',question:'Hi',document}),{code:'LOGIN_REQUIRED'});
  const login=await service.login({sessionId:state.sessionId}); assert.match(login.authUrl,/^https:\/\/auth.openai.com\//);
  await waitFor(()=>service.poll({sessionId:state.sessionId}).authenticated);
  assert.doesNotMatch(JSON.stringify(service.poll({sessionId:state.sessionId})),/accessToken|refreshToken|authUrl/);
});
test('chat sends supported reasoning effort and Auto resets a previous override to Codex settings', async t=>{
  const {service,log}=await setup(t), opened=await service.open({skillId:'one'});
  assert.equal(opened.models[0].supportedReasoningEfforts?.[1]?.reasoningEffort,'high');
  assert.equal(opened.defaultReasoningEffort,'medium');
  const params={sessionId:opened.sessionId,question:'Explain',document,model:'fixture-model'};
  await assert.rejects(service.send({...params,requestId:'wrong-file',document:{...document,skill:{...document.skill,id:'two'}}}),{code:'CHAT_SKILL_MISMATCH'});
  await assert.rejects(service.send({...params,requestId:'unsupported',effort:'ultra'}),{code:'EFFORT_UNSUPPORTED'});
  await service.send({...params,requestId:'high',effort:'high'});
  await waitFor(()=>!service.poll({sessionId:opened.sessionId}).pending);
  await assert.rejects(service.send({...params,requestId:'high',effort:'medium'}),{code:'REQUEST_REUSED'});
  await service.send({...params,requestId:'auto'});
  const turns=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse).filter(request=>request.method==='turn/start');
  assert.deepEqual(turns.map(turn=>turn.params.effort),['high','medium']);
});
test('stop, reset and session disposal isolate conversations', async t=>{
  const {service}=await setup(t), first=await service.open(), second=await service.open();
  await service.send({sessionId:first.sessionId,requestId:'stop',question:'Hi',document});
  await service.stop({sessionId:first.sessionId});
  assert.equal(service.poll({sessionId:first.sessionId}).messages[1].status,'interrupted');
  assert.equal(service.poll({sessionId:second.sessionId}).messages.length,0);
  const reset=await service.reset({sessionId:first.sessionId}); assert.equal(reset.messages.length,0);
  await service.dispose({sessionId:first.sessionId});
  assert.throws(()=>service.poll({sessionId:first.sessionId}),{code:'CHAT_SESSION_EXPIRED'});
});
test('stopping one skill leaves another skill generating on its own thread', async t=>{
  const {service,log}=await setup(t), first=await service.open({skillId:'one'}), second=await service.open({skillId:'two'});
  await Promise.all([
    service.send({sessionId:first.sessionId,requestId:'first',question:'First skill',document,effort:'high'}),
    service.send({sessionId:second.sessionId,requestId:'second',question:'Second skill',document:{...document,skill:{...document.skill,id:'two'}},effort:'medium'}),
  ]);
  await service.stop({sessionId:first.sessionId});
  await waitFor(()=>!service.poll({sessionId:second.sessionId}).pending);
  assert.equal(service.poll({sessionId:first.sessionId}).messages.at(-1).status,'interrupted');
  assert.equal(service.poll({sessionId:second.sessionId}).messages.at(-1).status,'completed');
  const turns=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse).filter(request=>request.method==='turn/start');
  assert.notEqual(turns[0].params.threadId,turns[1].params.threadId);
});

test('finishing the last old session cannot erase a newer connection', async t=>{
  const {service}=await setup(t),first=await service.open(),oldRPC=service.rpc;
  let release;const gate=new Promise(r=>release=r),close=oldRPC.close.bind(oldRPC);
  oldRPC.close=async()=>{await close();await gate;};
  const disposing=service.dispose({sessionId:first.sessionId});
  await waitFor(()=>service.rpc===null);
  await service.open();const connection=service.connecting;
  release();await disposing;
  assert.equal(service.connecting,connection);
});
test('disposing the last skill during rediscovery prevents an unused replacement process', async t=>{
  const {service,log}=await setup(t),opened=await service.open({skillId:'one'});
  await service.rpc.close();
  const resolveCLI=service.resolveCLI;let release;
  service.resolveCLI=async()=>{await new Promise(resolve=>{release=resolve;});return resolveCLI();};
  const sending=service.send({sessionId:opened.sessionId,requestId:'reconnect',question:'Hello',document}).catch(error=>error);
  await waitFor(()=>Boolean(release));
  await service.dispose({sessionId:opened.sessionId});release();
  const result=await sending;
  assert.equal(result.code,'CHAT_SESSION_EXPIRED');
  assert.equal(service.sessions.size,0);assert.equal(service.rpc,null);
  const requests=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(requests.filter(request=>request.method==='thread/start').length,0);
});

test('stopping a question before its thread starts never closes another chat connection',async t=>{
 const {service}=await setup(t),first=await service.open(),second=await service.open();
 await service.send({sessionId:first.sessionId,requestId:'other',question:'Other chat',document});
 const rpc=service.rpc,request=rpc.request.bind(rpc);let release;
 rpc.request=async(method,params)=>{if(method==='thread/start')await new Promise(r=>release=r);return request(method,params);};
 const sending=service.send({sessionId:second.sessionId,requestId:'cancel-early',question:'Cancel me',document}).catch(error=>error);
 await waitFor(()=>Boolean(release));
 try{await service.stop({sessionId:second.sessionId});assert.ok(service.rpc===rpc,'the shared connection remains available');}
 finally{release();await sending;}
 const stopped=service.poll({sessionId:second.sessionId});assert.equal(stopped.pending,false);assert.equal(stopped.messages.at(-1).status,'interrupted');
});
test('reset reserves its session while the old thread is being released',async t=>{
 const {service}=await setup(t),opened=await service.open();
 await service.send({sessionId:opened.sessionId,requestId:'first',question:'Hello',document});await waitFor(()=>!service.poll({sessionId:opened.sessionId}).pending);
 const rpc=service.rpc,request=rpc.request.bind(rpc);let release;
 rpc.request=async(method,params)=>{if(method==='thread/unsubscribe')await new Promise(r=>release=r);return request(method,params);};
 const reset=service.reset({sessionId:opened.sessionId});await waitFor(()=>Boolean(release));
 try{await assert.rejects(service.send({sessionId:opened.sessionId,requestId:'during-reset',question:'Do not lose me',document}),{code:'CHAT_BUSY'});}
 finally{release();await reset;}
 assert.equal(service.poll({sessionId:opened.sessionId}).pending,false);
});

test('closing during CLI discovery prevents a late background process from starting',async()=>{
 let release;
 const service=new ChatService({stateDir:join(tmpdir(),'studio-late-start'),resolveCLI:()=>new Promise(r=>release=r)});
 const opening=service.open();await service.close();release({path:process.execPath,args:[fixture],source:'test',version:'fixture'});
 await assert.rejects(opening,{code:'CHAT_CLOSED'});assert.equal(service.rpc,undefined);
});
test('sign-in after reconnect starts a fresh browser flow in the replacement process',async t=>{
 const {service,log}=await setup(t,true),first=await service.open();await service.login({sessionId:first.sessionId});await service.dispose({sessionId:first.sessionId});
 const second=await service.open();assert.equal(second.authenticated,false);await service.login({sessionId:second.sessionId});
 const requests=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(requests.filter(r=>r.method==='account/login/start').length,2);
});
