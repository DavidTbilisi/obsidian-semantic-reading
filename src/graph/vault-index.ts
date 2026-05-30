import { App, TFile, Component, Events } from 'obsidian';
import { parseBody, canonicalize, blockIdFor, Paragraph } from '../syntax';
import { stripFrontmatter } from '../views/cards-view';

export interface Mention {
  notePath: string;
  paraIndex: number;       // 0-based
  blockId: string;         // canonical block id we assign per paragraph
  text: string;
  note?: string;
  wikilink?: string;
}

export interface ConceptEntry {
  canonical: string;
  display: string;
  mentions: Mention[];
  coOccurs: Record<string, number>;
}

export interface VaultIndex {
  concepts: Record<string, ConceptEntry>;
  byTag: Record<string, Mention[]>;
  rev: number;
}

interface PerFileSlice {
  concepts: Record<string, Mention[]>;
  byTag: Record<string, Mention[]>;
  paragraphConcepts: string[][];   // concept canonicals per paragraph (for co-occurrence)
}

const EMPTY: VaultIndex = { concepts: {}, byTag: {}, rev: 0 };

export class VaultIndexer extends Component {
  private app: App;
  private events = new Events();
  private perFile = new Map<string, PerFileSlice>();
  private index: VaultIndex = EMPTY;
  private hubFolders: Set<string>;

  constructor(app: App, hubFolders: string[]) {
    super();
    this.app = app;
    this.hubFolders = new Set(hubFolders);
  }

  on(name: 'changed', cb: () => void): ReturnType<Events['on']> {
    return this.events.on(name, cb);
  }

  get(): VaultIndex { return this.index; }

  async init(): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();
    for (const f of files) {
      if (this.isHub(f.path)) continue;
      await this.scan(f, /*emit*/ false);
    }
    this.rebuild();
    this.events.trigger('changed');

    this.registerEvent(this.app.vault.on('modify', (f) => {
      if (f instanceof TFile && f.extension === 'md' && !this.isHub(f.path)) {
        this.scanAndRebuild(f);
      }
    }));
    this.registerEvent(this.app.vault.on('delete', (f) => {
      if (f instanceof TFile && f.extension === 'md') {
        this.perFile.delete(f.path);
        this.rebuild();
        this.events.trigger('changed');
      }
    }));
    this.registerEvent(this.app.vault.on('rename', (f, oldPath) => {
      if (f instanceof TFile && f.extension === 'md') {
        const prev = this.perFile.get(oldPath);
        if (prev) {
          this.perFile.delete(oldPath);
          // Rewrite mention notePaths to new path.
          retargetSlice(prev, f.path);
          this.perFile.set(f.path, prev);
          this.rebuild();
          this.events.trigger('changed');
        }
      }
    }));
  }

  setHubFolders(folders: string[]): void {
    this.hubFolders = new Set(folders);
  }

  // For tests + commands: force a full rebuild.
  async refreshAll(): Promise<void> {
    this.perFile.clear();
    await this.init();
  }

  private isHub(path: string): boolean {
    for (const f of this.hubFolders) {
      if (path === f + '.md' || path.startsWith(f + '/')) return true;
    }
    return false;
  }

  private async scanAndRebuild(file: TFile): Promise<void> {
    await this.scan(file, true);
  }

  private async scan(file: TFile, emit: boolean): Promise<void> {
    const body = await this.app.vault.read(file);
    const fmCache = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (fmCache && fmCache.sr_hub === true) return; // safety net: skip hub files
    const paragraphs = parseBody(stripFrontmatter(body));
    const slice = buildPerFileSlice(file.path, paragraphs);
    this.perFile.set(file.path, slice);
    if (emit) {
      this.rebuild();
      this.events.trigger('changed');
    }
  }

  private rebuild(): void {
    const concepts: Record<string, ConceptEntry> = {};
    const byTag: Record<string, Mention[]> = {};

    for (const slice of this.perFile.values()) {
      // Concepts (Def tag).
      for (const canonical of Object.keys(slice.concepts)) {
        for (const m of slice.concepts[canonical]) {
          if (!concepts[canonical]) {
            concepts[canonical] = {
              canonical,
              display: prettyDisplay(canonical, m.text),
              mentions: [],
              coOccurs: {},
            };
          }
          concepts[canonical].mentions.push(m);
        }
      }
      // Co-occurrence.
      for (const list of slice.paragraphConcepts) {
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            const a = list[i], b = list[j];
            if (!concepts[a] || !concepts[b]) continue;
            concepts[a].coOccurs[b] = (concepts[a].coOccurs[b] || 0) + 1;
            concepts[b].coOccurs[a] = (concepts[b].coOccurs[a] || 0) + 1;
          }
        }
      }
      // byTag.
      for (const tag of Object.keys(slice.byTag)) {
        (byTag[tag] = byTag[tag] || []).push(...slice.byTag[tag]);
      }
    }

    this.index = { concepts, byTag, rev: this.index.rev + 1 };
  }
}

function buildPerFileSlice(notePath: string, paragraphs: Paragraph[]): PerFileSlice {
  const concepts: Record<string, Mention[]> = {};
  const byTag: Record<string, Mention[]> = {};
  const paragraphConcepts: string[][] = [];
  paragraphs.forEach((segs, pi) => {
    const here: string[] = [];
    const blockId = blockIdFor(pi);
    for (const s of segs) {
      if (!s.tag) continue;
      const mention: Mention = {
        notePath,
        paraIndex: pi,
        blockId,
        text: s.text.trim(),
      };
      if (s.note) mention.note = s.note;
      if (s.wikilink) mention.wikilink = s.wikilink;
      (byTag[s.tag] = byTag[s.tag] || []).push(mention);
      if (s.tag === 'Def') {
        const canonical = s.wikilink
          ? canonicalize(basename(s.wikilink))
          : canonicalize(s.text);
        if (!canonical) continue;
        (concepts[canonical] = concepts[canonical] || []).push(mention);
        here.push(canonical);
      }
    }
    paragraphConcepts.push(Array.from(new Set(here)));
  });
  return { concepts, byTag, paragraphConcepts };
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

function prettyDisplay(canonical: string, fallback: string): string {
  // Capitalize each hyphenated word; fall back to the original display text if available.
  if (!canonical) return fallback;
  const words = canonical.split('-');
  if (words.length === 1 && fallback) return fallback;
  return words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function retargetSlice(slice: PerFileSlice, newPath: string): void {
  for (const list of Object.values(slice.concepts)) {
    for (const m of list) m.notePath = newPath;
  }
  for (const list of Object.values(slice.byTag)) {
    for (const m of list) m.notePath = newPath;
  }
}
