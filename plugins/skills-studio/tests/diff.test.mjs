import { setLanguage } from '../ui/i18n.mjs';
setLanguage('ru');
import test from 'node:test';
import assert from 'node:assert/strict';

import { createUnifiedDiff } from '../ui/diff.mjs';

test('unified diff identifies replacements and keeps context line numbers', () => {
  const diff = createUnifiedDiff('first\nold\nlast\n', 'first\nnew\nlast\n');
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  assert.equal(diff.hunks[0].header, '@@ -1,3 +1,3 @@');
  assert.deepEqual(diff.hunks[0].lines, [
    { kind: 'context', text: 'first', oldLine: 1, newLine: 1 },
    { kind: 'remove', text: 'old', oldLine: 2, newLine: null },
    { kind: 'add', text: 'new', oldLine: null, newLine: 2 },
    { kind: 'context', text: 'last', oldLine: 3, newLine: 3 },
  ]);
});

test('empty files, blank lines and missing final newlines remain visible', () => {
  assert.deepEqual(createUnifiedDiff('', '').hunks, []);
  assert.deepEqual(createUnifiedDiff('same\n', 'same\n').hunks, []);
  const added = createUnifiedDiff('', '\ntext');
  assert.equal(added.hunks[0].header, '@@ -0,0 +1,2 @@');
  assert.equal(added.added, 2);
  assert.deepEqual(added.hunks[0].lines.map(line => [line.kind, line.text]), [
    ['add', ''], ['add', 'text'], ['note', 'Нет перевода строки в конце файла'],
  ]);
  const removed = createUnifiedDiff('text\n', '');
  assert.equal(removed.hunks[0].header, '@@ -1,1 +0,0 @@');
  assert.equal(removed.removed, 1);
  const newline = createUnifiedDiff('text', 'text\n');
  assert.equal(newline.added, 1);
  assert.equal(newline.removed, 1);
});

test('distant edits form separate hunks with three lines of context', () => {
  const before = Array.from({ length: 20 }, (_, i) => `${i + 1}\n`).join('');
  const after = before.replace('2\n', 'two\n').replace('18\n', 'eighteen\n');
  const diff = createUnifiedDiff(before, after);
  assert.deepEqual(diff.hunks.map(hunk => hunk.header), ['@@ -1,5 +1,5 @@', '@@ -15,6 +15,6 @@']);
  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 2);
});

test('large rewrites finish without quadratic memory and preserve all changed lines', () => {
  const before = Array.from({ length: 3000 }, (_, i) => `old ${i}\n`).join('');
  const after = Array.from({ length: 3000 }, (_, i) => `new ${i}\n`).join('');
  const diff = createUnifiedDiff(before, after);
  assert.equal(diff.removed, 3000);
  assert.equal(diff.added, 3000);
  assert.equal(diff.hunks[0].header, '@@ -1,3000 +1,3000 @@');
});
