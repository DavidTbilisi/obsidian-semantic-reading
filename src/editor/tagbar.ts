import { Editor, MarkdownView } from 'obsidian';
import {
  TAGS, MODES, FAMILIES, cssTag, tagOrder, tagForKey,
} from '../constants';
import {
  applyTagRange,
  blockIdFor,
  findParagraphWithIndexAt,
  parseParagraph,
  plainTextOf,
  rawToPlain,
  serializeParagraph,
  stripOffsets,
} from '../syntax';

export type TagbarPosition =
  | 'auto'
  | 'top-left' | 'top-center' | 'top-right'
  | 'bottom-left' | 'bottom-center' | 'bottom-right'
  // 'invisible' keeps the tagbar armed for keyboard shortcuts but never renders
  // the picker — you tag the selection by pressing the letter key, no UI shown.
  | 'invisible';

export class Tagbar {
  // Cache the document we attach to so add/removeEventListener target the same
  // one even if focus later moves to a pop-out window (activeDocument would shift).
  private readonly doc: Document = activeDocument;
  private el: HTMLDivElement;
  private currentEditor: Editor | null = null;
  private currentView: MarkdownView | null = null;
  private currentSelection: { from: number; to: number } | null = null;
  // External commit hook used by non-markdown surfaces (PDF view). When set,
  // `apply(tag)` invokes this instead of running the markdown-editor commit.
  private pendingCommit: ((tag: string) => void | Promise<void>) | null = null;
  private mode: number;
  private getPosition: () => TagbarPosition;
  // True whenever a selection is armed for tagging — independent of whether the
  // picker is visually rendered. In 'invisible' position the bar stays armed
  // (so shortcuts fire) while `el` remains display:none.
  private active = false;
  private keyHandler: (e: KeyboardEvent) => void;
  private outsideClickHandler: (e: MouseEvent) => void;

  constructor(mode: number, getPosition: () => TagbarPosition = () => 'auto') {
    this.mode = mode;
    this.getPosition = getPosition;
    this.el = this.doc.createElement('div');
    this.el.className = 'sr-tagbar';
    this.el.addClass('is-hidden');
    this.doc.body.appendChild(this.el);

    this.keyHandler = (e: KeyboardEvent) => this.onKey(e);
    this.outsideClickHandler = (e: MouseEvent) => {
      if (this.active && !this.el.contains(e.target as Node)) this.hide();
    };
    this.doc.addEventListener('keydown', this.keyHandler, true);
    this.doc.addEventListener('mousedown', this.outsideClickHandler, true);
  }

  setMode(mode: number): void {
    this.mode = mode;
    if (this.isVisible()) this.render();
  }

  isVisible(): boolean {
    return !this.el.hasClass('is-hidden');
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
    this.active = true;

    if (this.getPosition() === 'invisible') { this.el.addClass('is-hidden'); return; }
    this.render();
    this.positionEl(view.contentEl, x, y);
    this.el.removeClass('is-hidden');
  }

  // Open the tagbar against a non-markdown surface. The caller owns the commit:
  // on tag pick the tagbar invokes `commit(tag)` and hides itself.
  showWithCommit(
    x: number,
    y: number,
    commit: (tag: string) => void | Promise<void>,
    paneEl?: HTMLElement,
  ): void {
    this.currentEditor = null;
    this.currentView = null;
    this.currentSelection = null;
    this.pendingCommit = commit;
    this.active = true;

    if (this.getPosition() === 'invisible') { this.el.addClass('is-hidden'); return; }
    this.render();
    this.positionEl(paneEl, x, y);
    this.el.removeClass('is-hidden');
  }

  // Place the tagbar according to the user's chosen position. In 'auto' mode we
  // float above the selection at (x, y). In any corner mode we pin to the
  // anchor pane's bounding rect (falls back to the window if no pane was given).
  private positionEl(anchor: HTMLElement | undefined, x: number, y: number): void {
    const mode = this.getPosition();
    const rect = this.el.getBoundingClientRect();
    const margin = 8;

    if (mode === 'auto') {
      const px = Math.min(Math.max(margin, x - rect.width / 2), window.innerWidth - rect.width - margin);
      const py = Math.max(margin, y - rect.height - 12);
      this.el.style.left = px + 'px';
      this.el.style.top = py + 'px';
      return;
    }

    const pane = anchor?.getBoundingClientRect()
      ?? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight, width: window.innerWidth, height: window.innerHeight } as DOMRect;

    const isTop = mode.startsWith('top-');
    const horiz = mode.slice(mode.indexOf('-') + 1);

    let px: number;
    if (horiz === 'left')   px = pane.left + margin;
    else if (horiz === 'right') px = pane.right - rect.width - margin;
    else                    px = pane.left + (pane.width - rect.width) / 2;

    const py = isTop ? pane.top + margin : pane.bottom - rect.height - margin;

    this.el.style.left = Math.max(margin, px) + 'px';
    this.el.style.top = Math.max(margin, py) + 'px';
  }

  hide(): void {
    this.el.addClass('is-hidden');
    this.active = false;
    this.currentEditor = null;
    this.currentView = null;
    this.currentSelection = null;
    this.pendingCommit = null;
  }

  destroy(): void {
    this.doc.removeEventListener('keydown', this.keyHandler, true);
    this.doc.removeEventListener('mousedown', this.outsideClickHandler, true);
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
    if (!this.active) return;
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
    if (this.pendingCommit) {
      const commit = this.pendingCommit;
      this.hide();
      void commit(tag);
      return;
    }
    const editor = this.currentEditor;
    const sel = this.currentSelection;
    if (!editor || !sel) return;

    const body = editor.getValue();
    const found = findParagraphWithIndexAt(body, sel.from);
    if (!found) { this.hide(); return; }
    const { block: para, index: paraIndex } = found;

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

    // Ensure paragraph carries a block-id so [[note#^id]] links from hub/synthesis resolve.
    // Use the existing id if there is one (user-set or assigned earlier); otherwise mint p<n>-sr.
    const blockId = para.blockId || blockIdFor(paraIndex);
    const finalText = newText + ' ^' + blockId;

    editor.replaceRange(
      finalText,
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
