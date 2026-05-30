import { App, Editor, MarkdownView, Modal, Notice } from 'obsidian';
import { AIClient, TagSuggestion } from './client';
import { applyTagRange, findParagraphAt, parseParagraph, plainTextOf, serializeParagraph, stripOffsets } from '../syntax';
import { TAGS, MODES, cssTag } from '../constants';

export class SuggestModal extends Modal {
  private ai: AIClient;
  private view: MarkdownView;
  private mode: number;
  private suggestions: (TagSuggestion & { accepted?: boolean })[] = [];
  private loading = true;
  private error: string | null = null;
  private paragraphIndex = -1;

  constructor(app: App, ai: AIClient, view: MarkdownView, mode: number) {
    super(app);
    this.ai = ai;
    this.view = view;
    this.mode = mode;
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'AI tag suggestions' });
    this.render();
    await this.run();
  }

  private async run(): Promise<void> {
    const editor = this.view.editor;
    if (!editor) { this.error = 'No active editor'; this.loading = false; this.render(); return; }
    const cursor = editor.posToOffset(editor.getCursor());
    const body = editor.getValue();
    const para = findParagraphAt(body, cursor);
    if (!para) { this.error = 'Cursor is not in a paragraph'; this.loading = false; this.render(); return; }

    // Compute paragraph index for later replaceRange.
    const blocks = body.split(/\n[ \t]*\n+/);
    let runningOffset = 0;
    this.paragraphIndex = 0;
    for (let i = 0; i < blocks.length; i++) {
      if (cursor >= runningOffset && cursor <= runningOffset + blocks[i].length) {
        this.paragraphIndex = i;
        break;
      }
      runningOffset += blocks[i].length + 2;
    }

    const parsed = parseParagraph(para.text);
    const segs = parsed.map(stripOffsets);
    const plainText = plainTextOf(segs);
    const existingTags = segs.filter(s => s.tag).map(s => ({ tag: s.tag!, text: s.text }));

    try {
      const result = await this.ai.suggest(plainText, existingTags, this.mode);
      // Only keep suggestions whose tag is in the active mode and whose span is in the plain text.
      const allowed = new Set(MODES[this.mode]?.tags || []);
      this.suggestions = result.suggestions.filter(s =>
        allowed.has(s.tag) && plainText.includes(s.span)
      );
      this.loading = false;
    } catch (err: unknown) {
      this.error = err instanceof Error ? err.message : String(err);
      this.loading = false;
    }
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.querySelectorAll('.sr-suggest-body').forEach(el => el.remove());
    const body = contentEl.createDiv({ cls: 'sr-suggest-body' });
    if (this.loading) {
      body.createDiv({ cls: 'sr-view-empty', text: 'Asking the model…' });
      return;
    }
    if (this.error) {
      body.createDiv({ cls: 'sr-view-empty', text: 'Error: ' + this.error });
      return;
    }
    if (!this.suggestions.length) {
      body.createDiv({ cls: 'sr-view-empty', text: 'No suggestions — model declined to tag this paragraph.' });
      return;
    }

    this.suggestions.forEach((s, i) => {
      const row = body.createDiv({ cls: 'sr-suggest-row' });
      row.createSpan({ cls: 'sr-chip sr-tg-' + cssTag(s.tag), text: s.tag });
      const text = row.createSpan({ cls: 'sr-suggest-span' });
      text.setText('"' + s.span + '"');
      if (s.rationale) {
        const why = row.createSpan({ cls: 'sr-suggest-why' });
        why.setText('— ' + s.rationale);
      }
      const accept = row.createEl('button', { cls: 'sr-suggest-accept', text: s.accepted ? '✓ applied' : 'Apply' });
      accept.disabled = !!s.accepted;
      accept.onclick = async () => {
        await this.apply(i);
        accept.setText('✓ applied');
        accept.disabled = true;
      };
    });

    const footer = body.createDiv({ cls: 'sr-modal-actions' });
    const acceptAll = footer.createEl('button', { cls: 'mod-cta', text: 'Apply all' });
    acceptAll.onclick = async () => {
      for (let i = 0; i < this.suggestions.length; i++) {
        if (!this.suggestions[i].accepted) await this.apply(i);
      }
      this.close();
    };
    footer.createEl('button', { text: 'Close' }).onclick = () => this.close();
  }

  private async apply(i: number): Promise<void> {
    const s = this.suggestions[i];
    if (s.accepted) return;
    const editor = this.view.editor;
    if (!editor) return;
    const body = editor.getValue();
    const blocks = splitParagraphs(body);
    const para = blocks[this.paragraphIndex];
    if (!para) return;

    const parsed = parseParagraph(para.text);
    const segs = parsed.map(stripOffsets);
    const plainText = plainTextOf(segs);
    const idx = plainText.indexOf(s.span);
    if (idx < 0) {
      new Notice('Suggested span not found verbatim in paragraph; skipping.');
      return;
    }
    if (!TAGS[s.tag]) {
      new Notice(`Unknown tag ${s.tag}; skipping.`);
      return;
    }
    const newSegs = applyTagRange(segs, idx, idx + s.span.length, s.tag);
    const newText = serializeParagraph(newSegs);
    editor.replaceRange(
      newText,
      editor.offsetToPos(para.start),
      editor.offsetToPos(para.end)
    );
    s.accepted = true;
  }
}

// Local copy to avoid the cards-view import cycle.
function splitParagraphs(body: string): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  const re = /\n[ \t]*\n+/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    pushBlock(out, body, last, m.index);
    last = re.lastIndex;
  }
  pushBlock(out, body, last, body.length);
  return out;
}
function pushBlock(out: { text: string; start: number; end: number }[], body: string, s: number, e: number): void {
  const slice = body.slice(s, e).replace(/^\s+|\s+$/g, '');
  if (!slice.length) return;
  let i = s, j = e;
  while (i < j && /\s/.test(body[i])) i++;
  while (j > i && /\s/.test(body[j - 1])) j--;
  out.push({ text: body.slice(i, j), start: i, end: j });
}
