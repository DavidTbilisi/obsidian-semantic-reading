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
import { Tagbar, TagbarPosition, selectionCoords } from './src/editor/tagbar';
import { isPdfView, showTagbarForPdf } from './src/pdf/pdf-tagbar';
import { isSidecarPath } from './src/pdf/sidecar';
import { PdfHighlightLayer } from './src/pdf/highlight-layer';
import { installPdfRectDragTracking } from './src/pdf/rect-drag';
import { CardsView, CARDS_VIEW_TYPE, stripFrontmatter } from './src/views/cards-view';
import { AtlasView, ATLAS_VIEW_TYPE } from './src/views/atlas-view';
import { VaultAtlasView, VAULT_ATLAS_VIEW_TYPE } from './src/views/vault-atlas-view';
import { ReviewView, REVIEW_VIEW_TYPE, StudyData, emptyStudyData } from './src/views/review-view';
import { parseBody } from './src/syntax';
import { rebuildFrontmatter, readDomainFrom, readModeFrom } from './src/frontmatter';
import { buildMarkdown } from './src/export/markdown';
import { buildAnkiCsvs, safeName } from './src/export/anki-csv';
import { writeConceptCanvas } from './src/export/canvas';
import { writeDataviewStarter } from './src/integrations/dataview-pack';
import { writeActionsMoc } from './src/integrations/tasks-moc';
import { writeRelationCanvas, writeRelationMermaid } from './src/integrations/relation-graph';
import { writeActionsIcs } from './src/integrations/ics-export';
import {
  DEFAULT_TASKS_PUSH_OPTIONS,
  TasksPushOptions,
  pushActions,
} from './src/integrations/tasks-push';
import {
  DEFAULT_READWISE_OPTIONS,
  ReadwiseOptions,
  importKindleClippings,
  importReadwise,
} from './src/integrations/readwise-import';
import {
  AnkiConnectOptions,
  DEFAULT_ANKI_OPTIONS,
  checkAnkiAvailable,
  syncCardsToAnki,
} from './src/integrations/ankiconnect';
import { maybeInjectDaily } from './src/integrations/daily-note';
import { DEFAULT_MCP_OPTIONS, McpServer, McpServerOptions } from './src/mcp/server';
import { buildMcpContext } from './src/mcp/tools';
import { BUILTIN_KEY_TO_TAG, BUILTIN_TAGS, FAMILIES, MODES, TAGS, applyKeyBindingOverrides } from './src/constants';
import {
  CustomTagDef,
  applyCustomTags,
  injectCustomTagCSS,
  mergeImported,
  parseFromFrontmatter,
  validateCustomTag,
} from './src/custom-tags';
import { DomainProfile, findDomain, resolveTagsFor } from './src/domains';
import { DOMAIN_PRESETS } from './src/domain-presets';
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
  domains: DomainProfile[];
  anki: AnkiConnectOptions;
  dailyNoteInjection: boolean;
  icsPath: string;
  tasksPush: TasksPushOptions;
  readwise: ReadwiseOptions;
  mcp: McpServerOptions;
  pdfAnnotationsEnabled: boolean;
  tagbarPosition: TagbarPosition;
  tagKeyBindings: Record<string, string>;
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
  domains: DOMAIN_PRESETS,
  anki: DEFAULT_ANKI_OPTIONS,
  dailyNoteInjection: false,
  icsPath: 'actions.ics',
  tasksPush: DEFAULT_TASKS_PUSH_OPTIONS,
  readwise: DEFAULT_READWISE_OPTIONS,
  mcp: DEFAULT_MCP_OPTIONS,
  pdfAnnotationsEnabled: true,
  tagbarPosition: 'top-right',
  tagKeyBindings: {},
};

export default class SemanticReadingPlugin extends Plugin {
  settings!: SemanticReadingSettings;
  tagbar!: Tagbar;
  ai!: AIClient;
  indexer!: VaultIndexer;
  api!: SemanticReadingAPI;
  mcp!: McpServer;
  pdfHighlightLayer?: PdfHighlightLayer;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.tagbar = new Tagbar(this.settings.defaultMode, () => this.settings.tagbarPosition);
    this.ai = new AIClient(this.settings.ai);
    this.indexer = new VaultIndexer(this.app, this.hubFolders());
    this.addChild(this.indexer);
    if (this.settings.pdfAnnotationsEnabled) {
      this.pdfHighlightLayer = new PdfHighlightLayer(this.app, this.indexer);
      this.addChild(this.pdfHighlightLayer);
    }
    this.api = createApi(this, this.manifest.version);
    this.mcp = new McpServer(buildMcpContext(this.manifest.version, {
      app: this.app,
      api: this.api,
      ai: this.ai,
      conceptsFolder: () => this.settings.conceptsFolder,
      activeMode: () => this.activeMode(),
      rebuildHubs: () => rebuildHubs(this.app, this.indexer.get(), this.hubOptions()),
      exportMarkdown: (notePath) => this.exportMarkdownByPath(notePath),
    }));

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

    // Tagbar on selection — markdown editors, plus PDF views when enabled.
    if (this.settings.pdfAnnotationsEnabled) installPdfRectDragTracking();
    this.registerDomEvent(document, 'mouseup', (e: MouseEvent) => {
      if ((e.target as HTMLElement)?.closest('.sr-tagbar')) return;
      const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (mdView && mdView.editor) {
        window.setTimeout(() => this.showTagbarFor(mdView), 0);
        return;
      }
      if (this.settings.pdfAnnotationsEnabled) {
        const active = this.app.workspace.activeLeaf?.view;
        if (isPdfView(active)) {
          window.setTimeout(() => showTagbarForPdf(this.app, this.tagbar, active, e), 0);
        }
      }
    });

    // Sync frontmatter + indexer on save (debounced per file).
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        if (this.isHubFile(file.path)) return;
        if (isSidecarPath(file.path)) return;
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

    // Re-apply custom tags when the active file changes — its semantic_domain
    // frontmatter may select a different toolkit. Tracked via lastDomainName so
    // we only re-mutate globals on actual change.
    this.registerEvent(this.app.workspace.on('file-open', () => this.maybeSwitchDomain()));
    this.registerEvent(this.app.metadataCache.on('changed', (file) => {
      const active = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
      if (active && file.path === active.path) this.maybeSwitchDomain();
    }));

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
      this.lastMcpKey = JSON.stringify(this.settings.mcp);
      this.mcp.start(this.settings.mcp).catch(err => {
        console.error('MCP server failed to start', err);
        new Notice(`MCP server failed: ${(err as Error).message}`);
      });
    });
  }

  onunload(): void {
    this.tagbar?.destroy();
    void this.mcp?.stop();
  }

  async loadSettings(): Promise<void> {
    const saved = ((await this.loadData()) ?? {}) as Partial<SemanticReadingSettings>;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    this.settings.ai = Object.assign({}, DEFAULT_AI_CONFIG, saved.ai);
    this.settings.study = saved.study || emptyStudyData();
    this.settings.customTags = Array.isArray(saved.customTags) ? saved.customTags : [];
    this.settings.domains = Array.isArray(saved.domains) ? saved.domains : DOMAIN_PRESETS;
    this.settings.tasksPush = Object.assign({}, DEFAULT_TASKS_PUSH_OPTIONS, saved.tasksPush);
    this.settings.readwise = Object.assign({}, DEFAULT_READWISE_OPTIONS, saved.readwise);
    this.settings.mcp = Object.assign({}, DEFAULT_MCP_OPTIONS, saved.mcp);
    this.settings.tagKeyBindings = (saved.tagKeyBindings && typeof saved.tagKeyBindings === 'object')
      ? saved.tagKeyBindings
      : {};
    this.refreshCustomTags();
  }
  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.refreshCustomTags();
    this.tagbar?.setMode(this.activeMode());
    this.ai?.update(this.settings.ai);
    this.indexer?.setHubFolders(this.hubFolders());
    // Restart MCP only when its own config changed (start() does its own
    // stop()-first). Crucial for sr_review_card: grading a card via MCP calls
    // saveSettings() to persist study state, and we must NOT bounce the server
    // mid-request just because an unrelated setting was written.
    const mcpKey = JSON.stringify(this.settings.mcp);
    if (this.mcp && mcpKey !== this.lastMcpKey) {
      this.lastMcpKey = mcpKey;
      this.mcp.start(this.settings.mcp).catch(err => {
        console.error('MCP server restart failed', err);
        new Notice(`MCP server failed: ${(err as Error).message}`);
      });
    }
  }
  private lastMcpKey = '';

  private lastDomainName: string | null = null;
  private maybeSwitchDomain(): void {
    const d = this.activeDomain();
    const name = d ? d.name : null;
    if (name === this.lastDomainName) return;
    this.lastDomainName = name;
    this.refreshCustomTags();
    this.tagbar?.setMode(this.activeMode());
  }

  refreshCustomTags(): void {
    const domain = this.activeDomain();
    applyCustomTags(this.settings.customTags, domain);
    applyKeyBindingOverrides(this.settings.tagKeyBindings || {});
    // Inject CSS for universal customs + every domain's tags so opening any
    // note already has its colors available.
    const allDomainTags = (this.settings.domains || []).flatMap(d => d.tags);
    injectCustomTagCSS([...this.settings.customTags, ...allDomainTags]);
  }

  domainForPath(notePath: string): string | null {
    const file = this.app.vault.getAbstractFileByPath(notePath);
    if (!(file instanceof TFile)) return null;
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    return readDomainFrom(fm as Record<string, unknown> | null);
  }

  activeDomain(): DomainProfile | null {
    const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
    const fm = file ? this.app.metadataCache.getFileCache(file)?.frontmatter : null;
    const name = readDomainFrom(fm as Record<string, unknown> | null);
    return findDomain(this.settings.domains || [], name);
  }

  // Pure resolver: effective TAGS dict for any file, without mutating globals.
  // Used by the public API and MCP tools so other tools can answer "what tags
  // apply to note X?" regardless of which note is currently focused.
  resolveTagsForFile(file: TFile): Record<string, ReturnType<typeof resolveTagsFor>[string]> {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const name = readDomainFrom(fm as Record<string, unknown> | null);
    return resolveTagsFor(findDomain(this.settings.domains || [], name), this.settings.customTags);
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
    const domain = this.activeDomain();
    const fallback = domain?.defaultMode ?? this.settings.defaultMode;
    return readModeFrom(fm as Record<string, unknown> | null, fallback);
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
      id: 'relation-graph-mermaid',
      name: 'Insert relation graph (Mermaid) from R-tags',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
        if (!file) return false;
        if (!checking) this.insertRelationMermaid(file);
        return true;
      },
    });

    this.addCommand({
      id: 'relation-graph-canvas',
      name: 'Export relation graph (Canvas) from R-tags',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
        if (!file) return false;
        if (!checking) this.exportRelationCanvas(file);
        return true;
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
      id: 'import-readwise',
      name: 'Import Readwise highlights',
      callback: async () => {
        if (!this.settings.readwise.token) {
          new Notice('Set your Readwise token in plugin settings first.');
          return;
        }
        new Notice('Readwise — fetching…');
        try {
          const r = await importReadwise(this.app, this.settings.readwise);
          this.settings.readwise.lastUpdated = r.newLastUpdated;
          await this.saveSettings();
          const tail = r.failed ? `, failed ${r.failed}` : '';
          new Notice(`Readwise — created ${r.created}, skipped ${r.skipped}${tail}`);
          if (r.errors.length) console.warn('readwise errors:', r.errors);
        } catch (err) {
          new Notice(`Readwise import failed: ${(err as Error).message}`);
          console.error('readwise-import failed', err);
        }
      },
    });

    this.addCommand({
      id: 'import-kindle-clippings',
      name: 'Import Kindle clippings from file…',
      callback: () => this.pickKindleFile(),
    });

    this.addCommand({
      id: 'sync-actions-to-tasks',
      name: 'Sync actions to tasks app (Todoist / Things)',
      callback: async () => {
        if (this.settings.tasksPush.provider === 'none') {
          new Notice('Pick a tasks provider in plugin settings first.');
          return;
        }
        try {
          const r = await pushActions(this.indexer.get(), this.settings.tasksPush, {
            resolveDomain: (p) => this.domainForPath(p),
          });
          this.settings.tasksPush.syncedSrids = r.syncedSrids;
          await this.saveSettings();
          const tail = r.failed ? `, failed ${r.failed}` : '';
          new Notice(`Tasks — added ${r.added}, skipped ${r.skipped}${tail}`);
          if (r.errors.length) console.warn('tasks-push errors:', r.errors);
        } catch (err) {
          new Notice(`Tasks sync failed: ${(err as Error).message}`);
          console.error('tasks-push failed', err);
        }
      },
    });

    this.addCommand({
      id: 'export-actions-ics',
      name: 'Export actions to ICS (calendar)',
      callback: async () => {
        try {
          const r = await writeActionsIcs(this.app, this.indexer.get(), this.settings.icsPath);
          new Notice(`ICS — ${r.count} event${r.count === 1 ? '' : 's'} → ${r.path}`);
        } catch (err) {
          new Notice(`ICS export failed: ${(err as Error).message}`);
          console.error('ics-export failed', err);
        }
      },
    });

    this.addCommand({
      id: 'mcp-status',
      name: 'MCP server: show status',
      callback: () => {
        if (this.mcp.isRunning()) {
          new Notice(`MCP server: listening on http://127.0.0.1:${this.mcp.runningPort()}${this.settings.mcp.token ? ' (token required)' : ' (no auth)'}`);
        } else {
          new Notice(this.settings.mcp.enabled
            ? 'MCP server: enabled but not running. Check logs.'
            : 'MCP server: disabled. Enable it in plugin settings.');
        }
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

  private async exportMarkdown(file: TFile): Promise<string> {
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
    return targetPath;
  }

  // Path-addressed wrapper for the sr_export_markdown MCP tool.
  private async exportMarkdownByPath(notePath: string): Promise<{ path: string }> {
    const file = this.app.vault.getAbstractFileByPath(notePath);
    if (!(file instanceof TFile)) throw new Error(`note not found: ${notePath}`);
    const path = await this.exportMarkdown(file);
    return { path };
  }

  private pickKindleFile(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt,text/plain';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const r = await importKindleClippings(this.app, text, this.settings.readwise.destFolder);
        new Notice(`Kindle — ${r.books} book${r.books === 1 ? '' : 's'}, created ${r.created}, skipped ${r.skipped}`);
      } catch (err) {
        new Notice(`Kindle import failed: ${(err as Error).message}`);
        console.error('kindle-import failed', err);
      }
    };
    input.click();
  }

  private async insertRelationMermaid(file: TFile): Promise<void> {
    try {
      const body = await this.app.vault.read(file);
      const paragraphs = parseBody(stripFrontmatter(body));
      const r = await writeRelationMermaid(this.app, file, paragraphs);
      new Notice(`Relation graph — ${r.edges} edge${r.edges === 1 ? '' : 's'} from R-tags`);
    } catch (err) {
      new Notice(`Relation graph failed: ${(err as Error).message}`);
      console.error('relation-graph mermaid failed', err);
    }
  }

  private async exportRelationCanvas(file: TFile): Promise<void> {
    try {
      const body = await this.app.vault.read(file);
      const paragraphs = parseBody(stripFrontmatter(body));
      const r = await writeRelationCanvas(this.app, file, paragraphs);
      new Notice(`Canvas — ${r.nodes} nodes, ${r.edges} edges → ${r.path}`);
    } catch (err) {
      new Notice(`Relation canvas failed: ${(err as Error).message}`);
      console.error('relation-graph canvas failed', err);
    }
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

    new Setting(containerEl).setName('Reading').setHeading();
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

    new Setting(containerEl)
      .setName('Tagbar position')
      .setDesc('Where the tag picker appears when you select text. "Auto" floats above the selection; the corner options pin it to the active pane. "Invisible" hides the picker entirely — tag the selection with the letter shortcut, no UI shown.')
      .addDropdown(d => {
        const options: { value: TagbarPosition; label: string }[] = [
          { value: 'top-right',     label: 'Top right' },
          { value: 'top-center',    label: 'Top center' },
          { value: 'top-left',      label: 'Top left' },
          { value: 'bottom-right',  label: 'Bottom right' },
          { value: 'bottom-center', label: 'Bottom center' },
          { value: 'bottom-left',   label: 'Bottom left' },
          { value: 'auto',          label: 'Auto (above selection)' },
          { value: 'invisible',     label: 'Invisible (shortcuts only)' },
        ];
        options.forEach(o => d.addOption(o.value, o.label));
        d.setValue(this.plugin.settings.tagbarPosition);
        d.onChange(async v => {
          this.plugin.settings.tagbarPosition = v as TagbarPosition;
          await this.plugin.saveSettings();
        });
      });

    this.renderTagKeyBindings(containerEl);

    new Setting(containerEl).setName('Knowledge graph').setHeading();
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

    new Setting(containerEl).setName('AI co-reader').setHeading();
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

    new Setting(containerEl).setName('Synthesis').setHeading();
    new Setting(containerEl)
      .setName('Synthesis output folder')
      .setDesc('Where generated documents are written.')
      .addText(t => {
        t.setValue(this.plugin.settings.synthesisFolder);
        t.onChange(async v => { this.plugin.settings.synthesisFolder = v || 'Synthesis'; await this.plugin.saveSettings(); });
      });

    new Setting(containerEl).setName('Custom tags').setHeading();
    containerEl.createEl('p', {
      text: 'Add tags beyond the built-in 19. They appear in the tagbar, the cards/sheet/gaps views, exports, and AI prompts. Sigils starting with a built-in name are rejected. Notes that use a custom tag automatically embed a `semantic_tags_def` block in their frontmatter, so other vaults can import the definition via the "Import custom tags from current note" command.',
      cls: 'setting-item-description',
    });
    this.renderTagListEditor(
      containerEl,
      () => this.plugin.settings.customTags,
      (next) => { this.plugin.settings.customTags = next; },
    );

    new Setting(containerEl).setName('Domains').setHeading();
    containerEl.createEl('p', {
      text: 'Per-note tag profiles. Activate a profile in any note by adding `semantic_domain: <name>` to its frontmatter. Each profile carries its own tags and a merge mode: add (built-ins + profile), subset (only listed built-ins + profile), or replace (only profile).',
      cls: 'setting-item-description',
    });
    this.renderDomainsEditor(containerEl);

    new Setting(containerEl).setName('Review queue').setHeading();
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

    new Setting(containerEl).setName('Anki sync (AnkiConnect)').setHeading();
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

    new Setting(containerEl).setName('PDF annotations').setHeading();
    new Setting(containerEl)
      .setName('Enable tagging in PDF views')
      .setDesc('When selecting text inside an Obsidian PDF view, the tagbar appears just like in markdown. Picks are saved to a colocated sidecar (<name>.sr.md) that the indexer, hubs, cards, and MCP already understand.')
      .addToggle(t => {
        t.setValue(this.plugin.settings.pdfAnnotationsEnabled);
        t.onChange(async v => { this.plugin.settings.pdfAnnotationsEnabled = v; await this.plugin.saveSettings(); });
      });

    new Setting(containerEl).setName('Daily note injection').setHeading();
    new Setting(containerEl)
      .setName('Inject summary on today\'s daily note')
      .setDesc('When you open a note named YYYY-MM-DD (today), prepend "📚 N cards due · M open questions · K concepts". Idempotent — uses an HTML-comment marker.')
      .addToggle(t => {
        t.setValue(this.plugin.settings.dailyNoteInjection);
        t.onChange(async v => { this.plugin.settings.dailyNoteInjection = v; await this.plugin.saveSettings(); });
      });

    new Setting(containerEl).setName('Readwise / Kindle import').setHeading();
    containerEl.createEl('p', {
      text: 'Pull highlights into the vault as one note per book, ready to tag with semantic sigils. Existing destination notes are never overwritten — the importer skips books whose target file already exists.',
      cls: 'setting-item-description',
    });
    new Setting(containerEl)
      .setName('Readwise API token')
      .setDesc('readwise.io → Settings → Access Token. Stored in plugin data.')
      .addText(t => {
        t.inputEl.type = 'password';
        t.setPlaceholder('readwise token');
        t.setValue(this.plugin.settings.readwise.token);
        t.onChange(async v => { this.plugin.settings.readwise.token = v.trim(); await this.plugin.saveSettings(); });
      });
    new Setting(containerEl)
      .setName('Destination folder')
      .setDesc('Vault-relative. Created if missing. Used for both Readwise and Kindle imports.')
      .addText(t => {
        t.setValue(this.plugin.settings.readwise.destFolder);
        t.onChange(async v => { this.plugin.settings.readwise.destFolder = v.trim() || 'Readwise'; await this.plugin.saveSettings(); });
      });
    new Setting(containerEl)
      .setName('Last sync cursor')
      .setDesc('ISO timestamp passed to Readwise as `updatedAfter`. Empty = full sync next run.')
      .addText(t => {
        t.setValue(this.plugin.settings.readwise.lastUpdated);
        t.onChange(async v => { this.plugin.settings.readwise.lastUpdated = v.trim(); await this.plugin.saveSettings(); });
      })
      .addButton(b => {
        b.setButtonText('Reset');
        b.onClick(async () => {
          this.plugin.settings.readwise.lastUpdated = '';
          await this.plugin.saveSettings();
          this.display();
        });
      });

    new Setting(containerEl).setName('Tasks app push').setHeading();
    containerEl.createEl('p', {
      text: 'Push every A-tagged span to an external task manager. Re-runs are idempotent — each task carries an `srid_<blockId>` label, so already-synced actions are skipped. Domain-aware routing: a note\'s `semantic_domain` maps to a project/list via the table below.',
      cls: 'setting-item-description',
    });
    new Setting(containerEl)
      .setName('Provider')
      .setDesc('Todoist uses the REST API. Things 3 uses x-callback-url on macOS/iOS.')
      .addDropdown(d => {
        d.addOption('none', '— off —');
        d.addOption('todoist', 'Todoist');
        d.addOption('things', 'Things 3');
        d.setValue(this.plugin.settings.tasksPush.provider);
        d.onChange(async v => {
          this.plugin.settings.tasksPush.provider = v as TasksPushOptions['provider'];
          await this.plugin.saveSettings();
          this.display();
        });
      });
    if (this.plugin.settings.tasksPush.provider === 'todoist') {
      new Setting(containerEl)
        .setName('Todoist API token')
        .setDesc('Todoist → Settings → Integrations → Developer → API token. Stored in plugin data.')
        .addText(t => {
          t.inputEl.type = 'password';
          t.setPlaceholder('todoist personal token');
          t.setValue(this.plugin.settings.tasksPush.todoistToken);
          t.onChange(async v => { this.plugin.settings.tasksPush.todoistToken = v.trim(); await this.plugin.saveSettings(); });
        });
      new Setting(containerEl)
        .setName('Default project id')
        .setDesc('Optional. If a note has no domain (or the domain isn\'t mapped below), tasks land here. Leave empty for Inbox.')
        .addText(t => {
          t.setValue(this.plugin.settings.tasksPush.defaultProject);
          t.onChange(async v => { this.plugin.settings.tasksPush.defaultProject = v.trim(); await this.plugin.saveSettings(); });
        });
    }
    if (this.plugin.settings.tasksPush.provider === 'things') {
      new Setting(containerEl)
        .setName('Default Things list')
        .setDesc('Name of a Things list. Leave empty for Inbox.')
        .addText(t => {
          t.setValue(this.plugin.settings.tasksPush.defaultProject);
          t.onChange(async v => { this.plugin.settings.tasksPush.defaultProject = v.trim(); await this.plugin.saveSettings(); });
        });
    }
    if (this.plugin.settings.tasksPush.provider !== 'none') {
      containerEl.createEl('p', {
        text: 'Domain → project/list mapping. One per line as `domain = project_or_list_id`. Domains come from the `semantic_domain:` frontmatter field.',
        cls: 'setting-item-description',
      });
      const mapEl = containerEl.createEl('textarea', { cls: 'sr-domain-map' });
      mapEl.rows = 5;
      mapEl.placeholder = 'programming = 2334455667\nmeeting = 2334455700';
      mapEl.value = Object.entries(this.plugin.settings.tasksPush.projectByDomain)
        .map(([k, v]) => `${k} = ${v}`).join('\n');
      mapEl.onchange = async () => {
        const next: Record<string, string> = {};
        for (const line of mapEl.value.split('\n')) {
          const m = /^\s*([^=]+?)\s*=\s*(.+?)\s*$/.exec(line);
          if (m) next[m[1]] = m[2];
        }
        this.plugin.settings.tasksPush.projectByDomain = next;
        await this.plugin.saveSettings();
      };
      new Setting(containerEl)
        .setName('Clear local sync record')
        .setDesc('Forget which actions have already been pushed. Used by Things (which can\'t be queried). Next sync will re-push every action.')
        .addButton(b => {
          b.setButtonText('Clear').setWarning();
          b.onClick(async () => {
            this.plugin.settings.tasksPush.syncedSrids = [];
            await this.plugin.saveSettings();
            new Notice('Local sync record cleared.');
          });
        });
    }

    new Setting(containerEl).setName('Calendar (.ics) export').setHeading();
    containerEl.createEl('p', {
      text: 'Run "Export actions to ICS (calendar)" to write a `.ics` file pairing every A-tagged action with a co-located D (date) span in the same paragraph. Subscribe to the file from Calendar.app or any ICS-aware client.',
      cls: 'setting-item-description',
    });
    new Setting(containerEl)
      .setName('ICS output path')
      .setDesc('Vault-relative. Defaults to `actions.ics` at the vault root.')
      .addText(t => {
        t.setValue(this.plugin.settings.icsPath);
        t.onChange(async v => { this.plugin.settings.icsPath = v.trim() || 'actions.ics'; await this.plugin.saveSettings(); });
      });

    new Setting(containerEl).setName('MCP server').setHeading();
    containerEl.createEl('p', {
      text: 'Expose the vault tag index as MCP tools, resources (concept hubs, open questions, notes), and prompts (tag-suggest, synthesis) so Claude Desktop / Cursor / VS Code (or any MCP client) can query, review, and tag. JSON-RPC 2.0 over HTTP with an SSE channel for change notifications, bound to 127.0.0.1 only. Desktop Obsidian only — no-op on mobile.',
      cls: 'setting-item-description',
    });
    new Setting(containerEl)
      .setName('Enable MCP server')
      .setDesc('Start an HTTP MCP server when Obsidian is running. Off by default — opening a port is opt-in.')
      .addToggle(t => {
        t.setValue(this.plugin.settings.mcp.enabled);
        t.onChange(async v => { this.plugin.settings.mcp.enabled = v; await this.plugin.saveSettings(); });
      });
    new Setting(containerEl)
      .setName('Port')
      .setDesc('Default: 8745. Change if it collides with another service.')
      .addText(t => {
        t.setValue(String(this.plugin.settings.mcp.port));
        t.onChange(async v => {
          const n = parseInt(v, 10);
          if (n > 0 && n < 65536) {
            this.plugin.settings.mcp.port = n;
            await this.plugin.saveSettings();
          }
        });
      });
    new Setting(containerEl)
      .setName('Bearer token (optional)')
      .setDesc('If set, clients must send `Authorization: Bearer <token>`. Leave empty for no auth (still localhost-only).')
      .addText(t => {
        t.inputEl.type = 'password';
        t.setPlaceholder('(no auth)');
        t.setValue(this.plugin.settings.mcp.token);
        t.onChange(async v => { this.plugin.settings.mcp.token = v.trim(); await this.plugin.saveSettings(); });
      });
    new Setting(containerEl)
      .setName('Allow write tools')
      .setDesc('Off by default. When off, read-only tools work but write tools (sr_apply_tag, sr_review_card, sr_rebuild_hubs, sr_export_markdown) are hidden and refused — clients can read your vault but not change it.')
      .addToggle(t => {
        t.setValue(this.plugin.settings.mcp.allowWrites);
        t.onChange(async v => { this.plugin.settings.mcp.allowWrites = v; await this.plugin.saveSettings(); });
      });
    new Setting(containerEl)
      .setName('Connection snippet')
      .setDesc('Copy a sample Claude Desktop / Cursor MCP server config to clipboard.')
      .addButton(b => {
        b.setButtonText('Copy config');
        b.onClick(async () => {
          const port = this.plugin.settings.mcp.port;
          const token = this.plugin.settings.mcp.token;
          const headers = token ? `, "headers": { "Authorization": "Bearer ${token}" }` : '';
          const snippet = `{
  "mcpServers": {
    "semantic-reading": {
      "url": "http://127.0.0.1:${port}/"${headers}
    }
  }
}`;
          await navigator.clipboard.writeText(snippet);
          new Notice('Copied MCP config snippet to clipboard.');
        });
      });
  }

  // Tag key-binding editor: one row per known sigil, with the current effective
  // key (built-in or override). Empty input clears the binding. Save validates
  // for single-letter keys and collisions; the first conflicting row wins, the
  // rest reset to their previous value with a Notice.
  private renderTagKeyBindings(parent: HTMLElement): void {
    const details = parent.createEl('details', { cls: 'sr-tag-shortcuts-details' });
    const summary = details.createEl('summary');
    summary.setText('Tag shortcuts');

    details.createEl('p', {
      cls: 'setting-item-description',
      text: 'One letter per tag. Empty = no shortcut. Built-in letters are shown as defaults; overrides take precedence.',
    });

    const wrap = details.createDiv({ cls: 'sr-tag-shortcuts' });

    const draw = () => {
      wrap.empty();
      const overrides = this.plugin.settings.tagKeyBindings || {};
      // Current effective key per sigil: built-in unless explicitly overridden.
      const builtinByTag: Record<string, string> = {};
      for (const [k, sigil] of Object.entries(BUILTIN_KEY_TO_TAG)) builtinByTag[sigil] = k;
      const overrideByTag: Record<string, string> = {};
      // Keys whose binding was explicitly cleared by the user (override = '').
      const clearedKeys = new Set<string>();
      for (const [k, sigil] of Object.entries(overrides)) {
        if (!k) continue;
        if (sigil) overrideByTag[sigil] = k;
        else clearedKeys.add(k);
      }

      const sigils = Object.keys(TAGS).sort();
      for (const sigil of sigils) {
        const def = TAGS[sigil];
        const builtin = builtinByTag[sigil] || '';
        const override = overrideByTag[sigil] || '';
        // Built-in binding is shadowed if the user explicitly cleared it.
        const builtinActive = builtin && !clearedKeys.has(builtin);
        const current = override || (builtinActive ? builtin : '');
        new Setting(wrap)
          .setName(`${sigil} — ${def.name}`)
          .setDesc(def.desc || '')
          .addText(t => {
            t.inputEl.maxLength = 1;
            t.inputEl.addClass('sr-key-input');
            t.setPlaceholder(builtinByTag[sigil] || '');
            t.setValue(current);
            t.onChange(async v => {
              const next = (v || '').toLowerCase().slice(0, 1);

              // Re-read state live so multiple edits in one render don't race.
              const live = this.plugin.settings.tagKeyBindings || {};
              const liveOverrideByTag: Record<string, string> = {};
              const liveCleared = new Set<string>();
              for (const [k, s] of Object.entries(live)) {
                if (!k) continue;
                if (s) liveOverrideByTag[s] = k;
                else liveCleared.add(k);
              }

              const wasOverride = liveOverrideByTag[sigil] || '';
              const wasBuiltin = builtinByTag[sigil] || '';
              const wasEffective = wasOverride
                || (wasBuiltin && !liveCleared.has(wasBuiltin) ? wasBuiltin : '');

              if (next === wasEffective) return;

              if (next) {
                for (const other of sigils) {
                  if (other === sigil) continue;
                  const otherOverride = liveOverrideByTag[other] || '';
                  const otherBuiltin = builtinByTag[other] || '';
                  const otherEff = otherOverride
                    || (otherBuiltin && !liveCleared.has(otherBuiltin) ? otherBuiltin : '');
                  if (otherEff === next) {
                    new Notice(`"${next}" is already bound to ${other}`);
                    t.setValue(current);
                    return;
                  }
                }
              }

              const map = { ...live };
              if (!next) {
                if (wasOverride) delete map[wasOverride];
                if (wasBuiltin) map[wasBuiltin] = '';
              } else {
                if (wasOverride && wasOverride !== next) delete map[wasOverride];
                // If the new key was previously a "cleared built-in" marker, drop that.
                if (map[next] === '') delete map[next];
                map[next] = sigil;
              }

              this.plugin.settings.tagKeyBindings = map;
              await this.plugin.saveSettings();
            });
          });
      }

      new Setting(wrap)
        .addButton(b => {
          b.setButtonText('Reset to defaults');
          b.onClick(async () => {
            this.plugin.settings.tagKeyBindings = {};
            await this.plugin.saveSettings();
            draw();
          });
        });
    };

    draw();
  }

  // Parameterized tag-list editor — used both for vault-wide custom tags and
  // for each domain profile's tag list. Caller supplies a getter/setter pair
  // so the editor doesn't need to know which list it's mutating.
  private renderTagListEditor(
    parent: HTMLElement,
    getList: () => CustomTagDef[],
    setList: (next: CustomTagDef[]) => void,
    opts: { addLabel?: string; showImport?: boolean; showHeaders?: boolean } = {},
  ): void {
    const wrap = parent.createDiv({ cls: 'sr-custom-tags' });

    const draw = () => {
      wrap.empty();
      const list = getList();

      if (opts.showHeaders && list.length > 0) {
        const head = wrap.createDiv({ cls: 'sr-ct-row sr-ct-head' });
        head.createSpan({ cls: 'sr-ct-sigil sr-ct-h', text: 'Sigil' });
        head.createSpan({ cls: 'sr-ct-name sr-ct-h', text: 'Name' });
        head.createSpan({ cls: 'sr-ct-family sr-ct-h', text: 'Family' });
        head.createSpan({ cls: 'sr-ct-desc sr-ct-h', text: 'Description' });
        head.createSpan({ cls: 'sr-ct-colors-h sr-ct-h', text: 'Colors' });
        head.createSpan({ cls: 'sr-ct-key sr-ct-h', text: 'Key' });
        head.createSpan({ cls: 'sr-ct-modes sr-ct-h', text: 'Modes' });
        head.createSpan({ cls: 'sr-ct-del-h sr-ct-h' });
      }

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

        // Split-swatch color chip. Left half = light theme, right half = dark.
        // Click either half to open its native picker.
        const swatch = row.createDiv({ cls: 'sr-ct-swatch', attr: { title: 'Click left half to set light-theme color · right half for dark-theme color' } });
        const light = swatch.createEl('input', { type: 'color', cls: 'sr-ct-swatch-input sr-ct-swatch-light', value: t.light || '#6c6c6c' });
        light.title = 'Light-theme color';
        light.onchange = () => commit({ ...t, light: light.value }, idx);
        const dark = swatch.createEl('input', { type: 'color', cls: 'sr-ct-swatch-input sr-ct-swatch-dark', value: t.dark || '#bdbdbd' });
        dark.title = 'Dark-theme color';
        dark.onchange = () => commit({ ...t, dark: dark.value }, idx);

        // Keycap-styled single-letter shortcut.
        const key = row.createEl('input', { type: 'text', cls: 'sr-ct-key', value: t.keyBinding || '' });
        key.placeholder = '·';
        key.maxLength = 1;
        key.title = 'Single-letter keyboard shortcut (skipped if conflicts with built-in)';
        key.onchange = () => commit({ ...t, keyBinding: key.value || undefined }, idx);

        // Modes as 5 toggle pills. At least one must remain selected — if user
        // clears all, we fall back to "all modes" (undefined inModes).
        const modesEl = row.createDiv({ cls: 'sr-ct-modes' });
        const currentModes = new Set(t.inModes && t.inModes.length ? t.inModes : [1, 2, 3, 4, 5]);
        ([1, 2, 3, 4, 5] as const).forEach(m => {
          const pill = modesEl.createEl('button', {
            cls: `sr-ct-mode-pill${currentModes.has(m) ? ' is-on' : ''}`,
            text: String(m),
          });
          pill.title = `Mode ${m} — ${MODES[m]?.name ?? ''}`;
          pill.onclick = (e) => {
            e.preventDefault();
            if (currentModes.has(m)) currentModes.delete(m); else currentModes.add(m);
            const next = [1, 2, 3, 4, 5].filter(n => currentModes.has(n));
            commit({ ...t, inModes: next.length === 5 || next.length === 0 ? undefined : next }, idx);
            draw();
          };
        });

        const del = row.createEl('button', { cls: 'sr-ct-del', text: '×' });
        del.title = 'Remove this tag';
        del.onclick = async () => {
          setList(getList().filter((_, i) => i !== idx));
          await this.plugin.saveSettings();
          draw();
        };
      });

      const actions = wrap.createDiv({ cls: 'sr-ct-actions' });
      const addBtn = actions.createEl('button', { cls: 'mod-cta', text: opts.addLabel || '+ Add custom tag' });
      addBtn.onclick = async () => {
        const sigil = nextFreeSigil(getList());
        setList([...getList(), {
          sigil,
          name: 'New tag',
          family: 'Structure',
          desc: '',
          light: '#6c6c6c',
          dark: '#bdbdbd',
        }]);
        await this.plugin.saveSettings();
        draw();
      };
      if (opts.showImport) {
        const importBtn = actions.createEl('button', { text: 'Import from current note' });
        importBtn.title = 'Add any semantic_tags_def entries from the active note';
        importBtn.onclick = async () => {
          const r = await this.plugin.importCustomTagsFromActiveNote();
          if (!r) { new Notice('Open a note first.'); return; }
          if (r.added === 0 && r.skipped === 0) new Notice('No semantic_tags_def found in this note.');
          else new Notice(`Custom tags — added ${r.added}, skipped ${r.skipped}`);
          draw();
        };
      }
    };

    const commit = async (next: CustomTagDef, idx: number) => {
      const list = getList();
      const others = list.filter((_, i) => i !== idx);
      const err = validateCustomTag(next, others);
      if (err) { new Notice(err); draw(); return; }
      list[idx] = next;
      await this.plugin.saveSettings();
    };

    draw();
  }

  private renderDomainsEditor(parent: HTMLElement): void {
    const wrap = parent.createDiv({ cls: 'sr-domains' });
    // Track expanded cards by name. Newly added profiles auto-expand.
    const expanded = new Set<string>();

    const draw = () => {
      wrap.empty();
      const list = this.plugin.settings.domains;

      list.forEach((d, idx) => {
        const isOpen = expanded.has(d.name);
        const card = wrap.createDiv({ cls: `sr-domain-card${isOpen ? ' is-open' : ''}` });

        // -- Summary chip (always visible) --
        const summary = card.createDiv({ cls: 'sr-domain-summary' });

        const caret = summary.createSpan({ cls: 'sr-domain-caret', text: isOpen ? '▾' : '▸' });
        caret.setAttr('role', 'button');
        caret.setAttr('aria-label', isOpen ? 'Collapse' : 'Expand');

        const enabled = summary.createEl('input', { type: 'checkbox', cls: 'sr-domain-enabled' });
        enabled.checked = !d.disabled;
        enabled.title = 'Enabled (uncheck to ignore this profile)';
        enabled.onclick = (e) => e.stopPropagation();
        enabled.onchange = async () => {
          list[idx] = { ...d, disabled: !enabled.checked };
          await this.plugin.saveSettings();
          // Reflect dim state without re-render.
          card.toggleClass('is-disabled', !enabled.checked);
        };
        card.toggleClass('is-disabled', !!d.disabled);

        summary.createSpan({ cls: 'sr-domain-slug', text: d.name || '(unnamed)' });
        summary.createSpan({ cls: 'sr-domain-label', text: d.label || '' });

        // Meta: single-line, muted suffix text. Merge mode gets a small dot
        // (color-coded by weight, not by traffic-light semantics).
        const metaLine = summary.createSpan({ cls: 'sr-domain-meta-line' });
        const mergeTag = metaLine.createSpan({ cls: 'sr-domain-merge-tag' });
        mergeTag.createSpan({ cls: `sr-domain-merge-dot sr-merge-${d.mergeMode}` });
        mergeTag.createSpan({ cls: 'sr-domain-merge-text', text: d.mergeMode });
        const tagCount = (d.tags || []).length;
        metaLine.createSpan({ cls: 'sr-domain-meta-sep', text: '·' });
        metaLine.createSpan({ cls: 'sr-domain-meta-text', text: `${tagCount} ${tagCount === 1 ? 'tag' : 'tags'}` });
        if (d.defaultMode) {
          metaLine.createSpan({ cls: 'sr-domain-meta-sep', text: '·' });
          metaLine.createSpan({ cls: 'sr-domain-meta-text', text: `mode ${d.defaultMode}` });
        }

        const del = summary.createEl('button', { cls: 'sr-ct-del sr-domain-del', text: '×' });
        del.title = 'Delete this domain profile';
        del.onclick = async (e) => {
          e.stopPropagation();
          expanded.delete(d.name);
          this.plugin.settings.domains = list.filter((_, i) => i !== idx);
          await this.plugin.saveSettings();
          draw();
        };

        // Click anywhere on the summary (outside interactive controls) toggles.
        summary.onclick = (e) => {
          const t = e.target as HTMLElement;
          if (t.closest('input, button, select')) return;
          if (isOpen) expanded.delete(d.name); else expanded.add(d.name);
          draw();
        };

        if (!isOpen) return;

        // -- Expanded body --
        const body = card.createDiv({ cls: 'sr-domain-body' });

        const meta = body.createDiv({ cls: 'sr-domain-meta' });

        const slugField = meta.createDiv({ cls: 'sr-field' });
        slugField.createEl('label', { text: 'Slug', cls: 'sr-field-label' });
        const nameEl = slugField.createEl('input', { type: 'text', cls: 'sr-field-input sr-field-slug', value: d.name });
        nameEl.placeholder = 'semantic_domain';
        nameEl.onchange = async () => {
          const prev = d.name;
          const next = nameEl.value.trim();
          list[idx] = { ...d, name: next };
          if (expanded.has(prev)) { expanded.delete(prev); expanded.add(next); }
          await this.plugin.saveSettings();
          draw();
        };

        const labelField = meta.createDiv({ cls: 'sr-field sr-field-grow' });
        labelField.createEl('label', { text: 'Label', cls: 'sr-field-label' });
        const labelEl = labelField.createEl('input', { type: 'text', cls: 'sr-field-input', value: d.label });
        labelEl.placeholder = 'human label';
        labelEl.onchange = async () => {
          list[idx] = { ...d, label: labelEl.value };
          await this.plugin.saveSettings();
          draw();
        };

        const mergeField = meta.createDiv({ cls: 'sr-field' });
        mergeField.createEl('label', { text: 'Merge mode', cls: 'sr-field-label' });
        const seg = mergeField.createDiv({ cls: 'sr-seg' });
        const mergeModes: DomainProfile['mergeMode'][] = ['add', 'subset', 'replace'];
        const mergeTitles: Record<DomainProfile['mergeMode'], string> = {
          add: 'add — built-ins + profile tags',
          subset: 'subset — only listed built-ins + profile tags',
          replace: 'replace — only profile tags',
        };
        mergeModes.forEach(m => {
          const btn = seg.createEl('button', { cls: `sr-seg-btn${m === d.mergeMode ? ' is-active' : ''}`, text: m });
          btn.title = mergeTitles[m];
          btn.onclick = async (e) => {
            e.preventDefault();
            if (m === d.mergeMode) return;
            list[idx] = { ...d, mergeMode: m };
            await this.plugin.saveSettings();
            draw();
          };
        });

        const modeField = meta.createDiv({ cls: 'sr-field' });
        modeField.createEl('label', { text: 'Default reading mode', cls: 'sr-field-label' });
        const modeEl = modeField.createEl('input', { type: 'text', cls: 'sr-field-input sr-field-mode', value: d.defaultMode ? String(d.defaultMode) : '' });
        modeEl.placeholder = '1–5';
        modeEl.title = 'Optional. When set, opening a note in this domain switches to this reading mode.';
        modeEl.onchange = async () => {
          const n = parseInt(modeEl.value, 10);
          const next = n >= 1 && n <= 5 ? n : undefined;
          list[idx] = { ...d, defaultMode: next };
          await this.plugin.saveSettings();
          draw();
        };

        if (d.mergeMode === 'subset') {
          const keepField = body.createDiv({ cls: 'sr-field' });
          keepField.createEl('label', { text: 'Keep built-ins', cls: 'sr-field-label' });
          const sub = keepField.createEl('div', { cls: 'sr-field-sublabel', text: 'Click sigils to include them alongside this profile\'s tags.' });
          sub.title = 'Built-in tags that survive subset mode.';
          const picker = keepField.createDiv({ cls: 'sr-pill-picker' });
          const kept = new Set(d.keepBuiltins || []);
          Object.entries(BUILTIN_TAGS).forEach(([sigil, def]) => {
            const pill = picker.createEl('button', {
              cls: `sr-pill${kept.has(sigil) ? ' is-on' : ''}`,
              text: sigil,
            });
            pill.title = `${def.name} — ${def.desc}`;
            pill.onclick = async (e) => {
              e.preventDefault();
              if (kept.has(sigil)) kept.delete(sigil); else kept.add(sigil);
              const next = Object.keys(BUILTIN_TAGS).filter(s => kept.has(s));
              list[idx] = { ...d, keepBuiltins: next };
              await this.plugin.saveSettings();
              draw();
            };
          });
        }

        const tagsSection = body.createDiv({ cls: 'sr-domain-tags' });
        tagsSection.createEl('div', { cls: 'sr-domain-tags-heading', text: 'Tags' });
        this.renderTagListEditor(
          tagsSection,
          () => list[idx].tags,
          (next) => { list[idx] = { ...list[idx], tags: next }; },
          { addLabel: '+ Add tag', showHeaders: true },
        );
      });

      const actions = wrap.createDiv({ cls: 'sr-ct-actions' });
      const addBtn = actions.createEl('button', { cls: 'mod-cta', text: '+ Add domain profile' });
      addBtn.onclick = async () => {
        const taken = new Set(list.map(d => d.name));
        let n = list.length + 1;
        let name = `domain${n}`;
        while (taken.has(name)) { n++; name = `domain${n}`; }
        expanded.add(name);
        this.plugin.settings.domains = [...list, {
          name,
          label: 'New domain',
          mergeMode: 'add',
          tags: [],
        }];
        await this.plugin.saveSettings();
        draw();
      };
      const resetBtn = actions.createEl('button', { text: 'Reset to presets' });
      resetBtn.title = 'Replace all domain profiles with the bundled presets. This overwrites your edits.';
      resetBtn.onclick = async () => {
        expanded.clear();
        this.plugin.settings.domains = JSON.parse(JSON.stringify(DOMAIN_PRESETS));
        await this.plugin.saveSettings();
        draw();
      };
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
