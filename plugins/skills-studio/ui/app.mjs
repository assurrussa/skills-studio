import { t, localizeService } from './i18n.mjs';
import { App } from '@modelcontextprotocol/ext-apps';
import { mountStudio } from './view.mjs';
import { createSkillChats } from './skill-chats.mjs';

const app = new App({ name: 'Skills Studio', version: '0.2.6' }, { availableDisplayModes:['fullscreen'] }, { autoResize: false });
let ui;
app.onhostcontextchanged = context => { if (context.theme) ui?.applyTheme(context.theme); };
app.onteardown = async () => { await ui?.destroy(); return {}; };

async function call(name, args = {}) {
  const result = await app.callServerTool({ name: 'skills_studio.' + name, arguments: args });
  const data = result.structuredContent;
  if (result.isError) throw Object.assign(new Error(data?.message || result.content?.find(x => x.type === 'text')?.text || t('Ошибка сервера.')), { code: data?.code });
  if (!data) throw new Error(t('Сервер вернул пустой ответ.'));
  return data;
}

async function start() {
  await app.connect();
  const context = app.getHostContext();
  if (context?.displayMode !== 'fullscreen' && context?.availableDisplayModes?.includes('fullscreen')) {
    // Request the plugin's presentation only; native neighboring tabs belong to the host.
    await app.requestDisplayMode({mode:'fullscreen'}, {timeout:3000}).catch(()=>{});
  }
  ui = mountStudio({ call, chat: createSkillChats(call), openExternal:async url => { const result = await app.openLink({url}); if(result.isError) throw new Error(t('Не удалось открыть браузер для входа.')); }, theme: app.getHostContext()?.theme || 'dark' });
  await ui.controller.initialize();
}
start().catch(error => {
  document.getElementById('status').textContent = t('Не удалось подключиться');
  const banner = document.getElementById('error');
  banner.hidden = false;
  banner.textContent = localizeService(error.message) + '\n' + t('Откройте Skills Studio из панели плагинов Codex. Если плагин установлен впервые, откройте новый чат или перезапустите приложение.');
});
