import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppServerChat } from '../ui/chat.mjs';
const initial = {sessionId:'one',revision:1,authenticated:true,status:'ready',messages:[],models:[],pending:false};

test('the chat client starts lazily and sends one question with its exact snapshot', async()=>{
  const requests=[];let release;
  const chat=createAppServerChat(async(name,args)=>{requests.push({name,args});if(name==='chat_open')return initial;if(name==='chat_send')return new Promise(r=>{release=()=>r({...initial,revision:2,pending:true});});return {};},{pollMs:100000});
  assert.equal(requests.length,0);
  const context={versions:{editor:'unsaved'},selection:{ranges:[{text:'selected'}]}};
  const pending=chat.send('Question',context,'fixture-model','high');
  await new Promise(r=>setImmediate(r));
  await assert.rejects(chat.send('Duplicate',context),{code:'CHAT_BUSY'});
  assert.deepEqual(requests[1].args.document,context);assert.equal(requests[1].name,'chat_send');
  assert.equal(requests[1].args.effort,'high');
  release();await pending;assert.equal(chat.state.pending,true);await chat.destroy();
  assert.equal(requests.at(-1).name,'chat_close');
});
test('late polling never overwrites a newer conversation revision', async()=>{
  let finishPoll;
  const chat=createAppServerChat(async name=>{if(name==='chat_open')return initial;if(name==='chat_poll')return new Promise(r=>finishPoll=r);if(name==='chat_reset')return {...initial,revision:4,messages:[]};return {};},{pollMs:100000});
  await chat.open();const poll=chat.poll();await chat.reset();finishPoll({...initial,revision:2,messages:[{text:'outdated'}]});await poll;
  assert.equal(chat.state.revision,4);assert.deepEqual(chat.state.messages,[]);await chat.destroy();
});
test('a rejected send is not automatically retried and can be inspected through polling', async()=>{
  let sends=0;
  const chat=createAppServerChat(async name=>{if(name==='chat_open')return initial;if(name==='chat_send'){sends++;throw Error('No connection');}if(name==='chat_poll')return {...initial,revision:2,pending:true};return {};},{pollMs:100000});
  await assert.rejects(chat.send('Question',null),/No connection/);await chat.poll();assert.equal(chat.state.pending,true);assert.equal(sends,1);await chat.destroy();
});
test('destroying an opening panel disposes a late-created server session', async()=>{
  const calls=[];let resolveOpen;
  const chat=createAppServerChat(async name=>{calls.push(name);if(name==='chat_open')return new Promise(r=>resolveOpen=r);return {};},{pollMs:100000});
  const pending=chat.open();const destroyed=chat.destroy();resolveOpen(initial);await pending;await destroyed;
  assert.deepEqual(calls,['chat_open','chat_close']);
});

test('a poll from a closed session cannot replace a reconnected chat', async()=>{
  let finishPoll, opens=0;
  const chat=createAppServerChat(async name=>{if(name==='chat_open')return {...initial,sessionId:++opens===1?'old':'new'};if(name==='chat_poll')return new Promise(r=>finishPoll=r);return {};},{pollMs:100000});
  await chat.open();const pending=chat.poll();await chat.reconnect();finishPoll({...initial,sessionId:'old',revision:50,messages:[{text:'old conversation'}]});await pending;
  assert.equal(chat.state.sessionId,'new');assert.equal(chat.state.messages.length,0);await chat.destroy();
});

test('reset disables sending until its server operation completes',async()=>{
 let release;
 const chat=createAppServerChat(async name=>{if(name==='chat_open')return initial;if(name==='chat_reset')return new Promise(r=>release=()=>r({...initial,revision:2}));return {};},{pollMs:100000});
 await chat.open();const resetting=chat.reset();await new Promise(r=>setImmediate(r));assert.equal(chat.sending,true);
 await assert.rejects(chat.send('Concurrent question',null),{code:'CHAT_BUSY'});release();await resetting;assert.equal(chat.sending,false);await chat.destroy();
});
