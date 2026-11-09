import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createModelPicker } from '../ui/model-picker.mjs';

function fixture(t) {
  const dom = new JSDOM('<div><button id="model"></button><div id="popup" hidden><div id="options"></div></div></div><button id="outside">Outside</button>');
  const document = dom.window.document, $ = id => document.getElementById(id);
  const picker = createModelPicker({ trigger:$('model'), popup:$('popup'), options:$('options') });
  picker.setOptions([{model:'fast',displayName:'Fast'},{model:'smart',displayName:'Smart',isDefault:true}]);
  t.after(() => { picker.destroy(); dom.window.close(); });
  const key = value => document.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true}));
  return { dom, document, $, picker, key };
}

test('model selection survives catalog refresh and cannot change while the picker is disabled', t => {
  const f = fixture(t);
  assert.equal(f.$('model').value,'smart');
  f.$('model').click();
  assert.equal(f.document.activeElement.textContent,'Smart');
  f.key('Home'); f.key('Enter');
  assert.equal(f.$('model').value,'fast');
  f.picker.setOptions([{model:'smart',displayName:'Smart',isDefault:true},{model:'fast',displayName:'Fast updated'}]);
  assert.equal(f.$('model').value,'fast');
  assert.equal(f.$('model').textContent,'Fast updated');
  f.$('model').click(); f.picker.setDisabled(true);
  assert.equal(f.$('popup').hidden,true);
  f.$('model').click();
  assert.equal(f.$('popup').hidden,true);
  assert.equal(f.$('model').value,'fast');
  f.picker.setDisabled(false);
  f.picker.setOptions([{model:'replacement',displayName:'Replacement'}]);
  assert.equal(f.$('model').value,'replacement');
});

test('model menu dismisses on outside interaction and Tab without committing a highlighted choice', t => {
  const f = fixture(t);
  f.$('model').click(); f.key('Home'); f.key('Tab');
  assert.equal(f.$('popup').hidden,true);
  assert.equal(f.document.activeElement,f.$('model'));
  assert.equal(f.$('model').value,'smart');
  f.$('model').click();
  f.$('outside').dispatchEvent(new f.dom.window.Event('pointerdown',{bubbles:true}));
  assert.equal(f.$('popup').hidden,true);
  f.$('model').click(); f.$('outside').focus();
  assert.equal(f.$('popup').hidden,true);
  assert.equal(f.document.activeElement,f.$('outside'));
});
