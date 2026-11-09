export function createProjectPicker({ trigger, popup, search, options, onSelect }) {
  const document = trigger.ownerDocument;
  const root = trigger.parentElement;
  const abort = new document.defaultView.AbortController();
  const on = (element, type, listener) => element.addEventListener(type, listener, { signal: abort.signal });
  let projects = [], selected = null, filtered = [], active = -1, opened = false;
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const label = element('span', 'project-trigger-label');
  const chevron = element('span', 'project-chevron');
  chevron.setAttribute('aria-hidden', 'true');
  trigger.replaceChildren(label, chevron);
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-controls', popup.id);
  trigger.setAttribute('aria-expanded', 'false');
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', 'Выбор проекта');
  search.setAttribute('role', 'combobox');
  search.setAttribute('aria-label', 'Поиск проекта');
  search.setAttribute('aria-autocomplete', 'list');
  search.setAttribute('aria-controls', options.id);
  search.setAttribute('aria-expanded', 'false');
  options.setAttribute('role', 'listbox');
  options.setAttribute('aria-label', 'Проекты');

  function highlight(index, scroll = true) {
    active = filtered.length ? Math.max(0, Math.min(index, filtered.length - 1)) : -1;
    for (const [position, option] of [...options.querySelectorAll('[role="option"]')].entries()) option.classList.toggle('is-active', position === active);
    if (active >= 0) {
      const option = options.querySelector(`[data-index="${active}"]`);
      search.setAttribute('aria-activedescendant', option.id);
      if (scroll) option.scrollIntoView?.({ block: 'nearest' });
    } else search.removeAttribute('aria-activedescendant');
  }
  function close(restoreFocus = false) {
    opened = false; popup.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    search.setAttribute('aria-expanded', 'false');
    search.removeAttribute('aria-activedescendant');
    if (restoreFocus) trigger.focus();
  }
  function choose(index) {
    const project = filtered[index];
    if (!project) return;
    close(true);
    onSelect(project.id);
  }
  function renderOptions() {
    const query = search.value.trim().toLocaleLowerCase();
    filtered = [{ id: null, name: 'Только глобальные', roots: [] }, ...projects].filter(project => `${project.name} ${(project.roots || []).join(' ')}`.toLocaleLowerCase().includes(query));
    options.replaceChildren();
    if (!filtered.length) options.append(element('p', 'project-menu-empty', 'Проекты не найдены'));
    for (const [index, project] of filtered.entries()) {
      const option = element('button', 'project-option' + (project.id === null ? ' project-global' : ''));
      option.type = 'button'; option.tabIndex = -1;
      option.id = `${options.id}-${index}`;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(project.id === selected));
      option.dataset.value = project.id || '';
      option.dataset.index = String(index);
      const symbol = element('span', 'project-option-icon');
      symbol.innerHTML = project.id === null
        ? '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="10" cy="10" r="7"/><ellipse cx="10" cy="10" rx="3" ry="7"/><path d="M3 10h14"/></svg>'
        : '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M2.5 6V4.5h5L9 6h8.5v10h-15z"/></svg>';
      symbol.setAttribute('aria-hidden', 'true');
      const text = element('span', 'project-option-text');
      text.append(element('span', 'project-option-name', project.name));
      const path = project.roots?.[0];
      if (path) { const subtitle = element('span', 'project-option-path', path); subtitle.title = path; text.append(subtitle); }
      const check = element('span', 'project-option-check', project.id === selected ? '✓' : '');
      check.setAttribute('aria-hidden', 'true');
      option.append(symbol, text, check);
      option.addEventListener('click', () => choose(index));
      option.addEventListener('pointermove', () => highlight(index, false));
      options.append(option);
    }
    const selectedIndex = filtered.findIndex(project => project.id === selected);
    highlight(query ? 0 : Math.max(0, selectedIndex), false);
  }
  function open() {
    if (trigger.disabled) return;
    search.value = ''; renderOptions();
    opened = true; popup.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    search.setAttribute('aria-expanded', 'true');
    search.focus();
  }
  on(trigger, 'click', () => opened ? close() : open());
  on(trigger, 'keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); open(); }
  });
  on(search, 'input', renderOptions);
  on(options, 'pointerdown', event => event.preventDefault());
  on(root, 'keydown', event => {
    if (!opened) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (event.target === search && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault(); highlight(active + (event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.target === search && event.key === 'Enter') { event.preventDefault(); choose(active); }
    else if (event.key === 'Tab') close();
  });
  on(document, 'pointerdown', event => { if (opened && !root.contains(event.target)) close(); });
  on(document, 'focusin', event => { if (opened && !root.contains(event.target)) close(); });
  return {
    setOptions(values, value) {
      projects = values; selected = value || null;
      const current = projects.find(project => project.id === selected);
      label.textContent = current?.name || 'Только глобальные';
      trigger.title = current?.roots?.join('\n') || 'Показать глобальные скиллы';
      trigger.setAttribute('aria-label', `Проект: ${label.textContent}`);
      if (opened) renderOptions();
    },
    setDisabled(value) { trigger.disabled = Boolean(value); if (value && opened) close(); },
    destroy() { abort.abort(); },
  };
}
