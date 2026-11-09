import { renderMarkdown } from './preview.mjs';
import { createModelPicker } from './model-picker.mjs';

export function createSideChat({chat,readSnapshot,openExternal}) {
  const $=id=>document.getElementById(id), panel=$('chat-panel'), workspace=document.querySelector('.workspace');
  const abort=new window.AbortController(),on=(id,type,fn)=>$(id).addEventListener(type,fn,{signal:abort.signal});
  let selected=null,localError='',messageSignature='',loginBusy=false,skillId=null;
  const forms=new Map();
  const modelPicker=createModelPicker({trigger:$('chat-model'),popup:$('chat-model-menu'),options:$('chat-model-options')});
  const effortPicker=createModelPicker({trigger:$('chat-effort'),popup:$('chat-effort-menu'),options:$('chat-effort-options'),labelPrefix:'Усилие',listLabel:'Усилие модели'});
  effortPicker.setOptions([{model:'',displayName:'Авто',description:'Усилие из настроек Codex'}]);
  function error(value){localError=value||'';$('ask-error').textContent=localError;$('ask-error').hidden=!localError;}
  function remember(){if(skillId)forms.set(skillId,{question:$('ask-question').value,model:$('chat-model').value,effort:$('chat-effort').value,selected,error:localError,scrollTop:$('chat-messages').scrollTop});}
  function report(id,value){if(skillId===id)error(value);else forms.set(id,{...forms.get(id),error:value||''});}
  function synchronize(current){
    const next=current?.skill.id||null;if(next===skillId)return;
    remember();skillId=next;const form=forms.get(skillId)||{};
    selected=form.selected||null;$('ask-question').value=form.question||'';error(form.error);
    modelPicker.setValue(form.model);effortPicker.setValue(form.effort);messageSignature='';
    chat.selectSkill?.(skillId);
    $('chat-messages').scrollTop=form.scrollTop??$('chat-messages').scrollHeight;
  }
  function context(current=readSnapshot()){
    if(selected&&(selected.skill.id!==current?.skill.id||selected.versions.editor!==current.versions.editor))selected=null;
    if(current)current.selection=selected?.selection||null;
    return current;
  }
  function refreshContext(){
    const snapshot=readSnapshot();synchronize(snapshot);
    const current=context(snapshot),ranges=current?.selection?.ranges||[];
    $('ask-context').textContent=current?`${current.skill.name}${current.dirty?' · есть правки':''}${ranges.length?' · выделение':''}`:'Скилл не выбран';
    $('ask-context').title=current?.skill.path||'';
    $('ask-selection').textContent=ranges.map(range=>range.text).join('\n…\n').slice(0,2000);
    $('ask-selection').hidden=!ranges.length;$('chat-clear-selection').hidden=!ranges.length;
  }
  function refreshEffort(state){
    if(!state.models?.length&&state.status!=='ready')return false;
    const model=state.models?.find(model=>model.model===$('chat-model').value);
    const supported=model?.supportedReasoningEfforts||[];
    const fallback=supported.some(option=>option.reasoningEffort===state.defaultReasoningEffort)?state.defaultReasoningEffort:model?.defaultReasoningEffort;
    const names={none:'None',minimal:'Minimal',low:'Low',medium:'Medium',high:'High',xhigh:'Extra high',max:'Max',ultra:'Ultra'};
    effortPicker.setOptions([{model:'',displayName:'Авто',isDefault:true,description:fallback?`Усилие: Авто (${fallback})`:'Усилие из настроек Codex'},...supported.map(option=>({model:option.reasoningEffort,displayName:names[option.reasoningEffort]||option.reasoningEffort,description:option.description}))]);
    return supported.length>0;
  }
  function render(state){
    modelPicker.setOptions(state.models);
    const hasEffort=refreshEffort(state);
    const busy=state.pending||state.resetting||chat.sending;
    $('ask-send').disabled=!skillId||state.status!=='ready'||!state.authenticated||busy;modelPicker.setDisabled(!skillId||busy||state.status!=='ready');effortPicker.setDisabled(!skillId||busy||state.status!=='ready'||!hasEffort);
    $('ask-send').hidden=Boolean(state.pending);$('chat-stop').hidden=!state.pending;$('chat-new').disabled=!skillId||Boolean(busy);
    $('chat-connection').textContent=state.status==='starting'?'Запуск App Server…':state.status==='ready'?`${state.cli?.source||'Codex'}${state.account?.planType?' · '+state.account.planType:state.account?.type==='apiKey'?' · API key':''}`:state.status==='signed-out'?'Требуется вход':'Нет соединения';
    $('chat-connection').title=state.cli?`Codex CLI ${state.cli.version}`:'';
    $('chat-setup').hidden=!['starting','signed-out','error'].includes(state.status);
    $('chat-setup-text').textContent=state.status==='starting'?'Подключаем локальный помощник…':state.status==='signed-out'?'Войдите через ChatGPT, чтобы использовать доступные вашему аккаунту модели.':state.error||'Не удалось подключиться.';
    $('chat-login').hidden=state.status!=='signed-out';$('chat-login').disabled=loginBusy;
    $('chat-retry').hidden=state.status!=='error';$('chat-install').hidden=state.status!=='error';
    const signature=JSON.stringify(state.messages);
    if(signature!==messageSignature){
      messageSignature=signature;const messages=$('chat-messages'),atBottom=messages.scrollHeight-messages.scrollTop-messages.clientHeight<80;
      messages.replaceChildren();
      if(!state.messages.length){const empty=document.createElement('p');empty.className='chat-empty';empty.textContent='Обсудите структуру скилла, выделенный фрагмент или текущие правки.';messages.append(empty);}
      for(const message of state.messages){
        const article=document.createElement('article');article.className=`chat-message chat-${message.role}`;article.dataset.messageId=message.id;
        const label=document.createElement('div');label.className='chat-role';label.textContent=message.role==='user'?'Вы':'Помощник';
        const body=document.createElement('div');body.className='chat-message-body';
        if(message.role==='assistant'&&message.text)renderMarkdown(body,message.text);else body.textContent=message.text||(message.status==='streaming'?'Думает…':message.status==='interrupted'?'Генерация остановлена':'Ответ не получен');
        article.append(label,body);
        if(message.status==='interrupted'){const status=document.createElement('small');status.textContent='Остановлено';article.append(status);}
        messages.append(article);
      }
      if(atBottom)messages.scrollTop=messages.scrollHeight;
    }
    if(state.error)error(state.error);
    refreshContext();
  }
  const unsubscribe=chat.subscribe(render);
  async function connect(){const id=skillId;try{await chat.open();}catch(cause){report(id,cause.message);}}
  async function open(snapshot){
    refreshContext();if(snapshot?.selection)selected=structuredClone(snapshot);
    panel.hidden=false;workspace.classList.add('chat-open');chat.setVisible(true);refreshContext();
    $('ask').setAttribute('aria-expanded','true');$('ask-question').focus();await connect();
  }
  async function send(){
    if(chat.sending||chat.state.pending)return;
    const question=$('ask-question').value.trim();if(!question){error('Введите вопрос.');$('ask-question').focus();return;}
    const snapshot=context(),id=skillId;error('');remember();
    try{
      await chat.send(question,snapshot,$('chat-model').value||undefined,$('chat-effort').value||undefined);report(id,'');
      if(skillId===id){if($('ask-question').value.trim()===question)$('ask-question').value='';selected=null;refreshContext();}
      else {const form=forms.get(id);if(form){if(form.question?.trim()===question)form.question='';form.selected=null;}}
    }
    catch(cause){report(id,cause.message);}
  }
  on('chat-close','click',()=>{modelPicker.close();effortPicker.close();panel.hidden=true;workspace.classList.remove('chat-open');chat.setVisible(false);$('ask').setAttribute('aria-expanded','false');$('ask').focus();});
  on('chat-model','change',()=>{render(chat.state);remember();});
  on('chat-effort','change',remember);
  on('ask-send','click',send);
  on('ask-question','keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();void send();}});
  on('chat-clear-selection','click',()=>{selected=null;refreshContext();});
  on('chat-stop','click',async()=>{const id=skillId;try{await chat.stop();}catch(cause){report(id,cause.message);}});
  on('chat-new','click',async()=>{const id=skillId;try{await chat.reset();report(id,'');}catch(cause){report(id,cause.message);}});
  on('chat-retry','click',async()=>{const id=skillId;error('');try{await chat.reconnect();}catch(cause){report(id,cause.message);}});
  on('chat-login','click',async()=>{
    if(loginBusy)return;const id=skillId;loginBusy=true;render(chat.state);error('');
    try{const {authUrl}=await chat.login();await openExternal(authUrl);}catch(cause){report(id,cause.message);}
    finally{loginBusy=false;render(chat.state);}
  });
  return {open,refreshContext,destroy(){modelPicker.destroy();effortPicker.destroy();forms.clear();abort.abort();unsubscribe();return chat.destroy();}};
}
