export const availabilityLabel = skill => skill.disabled ? 'Архив disabled-skills' : ({enabled:'Доступен Codex',disabled:'Выключен в Codex',cached:'Только в кэше',unknown:'Состояние не проверено'}[skill.availability?.status] || 'Состояние не проверено');
export const needsAttention = skill => Boolean(skill.validationError || skill.health?.checks?.some(c=>c.severity !== 'info') || skill.health?.review?.state === 'changed' || skill.health?.sourceCheck?.status === 'update-available' || (skill.health?.sourceCheck && skill.health.sourceCheck.fingerprint !== skill.health.fingerprint));
export function matchesStatus(skill, filter) {
  if (filter === 'attention') return needsAttention(skill);
  if (filter === 'unknown') return !skill.availability || ['unknown','cached'].includes(skill.availability.status);
  if (filter === 'disabled') return skill.disabled || skill.availability?.status === 'disabled';
  return filter === 'all' || !skill.disabled && skill.availability?.status === filter;
}
import { mountContextOverview } from './context.mjs';
export function mountCatalog({document, controller, perform, overview, onFilter}) {
  const $ = id => document.getElementById(id);
  const node = (tag,text,cls) => {const el=document.createElement(tag);el.textContent=text;if(cls)el.className=cls;return el;};
  let signature='';
  const reviewDrafts = new Map();
  const contextOverview = mountContextOverview({document, target:$('context-overview'), onRecalculate:()=>perform(()=>controller.refresh())});
  $('overview-button').addEventListener('click',overview);
  $('status-filter').addEventListener('change',()=>onFilter($('status-filter').value));
  const timestamp = value => value ? new Date(value).toLocaleString('ru-RU') : 'не выполнялась';
  function render(state) {
    contextOverview.render(state.context,{busy:Boolean(state.busy),visibleCount:state.skills.length});
    const skills=state.skills;
    const selectedFilter=$('status-filter').value || 'all';
    const focusedFilter=document.activeElement?.closest('.overview-count')?.dataset.filter;
    const filterCount=Number(Boolean(state.hideSystemSkills))+Number(Boolean(state.hidePluginSkills))+Number(selectedFilter!=='all');
    if($('filter-count')){$('filter-count').textContent=String(filterCount);$('filter-count').hidden=!filterCount;}
    $('overview-counts').replaceChildren();
    for (const [filter,label] of [['all','Найдено'],['enabled','Доступно'],['disabled','Выключено'],['attention','Требуют внимания'],['unknown','Не подтверждено']]) {
      const count=skills.filter(s=>matchesStatus(s,filter)).length;
      const button=node('button','','overview-count');button.type='button';button.dataset.filter=filter;
      button.append(node('strong',String(count)),node('span',label));
      button.setAttribute('aria-label',`${count} · ${label}`);button.setAttribute('aria-pressed',String(selectedFilter===filter));
      button.onclick=()=>{$('status-filter').value=filter;onFilter(filter);};$('overview-counts').append(button);
    }
    if(focusedFilter)$('overview-counts').querySelector(`[data-filter="${focusedFilter}"]`)?.focus();
    $('overview-context').textContent=state.projectId ? `Для проекта «${state.projects.find(p=>p.id===state.projectId)?.name || state.projectId}»` : 'Глобальные навыки и установленные плагины';
    const skill=state.current;const target=$('skill-details');target.hidden=!skill;
    const next=JSON.stringify([skill?.id,skill?.health,skill?.registrations,skill?.availability,state.busy,controller.dirty]);
    if(next===signature)return;signature=next;target.replaceChildren();if(!skill)return;
    const heading=node('summary','Сведения о навыке');target.append(heading);
    const body=node('div','','skill-details-body');target.append(body);
    const line=(title,value)=>{const p=node('p','');p.append(node('strong',title+' '),document.createTextNode(value));body.append(p);};
    line('Доступность:',availabilityLabel(skill));if(skill.availability?.reason)line('Основание:',skill.availability.reason);
    line('Оригинал:',skill.canonicalPath || skill.path);
    if(skill.canonicalPath && skill.canonicalPath!==skill.path)line('Ссылка:','Сохранение меняет исходный файл по указанному пути.');
    const registrations=skill.registrations||[{path:skill.path,scope:skill.scope}];
    const list=node('ul','');for(const r of registrations) {
      const item=node('li',`${r.scope} · ${r.path} · ${availabilityLabel(r)}`);
      if(r.runtimePath && r.runtimePath!==r.path) item.append(node('p',`Codex использует оригинал: ${r.runtimePath}. Переключение применяется к этому файлу.`));
      if(!skill.readOnly && !skill.disabled && !r.readOnly && ['enabled','disabled'].includes(r.availability?.status)) {
        const enabled=r.availability.status==='disabled';const toggle=node('button',enabled?'Включить':'Выключить','secondary');toggle.type='button';toggle.disabled=Boolean(state.busy)||controller.dirty;toggle.onclick=()=>perform(()=>controller.setEnabled(skill,enabled,{registrationPath:r.path}));item.append(document.createTextNode(' '),toggle);
      }
      list.append(item);
    }body.append(list);
    if(skill.git)line('Git:',skill.git.repository);
    if(skill.plugin)line('Плагин:',`${skill.plugin.name} · ${skill.plugin.version}`);
    const health=skill.health;
    if(!health){line('Проверки:','Данные ещё не получены');return;}
    const source=health.sourceCheck;
    const sourceLabel={'current':'Совпадает с проверенным источником','update-available':'Источник содержит изменения','unknown':'Актуальность неизвестна'};
    line('Источник:',source ? (sourceLabel[source.status] || source.status) : 'Ещё не проверялся');
    if(source){line('Проверка:',timestamp(source.checkedAt));if(source.reason)line('Результат:',source.reason);if(source.dirty)line('Рабочая копия:','Есть локальные изменения');if(source.fingerprint!==health.fingerprint)line('После проверки:','Пакет изменился; повторите проверку источника');}
    const check=node('button','Проверить источник','secondary');check.type='button';check.disabled=Boolean(state.busy)||controller.dirty;check.onclick=()=>perform(()=>controller.healthAction('check_source'));body.append(check);
    const review=health.review;
    line('Содержание:',!review?'Ревью не зафиксировано':review.state==='reviewed'?'Ревью зафиксировано для этой версии':'Пакет изменился — нужен повторный просмотр');
    if(review){line('Дата ревью:',timestamp(review.reviewedAt));line('Комментарий:',review.note);for(const url of review.evidenceUrls||[]) {const a=node('a',url);a.href=url;a.target='_blank';a.rel='noopener noreferrer';body.append(a,node('br',''));}}
    for(const problem of health.checks||[])line(problem.severity==='error'?'Ошибка:':'Замечание:',problem.message);
    const draft = reviewDrafts.get(skill.id) || {note:'',urls:''};
    reviewDrafts.set(skill.id,draft);
    const form=node('form','');form.className='review-form';
    const note=node('textarea','');note.placeholder='Что проверено и на каком основании';note.setAttribute('aria-label','Комментарий к ревью');note.required=true;note.maxLength=10000;note.value=draft.note;note.addEventListener('input',()=>{draft.note=note.value;});
    const urls=node('textarea','');urls.placeholder='Ссылки на основания проверки, по одной на строку';urls.setAttribute('aria-label','Источники ревью');urls.value=draft.urls;urls.addEventListener('input',()=>{draft.urls=urls.value;});
    const submit=node('button','Зафиксировать ревью','secondary');submit.type='submit';submit.disabled=Boolean(state.busy)||controller.dirty||!health.fingerprint;
    form.append(note,urls,submit);form.onsubmit=e=>{e.preventDefault();draft.note=note.value;draft.urls=urls.value;if(!note.value.trim())return;perform(()=>controller.healthAction('review_save',{fingerprint:health.fingerprint,note:note.value.trim(),evidenceUrls:urls.value.split(/\n/).map(s=>s.trim()).filter(Boolean)}));};body.append(form);
    if(controller.dirty)line('Несохранённые изменения:','Сохраните текст перед проверкой или фиксацией ревью.');
  }
  return {render};
}
