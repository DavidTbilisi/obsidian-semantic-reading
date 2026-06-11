import { ItemView, WorkspaceLeaf, MarkdownView, TFile } from 'obsidian';
import { parseBody, countTags, flatExtracts, Paragraph } from '../syntax';
import { TAGS, CARD_GROUPS, FAMILIES, FamilyName, cssTag, tagOrder } from '../constants';

export const CARDS_VIEW_TYPE = 'semantic-reading-cards';

type SubView = 'cards' | 'sheet' | 'gaps';

export class CardsView extends ItemView {
  private active: SubView = 'cards';
  private currentFile: TFile | null = null;
  private paragraphs: Paragraph[] = [];
  private refreshHandle: number | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string { return CARDS_VIEW_TYPE; }
  getDisplayText(): string { return 'Semantic Reading'; }
  getIcon(): string { return 'list-tree'; }

  async onOpen(): Promise<void> {
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.scheduleRefresh()));
    this.registerEvent(this.app.workspace.on('editor-change', () => this.scheduleRefresh(200)));
    this.registerEvent(this.app.metadataCache.on('changed', (f) => {
      if (this.currentFile && f.path === this.currentFile.path) this.scheduleRefresh();
    }));
    void this.refresh();
  }

  async onClose(): Promise<void> {
    if (this.refreshHandle !== null) window.clearTimeout(this.refreshHandle);
  }

  private scheduleRefresh(delay = 60): void {
    if (this.refreshHandle !== null) window.clearTimeout(this.refreshHandle);
    this.refreshHandle = window.setTimeout(() => {
      this.refreshHandle = null;
      void this.refresh();
    }, delay);
  }

  private async refresh(): Promise<void> {
    // Use getActiveFile() instead of getActiveViewOfType(MarkdownView):
    // the latter returns null whenever the side panel itself is focused
    // (e.g. right after the user clicks Sheet/Gaps), wiping paragraphs
    // and rendering an empty view. getActiveFile() tracks the last
    // active *file* across leaf switches.
    const file = this.app.workspace.getActiveFile() ?? null;
    this.currentFile = file;
    if (!file || file.extension !== 'md') {
      this.paragraphs = [];
      this.render();
      return;
    }
    const editor = this.findEditorFor(file);
    const body = editor ? editor.getValue() : await this.app.vault.read(file);
    this.paragraphs = parseBody(stripFrontmatter(body));
    this.render();
  }

  private findEditorFor(file: TFile): import('obsidian').Editor | null {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const v = leaf.view;
      if (v instanceof MarkdownView && v.file?.path === file.path) return v.editor;
    }
    return null;
  }

  private render(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('sr-view-root');

    const header = root.createDiv({ cls: 'sr-view-header' });
    header.createEl('h3', { text: this.currentFile?.basename ?? 'No active note' });

    const tabs = root.createDiv({ cls: 'sr-view-tabs' });
    (['cards', 'sheet', 'gaps'] as SubView[]).forEach(t => {
      const b = tabs.createEl('button', {
        cls: 'sr-view-tab' + (t === this.active ? ' is-active' : ''),
        text: t === 'cards' ? 'Cards' : t === 'sheet' ? 'Sheet' : 'Gaps',
      });
      b.onclick = () => { this.active = t; this.render(); };
    });

    const body = root.createDiv({ cls: 'sr-view-body' });
    if (!this.currentFile) {
      body.createDiv({ cls: 'sr-view-empty', text: 'Open a note to see its semantic tags here.' });
      return;
    }
    if (this.active === 'cards') this.renderCards(body);
    else if (this.active === 'sheet') this.renderSheet(body);
    else this.renderGaps(body);
  }

  private renderCards(parent: HTMLElement): void {
    const counts = countTags(this.paragraphs);
    if (!Object.keys(counts).length) {
      parent.createDiv({ cls: 'sr-view-empty', text: 'No tags yet. Select text in the editor and press a tag letter.' });
      return;
    }
    this.paragraphs.forEach((segs, pi) => {
      const tagged = segs.filter(s => s.tag);
      if (!tagged.length) return;
      const card = parent.createDiv({ cls: 'sr-card' });
      card.createEl('h4', { cls: 'sr-card-title', text: '¶' + (pi + 1) });
      const counts: Record<string, number> = {};
      tagged.forEach(s => { counts[s.tag!] = (counts[s.tag!] || 0) + 1; });
      const chipRow = card.createDiv({ cls: 'sr-card-chips' });
      Object.keys(counts).forEach(t => {
        const chip = chipRow.createSpan({ cls: 'sr-chip sr-tg-' + cssTag(t) });
        chip.setText(t + ' · ' + counts[t]);
      });
      CARD_GROUPS.forEach(g => {
        const items = tagged.filter(s => g.tags.includes(s.tag!));
        if (!items.length) return;
        const sec = card.createDiv({ cls: 'sr-card-section' });
        sec.createEl('div', { cls: 'sr-card-section-label', text: g.label });
        items.forEach(s => {
          const row = sec.createDiv({ cls: 'sr-card-row' });
          row.createSpan({ cls: 'sr-row-tag sr-tg-' + cssTag(s.tag!), text: s.tag! });
          row.createSpan({ cls: 'sr-row-text', text: s.text });
          if (s.note) row.createSpan({ cls: 'sr-row-note', text: '— ' + s.note });
        });
      });
    });
  }

  private renderSheet(parent: HTMLElement): void {
    const extracts = flatExtracts(this.paragraphs);
    if (!extracts.length) {
      parent.createDiv({ cls: 'sr-view-empty', text: 'No tagged spans yet.' });
      return;
    }
    const byFam: Record<FamilyName, typeof extracts> = {
      Anchor: [], Meaning: [], Structure: [], Execution: [], Language: [],
    };
    extracts.forEach(e => {
      const fam = TAGS[e.tag]?.family;
      if (fam) byFam[fam].push(e);
    });
    FAMILIES.forEach(fam => {
      const items = byFam[fam];
      if (!items.length) return;
      const sec = parent.createDiv({ cls: 'sr-sheet-section' });
      sec.createEl('h4', { text: fam });
      const ordered = tagOrder(t => TAGS[t].family === fam);
      ordered.forEach(t => {
        const tagItems = items.filter(i => i.tag === t);
        if (!tagItems.length) return;
        const tagSec = sec.createDiv({ cls: 'sr-sheet-tag' });
        const head = tagSec.createDiv({ cls: 'sr-sheet-tag-head' });
        head.createSpan({ cls: 'sr-chip sr-tg-' + cssTag(t), text: t });
        head.createSpan({ cls: 'sr-sheet-tag-name', text: TAGS[t].name });
        tagItems.forEach(it => {
          const row = tagSec.createDiv({ cls: 'sr-sheet-row' });
          row.createSpan({ cls: 'sr-sheet-text', text: it.text });
          row.createSpan({ cls: 'sr-sheet-para', text: '¶' + it.paragraph });
        });
      });
    });
  }

  private renderGaps(parent: HTMLElement): void {
    const questions = flatExtracts(this.paragraphs, s => s.tag === 'Q');
    const notes = flatExtracts(this.paragraphs, s => !!s.note);
    if (!questions.length && !notes.length) {
      parent.createDiv({ cls: 'sr-view-empty', text: 'No questions or notes yet. Tag with Q or attach a note to a tagged span.' });
      return;
    }
    if (questions.length) {
      const sec = parent.createDiv({ cls: 'sr-sheet-section' });
      sec.createEl('h4', { text: 'Open questions' });
      questions.forEach(q => {
        const row = sec.createDiv({ cls: 'sr-sheet-row' });
        row.createSpan({ cls: 'sr-chip sr-tg-Q', text: 'Q' });
        row.createSpan({ cls: 'sr-sheet-text', text: q.text });
        row.createSpan({ cls: 'sr-sheet-para', text: '¶' + q.paragraph });
      });
    }
    if (notes.length) {
      const sec = parent.createDiv({ cls: 'sr-sheet-section' });
      sec.createEl('h4', { text: 'Reader notes' });
      notes.forEach(n => {
        const row = sec.createDiv({ cls: 'sr-sheet-row' });
        row.createSpan({ cls: 'sr-chip sr-tg-' + cssTag(n.tag), text: n.tag });
        row.createSpan({ cls: 'sr-sheet-text', text: n.text });
        const noteEl = row.createSpan({ cls: 'sr-row-note', text: '— ' + n.note });
        noteEl.setAttr('title', n.note || '');
        row.createSpan({ cls: 'sr-sheet-para', text: '¶' + n.paragraph });
      });
    }
  }
}

export function stripFrontmatter(body: string): string {
  if (!body.startsWith('---')) return body;
  const end = body.indexOf('\n---', 3);
  if (end < 0) return body;
  return body.slice(end + 4).replace(/^\n/, '');
}
