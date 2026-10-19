/**
 * The small subset of Markdown the assistant is allowed to use: paragraphs, bullet and
 * numbered lists, **bold** and `code`. Model output is untrusted, so everything is escaped
 * first and nothing can produce a link, an image or raw HTML.
 */

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function inline(text: string): string {
  return esc(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
}

const BULLET = /^\s*[-•*]\s+(.*)$/;
const NUMBER = /^\s*\d{1,2}[.)]\s+(.*)$/;

/** Splits text into blocks and returns the HTML of each one. */
export function renderBlocks(text: string): string[] {
  const blocks: string[] = [];
  let para: string[] = [];
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null;
  const flush = () => {
    if (para.length) blocks.push(`<p>${para.map(inline).join('<br>')}</p>`);
    if (list) blocks.push(`<${list.tag}>${list.items.map(i => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
    para = [];
    list = null;
  };
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.replace(/^#{1,6}\s+/, ''); // headings are not part of the style: keep their text only
    const b = BULLET.exec(line);
    const n = b ? null : NUMBER.exec(line);
    if (b || n) {
      const tag = b ? 'ul' : 'ol';
      if (para.length || (list && list.tag !== tag)) flush();
      list ??= { tag, items: [] };
      list.items.push((b ?? n)![1]);
    } else if (!line.trim()) flush();
    else {
      if (list) flush();
      para.push(line.trim());
    }
  }
  flush();
  return blocks;
}

/**
 * Updates a container to show `text`. Finished blocks are left untouched and only the
 * last one is rewritten, so already-rendered text does not flicker or re-animate while streaming.
 */
export function renderInto(el: HTMLElement, text: string) {
  const blocks = renderBlocks(text);
  const have = el.children.length;
  for (let i = Math.max(0, have - 1); i < blocks.length; i++) {
    const existing = el.children[i] as HTMLElement | undefined;
    if (existing) {
      if (existing.dataset.src !== blocks[i]) {
        const tpl = document.createElement('template');
        tpl.innerHTML = blocks[i];
        const fresh = tpl.content.firstElementChild as HTMLElement;
        fresh.dataset.src = blocks[i];
        existing.replaceWith(fresh);
      }
    } else {
      const tpl = document.createElement('template');
      tpl.innerHTML = blocks[i];
      const fresh = tpl.content.firstElementChild as HTMLElement;
      fresh.dataset.src = blocks[i];
      fresh.classList.add('is-new');
      el.appendChild(fresh);
    }
  }
  while (el.children.length > blocks.length) el.lastElementChild!.remove();
}

/** Plain text for speech synthesis and the clipboard. */
export const toPlain = (text: string) =>
  text
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^\s*[-•*]\s+/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .trim();
