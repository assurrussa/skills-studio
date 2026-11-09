import { mountCatalog, availabilityLabel, matchesStatus } from './catalog.mjs';
import { Decoration, EditorView, keymap } from '@codemirror/view';
import { Compartment, EditorState } from '@codemirror/state';
import { basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { StudioController } from './controller.mjs';
import { createProjectPicker } from './project-picker.mjs';
import { createUnifiedDiff } from './diff.mjs';
import { createSkillMenu } from './skill-menu.mjs';
import { renderMarkdown } from './preview.mjs';
import { createSelectionMenu } from './selection-menu.mjs';
import { createSideChat } from './side-chat.mjs';

export function mountStudio({ call, chat = null, openExternal = url => window.open(url, '_blank', 'noopener,noreferrer'), theme = 'dark' }) {
  const $ = id => document.getElementById(id);
  const readOnly = new Compartment(), appearance = new Compartment(), diffAppearance = new Compartment();
  let currentId = null, listSignature = '', syncing = false, editorReadOnly = true;
  let mode = 'view', diffSignature = '', previewSignature = '';
  const modes = ['view', 'edit', 'diff'];
  let selectionMenu = null, sideChat = null;
  let search = '', statusFilter = 'all';
  const abort = new window.AbortController();
  const on = (element, type, fn) => element.addEventListener(type, fn, { signal: abort.signal });
  const controller = new StudioController(call, render);
  const catalog = mountCatalog({document,controller,perform,overview:()=>switchDocument(options=>controller.overview(options)),onFilter:value=>{statusFilter=value;catalog.render(controller.state);renderList(controller.state);}});
  const skillMenu = createSkillMenu({ document, onAction:(action, skill) => perform(() => handleSkillAction(action, skill)) });
  const projectPicker = createProjectPicker({ trigger: $('project'), popup: $('project-menu'), search: $('project-filter'), options: $('project-options'), onSelect: next => switchDocument(options => controller.selectProject(next, options)) });
  const editor = new EditorView({ parent: $('editor'), state: EditorState.create({ extensions: editorExtensions() }) });
  const diffEditor = new EditorView({ parent: $('diff-code'), state: EditorState.create({ extensions: diffExtensions() }) });
  selectionMenu = createSelectionMenu({ editor, readContext:() => chat?.available && !controller.state.busy ? readChatSnapshot() : null, onAsk:openAsk });

  if (chat) sideChat = createSideChat({ chat, readSnapshot:readChatSnapshot, openExternal });

  function applyTheme(value) {
    const dark = value !== 'light';
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    editor.dispatch({ effects: appearance.reconfigure(dark ? oneDark : []) });
    diffEditor.dispatch({ effects: diffAppearance.reconfigure(dark ? oneDark : []) });
  }
  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function renderList(state) {
    const signature = JSON.stringify([state.skills, state.projectId, state.current?.id, state.busy, state.hideSystemSkills, state.collapsedSections, search, statusFilter, state.hidePluginSkills]);
    if (signature === listSignature) return;
    listSignature = signature;
    const nav = $('skills');
    const focusedSection = nav.contains(document.activeElement) ? document.activeElement.closest('.section-heading')?.dataset.sectionId : null;
    nav.replaceChildren();
    const visibleSkills = state.skills.filter(skill => (!state.hideSystemSkills || !skill.system) && (!state.hidePluginSkills || skill.scope !== 'plugin'));
    const items = visibleSkills.filter(skill => matchesStatus(skill,statusFilter)).filter(skill => `${skill.name} ${skill.description || ''} ${skill.source || ''} ${skill.agentSkill ? 'AgentSkill Skills agentSkill ai skills add' : ''} ${skill.git ? 'Git' : ''} ${skill.disabled || skill.availability?.status === 'disabled' ? 'Disabled выключен' : ''}`.toLocaleLowerCase().includes(search));
    const sections = [];
    if (state.projectId) sections.push({ id: `local:${state.projectId}`, title: 'Локальные', group: items.filter(x => x.scope === 'local') });
    sections.push({ id: 'global', title: 'Глобальные', group: items.filter(x => x.scope === 'global') });
    if (!state.hidePluginSkills) {
      const plugins = new Map(visibleSkills.filter(x => x.scope === 'plugin' && x.plugin).map(x => [x.plugin.id, x.plugin]));
      for (const plugin of [...plugins.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'))) sections.push({ id: `plugin:${plugin.id}`, title: plugin.name, group: items.filter(x => x.scope === 'plugin' && x.plugin?.id === plugin.id), plugin });
    }
    for (const { id, title, group, plugin } of sections) {
      if (!group.length && (search || statusFilter !== 'all')) continue;
      const section = node('section', 'skill-section'); section.dataset.section = id;
      const collapsed = state.collapsedSections.includes(id);
      const heading = node('button', 'section-heading'); heading.type = 'button'; heading.dataset.sectionId = id;
      const body = node('div', 'section-items'); body.id = 'section-' + encodeURIComponent(id); body.hidden = collapsed;
      heading.setAttribute('aria-expanded', String(!collapsed)); heading.setAttribute('aria-controls', body.id);
      const chevron = node('span', 'section-chevron'); chevron.setAttribute('aria-hidden', 'true');
      heading.append(chevron, node('span', 'section-title', title), node('span', 'section-count', String(group.length)));
      if (plugin) heading.title = `${plugin.name} · ${plugin.marketplace || ''} · Только чтение`;
      heading.addEventListener('click', () => perform(() => controller.toggleSection(id)));
      section.append(heading, body); nav.append(section);
      if (!group.length) body.append(node('p', 'list-empty', search ? 'Ничего не найдено' : 'Скиллов пока нет'));
      for (const skill of group) {
        const row = node('div', 'skill-row');
        const button = node('button', 'skill' + (state.current?.id === skill.id ? ' selected' : '') + (skill.disabled ? ' skill-disabled' : ''));
        button.type = 'button'; button.disabled = state.busy;
        button.title = [skill.description, skill.path].filter(Boolean).join('\n');
        if (state.current?.id === skill.id) button.setAttribute('aria-current', 'true');
        button.append(node('span', 'skill-mark', '◇'));
        const text = node('span', 'skill-text');
        text.append(node('span', 'skill-name', skill.name), node('span', 'skill-source', (skill.source || 'SKILL.md') + ' · ' + availabilityLabel(skill)));
        if (skill.disabled || skill.agentSkill || skill.git) {
          const badges = node('span', 'skill-badges');
          if (skill.disabled) {
            const badge = node('span', 'skill-badge badge-disabled', 'Disabled');
            badge.title = 'Выключен: находится в disabled-skills'; badges.append(badge);
          }
          if (skill.agentSkill) {
            const badge = node('span', 'skill-badge badge-agentSkill', 'AgentSkill Skills');
            badge.title = ['Установлен через agentSkill ai skills add', `Lock-файл: ${skill.agentSkill.lockfile}`, skill.agentSkill.source ? `Источник: ${skill.agentSkill.source}` : ''].filter(Boolean).join('\n');
            badges.append(badge);
          }
          if (skill.git) {
            const badge = node('span', 'skill-badge badge-git', 'Git');
            badge.title = `Отслеживается Git\nРепозиторий: ${skill.git.repository}\nФайл или ссылка: ${skill.git.trackedPath}`;
            badges.append(badge);
          }
          text.append(badges);
        }
        button.append(text);
        if (skill.readOnly) { const lock = node('span', 'skill-lock', 'RO'); lock.title = 'Только чтение'; button.append(lock); }
        button.addEventListener('click', () => { if (state.current?.id !== skill.id) switchDocument(options => controller.open(skill.id, options)); });
        const more = node('button', 'skill-menu-trigger'); more.type = 'button'; more.disabled = Boolean(state.busy);
        more.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>';
        more.setAttribute('aria-label', `Действия: ${skill.name}`); more.setAttribute('aria-haspopup', 'menu'); more.title = 'Действия со скиллом';
        const openMenu = point => skillMenu.open({ skill, anchor:more, point, projectId:state.projectId });
        more.addEventListener('click', () => openMenu());
        row.addEventListener('contextmenu', event => { event.preventDefault(); if (!state.busy) openMenu(event.clientX || event.clientY ? { x:event.clientX, y:event.clientY } : undefined); });
        button.addEventListener('keydown', event => { if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); openMenu(); } });
        row.append(button, more); body.append(row);
      }
    }
    if (focusedSection) [...nav.querySelectorAll('.section-heading')].find(heading => heading.dataset.sectionId === focusedSection)?.focus();
    if (!items.length && (search || statusFilter !== 'all')) nav.append(node('p', 'list-empty', 'Ничего не найдено'));
    $('total').textContent = `${visibleSkills.length} скиллов · на диске`;
  }
  function render(state) {
    if (state.busy) skillMenu.close();
    if (!state.current || currentId !== state.current.id) mode = 'view';
    if (state.busy || !state.current || currentId !== state.current.id || mode !== 'edit') selectionMenu.close();
    projectPicker.setOptions(state.projects, state.projectId);
    projectPicker.setDisabled(state.busy);
    catalog.render(state);
    $('hide-plugin-skills').checked = state.hidePluginSkills;
    $('hide-plugin-skills').disabled = Boolean(state.busy);
    $('hide-system-skills').checked = state.hideSystemSkills;
    $('hide-system-skills').disabled = Boolean(state.busy);
    $('refresh').disabled = state.busy;
    $('save').disabled = state.busy || !controller.dirty || Boolean(state.current?.readOnly);
    $('location-actions').hidden = !state.current;
    $('copy-path').disabled = $('open-terminal').disabled = !state.current || Boolean(state.busy);
    $('overview-button').setAttribute('aria-current',state.current?'false':'page');
    $('ask').disabled = !state.current || Boolean(state.busy) || !chat?.available;
    $('document-modes').style.setProperty('--mode-index', String(modes.indexOf(mode)));
    for (const value of modes) {
      const tab = $(`mode-${value}`);
      tab.disabled = !state.current || state.busy === 'load';
      tab.setAttribute('aria-selected', String(mode === value));
      tab.tabIndex = mode === value ? 0 : -1;
    }
    $('dirty-dot').hidden = !controller.dirty;
    $('readonly').hidden = !state.current?.readOnly;
    $('title').textContent = state.current?.name || 'Обзор навыков';
    $('path').textContent = state.current?.path || 'Каталог, доступность и контекст';
    $('path').title = state.current?.path || '';
    $('status').textContent = state.busy ? 'Загрузка…' : controller.dirty ? 'Есть несохранённые изменения' : state.status;
    $('error').hidden = !state.error;
    $('error').textContent = state.error?.message || '';
    const warnings = [...state.warnings, ...(state.current?.validationError ? [state.current.validationError] : [])];
    $('warnings').hidden = !warnings.length;
    $('warning-title').textContent = `Замечания: ${warnings.length}`;
    $('warning-list').replaceChildren(...warnings.map(warning => node('li', '', warning)));
    $('empty').hidden = Boolean(state.current);
    $('editor').hidden = !state.current || mode !== 'edit';
    $('markdown-view').hidden = !state.current || mode !== 'view';
    $('diff-view').hidden = !state.current || mode !== 'diff';
    $('cursor').hidden = mode !== 'edit';
    if (state.current) {
      const switched = currentId !== state.current.id;
      if (switched || editor.state.doc.toString() !== state.current.content) {
        syncing = true;
        // A fresh state prevents undo from restoring content from a different file.
        if (switched) {
          editor.setState(EditorState.create({ doc: state.current.content, extensions: editorExtensions() }));
        } else editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: state.current.content } });
        syncing = false;
      }
      currentId = state.current.id;
      const locked = Boolean(state.current.readOnly || state.busy === 'load');
      if (switched || editorReadOnly !== locked) {
        editorReadOnly = locked;
        editor.dispatch({ effects: readOnly.reconfigure([EditorState.readOnly.of(editorReadOnly), EditorView.editable.of(!editorReadOnly)]) });
      }
    } else currentId = null;
    if (state.current && mode === 'diff') renderDiff(state.current);
    if (state.current && mode === 'view') {
      const signature = JSON.stringify([state.current.id, state.current.content]);
      if (signature !== previewSignature) {
        renderMarkdown($('markdown-view'), state.current.content); previewSignature = signature;
      }
    }
    if (!state.busy) sideChat?.refreshContext();
    renderList(state);
  }
  function selectedRanges() {
    if (!controller.state.current || mode !== 'edit') return [];
    return editor.state.selection.ranges.filter(range => !range.empty).map(range => {
      const start = editor.state.doc.lineAt(range.from), end = editor.state.doc.lineAt(range.to);
      return { from: range.from, to: range.to, text: editor.state.sliceDoc(range.from, range.to), startLine: start.number, endLine: end.number, startColumn: range.from - start.from + 1, endColumn: range.to - end.from + 1 };
    });
  }
  function readChatSnapshot() {
    const state = controller.state, current = state.current;
    if (!current) return null;
    const ranges = selectedRanges();
    const project = state.projects.find(item => item.id === state.projectId);
    return {
      skill: { id: current.id, name: current.name, path: current.path, scope: current.scope, readOnly: Boolean(current.readOnly) },
      project: project ? { id: project.id, name: project.name } : null,
      versions: { opened: controller.originalContent, saved: controller.baseline, editor: editor.state.doc.toString() },
      dirty: controller.dirty,
      selection: ranges.length ? { ranges } : null,
    };
  }
  function scheduleChatContext() { sideChat?.refreshContext(); }
  function openAsk(context = null) {
    if (!chat?.available || !controller.state.current || controller.state.busy) return;
    void sideChat.open(context || readChatSnapshot());
  }
  function diffExtensions(decorations = []) {
    return [EditorState.readOnly.of(true), EditorView.editable.of(false),
      diffAppearance.of(document.documentElement.dataset.theme === 'light' ? [] : oneDark),
      EditorView.contentAttributes.of({ 'aria-label': 'Изменения SKILL.md', tabindex: '0', spellcheck: 'false' }),
      EditorView.decorations.of(Decoration.set(decorations))];
  }
  function renderDiff(current) {
    const signature = JSON.stringify([current.id, controller.baseline, current.content]);
    if (signature === diffSignature) return;
    diffSignature = signature;
    const diff = createUnifiedDiff(controller.baseline, current.content);
    $('diff-added').textContent = `+${diff.added}`;
    $('diff-removed').textContent = `−${diff.removed}`;
    $('diff-empty').hidden = diff.hunks.length > 0;
    $('diff-code').hidden = diff.hunks.length === 0;
    const lines = [];
    if (diff.hunks.length) {
      lines.push({ kind: 'file', text: '--- a/SKILL.md' }, { kind: 'file', text: '+++ b/SKILL.md' });
      const prefixes = { context: ' ', remove: '-', add: '+', note: '\\ ' };
      for (const hunk of diff.hunks) {
        lines.push({ kind: 'hunk', text: hunk.header });
        for (const line of hunk.lines) lines.push({ kind: line.kind, text: prefixes[line.kind] + line.text });
      }
    }
    let position = 0;
    const decorations = lines.map(line => {
      const decoration = Decoration.line({ class: `diff-${line.kind}` }).range(position);
      position += line.text.length + 1;
      return decoration;
    });
    diffEditor.setState(EditorState.create({ doc: lines.map(line => line.text).join('\n'), extensions: diffExtensions(decorations) }));
  }
  function editorExtensions() {
    return [basicSetup, markdown(), EditorView.lineWrapping, appearance.of(document.documentElement.dataset.theme === 'light' ? [] : oneDark),
      readOnly.of([EditorState.readOnly.of(!controller.state.current || Boolean(controller.state.current.readOnly)), EditorView.editable.of(Boolean(controller.state.current && !controller.state.current.readOnly))]),
      EditorView.contentAttributes.of({ 'aria-label': 'Текст SKILL.md', spellcheck: 'false' }),
      keymap.of([{ key: 'Mod-s', run: () => { perform(() => controller.save()); return true; } }]),
      EditorView.updateListener.of(update => {
        if (update.docChanged && !syncing) controller.edit(update.state.doc.toString());
        if (update.selectionSet || update.docChanged) {
          const point = update.state.selection.main.head, line = update.state.doc.lineAt(point); $('cursor').textContent = `Стр ${line.number}, ст ${point - line.from + 1}`;
          selectionMenu?.close();
          if (!syncing) scheduleChatContext();
        }
      })];
  }
  async function perform(operation) {
    try { await operation(); }
    catch (error) { if (!controller.state.error) { controller.state.error = { code: error.code, message: error.message }; controller.emit(); } }
  }
  function requestSkillName(action, skill) {
    return new Promise(resolve => {
      const dialog = $('skill-name-dialog');
      if (typeof dialog.showModal !== 'function') { resolve(null); return; }
      $('skill-name-title').textContent = action === 'rename' ? 'Переименовать скилл' : 'Сделать копию';
      $('skill-name-help').textContent = action === 'rename' ? 'Название из поля name в SKILL.md.' : `Копия всей папки будет создана в разделе «${skill.scope === 'local' ? 'Локальные' : 'Глобальные'}».`;
      $('skill-new-name').value = action === 'rename' ? skill.name : `${skill.name} (копия)`;
      $('skill-name-submit').textContent = action === 'rename' ? 'Переименовать' : 'Создать копию';
      dialog.returnValue = 'cancel';
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'submit' ? $('skill-new-name').value.trim() : null), { once:true });
      dialog.showModal(); $('skill-new-name').focus(); $('skill-new-name').select();
    });
  }
  function confirmDeleteSkill(skill) {
    return new Promise(resolve => {
      const dialog = $('delete-skill-dialog');
      if (typeof dialog.showModal !== 'function') { resolve(false); return; }
      $('delete-skill-name').textContent = `Удалить «${skill.name}»?`;
      dialog.returnValue = 'cancel';
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'delete'), { once:true });
      dialog.showModal(); $('delete-skill-cancel').focus();
    });
  }
  async function handleSkillAction(action, skill) {
    if (controller.state.busy) return;
    if (['enable','disable'].includes(action) && !skill.disabled) { await switchDocument(options=>controller.setEnabled(skill,action==='enable',options)); return; }
    if (action === 'reveal') { await controller.reveal(skill); return; }
    const values = {};
    if (action === 'rename' || action === 'copy') {
      const name = await requestSkillName(action, skill);
      if (!name) return;
      values.name = name;
    }
    if (action === 'delete' && !await confirmDeleteSkill(skill)) return;
    if (action === 'move') values.scope = skill.scope === 'global' ? 'local' : 'global';
    await switchDocument(options => controller.manage(action, skill, { ...values, ...options }));
  }
  function confirmSwitch() {
    return new Promise(resolve => {
      const dialog = $('unsaved');
      dialog.returnValue = 'cancel';
      dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true });
      if (typeof dialog.showModal !== 'function') { resolve('cancel'); return; }
      dialog.showModal();
    });
  }
  async function switchDocument(operation) {
    if (controller.state.busy) return;
    if (!controller.dirty) { await perform(() => operation({ discard: false })); return; }
    const choice = await confirmSwitch();
    if (choice === 'cancel') { render(controller.state); return; }
    if (choice === 'save') {
      try { await controller.save(); } catch { return; }
      if (controller.dirty) return;
    }
    await perform(() => operation({ discard: choice === 'discard' }));
  }
  on($('search'), 'input', () => { search = $('search').value.trim().toLocaleLowerCase(); renderList(controller.state); });
  on($('hide-system-skills'), 'change', () => { const hide = $('hide-system-skills').checked; perform(() => controller.setHideSystemSkills(hide)); });
  on($('hide-plugin-skills'), 'change', () => perform(() => controller.setHidePluginSkills($('hide-plugin-skills').checked)));
  on($('save'), 'click', () => perform(() => controller.save()));
  on($('copy-path'),'click',()=>perform(()=>controller.locationAction('copy_path')));
  on($('open-terminal'),'click',()=>perform(()=>controller.locationAction('open_terminal')));
  on($('ask'), 'click', () => openAsk());
  function selectMode(value) {
    if (!controller.state.current || controller.state.busy === 'load') return;
    mode = value; render(controller.state);
    if (mode !== 'view') (mode === 'diff' ? diffEditor : editor).requestMeasure();
  }
  for (const value of modes) {
    const tab = $(`mode-${value}`);
    on(tab, 'click', () => selectMode(value));
    on(tab, 'keydown', event => {
      const index = modes.indexOf(value);
      const next = { ArrowRight: (index + 1) % 3, ArrowLeft: (index + 2) % 3, Home: 0, End: 2 }[event.key];
      if (next === undefined) return;
      event.preventDefault(); selectMode(modes[next]); $(`mode-${modes[next]}`).focus();
    });
  }
  on($('refresh'), 'click', () => switchDocument(options => controller.refresh(options)));
  for (const [id, value] of [['cancel-switch', 'cancel'], ['discard-switch', 'discard'], ['save-switch', 'save']]) on($(id), 'click', () => $('unsaved').close(value));
  on($('skill-name-cancel'), 'click', () => $('skill-name-dialog').close('cancel'));
  on($('skill-name-submit'), 'click', () => { if ($('skill-new-name').value.trim() && $('skill-new-name').reportValidity()) $('skill-name-dialog').close('submit'); });
  on($('skill-new-name'), 'keydown', event => { if (event.key === 'Enter') { event.preventDefault(); $('skill-name-submit').click(); } });
  on($('delete-skill-cancel'), 'click', () => $('delete-skill-dialog').close('cancel'));
  on($('delete-skill-confirm'), 'click', () => $('delete-skill-dialog').close('delete'));
  on(window, 'keydown', event => {
    if (!(event.metaKey || event.ctrlKey)) return;
    if (event.key.toLowerCase() === 'k') { event.preventDefault(); $('search').focus(); $('search').select(); }
    if (event.key.toLowerCase() === 's') { event.preventDefault(); perform(() => controller.save()); }
  });
  on(window, 'beforeunload', event => { if (controller.dirty) { event.preventDefault(); event.returnValue = ''; } });
  applyTheme(theme); render(controller.state);
  return { controller, editor, applyTheme, destroy() { abort.abort(); selectionMenu.destroy(); skillMenu.destroy(); projectPicker.destroy(); editor.destroy(); diffEditor.destroy(); return sideChat?.destroy(); } };
}
