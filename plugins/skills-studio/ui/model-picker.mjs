export function createModelPicker({ trigger, popup, options, labelPrefix = 'Модель', listLabel = 'Модели' }) {
  const document = trigger.ownerDocument, root = trigger.parentElement;
  const abort = new document.defaultView.AbortController();
  const on = (element, type, listener) => element.addEventListener(type, listener, { signal: abort.signal });
  let models = [], selected = '', signature = null, opened = false;
  const label = document.createElement('span'); label.className = 'chat-model-label';
  const chevron = document.createElement('span'); chevron.className = 'chat-model-chevron'; chevron.setAttribute('aria-hidden', 'true');
  trigger.replaceChildren(label, chevron);
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-controls', options.id);
  trigger.setAttribute('aria-expanded', 'false');
  options.setAttribute('role', 'listbox'); options.setAttribute('aria-label', listLabel);

  function close(restoreFocus = false) {
    opened = false; popup.hidden = true; trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus();
  }
  function render() {
    const current = models.find(model => model.model === selected);
    trigger.value = selected; label.textContent = current?.displayName || 'Модель Codex';
    trigger.title = current?.description || `${labelPrefix}: ${label.textContent}`; trigger.setAttribute('aria-label', `${labelPrefix}: ${label.textContent}`);
    options.replaceChildren(...models.map(model => {
      const option = document.createElement('button'); option.type = 'button'; option.tabIndex = -1;
      option.className = 'chat-model-option'; option.setAttribute('role', 'option');
      if (model.description) option.title = model.description;
      option.setAttribute('aria-selected', String(model.model === selected));
      const name = document.createElement('span'); name.textContent = model.displayName;
      const check = document.createElement('span'); check.className = 'chat-model-check'; check.setAttribute('aria-hidden', 'true');
      check.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m4 10 4 4 8-8"/></svg>';
      option.append(name, check);
      option.addEventListener('click', () => { selected = model.model; render(); close(true); trigger.dispatchEvent(new document.defaultView.Event('change', { bubbles:true })); });
      return option;
    }));
  }
  function focus(index) {
    const buttons = [...options.children];
    const option = buttons[(index + buttons.length) % buttons.length];
    option?.focus(); option?.scrollIntoView?.({ block: 'nearest' });
  }
  function open() {
    if (trigger.disabled) return;
    opened = true; popup.hidden = false; trigger.setAttribute('aria-expanded', 'true');
    focus(Math.max(0, models.findIndex(model => model.model === selected)));
  }
  on(trigger, 'click', () => opened ? close() : open());
  on(root, 'keydown', event => {
    if (trigger.disabled) return;
    if (!opened) {
      if (event.target === trigger && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); open(); }
      return;
    }
    const active = [...options.children].indexOf(document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (event.key === 'Tab') close(true);
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      focus(event.key === 'Home' ? 0 : event.key === 'End' ? models.length - 1 : active + (event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); if (active >= 0) options.children[active].click();
    }
  });
  on(document, 'pointerdown', event => { if (opened && !root.contains(event.target)) close(); });
  on(document, 'focusin', event => { if (opened && !root.contains(event.target)) close(); });
  return {
    setOptions(values) {
      const next = JSON.stringify(values || []); if (next === signature) return;
      signature = next; close();
      models = values?.length ? values : [{ model: '', displayName: 'Модель Codex' }];
      if (values?.length && !models.some(model => model.model === selected)) selected = models.find(model => model.isDefault)?.model || models[0].model;
      render();
    },
    setValue(value) { selected = value || ''; close(); render(); },
    setDisabled(value) { if (value) close(); trigger.disabled = Boolean(value); },
    close,
    destroy() { close(); abort.abort(); },
  };
}
