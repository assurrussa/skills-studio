import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createProjectPicker } from '../ui/project-picker.mjs';

function fixture(t) {
  const dom = new JSDOM('<div id="picker"><button id="trigger" type="button"></button><div id="popup" hidden><input id="filter"><div id="options"></div></div></div><button id="outside">Outside</button>');
  t.after(() => dom.window.close());
  const $ = id => dom.window.document.getElementById(id);
  const selected = [];
  const picker = createProjectPicker({ trigger:$('trigger'),popup:$('popup'),search:$('filter'),options:$('options'),onSelect:value=>selected.push(value) });
  t.after(() => picker.destroy());
  picker.setOptions([{id:'alpha',name:'Alpha',roots:['/projects/alpha']},{id:'beta',name:'Beta',roots:['/projects/beta']}], 'alpha');
  const key = value => $('filter').dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true}));
  return {dom,$,picker,selected,key};
}

test('project menu opens with the selected project and filters names and paths', t => {
  const f = fixture(t);
  f.$('trigger').click();
  assert.equal(f.$('popup').hidden,false);
  assert.equal(f.$('trigger').getAttribute('aria-expanded'),'true');
  assert.equal(f.$('options').querySelector('[aria-selected="true"]').textContent.includes('Alpha'),true);
  assert.equal(f.dom.window.document.activeElement,f.$('filter'));
  f.$('filter').value='/projects/beta';f.$('filter').dispatchEvent(new f.dom.window.Event('input'));
  assert.deepEqual([...f.$('options').querySelectorAll('[role="option"]')].map(x=>x.dataset.value),['beta']);
});

test('project menu supports keyboard selection and restores focus on Escape', t => {
  const f = fixture(t);
  f.$('trigger').click();
  f.key('ArrowDown');f.key('Enter');
  assert.deepEqual(f.selected,['beta']);
  assert.equal(f.$('popup').hidden,true);
  f.$('trigger').click();f.key('Escape');
  assert.equal(f.$('popup').hidden,true);
  assert.equal(f.dom.window.document.activeElement,f.$('trigger'));
});

test('global-only selection, outside click and busy state work without losing current selection', t => {
  const f = fixture(t);
  f.$('trigger').click();
  f.$('options').querySelector('[data-value=""]').click();
  assert.deepEqual(f.selected,[null]);
  // The trigger changes only when the controller confirms the selected project.
  assert.match(f.$('trigger').textContent,/Alpha/);
  f.$('trigger').click();
  f.$('outside').dispatchEvent(new f.dom.window.Event('pointerdown',{bubbles:true}));
  assert.equal(f.$('popup').hidden,true);
  f.$('trigger').click();f.picker.setDisabled(true);
  assert.equal(f.$('popup').hidden,true);
  assert.equal(f.$('trigger').disabled,true);
  f.$('trigger').click();assert.equal(f.$('popup').hidden,true);
});
