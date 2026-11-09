export function createSkillMenu({ document, onAction }) {
  const window = document.defaultView, abort = new window.AbortController();
  const menu = document.createElement('div');
  menu.id = 'skill-menu'; menu.className = 'skill-context-menu'; menu.hidden = true; menu.setAttribute('role', 'menu');
  document.body.append(menu);
  let anchor;
  const on = (target, type, callback, options = {}) => target.addEventListener(type, callback, { ...options, signal:abort.signal });
  function close(restoreFocus = false) { menu.hidden = true; anchor?.setAttribute('aria-expanded', 'false'); if (restoreFocus && anchor?.isConnected) anchor.focus(); }
  function open({ skill, anchor:target, point, projectId }) {
    close(); anchor = target; menu.replaceChildren();
    menu.setAttribute('aria-label', `Действия со скиллом ${skill.name}`);
    const locked = Boolean(skill.readOnly || skill.scope === 'plugin');
    const off = skill.disabled || skill.availability?.status === 'disabled';
    const entries = [
      ['rename', 'Переименовать', locked],
      ['copy', 'Сделать копию', false],
      ['reveal', 'Открыть в Finder', false],
      ['move', skill.scope === 'global' ? 'Сделать локальным' : 'Сделать глобальным', locked || skill.scope === 'global' && !projectId],
      [off ? 'enable' : 'disable', skill.disabled ? 'Восстановить из архива' : off ? 'Включить' : 'Выключить', locked || (skill.registrations?.length > 1 && !skill.disabled) || Boolean(skill.availability && !['enabled','disabled'].includes(skill.availability.status) && !skill.disabled)],
      ['delete', 'Удалить', locked],
    ];
    for (const [action, title, disabled] of entries) {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = title; button.dataset.action = action; button.disabled = disabled;
      button.setAttribute('role', 'menuitem'); button.tabIndex = -1;
      if (disabled) button.title = locked ? 'Оригинал доступен только для чтения' : 'Сначала выберите проект';
      button.addEventListener('click', () => { close(); onAction(action, skill); });
      menu.append(button);
    }
    menu.hidden = false; target.setAttribute('aria-expanded', 'true');
    const rect = target.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(point?.x ?? rect.left, window.innerWidth - (menu.offsetWidth || 210) - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(point?.y ?? rect.bottom, window.innerHeight - (menu.offsetHeight || 190) - 8))}px`;
    menu.querySelector('button:not(:disabled)')?.focus();
  }
  on(document, 'keydown', event => {
    if (menu.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === 'Tab') { close(); return; }
    if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...menu.querySelectorAll('button:not(:disabled)')], current = buttons.indexOf(document.activeElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[index]?.focus();
  });
  on(document, 'pointerdown', event => { if (!menu.hidden && !menu.contains(event.target) && !anchor?.contains(event.target)) close(); });
  on(document, 'scroll', event => { if (!menu.contains(event.target)) close(); }, { capture:true });
  on(window, 'resize', () => close());
  return { open, close, destroy() { abort.abort(); menu.remove(); } };
}
