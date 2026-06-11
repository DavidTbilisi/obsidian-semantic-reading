import { App, Modal, Notice, Setting } from 'obsidian';
import { VaultIndexer } from '../graph/vault-index';
import { TEMPLATES, findTemplate, SynthesisTemplate } from '../synthesis/templates';
import { runSynthesis } from '../synthesis/runner';
import { AIClient } from '../ai/client';

export class SynthesizeModal extends Modal {
  private indexer: VaultIndexer;
  private ai: AIClient;
  private mode: number;
  private outputFolder: string;
  private template: SynthesisTemplate = TEMPLATES[0];
  private arg = '';

  constructor(
    app: App,
    indexer: VaultIndexer,
    ai: AIClient,
    mode: number,
    outputFolder: string
  ) {
    super(app);
    this.indexer = indexer;
    this.ai = ai;
    this.mode = mode;
    this.outputFolder = outputFolder;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Synthesize from vault tags' });

    new Setting(contentEl)
      .setName('Template')
      .addDropdown(d => {
        TEMPLATES.forEach(t => d.addOption(t.id, t.name));
        d.setValue(this.template.id);
        d.onChange(v => {
          this.template = findTemplate(v) || TEMPLATES[0];
          this.refreshArg();
        });
      });

    this.refreshArg();
  }

  private refreshArg(): void {
    const { contentEl } = this;
    // Remove any previous arg setting + preview block before re-rendering.
    contentEl.querySelectorAll('.sr-modal-arg, .sr-modal-preview, .sr-modal-actions').forEach(el => el.remove());

    if (this.template.arg !== 'none') {
      const argRow = contentEl.createDiv({ cls: 'sr-modal-arg' });
      new Setting(argRow)
        .setName(this.template.arg === 'concept' ? 'Concept (canonical slug)' : 'Note path')
        .setDesc(this.template.description)
        .addText(t => {
          t.setPlaceholder(this.template.arg === 'concept' ? 'e.g. industrialization' : 'Notes/My Note.md');
          t.setValue(this.arg);
          t.onChange(v => { this.arg = v.trim(); });
        });
    } else {
      contentEl.createDiv({ cls: 'sr-modal-arg sr-modal-empty-arg', text: this.template.description });
    }

    const previewBox = contentEl.createDiv({ cls: 'sr-modal-preview' });
    previewBox.createEl('h4', { text: 'Slice preview' });
    const pre = previewBox.createEl('pre');
    const slice = this.template.buildSlice(this.indexer.get(), this.arg || undefined);
    pre.setText(slice ? truncate(slice.body, 4000) : '(no slice — pick a different concept / note)');

    const actions = contentEl.createDiv({ cls: 'sr-modal-actions' });
    const runBtn = actions.createEl('button', { cls: 'mod-cta', text: 'Run synthesis' });
    runBtn.onclick = () => {
      if (!slice) { new Notice('Nothing to synthesize.'); return; }
      this.close();
      void (async () => {
        const file = await runSynthesis(this.app, this.ai, this.indexer, this.template, this.arg || undefined, this.mode, {
          outputFolder: this.outputFolder,
        });
        if (file) void this.app.workspace.getLeaf(false).openFile(file);
      })();
    };
    actions.createEl('button', { text: 'Cancel' }).onclick = () => this.close();
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '\n…' : s;
}
