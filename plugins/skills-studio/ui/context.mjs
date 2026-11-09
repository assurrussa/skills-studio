import { t, locale, language, sourceLabel } from './i18n.mjs';
const number = value => Number.isFinite(value) ? value.toLocaleString(locale()) : t('не рассчитано');
const tokens = value => Number.isFinite(value) ? `≈ ${number(value)}` : '—';

export function mountContextOverview({document, target, onRecalculate = () => {}}) {
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  let previousLanguage, previous, previousVisibleCount, refreshButton, query = '';
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
      refreshButton.textContent = busy ? t('Пересчитываю…') : t('Пересчитать');
      target.setAttribute('aria-busy',String(busy));
    };
    if (previousLanguage === language() && previous === context && previousVisibleCount === visibleCount) {syncRefresh(); return;}
    const restoreRefreshFocus = document.activeElement === refreshButton;
    for (const element of target.querySelectorAll('details')) {
      if (element.open) expanded.add(element.className); else expanded.delete(element.className);
    }
    previousLanguage = language();
    previous = context;
    previousVisibleCount = visibleCount;
    target.replaceChildren();
    const heading = node('div', undefined, 'context-heading');
    heading.append(node('h3', t('Навыки и контекст')), node('span', t('Оценка'), 'context-badge'));
    const actions = node('div',undefined,'context-actions');
    refreshButton = node('button',t('Пересчитать'),'secondary context-refresh');
    refreshButton.type = 'button';
    refreshButton.title = t('Заново проверить доступность в Codex и пересчитать токены');
    refreshButton.addEventListener('click',()=>onRecalculate());
    if (context?.checkedAt && Number.isFinite(Date.parse(context.checkedAt))) {
      const time = node('time',t("Обновлено {0}", new Date(context.checkedAt).toLocaleTimeString(locale())),'context-updated');
      time.dateTime = context.checkedAt; time.title = new Date(context.checkedAt).toLocaleString(locale()); actions.append(time);
    }
    actions.append(refreshButton); heading.append(actions); syncRefresh();
    target.append(heading);
    if (restoreRefreshFocus && !busy) refreshButton.focus();
    if (!context) {
      target.append(node('p', t('Оценка ещё не получена. Обновите каталог, чтобы пересчитать её.')));
      return;
    }
    const metric = node('div', undefined, 'context-metric');
    metric.append(node('span', t('Подтверждённый каталог · до сокращений Codex')), node('strong', t("{0} токенов", tokens(context.metadataTokens))));
    target.append(metric);
    const excluded = context.excluded || {};
    const unavailable = (excluded.unknown || 0) + (excluded.cached || 0);
    const total = context.totalCount ?? (context.enabledCount + (excluded.disabled || 0) + unavailable + (excluded.invalid || 0));
    const measured = context.measuredCount ?? context.entries.filter(entry=>Number.isFinite(entry.metadataTokens)).length;
    const coverage = [t("В расчёте: {0} из {1} найденных навыков", number(measured), number(total))];
    if (excluded.disabled) coverage.push(t("выключено — {0}", number(excluded.disabled)));
    if (unavailable) coverage.push(t("не подтверждено — {0}", number(unavailable)));
    if (excluded.invalid) coverage.push(t("ошибки метаданных — {0}", number(excluded.invalid)));
    if (measured < context.enabledCount) coverage.push(t("токены не рассчитаны — {0}", number(context.enabledCount-measured)));
    target.append(node('p',coverage.join(' · ')+'.','context-coverage'));
    if (Number.isFinite(visibleCount) && total > visibleCount) target.append(node('p',t("В списке слева — {0}. Скрыто фильтрами — {1}; оценка учитывает доступные навыки и из этой группы.", number(visibleCount), number(total-visibleCount)),'context-visibility'));
    const help = disclosure('context-help', t('О каталоге'));
    help.append(node('p', t("Навыков с подтверждённой доступностью: {0}, включая скрытые в списке. Учтены название, описание и путь к файлу.", number(context.enabledCount))));
    help.append(node('p', t('Оценка каталога, а не расход конкретного запроса. Остальной контекст чата здесь не учитывается.')));
    help.append(node('p', t('Доступность проверяется через отдельный локальный Codex CLI. Его каталог может отличаться от набора навыков открытого чата. Установленный плагин и наличие его файлов сами по себе не подтверждают загрузку навыка в контекст.')));
    target.append(help);
    if (unavailable || excluded.invalid || measured < context.enabledCount) {
      const reasons = [];
      if (unavailable) reasons.push(t("доступность не подтверждена — {0}", number(unavailable)));
      if (excluded.invalid) reasons.push(t("ошибки метаданных — {0}", number(excluded.invalid)));
      if (measured < context.enabledCount) reasons.push(t("токены не рассчитаны — {0}", number(context.enabledCount-measured)));
      target.append(node('p', t("Неполная оценка: {0}.{1}", reasons.join('; '), unavailable ? t(' Для этих навыков Codex не подтвердил доступность; это не означает, что они выключены. Нажмите «Пересчитать», чтобы повторить проверку.') : ''), 'context-caution'));
    }
    if (excluded.disabled) help.append(node('p', t("Выключенные навыки ({0}) в оценку не входят.", number(excluded.disabled))));
    const groups = new Map();
    for (const entry of context.entries) {
      const group = entry.scope === 'plugin' ? t('Плагины') : entry.scope === 'local' ? t('Проект') : entry.source === 'Системные' ? t('Системные') : t('Глобальные');
      groups.set(group, (groups.get(group) || 0) + (entry.metadataTokens || 0));
    }
    if (context.metadataTokens > 0) {
      const breakdown = node('div', undefined, 'context-groups');
      breakdown.append(node('p', t('Из чего состоит оценка каталога'), 'context-caption'));
      for (const [label, count] of groups) {
        const row = node('div', undefined, 'context-group');
        const caption = node('div'); caption.append(node('span', label), node('span', t("{0} ток.", tokens(count))));
        const track = node('div', undefined, 'context-track'); track.setAttribute('aria-hidden', 'true');
        const fill = node('span'); fill.style.width = `${100 * count / context.metadataTokens}%`; track.append(fill);
        row.append(caption, track); breakdown.append(row);
      }
      target.append(breakdown);
    }
    const details = disclosure('context-breakdown', t("Вклад каждого навыка · {0}", number(context.entries.length)));
    const input = node('input'); input.type = 'search'; input.placeholder = t('Найти в разбивке…'); input.setAttribute('aria-label', t('Поиск в оценке контекста')); input.value = query;
    const scroll = node('div', undefined, 'context-table-scroll'); scroll.tabIndex = 0; scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', t('Разбивка токенов по навыкам'));
    const table = node('table'); const caption = node('caption', t('По убыванию вклада в каталог. Размер полной инструкции считается отдельно, без дополнительных файлов.'));
    const head = node('thead'); const headerRow = node('tr');
    for (const title of [t('Навык'), t('В каталоге, ≈ ток.'), t('При чтении, ≈ ток.')]) {const th = node('th', title); th.scope = 'col'; headerRow.append(th);}
    head.append(headerRow);
    const body = node('tbody'); table.append(caption, head, body); scroll.append(table);
    const empty = node('p', t('Ничего не найдено'));
    const rows = () => {
      body.replaceChildren();
      const entries = context.entries.filter(entry => `${entry.name} ${entry.source || ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
      empty.hidden = entries.length > 0;
      for (const entry of entries) {
        const row = node('tr'); const label = node('td');
        const name = node('span', entry.name, 'context-skill-name'); name.title = entry.path || '';
        label.append(name, node('small', sourceLabel(entry) || entry.scope));
        row.append(label, node('td', number(entry.metadataTokens)), node('td', number(entry.instructionTokens))); body.append(row);
      }
    };
    input.addEventListener('input', () => {query = input.value; rows();}); rows();
    details.append(input, scroll, empty); target.append(details);
    const flow = disclosure('context-explanation', t('Как это влияет на запрос'));
    flow.append(node('p',t('Когда каталог включён в обращение к модели, он занимает место во входном контексте этого обращения. При следующих сообщениях контекст используется снова; новые копии каталога не накапливаются в истории на каждое сообщение.')));
    flow.append(node('p',t('Число выше — объём каталога до сокращений, а не фиксированная добавка к каждому запросу. Codex ограничивает стартовый список своим бюджетом: сокращает описания и при необходимости пропускает часть навыков. Фактический объём текущего запроса эта панель не измеряет.')));
    flow.append(node('p', t('Каталог помогает Codex выбрать подходящий навык. Полный SKILL.md добавляется при его использовании, а ссылки и скрипты — по мере необходимости. Все инструкции сразу не загружаются.')), node('p', t('Длинные описания увеличивают базовый объём. Похожие описания могут затруднять выбор; большой SKILL.md увеличивает контекст при чтении. Скрытие в списке не выключает навык.')));
    target.append(flow);
    const method = disclosure('context-method', t('Что именно посчитано'));
    method.append(node('p', t('Локальная оценка по o200k_base: сумма токенов строк «название: описание (путь)» доступных навыков. Полные инструкции считаются по сохранённым SKILL.md. Тексты никуда не отправляются.')));
    method.append(node('p', t('«Не рассчитано» означает, что текст недоступен либо превышает безопасный объём или сложность расчёта. Это защищает панель от зависания на очень больших или повторяющихся строках.')));
    method.append(node('p', t('Это не замер конкретного запроса: Codex может сокращать описания, менять формат каталога и состав доступных навыков. Модель и её токенизатор могут отличаться. Правила AGENTS.md, инструменты MCP, переписка и прочий контекст сюда не входят.')));
    method.append(node('p', t('Плагин не получает фактический объём навыков в текущем чате, лимит его контекста или расход тарифа. Поэтому здесь нет процента заполнения окна и лимита 20 000 из Antigravity.')));
    const link = node('a', t('Как Codex загружает навыки ↗')); link.href = 'https://learn.chatgpt.com/docs/build-skills'; link.target = '_blank'; link.rel = 'noopener noreferrer'; method.append(link);
    target.append(method);
  }
  return {render};
}
