import test from 'node:test';
import assert from 'node:assert/strict';
import { createSkillChats } from '../ui/skill-chats.mjs';

const ready = { revision:1, status:'ready', authenticated:true, messages:[], models:[], pending:false };
const snapshot = id => ({ skill:{id}, versions:{editor:id} });

test('each skill keeps its own session and resetting one never clears another', async t => {
  const states = new Map(), calls = [];
  const chat = createSkillChats(async (name, args) => {
    calls.push({name,args});
    if (name === 'chat_open') { const state = {...ready, sessionId:args.skillId}; states.set(args.skillId,state); return state; }
    if (name === 'chat_send') { const state = {...states.get(args.sessionId),revision:2,messages:[{role:'user',text:args.question}]}; states.set(args.sessionId,state); return state; }
    if (name === 'chat_reset') { const state = {...states.get(args.sessionId),revision:3,messages:[]}; states.set(args.sessionId,state); return state; }
    if (name === 'chat_poll') return states.get(args.sessionId);
    return {};
  }, {pollMs:100000});
  t.after(() => chat.destroy());
  chat.selectSkill('one'); await chat.send('First',snapshot('one'),'model','high');
  chat.selectSkill('two'); await chat.open();
  assert.deepEqual(chat.state.messages,[]);
  await chat.send('Second',snapshot('two'));
  chat.selectSkill('one');
  assert.deepEqual(chat.state.messages.map(message=>message.text),['First']);
  assert.equal(calls.find(call=>call.name==='chat_send').args.effort,'high');
  await chat.reset();
  chat.selectSkill('two');
  assert.deepEqual(chat.state.messages.map(message=>message.text),['Second']);
  assert.throws(() => chat.send('Wrong file',snapshot('one')),{code:'CHAT_SKILL_MISMATCH'});
});

test('a delayed reply from a background skill cannot replace the currently visible chat', async t => {
  let finish;
  const chat = createSkillChats(async (name,args) => {
    if (name === 'chat_open') return {...ready,sessionId:args.skillId};
    if (name === 'chat_send') return new Promise(resolve=>{finish=()=>resolve({...ready,sessionId:args.sessionId,revision:2,messages:[{text:'Only one'}]});});
    return {};
  },{pollMs:100000});
  t.after(() => chat.destroy());
  chat.selectSkill('one'); const sending=chat.send('First',snapshot('one'));
  await new Promise(resolve=>setImmediate(resolve));
  chat.selectSkill('two'); await chat.open(); finish(); await sending;
  assert.equal(chat.state.skillId,'two'); assert.deepEqual(chat.state.messages,[]);
  chat.selectSkill('one'); assert.equal(chat.state.messages[0].text,'Only one');
});
