import { createAppServerChat } from './chat.mjs';

const idle = { status:'idle', authenticated:false, messages:[], models:[], pending:false };

export function createSkillChats(call, options) {
  const entries = new Map(), listeners = new Set();
  let active = null, visible = false, destroyed = false;
  const state = () => ({ ...(active?.client.state || idle), skillId:active?.id || null });
  const emit = () => { if (!destroyed) for (const listener of listeners) listener(state()); };
  function current() {
    if (destroyed) throw Object.assign(new Error('Панель чата закрыта.'), { code:'CHAT_CLOSED' });
    if (!active) throw Object.assign(new Error('Сначала выберите скилл.'), { code:'SKILL_REQUIRED' });
    return active.client;
  }
  function selectSkill(id) {
    if (destroyed || active?.id === id || !active && !id) return;
    active?.client.setVisible(false);
    active = id ? entries.get(id) : null;
    if (id && !active) {
      const entry = { id, client:createAppServerChat((name, args) => call(name, name === 'chat_open' ? { ...args, skillId:id } : args), options) };
      entries.set(id, entry); active = entry;
      entry.unsubscribe = entry.client.subscribe(() => { if (active === entry) emit(); });
    }
    emit(); active?.client.setVisible(visible);
    if (visible && active) void active.client.open().catch(() => {});
  }
  return {
    available:true,
    get state() { return state(); },
    get sending() { return active?.client.sending || false; },
    selectSkill,
    subscribe(listener) { listeners.add(listener); listener(state()); return () => listeners.delete(listener); },
    open:() => current().open(), poll:() => current().poll(),
    setVisible(value) { visible = Boolean(value); active?.client.setVisible(visible); },
    send(question, document, model, effort) {
      const client = current();
      if (document?.skill?.id !== active.id) throw Object.assign(new Error('Этот чат относится к другому скиллу.'), { code:'CHAT_SKILL_MISMATCH' });
      return client.send(question, document, model, effort);
    },
    login:() => current().login(), stop:() => current().stop(), reset:() => current().reset(), reconnect:() => current().reconnect(),
    async destroy() {
      destroyed = true; listeners.clear();
      for (const entry of entries.values()) entry.unsubscribe();
      await Promise.all([...entries.values()].map(entry => entry.client.destroy()));
      entries.clear(); active = null;
    },
  };
}
