import { setLanguage } from '../ui/i18n.mjs';
setLanguage('ru');
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createSkillMenu } from '../ui/skill-menu.mjs';

test('skill menu switches the scope action and protects packaged originals', () => {
  const dom = new JSDOM('<button id="trigger">Actions</button>');
  const doc = dom.window.document, calls = [];
  const menu = createSkillMenu({ document:doc, onAction:(action,skill) => calls.push([action,skill.id]) });
  try {
    const trigger = doc.querySelector('#trigger');
    menu.open({ skill:{ id:'one', scope:'global', name:'One' }, anchor:trigger, projectId:null });
    assert.equal(doc.querySelector('[data-action="move"]').disabled, true);
    assert.equal(doc.querySelector('[data-action="disable"]').textContent, 'Выключить');
    doc.querySelector('[data-action="disable"]').click();
    assert.deepEqual(calls.pop(), ['disable','one']);
    menu.open({ skill:{ id:'off', scope:'global', name:'Off', disabled:true }, anchor:trigger, projectId:null });
    assert.equal(doc.querySelector('[data-action="enable"]').textContent, 'Восстановить из архива');
    doc.querySelector('[data-action="enable"]').click();
    assert.deepEqual(calls.pop(), ['enable','off']);
    menu.open({ skill:{ id:'one', scope:'local', name:'One' }, anchor:trigger, projectId:'p' });
    assert.equal(doc.querySelector('[data-action="move"]').textContent, 'Сделать глобальным');
    doc.querySelector('[data-action="move"]').click();
    assert.deepEqual(calls, [['move','one']]);
    menu.open({ skill:{ id:'package', scope:'plugin', name:'Packaged', readOnly:true }, anchor:trigger, projectId:'p' });
    for (const action of ['rename','move','delete','disable']) assert.equal(doc.querySelector(`[data-action="${action}"]`).disabled, true);
    for (const action of ['copy','reveal']) assert.equal(doc.querySelector(`[data-action="${action}"]`).disabled, false);
    doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key:'ArrowDown', bubbles:true }));
    assert.equal(doc.activeElement.dataset.action, 'reveal');
    doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key:'ArrowDown', bubbles:true }));
    assert.equal(doc.activeElement.dataset.action, 'copy');
    doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key:'Escape', bubbles:true }));
    assert.equal(doc.querySelector('#skill-menu').hidden, true);
    assert.equal(doc.activeElement, trigger);
  } finally { menu.destroy(); dom.window.close(); }
});
