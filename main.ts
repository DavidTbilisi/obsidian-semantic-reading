import {
  App,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
} from 'obsidian';
import { semanticReadingExtension } from './src/editor/cm-extension';
import { semanticReadingPostProcessor } from './src/editor/reading-post';
import { Tagbar, selectionCoords } from './src/editor/tagbar';
import { CardsView, CARDS_VIEW_TYPE, stripFrontmatter } from './src/views/cards-view';
import { AtlasView, ATLAS_VIEW_TYPE } from './src/views/atlas-view';
import { VaultAtlasView, VAULT_ATLAS_VIEW_TYPE } from './src/views/vault-atlas-view';
import { ReviewView, REVIEW_VIEW_TYPE, StudyData, emptyStudyData } from './src/views/review-view';
import { parseBody } from './src/syntax';
import { rebuildFrontmatter, readModeFrom } from './src/frontmatter';
import { buildMarkdown } from './src/export/markdown';
import { buildAnkiCsvs, safeName } from './src/export/anki-csv';
import { writeConceptCanvas } from './src/export/canvas';
import { writeDataviewStarter } from './src/integrations/dataview-pack';
import { writeActionsMoc } from './src/integrations/tasks-moc';
import {
  AnkiConnectOptions,
  DEFAULT_ANKI_OPTIONS,
  checkAnkiAvailable,
  syncCardsToAnki,
} from './src/integrations/ankiconnect';
import { maybeInjectDaily } from './src/integrations/daily-note';
import { FAMILIES, MODES } from './src/constants';
import {
  CustomTagDef,
  applyCustomTags,
  injectCustomTagCSS,
  mergeImported,
  parseFromFrontmatter,
  validateCustomTag,
} from './src/custom-tags';
import { AIClient, AIProviderConfig, DEFAULT_AI_CONFIG } from './src/ai/client';
import { SuggestModal } from './src/ai/suggest';
import { VaultIndexer } from './src/graph/vault-index';
import { rebuildHubs, HubPageOptions } from './src/graph/hub-pages';
import { SearchByTagModal } from './src/commands/search-modal';
import { SynthesizeModal } from './src/commands/synthesize-modal';
import { isDue, newCard } from './src/study/fsrs';
import { buildCards } from './src/study/card-builder';
import { SemanticReadingAPI, createApi } from './src/api';

interface SemanticReadingSettings {
  defaultMode: number;
  writeFrontmatter: boolean;
  autoBuildHubs: boolean;
  conceptsFolder: string;
  questionsFolder: string;
  synthesisFolder: string;
  ai: AIProviderConfig;
  study: StudyData;
  customTags: CustomTagDef[];
  anki: AnkiConnectOptions;
  dailyNoteInjection: boolean;
}

const DEFAULT_SETTINGS: SemanticReadingSettings = {
  defaultMode: 3,
  writeFrontmatter: true,
  autoBuildHubs: false,
  conceptsFolder: 'Concepts',
  questionsFolder: 'Questions',
  synthesisFolder: 'Synthesis',
  ai: DEFAULT_AI_CONFIG,
  study: emptyStudyData(),
  customTags: [],
  anki: DEFAULT_ANKI_OPTIONS,
  dailyNoteInjection: false,
};

export default class SemanticReadingPlugin extends Plugin {
  settings!: SemanticReadingSettings;
  tagbar!: Tagbar;
  ai!: AIClient;
  indexer!: VaultIndexer;
  api!: SemanticReadingAPI;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.tagbar = new Tagbar(this.settings.defaultMode);
    this.ai = new AIClient(this.settings.ai);
    this.indexer = new VaultIndexer(this.app, this.hubFolders());
    this.addChild(this.indexer);
    this.api = createApi(this, this.manifest.version);

    this.registerEditorExtension(semanticReadingExtension);
    this.registerMarkdownPostProcessor(semanticReadingPostProcessor);

    this.registerView(CARDS_VIEW_TYPE, (leaf: WorkspaceLeaf) => new CardsView(leaf));
    this.registerView(ATLAS_VIEW_TYPE, (leaf: WorkspaceLeaf) => new AtlasView(leaf));
    this.registerView(VAULT_ATLAS_VIEW_TYPE, (leaf: WorkspaceLeaf) => new VaultAtlasView(leaf, this.indexer));
    this.registerView(REVIEW_VIEW_TYPE, (leaf: WorkspaceLeaf) => new ReviewView(leaf, this.indexer, {
      get: () => this.settings.study,
      save: async (d) => { this.settings.study = d; await this.saveSettings(); },
    }));

    this.addRibbonIcon('list-tree', 'Semantic Reading: open cards view', () => this.openView(CARDS_VIEW_TYPE));
    this.addRibbonIcon('graduation-cap', 'Semantic Reading: review queue', () => this.openView(REVIEW_VIEW_TYPE));

    this.registerCommands();
    this.addSettingTab(new SemanticReadingSettingTab(this.app, this));

    // Tagbar on selection.
    this.registerDomEvent(document, 'mouseup', (e: MouseEvent) => {
      if ((e.target as HTMLElement)?.closest('.sr-tagbar')) return;
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view || !view.editor) return;
      window.setTimeout(() => this.showTagbarFor(view), 0);
    });

    // Sync frontmatter + indexer on save (debounced per file).
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        if (this.isHubFile(file.path)) return;
        if (this.settings.writeFrontmatter) this.scheduleSync(file);
      })
    );

    // Auto-rebuild hubs when the index changes (debounced).
    this.registerEvent(this.indexer.on('changed', () => {
      if (this.settings.autoBuildHubs) this.scheduleHubRebuild();
    }));

    // URI capture handler: obsidian://sr-capture?text=…&note=…
    this.registerObsidianProtocolHandler('sr-capture', async (params) => {
      await this.handleCaptureUri(params);
    });

    // Daily-note injection: prepend a tag-state summary when opening today's daily note.
    this.registerEvent(this.app.workspace.on('file-open', async (file) => {
      if (!file || !this.settings.dailyNoteInjection) return;
      try {
        await maybeInjectDaily(this.app, file, {
          index: () => this.indexer.get(),
          cardStates: () => this.settings.study.states,
        });
      } catch (err) {
        console.error('sr daily inject failed', err);
      }
    }));

    // Kick the indexer once layout is ready (avoids races on plugin enable).
    this.app.workspace.onLayoutReady(() => {
      this.indexer.init().catch(err => console.error('indexer init failed', err));
    });
  }

  async onunload(): Promise<void> {
    this.tagbar?.destroy();
  }

  async loadSettings(): Promise<void> {
    const saved = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    this.settings.ai = Object.assign({}, DEFAULT_AI_CONFIG, saved?.ai);
    this.settings.study = saved?.study || emptyStudyData();
    this.settings.customTags = Array.isArray(saved?.customTags) ? saved.customTags : [];
    this.refreshCustomTags();
  }
  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.refreshCustomTags();
    this.tagbar?.setMode(this.activeMode());
    this.ai?.update(this.settings.ai);
    this.indexer?.setHubFolders(this.hubFolders());
  }

  refreshCustomTags(): void {
    applyCustomTags(this.settings.customTags);
    injectCustomTagCSS(this.settings.customTags);
  }

  // Import custom-tag defs from the active note's `semantic_tags_def`
  // frontmatter — lets you adopt taxonomies from notes shared by other vaults.
  async importCustomTagsFromActiveNote(): Promise<{ added: number; skipped: number } | null> {
    const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
    if (!file) return null;
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
    const incoming = parseFromFrontmatter(fm?.semantic_tags_def);
    if (!incoming.length) return { added: 0, skipped: 0 };
    const { merged, added, skipped } = mergeImported(this.settings.customTags, incoming);
    this.settings.customTags = merged;
    await this.saveSettings();
    return { added, skipped };
  }

  activeMode(): number {
    const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
    const fm = file ? this.app.metadataCache.getFileCache(file)?.frontmatter : null;
    return readModeFrom(fm as Record<string, unknown> | null, this.settings.defaultMode);
  }

  private hubFolders(): string[] {
    return [this.settings.conceptsFolder, this.settings.questionsFolder].filter(Boolean);
  }
  private isHubFile(path: string): boolean {
    return this.hubFolders().some(f => path.startsWith(f + '/'));
  }

  private registerCommands(): void {
    this.addCommand({ id: 'open-cards-view', name: 'Open cards / sheet / gaps view', callback: () => this.openView(CARDS_VIEW_TYPE) });
    this.addCommand({ id: 'open-atlas-view', name: 'Open per-note concept atlas', callback: () => this.openView(ATLAS_VIEW_TYPE) });
    this.addCommand({ id: 'open-vault-atlas-view', name: 'Open vault-wide concept atlas', callback: () => this.openView(VAULT_ATLAS_VIEW_TYPE) });
    this.addCommand({ id: 'open-review', name: 'Open review queue', callback: () => this.openView(REVIEW_VIEW_TYPE) });

    this.addCommand({
      id: 'show-tagbar',
      name: 'Show tagbar for current selection',
      editorCallback: (_editor, ctx) => {
        const view = ctx instanceof MarkdownView ? ctx : this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view) this.showTagbarFor(view);
      },
    });

    this.addCommand({
      id: 'ai-suggest-tags',
      name: 'AI: suggest tags for this paragraph',
      hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 't' }],
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || !view.editor) return false;
        if (!checking) {
          if (!this.ai.isReady()) { new Notice('Configure your Anthropic API key first.'); return; }
          new SuggestModal(this.app, this.ai, view, this.activeMode()).open();
        }
        return true;
      },
    });

    this.addCommand({
      id: 'search-by-tag',
      name: 'Search vault by tag',
      callback: () => new SearchByTagModal(this.app, this.indexer).open(),
    });

    this.addCommand({
      id: 'synthesize',
      name: 'Synthesize from vault tags…',
      callback: () => {
        new SynthesizeModal(this.app, this.indexer, this.ai, this.activeMode(), this.settings.synthesisFolder).open();
      },
    });

    this.addCommand({
      id: 'rebuild-hubs',
      name: 'Rebuild concept hub pages',
      callback: async () => {
        const r = await rebuildHubs(this.app, this.indexer.get(), this.hubOptions());
        new Notice(`Hubs — created ${r.created}, updated ${r.updated}, skipped ${r.skipped}`);
      },
    });

    this.addCommand({
      id: 'export-canvas',
      name: 'Export concept graph to Canvas',
      callback: async () => {
        const path = 'Concept Graph.canvas';
        const r = await writeConceptCanvas(this.app, this.indexer.get(), path, {
          conceptsFolder: this.settings.conceptsFolder,
        });
        new Notice(`Canvas — ${r.nodes} concepts, ${r.edges} edges → ${r.path}`);
      },
    });

    this.addCommand({
      id: 'create-dataview-starter',
      name: 'Create Dataview starter pack',
      callback: async () => {
        const r = await writeDataviewStarter(this.app);
        new Notice(`Dataview starter ${r.created ? 'created' : 'updated'} → ${r.path}`);
      },
    });

    this.addCommand({
      id: 'build-actions-moc',
      name: 'Build Actions MOC (Tasks-plugin compatible)',
      callback: async () => {
        const r = await writeActionsMoc(this.app, this.indexer.get(), 'Actions.md');
        new Notice(`Actions MOC — ${r.count} action${r.count === 1 ? '' : 's'} → ${r.path}`);
      },
    });

    this.addCommand({
      id: 'sync-anki-connect',
      name: 'Sync cards to Anki (AnkiConnect)',
      callback: async () => {
        try {
          await checkAnkiAvailable(this.settings.anki);
        } catch (err) {
          new Notice(`AnkiConnect not reachable: ${(err as Error).message}. Is Anki running with the AnkiConnect add-on?`);
          return;
        }
        const cards = buildCards(this.indexer.get(), { enabledTags: new Set(['Def', 'Q']) });
        if (!cards.length) { new Notice('No cards to sync — tag some Defs or Qs first.'); return; }
        try {
          const r = await syncCardsToAnki(cards, this.settings.anki);
          const msg = `Anki — added ${r.added}, skipped ${r.skipped}` + (r.failed ? `, failed ${r.failed}` : '');
          new Notice(msg);
          if (r.errors.length) console.warn('AnkiConnect errors:', r.errors);
        } catch (err) {
          new Notice(`AnkiConnect error: ${(err as Error).message}`);
        }
      },
    });

    this.addCommand({
      id: 'rebuild-index',
      name: 'Rebuild vault tag index (full rescan)',
      callback: async () => { await this.indexer.refreshAll(); new Notice('Vault index rebuilt.'); },
    });

    this.addCommand({
      id: 'sync-frontmatter',
      name: 'Sync semantic_tags frontmatter from inline syntax',
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const file = view?.file;
        if (!file) return false;
        if (!checking) this.syncFrontmatter(file);
        return true;
      },
    });

    this.addCommand({
      id: 'export-markdown',
      name: 'Export annotated markdown',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
        if (!file) return false;
        if (!checking) this.exportMarkdown(file);
        return true;
      },
    });

    this.addCommand({
      id: 'export-anki',
      name: 'Export Anki CSV (per framework)',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
        if (!file) return false;
        if (!checking) this.exportAnki(file);
        return true;
      },
    });

    this.addCommand({
      id: 'import-custom-tags',
      name: 'Import custom tags from current note',
      callback: async () => {
        const r = await this.importCustomTagsFromActiveNote();
        if (!r) { new Notice('Open a note first.'); return; }
        if (r.added === 0 && r.skipped === 0) new Notice('No semantic_tags_def found in this note.');
        else new Notice(`Custom tags — added ${r.added}, skipped ${r.skipped}`);
      },
    });

    this.addCommand({
      id: 'study-stats',
      name: 'Study: show due-card count',
      callback: () => {
        const cards = buildCards(this.indexer.get(), { enabledTags: new Set(['Def', 'Q']) });
        const now = Date.now();
        const due = cards.filter(c => isDue(this.settings.study.states[c.id] || newCard(), now));
        new Notice(`${due.length} card${due.length === 1 ? '' : 's'} due now · ${cards.length} total · streak ${this.settings.study.streak}`);
      },
    });
  }

  private showTagbarFor(view: MarkdownView): void {
    if (!view.editor) return;
    const sel = view.editor.getSelection();
    if (!sel) { this.tagbar.hide(); return; }
    const coords = selectionCoords();
    if (!coords) { this.tagbar.hide(); return; }
    this.tagbar.setMode(this.activeMode());
    this.tagbar.showFor(view, coords.x, coords.y);
  }

  private syncTimers = new Map<string, number>();
  private scheduleSync(file: TFile): void {
    const prev = this.syncTimers.get(file.path);
    if (prev !== undefined) window.clearTimeout(prev);
    const id = window.setTimeout(() => {
      this.syncTimers.delete(file.path);
      this.syncFrontmatter(file).catch(err => console.error('sr sync failed', err));
    }, 1200);
    this.syncTimers.set(file.path, id);
  }

  private hubRebuildTimer: number | null = null;
  private scheduleHubRebuild(): void {
    if (this.hubRebuildTimer !== null) window.clearTimeout(this.hubRebuildTimer);
    this.hubRebuildTimer = window.setTimeout(() => {
      this.hubRebuildTimer = null;
      rebuildHubs(this.app, this.indexer.get(), this.hubOptions()).catch(err => console.error('hub rebuild failed', err));
    }, 3000);
  }

  private hubOptions(): HubPageOptions {
    return { conceptsFolder: this.settings.conceptsFolder, questionsFolder: this.settings.questionsFolder };
  }

  private async syncFrontmatter(file: TFile): Promise<void> {
    const body = await this.app.vault.read(file);
    const paragraphs = parseBody(stripFrontmatter(body));
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const mode = readModeFrom(fm as Record<string, unknown> | null, this.settings.defaultMode);
    await rebuildFrontmatter(this.app, file, paragraphs, mode, this.settings.customTags);
  }

  private async exportMarkdown(file: TFile): Promise<void> {
    const body = await this.app.vault.read(file);
    const paragraphs = parseBody(stripFrontmatter(body));
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const mode = readModeFrom(fm as Record<string, unknown> | null, this.settings.defaultMode);
    const md = buildMarkdown(file.basename, mode, paragraphs);
    const targetPath = file.parent
      ? (file.parent.path === '/' ? '' : file.parent.path + '/') + safeName(file.basename) + '.annotated.md'
      : safeName(file.basename) + '.annotated.md';
    await this.writeOrReplace(targetPath, md);
    new Notice('Exported ' + targetPath);
  }

  private async exportAnki(file: TFile): Promise<void> {
    const body = await this.app.vault.read(file);
    const paragraphs = parseBody(stripFrontmatter(body));
    const csvs = buildAnkiCsvs(paragraphs);
    if (!Object.keys(csvs).length) { new Notice('No tagged spans to export.'); return; }
    const dir = file.parent && file.parent.path !== '/' ? file.parent.path + '/' : '';
    const stem = safeName(file.basename);
    for (const fw of Object.keys(csvs)) {
      await this.writeOrReplace(`${dir}${stem}.anki.${fw}.csv`, csvs[fw]);
    }
    new Notice(`Exported ${Object.keys(csvs).length} Anki CSV file(s).`);
  }

  private async writeOrReplace(path: string, content: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await this.app.vault.modify(existing, content);
    else await this.app.vault.create(path, content);
  }

  private async openView(type: string): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(type);
    if (existing.length) { this.app.workspace.revealLeaf(existing[0]); return; }
    const isWide = type === REVIEW_VIEW_TYPE || type === VAULT_ATLAS_VIEW_TYPE;
    const leaf = isWide ? this.app.workspace.getLeaf('tab') : this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type, active: true });
      this.app.workspace.revealLeaf(leaf);
    }
  }

  private async handleCaptureUri(params: Record<string, string>): Promise<void> {
    const text = params.text || '';
    const source = params.source || '';
    if (!text) { new Notice('sr-capture: missing text'); return; }
    const dailyName = new Date().toISOString().slice(0, 10) + ' — captured.md';
    const path = dailyName;
    let file = this.app.vault.getAbstractFileByPath(path);
    const block = `\n\n## ${new Date().toLocaleTimeString()}${source ? ' — ' + source : ''}\n\n${text}\n`;
    if (file instanceof TFile) {
      const existing = await this.app.vault.read(file);
      await this.app.vault.modify(file, existing + block);
    } else {
      file = await this.app.vault.create(path, block.trimStart());
    }
    new Notice('Captured to ' + path);
    if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
  }
}

class SemanticReadingSettingTab extends PluginSettingTab {
  plugin: SemanticReadingPlugin;
  constructor(app: App, plugin: SemanticReadingPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Reading' });
    new Setting(containerEl)
      .setName('Default reading mode')
      .setDesc('Which tag palette to show in the tagbar. Override per-note via `semantic_mode:` frontmatter.')
      .addDropdown(d => {
        Object.keys(MODES).forEach(k => {
          const n = Number(k);
          d.addOption(k, `${k} — ${MODES[n].name}: ${MODES[n].desc}`);
        });
        d.setValue(String(this.plugin.settings.defaultMode));
        d.onChange(async v => { this.plugin.settings.defaultMode = Number(v) || 3; await this.plugin.saveSettings(); });
      });
    new Setting(containerEl)
      .setName('Keep frontmatter index in sync')
      .setDesc('Rebuild the `semantic_tags:` frontmatter array when a note is edited. Inline syntax is the source of truth.')
      .addToggle(t => {
        t.setValue(this.plugin.settings.writeFrontmatter);
        t.onChange(async v => { this.plugin.settings.writeFrontmatter = v; await this.plugin.saveSettings(); });
      });

    containerEl.createEl('h2', { text: 'Knowledge graph' });
    new Setting(containerEl)
      .setName('Concepts folder')
      .setDesc('Where auto-generated concept hub pages live.')
      .addText(t => {
        t.setValue(this.plugin.settings.conceptsFolder);
        t.onChange(async v => { this.plugin.settings.conceptsFolder = v || 'Concepts'; await this.plugin.saveSettings(); });
      });
    new Setting(containerEl)
      .setName('Questions folder')
      .setDesc('Where the auto-generated open-questions index lives.')
      .addText(t => {
        t.setValue(this.plugin.settings.questionsFolder);
        t.onChange(async v => { this.plugin.settings.questionsFolder = v || 'Questions'; await this.plugin.saveSettings(); });
      });
    new Setting(containerEl)
      .setName('Auto-rebuild hub pages on edit')
      .setDesc('When a note changes, regenerate the affected hub pages. Off by default — run "Rebuild concept hub pages" manually instead.')
      .addToggle(t => {
        t.setValue(this.plugin.settings.autoBuildHubs);
        t.onChange(async v => { this.plugin.settings.autoBuildHubs = v; await this.plugin.saveSettings(); });
      });

    containerEl.createEl('h2', { text: 'AI co-reader' });
    new Setting(containerEl)
      .setName('Enable AI features')
      .setDesc('Tag suggestion, consistency check, synthesis. Requires an Anthropic API key.')
      .addToggle(t => {
        t.setValue(this.plugin.settings.ai.enabled);
        t.onChange(async v => { this.plugin.settings.ai.enabled = v; await this.plugin.saveSettings(); });
      });
    new Setting(containerEl)
      .setName('Anthropic API key')
      .setDesc('Stored in plugin data. Never written to vault files.')
      .addText(t => {
        t.inputEl.type = 'password';
        t.setPlaceholder('sk-ant-…');
        t.setValue(this.plugin.settings.ai.apiKey);
        t.onChange(async v => { this.plugin.settings.ai.apiKey = v.trim(); await this.plugin.saveSettings(); });
      });
    new Setting(containerEl)
      .setName('Suggest / check model')
      .setDesc('Fast, cheap. Default: claude-sonnet-4-6.')
      .addText(t => {
        t.setValue(this.plugin.settings.ai.suggestModel);
        t.onChange(async v => { this.plugin.settings.ai.suggestModel = v.trim() || 'claude-sonnet-4-6'; await this.plugin.saveSettings(); });
      });
    new Setting(containerEl)
      .setName('Synthesis model')
      .setDesc('Long-form generation. Default: claude-opus-4-7.')
      .addText(t => {
        t.setValue(this.plugin.settings.ai.synthesisModel);
        t.onChange(async v => { this.plugin.settings.ai.synthesisModel = v.trim() || 'claude-opus-4-7'; await this.plugin.saveSettings(); });
      });

    containerEl.createEl('h2', { text: 'Synthesis' });
    new Setting(containerEl)
      .setName('Synthesis output folder')
      .setDesc('Where generated documents are written.')
      .addText(t => {
        t.setValue(this.plugin.settings.synthesisFolder);
        t.onChange(async v => { this.plugin.settings.synthesisFolder = v || 'Synthesis'; await this.plugin.saveSettings(); });
      });

    containerEl.createEl('h2', { text: 'Custom tags' });
    containerEl.createEl('p', {
      text: 'Add tags beyond the built-in 19. They appear in the tagbar, the cards/sheet/gaps views, exports, and AI prompts. Sigils starting with a built-in name are rejected. Notes that use a custom tag automatically embed a `semantic_tags_def` block in their frontmatter, so other vaults can import the definition via the "Import custom tags from current note" command.',
      cls: 'setting-item-description',
    });
    this.renderCustomTagsEditor(containerEl);

    containerEl.createEl('h2', { text: 'Review queue' });
    new Setting(containerEl)
      .setName('Reset all review state')
      .setDesc('Forget FSRS scheduling for every card. Cannot be undone.')
      .addButton(b => {
        b.setButtonText('Reset').setWarning();
        b.onClick(async () => {
          this.plugin.settings.study = emptyStudyData();
          await this.plugin.saveSettings();
          new Notice('Review state reset.');
        });
      });

    containerEl.createEl('h2', { text: 'Anki sync (AnkiConnect)' });
    containerEl.createEl('p', {
      text: 'Requires the AnkiConnect add-on running in Anki desktop. Run "Sync cards to Anki (AnkiConnect)" from the command palette to push Def + Q cards.',
      cls: 'setting-item-description',
    });
    new Setting(containerEl)
      .setName('AnkiConnect endpoint')
      .setDesc('Default: http://127.0.0.1:8765')
      .addText(t => {
        t.setValue(this.plugin.settings.anki.endpoint);
        t.onChange(async v => { this.plugin.settings.anki.endpoint = v.trim() || 'http://127.0.0.1:8765'; await this.plugin.saveSettings(); });
      });
    new Setting(containerEl)
      .setName('Anki deck name')
      .setDesc('Created on first sync if missing.')
      .addText(t => {
        t.setValue(this.plugin.settings.anki.deckName);
        t.onChange(async v => { this.plugin.settings.anki.deckName = v.trim() || 'Semantic Reading'; await this.plugin.saveSettings(); });
      });

    containerEl.createEl('h2', { text: 'Daily note injection' });
    new Setting(containerEl)
      .setName('Inject summary on today\'s daily note')
      .setDesc('When you open a note named YYYY-MM-DD (today), prepend "📚 N cards due · M open questions · K concepts". Idempotent — uses an HTML-comment marker.')
      .addToggle(t => {
        t.setValue(this.plugin.settings.dailyNoteInjection);
        t.onChange(async v => { this.plugin.settings.dailyNoteInjection = v; await this.plugin.saveSettings(); });
      });
  }

  private renderCustomTagsEditor(parent: HTMLElement): void {
    const wrap = parent.createDiv({ cls: 'sr-custom-tags' });

    const draw = () => {
      wrap.empty();
      const list = this.plugin.settings.customTags;

      list.forEach((t, idx) => {
        const row = wrap.createDiv({ cls: 'sr-ct-row' });

        const sigil = row.createEl('input', { type: 'text', cls: 'sr-ct-sigil', value: t.sigil });
        sigil.placeholder = 'sigil';
        sigil.maxLength = 12;
        sigil.onchange = () => commit({ ...t, sigil: sigil.value.trim() }, idx);

        const name = row.createEl('input', { type: 'text', cls: 'sr-ct-name', value: t.name });
        name.placeholder = 'name';
        name.onchange = () => commit({ ...t, name: name.value }, idx);

        const family = row.createEl('select', { cls: 'sr-ct-family' });
        FAMILIES.forEach(f => {
          const opt = family.createEl('option', { text: f, value: f });
          if (f === t.family) opt.selected = true;
        });
        family.onchange = () => commit({ ...t, family: family.value as typeof FAMILIES[number] }, idx);

        const desc = row.createEl('input', { type: 'text', cls: 'sr-ct-desc', value: t.desc || '' });
        desc.placeholder = 'description';
        desc.onchange = () => commit({ ...t, desc: desc.value }, idx);

        const light = row.createEl('input', { type: 'color', cls: 'sr-ct-color', value: t.light || '#6c6c6c' });
        light.title = 'Light-theme color';
        light.onchange = () => commit({ ...t, light: light.value }, idx);

        const dark = row.createEl('input', { type: 'color', cls: 'sr-ct-color', value: t.dark || '#bdbdbd' });
        dark.title = 'Dark-theme color';
        dark.onchange = () => commit({ ...t, dark: dark.value }, idx);

        const key = row.createEl('input', { type: 'text', cls: 'sr-ct-key', value: t.keyBinding || '' });
        key.placeholder = 'k';
        key.maxLength = 1;
        key.title = 'Single-letter keyboard shortcut (skipped if conflicts with built-in)';
        key.onchange = () => commit({ ...t, keyBinding: key.value || undefined }, idx);

        const modesEl = row.createEl('input', { type: 'text', cls: 'sr-ct-modes', value: (t.inModes && t.inModes.length ? t.inModes : [1, 2, 3, 4, 5]).join(',') });
        modesEl.placeholder = '1,2,3,4,5';
        modesEl.title = 'Reading modes this tag appears in (comma-separated 1–5)';
        modesEl.onchange = () => {
          const parsed = modesEl.value.split(',').map(s => Number(s.trim())).filter(n => n >= 1 && n <= 5);
          commit({ ...t, inModes: parsed.length ? parsed : undefined }, idx);
        };

        const del = row.createEl('button', { cls: 'sr-ct-del', text: '×' });
        del.title = 'Remove this tag';
        del.onclick = async () => {
          this.plugin.settings.customTags = list.filter((_, i) => i !== idx);
          await this.plugin.saveSettings();
          draw();
        };
      });

      const actions = wrap.createDiv({ cls: 'sr-ct-actions' });
      const addBtn = actions.createEl('button', { cls: 'mod-cta', text: '+ Add custom tag' });
      addBtn.onclick = async () => {
        const sigil = nextFreeSigil(this.plugin.settings.customTags);
        this.plugin.settings.customTags = [...this.plugin.settings.customTags, {
          sigil,
          name: 'New tag',
          family: 'Structure',
          desc: '',
          light: '#6c6c6c',
          dark: '#bdbdbd',
        }];
        await this.plugin.saveSettings();
        draw();
      };
      const importBtn = actions.createEl('button', { text: 'Import from current note' });
      importBtn.title = 'Add any semantic_tags_def entries from the active note';
      importBtn.onclick = async () => {
        const r = await this.plugin.importCustomTagsFromActiveNote();
        if (!r) { new Notice('Open a note first.'); return; }
        if (r.added === 0 && r.skipped === 0) new Notice('No semantic_tags_def found in this note.');
        else new Notice(`Custom tags — added ${r.added}, skipped ${r.skipped}`);
        draw();
      };
    };

    const commit = async (next: CustomTagDef, idx: number) => {
      const list = this.plugin.settings.customTags;
      const others = list.filter((_, i) => i !== idx);
      const err = validateCustomTag(next, others);
      if (err) { new Notice(err); draw(); return; }
      list[idx] = next;
      await this.plugin.saveSettings();
    };

    draw();
  }
}

function nextFreeSigil(existing: CustomTagDef[]): string {
  const taken = new Set(existing.map(t => t.sigil));
  for (let i = 1; i < 100; i++) {
    const candidate = 'Tag' + i;
    if (!taken.has(candidate)) return candidate;
  }
  return 'Tag';
}
