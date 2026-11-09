const number = value => Number.isFinite(value) ? value.toLocaleString('ru-RU') : 'не рассчитано';
const tokens = value => Number.isFinite(value) ? `≈ ${number(value)}` : '—';

export function mountContextOverview({document, target, onRecalculate = () => {}}) {
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  let previous, previousVisibleCount, refreshButton, query = '';
  const expanded = new Set();
  const disclosure = (className, title) => {
    const element = node('details', undefined, className);
    element.open = expanded.has(className);
    element.addEventListener('toggle', () => {
      if (!target.contains(element)) return;
      if (element.open) expanded.add(className); else expanded.delete(className);
    });
    element.append(node('summary', title));
    return element;
  };
  function render(context, {busy = false, visibleCount} = {}) {
    if (!target) return;
    const syncRefresh = () => {
      if (!refreshButton) return;
      refreshButton.disabled = busy;
      refreshButton.textContent = busy ? 'Пересчитываю…' : 'Пересчитать';
      target.setAttribute('aria-busy',String(busy));
    };
    if (previous === context && previousVisibleCount === visibleCount) {syncRefresh(); return;}
    const restoreRefreshFocus = document.activeElement === refreshButton;
    for (const element of target.querySelectorAll('details')) {
      if (element.open) expanded.add(element.className); else expanded.delete(element.className);
    }
    previous = context;
    previousVisibleCount = visibleCount;
    target.replaceChildren();
    const heading = node('div', undefined, 'context-heading');
    heading.append(node('h3', 'Навыки и контекст'), node('span', 'Оценка', 'context-badge'));
    const actions = node('div',undefined,'context-actions');
    refreshButton = node('button','Пересчитать','secondary context-refresh');
    refreshButton.type = 'button';
    refreshButton.title = 'Заново проверить доступность в Codex и пересчитать токены';
    refreshButton.addEventListener('click',()=>onRecalculate());
    if (context?.checkedAt && Number.isFinite(Date.parse(context.checkedAt))) {
      const time = node('time',`Обновлено ${new Date(context.checkedAt).toLocaleTimeString('ru-RU')}`,'context-updated');
      time.dateTime = context.checkedAt; time.title = new Date(context.checkedAt).toLocaleString('ru-RU'); actions.append(time);
    }
    actions.append(refreshButton); heading.append(actions); syncRefresh();
    target.append(heading);
    if (restoreRefreshFocus && !busy) refreshButton.focus();
    if (!context) {
      target.append(node('p', 'Оценка ещё не получена. Обновите каталог, чтобы пересчитать её.'));
      return;
    }
    const metric = node('div', undefined, 'context-metric');
    metric.append(node('span', 'Подтверждённый каталог · до сокращений Codex'), node('strong', `${tokens(context.metadataTokens)} токенов`));
    target.append(metric);
    const excluded = context.excluded || {};
    const unavailable = (excluded.unknown || 0) + (excluded.cached || 0);
    const total = context.totalCount ?? (context.enabledCount + (excluded.disabled || 0) + unavailable + (excluded.invalid || 0));
    const measured = context.measuredCount ?? context.entries.filter(entry=>Number.isFinite(entry.metadataTokens)).length;
    const coverage = [`В расчёте: ${number(measured)} из ${number(total)} найденных навыков`];
    if (excluded.disabled) coverage.push(`выключено — ${number(excluded.disabled)}`);
    if (unavailable) coverage.push(`не подтверждено — ${number(unavailable)}`);
    if (excluded.invalid) coverage.push(`ошибки метаданных — ${number(excluded.invalid)}`);
    if (measured < context.enabledCount) coverage.push(`токены не рассчитаны — ${number(context.enabledCount-measured)}`);
    target.append(node('p',coverage.join(' · ')+'.','context-coverage'));
    if (Number.isFinite(visibleCount) && total > visibleCount) target.append(node('p',`В списке слева — ${number(visibleCount)}. Ещё ${number(total-visibleCount)} скрыты фильтрами; оценка учитывает доступные навыки и из этой группы.`,'context-visibility'));
    const help = disclosure('context-help', 'О каталоге');
    help.append(node('p', `Навыков с подтверждённой доступностью: ${number(context.enabledCount)}, включая скрытые в списке. Учтены название, описание и путь к файлу.`));
    help.append(node('p', 'Оценка каталога, а не расход конкретного запроса. Остальной контекст чата здесь не учитывается.'));
    help.append(node('p', 'Доступность проверяется через отдельный локальный Codex CLI. Его каталог может отличаться от набора навыков открытого чата. Установленный плагин и наличие его файлов сами по себе не подтверждают загрузку навыка в контекст.'));
    target.append(help);
    if (unavailable || excluded.invalid || measured < context.enabledCount) {
      const reasons = [];
      if (unavailable) reasons.push(`доступность не подтверждена — ${number(unavailable)}`);
      if (excluded.invalid) reasons.push(`ошибки метаданных — ${number(excluded.invalid)}`);
      if (measured < context.enabledCount) reasons.push(`токены не рассчитаны — ${number(context.enabledCount-measured)}`);
      target.append(node('p', `Неполная оценка: ${reasons.join('; ')}.${unavailable ? ' Для этих навыков Codex не подтвердил доступность; это не означает, что они выключены. Нажмите «Пересчитать», чтобы повторить проверку.' : ''}`, 'context-caution'));
    }
    if (excluded.disabled) help.append(node('p', `Выключенные навыки (${number(excluded.disabled)}) в оценку не входят.`));
    const groups = new Map();
    for (const entry of context.entries) {
      const group = entry.scope === 'plugin' ? 'Плагины' : entry.scope === 'local' ? 'Проект' : entry.source === 'Системные' ? 'Системные' : 'Глобальные';
      groups.set(group, (groups.get(group) || 0) + (entry.metadataTokens || 0));
    }
    if (context.metadataTokens > 0) {
      const breakdown = node('div', undefined, 'context-groups');
      breakdown.append(node('p', 'Из чего состоит оценка каталога', 'context-caption'));
      for (const [label, count] of groups) {
        const row = node('div', undefined, 'context-group');
        const caption = node('div'); caption.append(node('span', label), node('span', `${tokens(count)} ток.`));
        const track = node('div', undefined, 'context-track'); track.setAttribute('aria-hidden', 'true');
        const fill = node('span'); fill.style.width = `${100 * count / context.metadataTokens}%`; track.append(fill);
        row.append(caption, track); breakdown.append(row);
      }
      target.append(breakdown);
    }
    const details = disclosure('context-breakdown', `Вклад каждого навыка · ${number(context.entries.length)}`);
    const input = node('input'); input.type = 'search'; input.placeholder = 'Найти в разбивке…'; input.setAttribute('aria-label', 'Поиск в оценке контекста'); input.value = query;
    const scroll = node('div', undefined, 'context-table-scroll'); scroll.tabIndex = 0; scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', 'Разбивка токенов по навыкам');
    const table = node('table'); const caption = node('caption', 'По убыванию вклада в каталог. Размер полной инструкции считается отдельно, без дополнительных файлов.');
    const head = node('thead'); const headerRow = node('tr');
    for (const title of ['Навык', 'В каталоге, ≈ ток.', 'При чтении, ≈ ток.']) {const th = node('th', title); th.scope = 'col'; headerRow.append(th);}
    head.append(headerRow);
    const body = node('tbody'); table.append(caption, head, body); scroll.append(table);
    const empty = node('p', 'Ничего не найдено');
    const rows = () => {
      body.replaceChildren();
      const entries = context.entries.filter(entry => `${entry.name} ${entry.source || ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
      empty.hidden = entries.length > 0;
      for (const entry of entries) {
        const row = node('tr'); const label = node('td');
        const name = node('span', entry.name, 'context-skill-name'); name.title = entry.path || '';
        label.append(name, node('small', entry.source || entry.scope));
        row.append(label, node('td', number(entry.metadataTokens)), node('td', number(entry.instructionTokens))); body.append(row);
      }
    };
    input.addEventListener('input', () => {query = input.value; rows();}); rows();
    details.append(input, scroll, empty); target.append(details);
    const flow = disclosure('context-explanation', 'Как это влияет на запрос');
    flow.append(node('p','Когда каталог включён в обращение к модели, он занимает место во входном контексте этого обращения. При следующих сообщениях контекст используется снова; новые копии каталога не накапливаются в истории на каждое сообщение.'));
    flow.append(node('p','Число выше — объём каталога до сокращений, а не фиксированная добавка к каждому запросу. Codex ограничивает стартовый список своим бюджетом: сокращает описания и при необходимости пропускает часть навыков. Фактический объём текущего запроса эта панель не измеряет.'));
    flow.append(node('p', 'Каталог помогает Codex выбрать подходящий навык. Полный SKILL.md добавляется при его использовании, а ссылки и скрипты — по мере необходимости. Все инструкции сразу не загружаются.'), node('p', 'Длинные описания увеличивают базовый объём. Похожие описания могут затруднять выбор; большой SKILL.md увеличивает контекст при чтении. Скрытие в списке не выключает навык.'));
    target.append(flow);
    const method = disclosure('context-method', 'Что именно посчитано');
    method.append(node('p', 'Локальная оценка по o200k_base: сумма токенов строк «название: описание (путь)» доступных навыков. Полные инструкции считаются по сохранённым SKILL.md. Тексты никуда не отправляются.'));
    method.append(node('p', '«Не рассчитано» означает, что текст недоступен либо превышает безопасный объём или сложность расчёта. Это защищает панель от зависания на очень больших или повторяющихся строках.'));
    method.append(node('p', 'Это не замер конкретного запроса: Codex может сокращать описания, менять формат каталога и состав доступных навыков. Модель и её токенизатор могут отличаться. Правила AGENTS.md, инструменты MCP, переписка и прочий контекст сюда не входят.'));
    method.append(node('p', 'Плагин не получает фактический объём навыков в текущем чате, лимит его контекста или расход тарифа. Поэтому здесь нет процента заполнения окна и лимита 20 000 из Antigravity.'));
    const link = node('a', 'Как Codex загружает навыки ↗'); link.href = 'https://learn.chatgpt.com/docs/build-skills'; link.target = '_blank'; link.rel = 'noopener noreferrer'; method.append(link);
    target.append(method);
  }
  return {render};
}
