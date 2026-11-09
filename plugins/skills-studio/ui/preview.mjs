import { Marked } from 'marked';

const escape = text => text.replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
const markdown = new Marked({ gfm: true, renderer: {
  html: ({ text }) => escape(text),
  // Previewing a local document must not fetch remote resources automatically.
  image: ({ text }) => `<span class="preview-image" title="Изображение">▧ ${escape(text || 'Изображение')}</span>`,
} });
const allowedTags = new Set('p h1 h2 h3 h4 h5 h6 ul ol li pre code blockquote table thead tbody tr th td strong em del hr br a span input'.split(' '));

function safeHref(value) {
  if (!value || /[\u0000-\u0020\u007f]/.test(value)) return null;
  if (value.startsWith('#')) return value;
  try { return ['http:', 'https:', 'mailto:'].includes(new URL(value).protocol) ? value : null; }
  catch { return null; }
}

function safeMarkdown(document, content) {
  // Parse in an inert template, then construct fresh nodes with an explicit
  // element/attribute allowlist. Never attach the parsed HTML itself.
  const template = document.createElement('template');
  template.innerHTML = markdown.parse(content);
  function copy(source) {
    if (source.nodeType === 3) return document.createTextNode(source.textContent);
    const tag = source.localName;
    if (source.namespaceURI !== 'http://www.w3.org/1999/xhtml' || !allowedTags.has(tag)) return document.createDocumentFragment();
    if (tag === 'input' && source.getAttribute('type') !== 'checkbox') return document.createDocumentFragment();
    const element = document.createElement(tag);
    if (tag === 'a') {
      const href = safeHref(source.getAttribute('href'));
      if (href) { element.setAttribute('href', href); element.setAttribute('target', '_blank'); element.setAttribute('rel', 'noopener noreferrer'); }
      if (source.hasAttribute('title')) element.title = source.getAttribute('title');
    }
    if (tag === 'code' && /^language-[\w+-]+$/.test(source.className)) element.className = source.className;
    if (tag === 'span' && source.className === 'preview-image') { element.className = 'preview-image'; element.title = 'Изображение'; }
    if (tag === 'ol' && /^-?\d+$/.test(source.getAttribute('start') || '')) element.setAttribute('start', source.getAttribute('start'));
    if (tag === 'input') { element.type = 'checkbox'; element.disabled = true; element.checked = source.hasAttribute('checked'); }
    for (const child of source.childNodes) element.append(copy(child));
    return element;
  }
  return [...template.content.childNodes].map(copy);
}

export function renderMarkdown(target, content) {
  const document = target.ownerDocument;
  const fragment = document.createDocumentFragment();
  const frontmatter = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (frontmatter) {
    const details = document.createElement('details'); details.className = 'preview-metadata';
    const summary = document.createElement('summary'); summary.textContent = 'Метаданные скилла';
    const pre = document.createElement('pre'); const code = document.createElement('code');
    code.textContent = frontmatter[1]; pre.append(code); details.append(summary, pre); fragment.append(details);
    content = content.slice(frontmatter[0].length);
  }
  const body = document.createElement('div'); body.className = 'markdown-body';
  body.append(...safeMarkdown(document, content));
  fragment.append(body); target.replaceChildren(fragment); target.scrollTop = 0;
}
