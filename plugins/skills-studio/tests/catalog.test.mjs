import { setLanguage } from '../ui/i18n.mjs';
setLanguage('ru');
import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountCatalog, matchesStatus, needsAttention} from '../ui/catalog.mjs';

test('overview separates available, cached and disabled and review is bound to displayed fingerprint', async () => {
  const dom=new JSDOM('<button id="overview-button"></button><select id="status-filter"><option value="all">all</option></select><div id="overview-counts"></div><p id="overview-context"></p><details id="skill-details"></details>');
  const current={id:'a',name:'A',path:'/alias/SKILL.md',canonicalPath:'/repo/a/SKILL.md',availability:{status:'enabled'},registrations:[{path:'/alias/SKILL.md',scope:'global',availability:{status:'enabled'}}],health:{fingerprint:'abc',checks:[],review:null,sourceCheck:null}};
  const state={skills:[current,{id:'b',availability:{status:'cached'}},{id:'c',availability:{status:'disabled'}}],current,projects:[],projectId:null};
  const calls=[];const controller={dirty:false,healthAction:async(...args)=>calls.push(args),setEnabled:async(...args)=>calls.push(args)};
  const panel=mountCatalog({document:dom.window.document,controller,perform:f=>f(),overview:()=>{},onFilter:()=>{}});
  panel.render(state);
  assert.equal(matchesStatus(state.skills[1],'enabled'),false);
  assert.equal(matchesStatus(state.skills[2],'disabled'),true);
  assert.match(dom.window.document.querySelector('#skill-details').textContent,/Сохранение меняет исходный файл/);
  const form=dom.window.document.querySelector('form');form.querySelector('textarea').value='Проверены команды';form.querySelectorAll('textarea')[1].value='https://example.com/docs';
  form.dispatchEvent(new dom.window.Event('submit',{cancelable:true}));
  assert.deepEqual(calls[0],['review_save',{fingerprint:'abc',note:'Проверены команды',evidenceUrls:['https://example.com/docs']}]);
  current.health.review={state:'changed'};assert.equal(needsAttention(current),true);
  controller.dirty=true;panel.render(state);
  assert.equal(dom.window.document.querySelector('button[type=submit]').disabled,true);
  dom.window.close();
});


test('review drafts survive rejected save, source check and switching skills', async () => {
  const {StudioController}=await import('../ui/controller.mjs');
  const dom=new JSDOM('<button id="overview-button"></button><select id="status-filter"></select><div id="overview-counts"></div><p id="overview-context"></p><details id="skill-details"></details>');
  const health={fingerprint:'abc',checks:[],review:null,sourceCheck:null};
  const current={id:'a',name:'A',path:'/a/SKILL.md',content:'',availability:{status:'enabled'},health};
  let panel, pending;
  const controller=new StudioController(async name=>{
    if(name==='review_save')throw new Error('Review rejected');
    if(name==='check_source')return {health};
  },state=>panel.render(state));
  panel=mountCatalog({document:dom.window.document,controller,perform:f=>{pending=f().catch(()=>{});},overview:()=>{},onFilter:()=>{}});
  Object.assign(controller.state,{current,skills:[current]});panel.render(controller.state);
  const fields=()=>[...dom.window.document.querySelectorAll('.review-form textarea')];
  fields()[0].value='Keep my review';fields()[1].value='https://example.com/evidence';
  dom.window.document.querySelector('form').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));
  await pending;
  assert.equal(controller.state.error.message,'Review rejected');
  assert.deepEqual(fields().map(el=>el.value),['Keep my review','https://example.com/evidence']);
  await controller.healthAction('check_source');
  assert.deepEqual(fields().map(el=>el.value),['Keep my review','https://example.com/evidence']);
  controller.state.current={...current,id:'b'};panel.render(controller.state);
  assert.deepEqual(fields().map(el=>el.value),['','']);
  controller.state.current=current;panel.render(controller.state);
  assert.deepEqual(fields().map(el=>el.value),['Keep my review','https://example.com/evidence']);
  dom.window.close();
});
