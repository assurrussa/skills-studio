import { language } from './i18n.mjs';
export class StudioController {
  constructor(call, onChange = () => {}) {
    this.call = call;
    this.onChange = onChange;
    this.baseline = '';
    this.originalContent = '';
    this.preferenceQueue = Promise.resolve();
    this.state = { language: 'en', projects: [], skills: [], context: null, projectId: null, hideSystemSkills: true, hidePluginSkills: false, collapsedSections: [], current: null, warnings: [], busy: false, status: 'Подключение…', error: null };
  }
  withCatalogChecks(current, skills = this.state.skills) {
    if (!current?.health) return current;
    const checks = skills.find(skill => skill.id === current.id)?.health?.checks || [];
    current.health.checks = [...current.health.checks.filter(check => !check.code.startsWith('DUPLICATE_')), ...checks.filter(check => check.code.startsWith('DUPLICATE_'))];
    return current;
  }
  get dirty() { return Boolean(this.state.current && this.state.current.content !== this.baseline); }
  emit() { this.onChange(this.state); }
  edit(content) { if (this.state.current && !this.state.current.readOnly && this.state.busy !== 'load') { this.state.current.content = content; this.emit(); } }
  guard(discard) {
    if (this.state.busy) throw Object.assign(new Error('Дождитесь завершения операции.'), { code: 'BUSY' });
    if (this.dirty && !discard) throw Object.assign(new Error('Есть несохранённые изменения.'), { code: 'UNSAVED' });
  }
  async run(operation, kind = 'load') {
    this.state.busy = kind; this.state.error = null; this.emit();
    try { return await operation(); }
    catch (error) { this.state.error = { code: error.code || 'ERROR', message: error.message }; throw error; }
    finally { this.state.busy = false; this.emit(); }
  }
  async initialize() {
    return this.run(async () => {
      const data = await this.call('open');
      const hideSystemSkills = data.hideSystemSkills !== false;
      const hidePluginSkills = data.hidePluginSkills === true;
      const catalog = await this.call('list', { projectId: data.selectedProjectId, includePlugins: !hidePluginSkills, includeSystem: !hideSystemSkills });
      Object.assign(this.state, { language: data.language === 'ru' ? 'ru' : 'en', projects: data.projects, projectId: data.selectedProjectId, hideSystemSkills, hidePluginSkills, collapsedSections: data.collapsedSections || [], skills: catalog.skills, context: catalog.context || null, warnings: [...new Set([...(data.warnings || []), ...catalog.warnings])], status: 'Выберите скилл' });
    });
  }
  async refresh({ discard = false } = {}) {
    this.guard(discard);
    return this.run(async () => {
      const projects = await this.call('projects');
      const projectId = projects.projects.some(p => p.id === this.state.projectId) ? this.state.projectId : null;
      const includePlugins = !this.state.hidePluginSkills, includeSystem = !this.state.hideSystemSkills;
      const catalog = await this.call('list', { projectId, includePlugins, includeSystem, forceReload: true });
      const currentId = this.state.current?.id;
      const current = currentId && catalog.skills.some(s => s.id === currentId) ? await this.call('read', { id: currentId, projectId, includePlugins, includeSystem }) : null;
      this.withCatalogChecks(current, catalog.skills);
      this.baseline = current?.content || '';
      this.originalContent = this.baseline;
      Object.assign(this.state, { projects: projects.projects, projectId, skills: catalog.skills, context: catalog.context || null, current, warnings: [...new Set([...projects.warnings, ...catalog.warnings])], status: 'Список обновлён' });
    });
  }
  async selectProject(projectId, { discard = false } = {}) {
    this.guard(discard);
    return this.run(async () => {
      const catalog = await this.call('list', { projectId, includePlugins: !this.state.hidePluginSkills, includeSystem: !this.state.hideSystemSkills });
      await this.call('select_project', { projectId });
      Object.assign(this.state, { projectId, skills: catalog.skills, context: catalog.context || null, warnings: catalog.warnings, current: null, status: 'Выберите скилл' });
      this.baseline = '';
      this.originalContent = '';
    });
  }
  async open(id, { discard = false } = {}) {
    this.guard(discard);
    return this.run(async () => {
      const current = await this.call('read', { id, projectId: this.state.projectId, includePlugins: !this.state.hidePluginSkills, includeSystem: !this.state.hideSystemSkills });
      this.withCatalogChecks(current);
      this.baseline = current.content;
      this.originalContent = current.content;
      Object.assign(this.state, { current, status: current.readOnly ? 'Только чтение' : 'Изменений нет' });
    });
  }
  async save() {
    if (!this.dirty || this.state.current?.readOnly) return;
    if (this.state.busy) return;
    return this.run(async () => {
      const current = this.state.current;
      const submitted = current.content;
      const result = await this.call('save', { id: current.id, projectId: this.state.projectId, includePlugins: !this.state.hidePluginSkills, includeSystem: !this.state.hideSystemSkills, revision: current.revision, content: submitted });
      current.revision = result.revision;
      if (result.health) current.health = result.health;
      this.state.skills = this.state.skills.map(s => s.id === current.id ? {...s, health:current.health} : s);
      this.baseline = submitted;
      this.state.context = null;
      this.state.status = this.dirty ? 'Есть новые несохранённые изменения' : 'Сохранено';
    }, 'save');
  }
  queuePreferences(patch) {
    const operation = this.preferenceQueue.then(() => this.call('update_preferences', patch));
    this.preferenceQueue = operation.catch(() => {});
    return operation;
  }
  async setLanguage(language) {
    if (!['en', 'ru'].includes(language)) throw new Error('Unsupported language.');
    if (this.state.busy || this.state.languageSaving || this.state.language === language) return;
    this.state.languageSaving = true; this.emit();
    // Commit only after persistence succeeds; a failed preference must not lie in the UI.
    try {
      await this.queuePreferences({language});
      this.state.language = language;
      this.state.error = null;
      this.emit();
    } catch (error) {
      this.state.error = {code:error.code || 'ERROR', message:error.message};
      this.emit();
      throw error;
    } finally { this.state.languageSaving = false; this.emit(); }
  }
  async setHideSystemSkills(hideSystemSkills) {
    if (this.state.busy) return;
    return this.run(async () => {
      const catalog = await this.call('list', { projectId: this.state.projectId, includePlugins: !this.state.hidePluginSkills, includeSystem: !hideSystemSkills });
      await this.queuePreferences({ hideSystemSkills });
      Object.assign(this.state, { hideSystemSkills, skills: catalog.skills, context: catalog.context || null, warnings: catalog.warnings });
      if (hideSystemSkills && this.state.current?.system) {
        this.state.current = null; this.baseline = ''; this.originalContent = ''; this.state.status = 'Выберите скилл';
      }
    });
  }
  async setHidePluginSkills(hidePluginSkills) {
    if (this.state.busy) return;
    return this.run(async () => {
      const catalog = await this.call('list', {projectId:this.state.projectId, includePlugins:!hidePluginSkills, includeSystem:!this.state.hideSystemSkills});
      await this.queuePreferences({hidePluginSkills});
      Object.assign(this.state, {hidePluginSkills, skills:catalog.skills, context:catalog.context || null, warnings:catalog.warnings});
      if (hidePluginSkills && this.state.current?.scope === 'plugin') {
        this.state.current = null; this.baseline = ''; this.originalContent = '';
      }
    });
  }
  async overview({discard = false} = {}) {
    this.guard(discard);
    this.state.current = null; this.baseline = ''; this.originalContent = ''; this.emit();
    if (!this.state.context) await this.run(async () => {
      const catalog = await this.call('list', {projectId:this.state.projectId, includePlugins:!this.state.hidePluginSkills, includeSystem:!this.state.hideSystemSkills});
      Object.assign(this.state, {skills:catalog.skills, context:catalog.context || null, warnings:catalog.warnings});
    });
  }
  async healthAction(name, values = {}) {
    this.guard(false);
    const current = this.state.current;
    if (!current) return;
    return this.run(async () => {
      const result = await this.call(name, {id:current.id, projectId:this.state.projectId, includePlugins:!this.state.hidePluginSkills, includeSystem:!this.state.hideSystemSkills, ...values});
      current.health = result.health;
      this.withCatalogChecks(current);
      this.state.skills = this.state.skills.map(s => s.id === current.id ? {...s, health:result.health} : s);
      this.state.status = name === 'review_save' ? 'Ревью сохранено' : 'Проверка источника завершена';
    });
  }
  async setEnabled(skill, enabled, {discard = false, registrationPath} = {}) {
    this.guard(discard);
    await this.run(async () => {
      await this.call('set_enabled', {id:skill.id, projectId:this.state.projectId, includePlugins:!this.state.hidePluginSkills, includeSystem:!this.state.hideSystemSkills, enabled, ...(registrationPath ? {registrationPath} : {})});
    });
    await this.refresh({discard:true});
  }
  toggleSection(sectionId) {
    const collapsed = new Set(this.state.collapsedSections);
    if (collapsed.has(sectionId)) collapsed.delete(sectionId); else collapsed.add(sectionId);
    this.state.collapsedSections = [...collapsed];
    this.emit();
    return this.queuePreferences({ collapsedSections: this.state.collapsedSections });
  }
  async manage(action, skill, { name, scope, discard = false } = {}) {
    this.guard(discard);
    return this.run(async () => {
      const common = { projectId:this.state.projectId, includePlugins:!this.state.hidePluginSkills, includeSystem:!this.state.hideSystemSkills };
      const before = this.state.current?.id === skill.id ? this.state.current : await this.call('read', { ...common, id:skill.id });
      const result = await this.call('manage', { ...common, id:skill.id, revision:before.revision, action, ...(name !== undefined ? { name } : {}), ...(scope ? { scope } : {}) });
      const catalog = await this.call('list', common);
      let current = result.skill;
      if (current) current = {...current, health:catalog.skills.find(s => s.id === current.id)?.health};
      if (!current && this.state.current?.id !== skill.id && catalog.skills.some(item => item.id === this.state.current?.id)) current = await this.call('read', { ...common, id:this.state.current.id });
      Object.assign(this.state, { skills:catalog.skills, context:catalog.context || null, warnings:catalog.warnings, current:current || null, status:{rename:'Скилл переименован',copy:'Копия создана',move:'Скилл перемещён',delete:'Скилл удалён; резервная копия сохранена',enable:'Скилл включён',disable:'Скилл выключен'}[action] });
      this.baseline = current?.content || ''; this.originalContent = this.baseline;
      return result;
    });
  }
  async reveal(skill) {
    return this.call('reveal', { id:skill.id, projectId:this.state.projectId, includePlugins:!this.state.hidePluginSkills, includeSystem:!this.state.hideSystemSkills });
  }
  async locationAction(action) {
    const skill=this.state.current;
    if (!skill || this.state.busy) return;
    if (!['copy_path','open_terminal'].includes(action)) throw new Error('Неизвестное действие.');
    return this.run(async()=>{
      const result=await this.call(action,{id:skill.id,projectId:this.state.projectId,includePlugins:!this.state.hidePluginSkills,includeSystem:!this.state.hideSystemSkills});
      this.state.status=action==='copy_path'?'Путь к оригиналу скопирован':'Папка открыта в терминале';
      return result;
    },'location');
  }
}
