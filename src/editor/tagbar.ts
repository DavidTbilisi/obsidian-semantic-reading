import { Editor, MarkdownView } from 'obsidian';
import {
  TAGS, MODES, FAMILIES, cssTag, tagOrder, tagForKey,
} from '../constants';
import {
  applyTagRange,
  findParagraphAt,
  parseParagraph,
  plainTextOf,
  rawToPlain,
  serializeParagraph,
  stripOffsets,
} from '../syntax';

export class Tagbar {
  private el: HTMLDivElement;
  private currentEditor: Editor | null = null;
  private currentView: MarkdownView | null = null;
  private currentSelection: { from: number; to: number } | null = null;
  private mode: number;
  private keyHandler: (e: KeyboardEvent) => void;
  private outsideClickHandler: (e: MouseEvent) => void;

  constructor(mode: number) {
    this.mode = mode;
    this.el = document.createElement('div');
    this.el.className = 'sr-tagbar';
    this.el.style.display = 'none';
    document.body.appendChild(this.el);

    this.keyHandler = (e: KeyboardEvent) => this.onKey(e);
    this.outsideClickHandler = (e: MouseEvent) => {
      if (this.isVisible() && !this.el.contains(e.target as Node)) this.hide();
    };
    document.addEventListener('keydown', this.keyHandler, true);
    document.addEventListener('mousedown', this.outsideClickHandler, true);
  }

  setMode(mode: number): void {
    this.mode = mode;
    if (this.isVisible()) this.render();
  }

  isVisible(): boolean {
    return this.el.style.display !== 'none';
  }

  showFor(view: MarkdownView, x: number, y: number): void {
    const editor = view.editor;
    if (!editor) return;
    const sel = editor.getSelection();
    if (!sel) { this.hide(); return; }
    const from = editor.posToOffset(editor.getCursor('from'));
    const to = editor.posToOffset(editor.getCursor('to'));
    if (from === to) { this.hide(); return; }

    this.currentEditor = editor;
    this.currentView = view;
    this.currentSelection = { from, to };

    this.render();

    const rect = this.el.getBoundingClientRect();
    const px = Math.min(Math.max(8, x - rect.width / 2), window.innerWidth - rect.width - 8);
    const py = Math.max(8, y - rect.height - 12);
    this.el.style.left = px + 'px';
    this.el.style.top = py + 'px';
    this.el.style.display = '';
  }

  hide(): void {
    this.el.style.display = 'none';
    this.currentEditor = null;
    this.currentView = null;
    this.currentSelection = null;
  }

  destroy(): void {
    document.removeEventListener('keydown', this.keyHandler, true);
    document.removeEventListener('mousedown', this.outsideClickHandler, true);
    this.el.remove();
  }

  private render(): void {
    this.el.empty();
    const mode = MODES[this.mode] || MODES[3];
    const available = new Set(mode.tags);
    const ordered = tagOrder(t => available.has(t));
    // Group by family for visual grouping.
    const byFamily: Record<string, string[]> = {};
    ordered.forEach(t => {
      const fam = TAGS[t].family;
      (byFamily[fam] = byFamily[fam] || []).push(t);
    });

    FAMILIES.forEach(fam => {
      const tags = byFamily[fam];
      if (!tags || !tags.length) return;
      const group = this.el.createDiv({ cls: 'sr-tagbar-group' });
      group.createSpan({ cls: 'sr-tagbar-family', text: fam });
      tags.forEach(t => {
        const btn = group.createEl('button', {
          cls: 'sr-tagbar-btn sr-tg-' + cssTag(t),
          attr: { 'data-tag': t, title: TAGS[t].name + ' — ' + TAGS[t].desc },
        });
        btn.textContent = t;
        btn.onclick = (e) => { e.preventDefault(); this.apply(t); };
      });
    });

    const hint = this.el.createDiv({ cls: 'sr-tagbar-hint' });
    hint.setText('letter to tag · esc to cancel · mode ' + this.mode);
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.isVisible()) return;
    if (e.key === 'Escape') { e.preventDefault(); this.hide(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key.length !== 1) return;
    const tag = tagForKey(e.key);
    if (!tag) return;
    const mode = MODES[this.mode] || MODES[3];
    if (!mode.tags.includes(tag)) return;
    e.preventDefault();
    this.apply(tag);
  }

  private apply(tag: string): void {
    const editor = this.currentEditor;
    const sel = this.currentSelection;
    if (!editor || !sel) return;

    const body = editor.getValue();
    const para = findParagraphAt(body, sel.from);
    if (!para) { this.hide(); return; }

    // Clamp selection to the paragraph bounds.
    const fromInPara = Math.max(0, sel.from - para.start);
    const toInPara = Math.min(para.end - para.start, sel.to - para.start);
    if (toInPara <= fromInPara) { this.hide(); return; }

    const parsed = parseParagraph(para.text);
    const plainFrom = rawToPlain(parsed, fromInPara);
    const plainTo = rawToPlain(parsed, toInPara);
    if (plainTo <= plainFrom) { this.hide(); return; }

    const segs = parsed.map(stripOffsets);
    const newSegs = applyTagRange(segs, plainFrom, plainTo, tag);
    const newText = serializeParagraph(newSegs);

    editor.replaceRange(
      newText,
      editor.offsetToPos(para.start),
      editor.offsetToPos(para.end)
    );

    this.hide();
  }
}

// Returns the (x, y) page coords of the current selection (mouse-released or keyboard).
export function selectionCoords(): { x: number; y: number } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return { x: rect.left + rect.width / 2, y: rect.top };
}

// `plainTextOf` is re-exported here so the tagbar's callers don't need a second import path.
export { plainTextOf };
