import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderMarkdown } from '../ui/preview.mjs';

test('preview renders skill metadata, common Markdown and literal fenced code', () => {
  const dom = new JSDOM('<article></article>');
  try {
    const target = dom.window.document.querySelector('article');
    renderMarkdown(target, '---\nname: Demo\ndescription: A skill\n---\n# Heading\n\n**Bold** and *emphasis* with [docs](https://example.com).\n\n- One\n- Two\n\n> Note\n\n| Key | Value |\n| --- | --- |\n| A | B |\n\n```html\n<script>alert(1)</script>\n```');
    assert.match(target.querySelector('.preview-metadata pre').textContent, /name: Demo/);
    assert.equal(target.querySelector('h1').textContent, 'Heading');
    assert.equal(target.querySelector('strong').textContent, 'Bold');
    assert.equal(target.querySelector('em').textContent, 'emphasis');
    assert.equal(target.querySelectorAll('li').length, 2);
    assert.equal(target.querySelector('blockquote').textContent.trim(), 'Note');
    assert.equal(target.querySelector('td').textContent, 'A');
    assert.equal(target.querySelector('pre code.language-html').textContent.trim(), '<script>alert(1)</script>');
    assert.equal(target.querySelector('a').getAttribute('href'), 'https://example.com');
    assert.equal(target.querySelector('a').getAttribute('rel'), 'noopener noreferrer');
  } finally { dom.window.close(); }
});

test('preview treats embedded HTML as text and never loads image resources', () => {
  const dom = new JSDOM('<article></article>');
  try {
    const target = dom.window.document.querySelector('article');
    renderMarkdown(target, '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert(1))\n\n[bad2](data:text/html,attack)\n\n![Alt text](https://example.com/tracker.png)\n\n![bad](data:image/svg+xml,attack)');
    assert.equal(target.querySelector('script,img,iframe,object,embed'), null);
    assert.equal(target.querySelector('[onerror],[onclick]'), null);
    assert.ok([...target.querySelectorAll('a')].every(link => !/^(?:javascript|data):/i.test(link.getAttribute('href'))));
    assert.match(target.textContent, /Alt text/);
    renderMarkdown(target, '---\nUnfinished frontmatter');
    assert.match(target.textContent, /Unfinished frontmatter/);
  } finally { dom.window.close(); }
});
