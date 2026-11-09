import { t } from './i18n.mjs';
export function createSelectionMenu({ editor, readContext, onAsk }) {
  const document = editor.dom.ownerDocument, window = document.defaultView;
  const abort = new window.AbortController();
  const on = (target, type, callback, options = {}) => target.addEventListener(type, callback, { ...options, signal:abort.signal });
  const menu = document.createElement('div');
  menu.id = 'editor-selection-menu'; menu.className = 'skill-context-menu editor-selection-menu';
  menu.hidden = true; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', t('Действия с выделенным текстом'));
  const ask = document.createElement('button');
  ask.type = 'button'; ask.textContent = t('Спросить в боковом чате'); ask.setAttribute('role', 'menuitem'); ask.tabIndex = -1;
  menu.append(ask); document.body.append(menu);
  let context = null;

  function close(restoreFocus = false) {
    menu.hidden = true; context = null;
    if (restoreFocus) editor.focus();
  }
  function open(event, keyboard = false) {
    close();
    const snapshot = readContext();
    if (!snapshot?.selection?.ranges.length) return;
    event.preventDefault();
    context = snapshot;
    const rect = keyboard ? editor.coordsAtPos(editor.state.selection.main.head) || editor.dom.getBoundingClientRect() : null;
    const x = rect?.left ?? event.clientX, y = rect?.bottom ?? event.clientY;
    menu.hidden = false;
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - (menu.offsetWidth || 230) - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - (menu.offsetHeight || 44) - 8))}px`;
    ask.focus({ preventScroll:true });
  }
  on(editor.contentDOM, 'contextmenu', event => open(event, !event.clientX && !event.clientY));
  on(editor.contentDOM, 'keydown', event => {
    if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') open(event, true);
  });
  on(ask, 'click', () => {
    const snapshot = context; close();
    if (snapshot) onAsk(snapshot);
  });
  on(menu, 'keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (event.key === 'Tab') close();
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); ask.focus({ preventScroll:true }); }
  });
  on(document, 'pointerdown', event => { if (!menu.hidden && !menu.contains(event.target)) close(); });
  on(document, 'scroll', event => { if (!menu.contains(event.target)) close(); }, { capture:true });
  on(window, 'resize', () => close());
  on(window, 'blur', () => close());
  function refreshLocale() { menu.setAttribute('aria-label', t('Действия с выделенным текстом')); ask.textContent = t('Спросить в боковом чате'); }
  return { refreshLocale, close, destroy() { abort.abort(); menu.remove(); } };
}
