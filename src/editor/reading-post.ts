import { MarkdownPostProcessor } from 'obsidian';
import { MARK_REGEX } from '../syntax';
import { cssTag } from '../constants';
import { tintCustomTag } from '../custom-tags';

// Walks rendered DOM text nodes inside a block and replaces {{Tag|text}} occurrences
// with a styled span + superscript label.
export const semanticReadingPostProcessor: MarkdownPostProcessor = (el) => {
  walkTextNodes(el, (textNode) => {
    const raw = textNode.nodeValue || '';
    if (!raw.includes('{{')) return;
    const re = new RegExp(MARK_REGEX.source, 'g');
    let m: RegExpExecArray | null;
    let last = 0;
    const frag = activeDocument.createDocumentFragment();
    let matched = false;
    while ((m = re.exec(raw)) !== null) {
      matched = true;
      if (m.index > last) frag.appendChild(activeDocument.createTextNode(raw.slice(last, m.index)));
      const tag = m[1];
      const text = m[2];
      const note = m[3];
      const span = activeDocument.createElement('span');
      span.className = 'sr-tspan sr-tg-' + cssTag(tag);
      tintCustomTag(span, tag);
      if (note) {
        span.classList.add('sr-has-note');
        span.title = note;
      }
      span.textContent = text;
      const sup = activeDocument.createElement('sup');
      sup.className = 'sr-tlabel';
      sup.textContent = tag;
      span.appendChild(sup);
      frag.appendChild(span);
      last = m.index + m[0].length;
    }
    if (!matched) return;
    if (last < raw.length) frag.appendChild(activeDocument.createTextNode(raw.slice(last)));
    textNode.parentNode?.replaceChild(frag, textNode);
  });
};

function walkTextNodes(root: Node, fn: (n: Text) => void): void {
  const walker = activeDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const collected: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) {
    // Avoid re-processing nodes we've already wrapped.
    if (n.parentElement && n.parentElement.closest('.sr-tspan')) continue;
    collected.push(n as Text);
  }
  collected.forEach(fn);
}
