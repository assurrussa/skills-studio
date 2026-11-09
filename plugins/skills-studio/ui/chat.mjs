const failure=(code,message)=>Object.assign(new Error(message),{code});

export function createAppServerChat(call,{pollMs=800}={}) {
  let state={status:'idle',authenticated:false,messages:[],models:[],pending:false},opening=null,timer,visible=false,destroyed=false,sending=false,polling=false;
  const listeners=new Set();
  const emit=()=>{if(!destroyed)for(const listener of listeners)listener(state);};
  function apply(next){if(destroyed||next?.unchanged)return;if(next.sessionId===state.sessionId&&next.revision<state.revision)return;state={...state,...next};emit();}
  function schedule(){clearTimeout(timer);if(!destroyed&&visible&&state.sessionId){timer=setTimeout(()=>{void poll().finally(schedule);},pollMs);timer.unref?.();}}
  async function open(){
    if(destroyed)throw failure('CHAT_CLOSED','Панель чата закрыта.');
    if(state.sessionId)return state;
    if(opening)return opening;
    state={...state,status:'starting',error:null};emit();
    opening=call('chat_open').then(async next=>{
      if(destroyed){await call('chat_close',{sessionId:next.sessionId}).catch(()=>{});return next;}
      apply(next);schedule();return state;
    }).catch(error=>{if(!destroyed){state={...state,status:'error',error:error.message};emit();}throw error;}).finally(()=>{opening=null;});
    return opening;
  }
  async function poll(){
    if(destroyed||!state.sessionId||polling)return;
    const sessionId=state.sessionId;
    polling=true;
    try{const next=await call('chat_poll',{sessionId,afterRevision:state.revision});if(state.sessionId===sessionId)apply(next);}
    catch(error){if(state.sessionId!==sessionId||destroyed)return;state={...state,error:error.message};if(error.code==='CHAT_SESSION_EXPIRED'){state.sessionId=null;state.status='error';state.pending=false;}emit();}
    finally{polling=false;}
  }
  async function operation(name,args={}){await open();const sessionId=state.sessionId;const next=await call(name,{sessionId,...args});if(state.sessionId===sessionId)apply(next);return next;}
  return {
    available:true,
    get state(){return state;},get sending(){return sending;},
    subscribe(listener){listeners.add(listener);listener(state);return()=>listeners.delete(listener);},
    open,poll,
    async reconnect(){if(state.pending||sending)throw failure('CHAT_BUSY','Сначала остановите генерацию.');if(state.sessionId)await call('chat_close',{sessionId:state.sessionId}).catch(()=>{});state={status:'idle',authenticated:false,messages:[],models:[],pending:false};return open();},
    setVisible(value){visible=value;if(value&&state.sessionId)void poll().then(schedule);else schedule();},
    async send(question,document,model,effort){
      if(sending||state.pending)throw failure('CHAT_BUSY','Вопрос уже отправляется.');
      sending=true;emit();
      try{return await operation('chat_send',{requestId:globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random()}`,question,document,...(model?{model}:{}),...(effort?{effort}:{})});}
      finally{sending=false;emit();}
    },
    async login(){await open();return call('chat_login',{sessionId:state.sessionId});},
    stop:()=>operation('chat_stop'),
    async reset(){if(sending||state.pending)throw failure('CHAT_BUSY','Сначала завершите текущую операцию.');sending=true;emit();try{return await operation('chat_reset');}finally{sending=false;emit();}},
    async destroy(){destroyed=true;visible=false;clearTimeout(timer);listeners.clear();if(opening)await opening.catch(()=>{});if(state.sessionId)await call('chat_close',{sessionId:state.sessionId}).catch(()=>{});},
  };
}
