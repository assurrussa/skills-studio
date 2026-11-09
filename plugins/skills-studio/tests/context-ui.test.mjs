import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountContextOverview} from '../ui/context.mjs';
import {StudioController} from '../ui/controller.mjs';
const context={method:'o200k_base',estimated:true,enabledCount:2,metadataTokens:160,instructionTokens:6000,excluded:{disabled:3,cached:1,unknown:2,invalid:1},entries:[{id:'p',name:'Plugin',source:'Demo plugin',scope:'plugin',metadataTokens:100,instructionTokens:5000},{id:'g',name:'Global',source:'Личные',scope:'global',metadataTokens:60,instructionTokens:1000}]};
test('overview separates baseline, on-demand instructions, incomplete data and actual request usage',()=>{
 const dom=new JSDOM('<section></section>');const target=dom.window.document.querySelector('section');const panel=mountContextOverview({document:dom.window.document,target});panel.render(context);
 assert.match(target.querySelector('.context-metric').textContent,/160 токенов/);
 assert.doesNotMatch(target.querySelector('.context-metric').textContent,/6000|6.000/);
 assert.match(target.querySelector('.context-caution').textContent,/доступность не подтверждена — 3; ошибки метаданных — 1/);
 assert.match(target.textContent,/а не расход конкретного запроса/);assert.match(target.textContent,/Скрытие в списке не выключает навык/);
 assert.match(target.querySelector('.context-method').textContent,/AGENTS.md.*MCP/);
 assert.equal(target.querySelector('.context-help').open,false);
 assert.equal(target.querySelector('.context-explanation').tagName,'DETAILS');
 assert.equal(target.querySelector('.context-explanation').open,false);
 assert.equal(target.querySelector('.context-caution').closest('details'),null,'attention remains visible without opening help');
 assert.match(target.querySelector('.context-help').textContent,/а не расход конкретного запроса/);
 const rows=()=>[...target.querySelectorAll('tbody tr')];assert.equal(rows().length,2);assert.match(rows()[0].textContent,/Plugin/);
 const input=target.querySelector('input');input.value='global';input.dispatchEvent(new dom.window.Event('input'));
 assert.equal(rows().length,1);assert.match(rows()[0].textContent,/Global/);
 panel.render(context);assert.equal(target.querySelector('input'),input);
 panel.render({...context,metadataTokens:170});assert.equal(target.querySelector('input').value,'global');assert.equal(rows().length,1);
 panel.render(null);assert.match(target.textContent,/Оценка ещё не получена/);assert.equal(rows().length,0);dom.window.close();
});
test('zero confirmed entries stays visibly incomplete without invalid bars',()=>{
 const dom=new JSDOM('<section></section>');const target=dom.window.document.querySelector('section');
 mountContextOverview({document:dom.window.document,target}).render({...context,entries:[],enabledCount:0,metadataTokens:0});
 assert.match(target.textContent,/Неполная оценка/);assert.equal(target.querySelector('.context-track'),null);dom.window.close();
});

test('coverage explains the full catalogue separately from filtered sidebar and unsafe token estimates',()=>{
 const dom=new JSDOM('<section></section>'),target=dom.window.document.querySelector('section');
 const panel=mountContextOverview({document:dom.window.document,target});
 panel.render({...context,totalCount:186,enabledCount:35,measuredCount:35,excluded:{disabled:23,cached:128,unknown:0,invalid:0}},{visibleCount:181});
 assert.match(target.querySelector('.context-coverage').textContent,/35 из 186.*выключено — 23.*не подтверждено — 128/);
 assert.match(target.querySelector('.context-visibility').textContent,/слева — 181.*Ещё 5 скрыты/);
 assert.match(target.querySelector('.context-caution').textContent,/не означает, что они выключены/);
 assert.match(target.querySelector('.context-explanation').textContent,/не фиксированная добавка к каждому запросу/);
 panel.render({...context,metadataTokens:null,measuredCount:1,excluded:{}});
 assert.match(target.querySelector('.context-caution').textContent,/токены не рассчитаны — 1/);
 assert.match(target.querySelector('.context-coverage').textContent,/В расчёте: 1 из 2/);
 dom.window.close();
});

test('recalculate forces runtime reload, keeps last estimate while busy and preserves disclosure state',async()=>{
 const dom=new JSDOM('<section></section>'),target=dom.window.document.querySelector('section');
 let panel,pending,release,fail=false;const calls=[];
 const c=new StudioController(async(name,args)=>{
  if(name==='open')return {projects:[],warnings:[],selectedProjectId:null};
  if(name==='projects')return {projects:[],warnings:[]};
  if(name==='list'){
   calls.push(args);
   if(args.forceReload){await new Promise(resolve=>{release=resolve;});if(fail)throw new Error('Codex недоступен');}
   return {skills:[],warnings:[],context:{...context,metadataTokens:args.forceReload?200:160,checkedAt:'2026-11-09T10:00:00Z'}};
  }
 },state=>panel.render(state.context,{busy:Boolean(state.busy),visibleCount:state.skills.length}));
 panel=mountContextOverview({document:dom.window.document,target,onRecalculate:()=>{pending=c.refresh();}});
 await c.initialize();
 target.querySelector('.context-explanation').open=true;
 target.querySelector('.context-refresh').click();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(target.querySelector('.context-refresh').disabled,true);
 assert.match(target.querySelector('.context-refresh').textContent,/Пересчитываю/);
 assert.match(target.querySelector('.context-metric').textContent,/160/);
 release();await pending;
 assert.equal(calls.at(-1).forceReload,true);assert.match(target.querySelector('.context-metric').textContent,/200/);
 assert.equal(target.querySelector('.context-explanation').open,true);
 assert.equal(target.querySelector('.context-updated').dateTime,'2026-11-09T10:00:00Z');
 assert.equal(target.querySelector('.context-refresh').disabled,false);
 const previous=c.state.context;fail=true;
 const rejected=c.refresh();await new Promise(resolve=>setImmediate(resolve));release();await assert.rejects(rejected,/Codex недоступен/);
 assert.equal(c.state.context,previous);assert.equal(target.querySelector('.context-refresh').disabled,false);
 dom.window.close();
});
test('controller preserves complete estimate through filters and recalculates after save on overview',async()=>{
 let value=160;const c=new StudioController(async(name,args)=>{
  if(name==='open')return {projects:[],warnings:[],selectedProjectId:null};
  if(name==='list')return {skills:[],warnings:[],context:{...context,metadataTokens:value}};
  if(name==='update_preferences')return args;
  if(name==='read')return {id:'g',content:'old',revision:'1'};
  if(name==='save'){value=180;return {revision:'2'};}
 });
 await c.initialize();assert.equal(c.state.context.metadataTokens,160);
 await c.setHidePluginSkills(true);await c.setHideSystemSkills(false);assert.equal(c.state.context.metadataTokens,160);
 await c.open('g');c.edit('new');await c.save();assert.equal(c.state.context,null);
 await c.overview();assert.equal(c.state.context.metadataTokens,180);
});
