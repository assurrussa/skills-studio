import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let signedIn = process.env.STUDIO_TEST_SIGNED_OUT !== '1', thread = 0, turn = 0;
const active = new Map();
readline.createInterface({ input:process.stdin }).on('line', line => {
  const request = JSON.parse(line), { id, method, params } = request;
  if (process.env.STUDIO_TEST_LOG) appendFileSync(process.env.STUDIO_TEST_LOG, JSON.stringify(request) + '\n');
  if (id === undefined || !method) return;
  let result = {};
  if (method === 'initialize') result = { userAgent:'fixture' };
  else if (method === 'account/read') result = { account:signedIn ? { type:'chatgpt', planType:'plus' } : null, requiresOpenaiAuth:true };
  else if (method === 'model/list') result = { data:[{ id:'fixture', model:'fixture-model', displayName:'Fixture', isDefault:true, hidden:false, defaultReasoningEffort:'medium', supportedReasoningEfforts:[{reasoningEffort:'medium',description:'Balanced'},{reasoningEffort:'high',description:'More reasoning'}] }], nextCursor:null };
  else if (method === 'config/read') result = { config:{model_reasoning_effort:'medium'} };
  else if (method === 'account/login/start') {
    result = { type:'chatgpt', loginId:'login', authUrl:'https://auth.openai.com/authorize?state=fixture' };
    setTimeout(() => { signedIn = true; send({ method:'account/login/completed', params:{ loginId:'login', success:true } }); }, 40);
  } else if (method === 'thread/start') result = { thread:{ id:'thread-' + ++thread } };
  else if (method === 'turn/start') {
    const current = { threadId:params.threadId, turnId:'turn-' + ++turn };
    active.set(params.threadId,current);
    result = { turn:{ id:current.turnId, status:'inProgress', items:[] } };
    send({ method:'turn/started', params:{ threadId:current.threadId, turn:result.turn } });
    setTimeout(() => {
      if (active.get(current.threadId) !== current) return;
      send({ method:'item/agentMessage/delta', params:{ ...current, itemId:'reply', delta:'Hello ' } });
      send({ method:'item/agentMessage/delta', params:{ ...current, itemId:'reply', delta:'**world**' } });
      send({ method:'item/completed', params:{ ...current, item:{ id:'reply', type:'agentMessage', text:'Hello **world**' } } });
      send({ method:'turn/completed', params:{ threadId:current.threadId, turn:{ id:current.turnId, status:'completed' } } });
    }, 150);
  } else if (method === 'turn/interrupt') {
    active.delete(params.threadId);
    send({ method:'turn/completed', params:{ threadId:params.threadId, turn:{ id:params.turnId, status:'interrupted' } } });
  } else if (method === 'fixture/crash') process.exit(7);
  else if (method === 'fixture/approval') send({ id:'approval', method:'item/commandExecution/requestApproval', params:{} });
  send({ id, result });
});
