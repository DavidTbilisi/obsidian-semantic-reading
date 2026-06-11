// Paint highlight overlays for tagged PDF spans inside an open PDF view.
//
// We read mentions out of the vault index (the indexer already finds every
// sidecar's `{{Tag|[[name.pdf#page=N|text]]}}` entry on its own), find each
// entry's text inside the page's `.textLayer`, build a DOM Range, and paint an
// absolutely-positioned overlay per visual line. PDF.js re-renders the text
// layer on zoom and page advance, so a MutationObserver per PDF view triggers
// a debounced repaint.
//
// Internal API touchpoints (must degrade gracefully if Obsidian changes them):
//   - PDF.js renders pages as `.page[data-page-number]` with a child `.textLayer`.
//   - Selection inside `.textLayer` is a normal DOM selection (no special API).

import { App, Component, WorkspaceLeaf } from 'obsidian';
import { VaultIndexer } from '../graph/vault-index';
import { isPdfView } from './pdf-tagbar';
import { parseRectFromWikilink } from './rect-drag';
import { tintCustomTag } from '../custom-tags';

interface HighlightEntry {
  page: number;
  text: string;
  tag: string;
  blockId: string;
  // When present, anchor is a rectangle (image-PDF / drag) rather than text.
  // Coordinates are percentages of the page's width/height (zoom-invariant).
  rect?: { leftPct: number; topPct: number; widthPct: number; heightPct: number };
}

const REPAINT_DEBOUNCE_MS = 80;

export class PdfHighlightLayer extends Component {
  private app: App;
  private indexer: VaultIndexer;
  private observers = new WeakMap<HTMLElement, MutationObserver>();
  private pendingRepaint: number | null = null;

  constructor(app: App, indexer: VaultIndexer) {
    super();
    this.app = app;
    this.indexer = indexer;
  }

  onload(): void {
    this.registerEvent(this.app.workspace.on('layout-change', () => this.attachAll()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.attachAll()));
    this.register(this.indexer.subscribe('changed', () => this.scheduleRepaintAll()));
    this.attachAll();
  }

  onunload(): void {
    activeDocument.querySelectorAll('.sr-pdf-highlight').forEach(el => el.remove());
  }

  private attachAll(): void {
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!isPdfView(leaf.view)) return;
      const container = (leaf.view as { containerEl?: HTMLElement }).containerEl;
      if (!container || this.observers.has(container)) return;
      const observer = new MutationObserver(() => this.scheduleRepaintLeaf(leaf));
      observer.observe(container, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-loaded', 'class'],
      });
      this.observers.set(container, observer);
      this.scheduleRepaintLeaf(leaf);
    });
  }

  // Leading-edge schedule: when mutations or index changes start arriving, queue
  // ONE repaint to fire after a short delay. Subsequent triggers during that
  // window are absorbed silently. This guarantees a repaint within
  // REPAINT_DEBOUNCE_MS even when PDF.js floods the DOM with virtualization
  // mutations, whereas a trailing debounce can be reset indefinitely.
  private scheduleRepaintLeaf(leaf: WorkspaceLeaf): void {
    if (this.pendingRepaint !== null) return;
    this.pendingRepaint = window.setTimeout(() => {
      this.pendingRepaint = null;
      this.repaintLeaf(leaf);
    }, REPAINT_DEBOUNCE_MS);
  }

  private scheduleRepaintAll(): void {
    if (this.pendingRepaint !== null) return;
    this.pendingRepaint = window.setTimeout(() => {
      this.pendingRepaint = null;
      this.app.workspace.iterateAllLeaves((leaf) => {
        if (isPdfView(leaf.view)) this.repaintLeaf(leaf);
      });
    }, REPAINT_DEBOUNCE_MS);
  }

  private repaintLeaf(leaf: WorkspaceLeaf): void {
    const view = leaf.view as { containerEl?: HTMLElement; file?: { path: string } };
    const file = view.file;
    const container = view.containerEl;
    if (!file || !container) return;

    const entries = this.getEntriesForPdf(file.path);
    const byPage = new Map<number, HighlightEntry[]>();
    for (const e of entries) {
      const list = byPage.get(e.page) || [];
      list.push(e);
      byPage.set(e.page, list);
    }

    container.querySelectorAll('.page[data-page-number]').forEach((node) => {
      const pageEl = node as HTMLElement;
      const pageNum = parseInt(pageEl.getAttribute('data-page-number') || '0', 10);
      paintPage(pageEl, byPage.get(pageNum) || []);
    });
  }

  // Pull every mention that belongs to this PDF (regardless of tag) from the
  // index. The wikilink shape is `<basename>.pdf#page=N`, written by the
  // sidecar writer and parsed by the existing indexer.
  private getEntriesForPdf(pdfPath: string): HighlightEntry[] {
    const idx = this.indexer.get();
    const basename = pdfPath.slice(pdfPath.lastIndexOf('/') + 1);
    const out: HighlightEntry[] = [];
    const seen = new Set<string>();
    for (const tag of Object.keys(idx.byTag)) {
      for (const m of idx.byTag[tag]) {
        if (!m.wikilink || !m.wikilink.startsWith(basename + '#')) continue;
        const pageMatch = /[#&]page=(\d+)/.exec(m.wikilink);
        if (!pageMatch) continue;
        const key = tag + ':' + m.blockId;
        if (seen.has(key)) continue;
        seen.add(key);
        const rect = parseRectFromWikilink(m.wikilink);
        out.push({
          page: parseInt(pageMatch[1], 10),
          text: m.text,
          tag,
          blockId: m.blockId,
          ...(rect ? { rect } : {}),
        });
      }
    }
    return out;
  }
}

function paintPage(pageEl: HTMLElement, entries: HighlightEntry[]): void {
  if (entries.length === 0) {
    pageEl.querySelectorAll(':scope > .sr-pdf-highlight').forEach((el) => el.remove());
    return;
  }

  // Use the page's own offset parent so overlay coords don't need page-scroll math.
  const pageRect = pageEl.getBoundingClientRect();

  // Split entries: rects don't need the text layer; text entries do. We paint
  // rects unconditionally and only attempt text-anchored painting when the
  // text layer is present. If it isn't, leave the existing text overlays in
  // place — they'll get refreshed on the next observer-driven repaint when
  // PDF.js puts the text layer back.
  const rectEntries = entries.filter((e) => !!e.rect);
  const textEntries = entries.filter((e) => !e.rect);

  // Clear and repaint rect overlays every pass (cheap, no text layer needed).
  pageEl.querySelectorAll(':scope > .sr-pdf-highlight-rect').forEach((el) => el.remove());
  for (const e of rectEntries) paintRectEntry(pageEl, pageRect, e);

  const textLayer = pageEl.querySelector('.textLayer');
  if (!textLayer) return;

  // Now that the text layer is available, refresh text overlays in place.
  pageEl.querySelectorAll(':scope > .sr-pdf-highlight:not(.sr-pdf-highlight-rect)')
    .forEach((el) => el.remove());
  if (textEntries.length === 0) return;

  // Track already-painted character ranges within the flat text so that two
  // entries with the same display text don't paint on top of each other —
  // each subsequent entry searches starting after the previous match.
  const flatInfo = buildFlatText(textLayer);
  if (!flatInfo) return;

  const usedRanges: Array<[number, number]> = [];

  for (const entry of textEntries) {
    const match = findFirstUnusedMatch(flatInfo.flat, entry.text, usedRanges);
    if (match == null) continue;
    usedRanges.push([match.start, match.end]);

    const range = rangeFromOffsets(flatInfo, match.start, match.end);
    if (!range) continue;
    const rects = range.getClientRects();
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      // Range.getClientRects() can emit subpixel-thin slivers for empty fragments
      // between text nodes — skip anything under 1 CSS px on either axis.
      if (r.width < 1 || r.height < 1) continue;
      const overlay = activeDocument.createElement('div');
      overlay.className = 'sr-pdf-highlight sr-tg-' + cssTag(entry.tag);
      tintCustomTag(overlay, entry.tag);
      overlay.setAttribute('data-block-id', entry.blockId);
      overlay.style.left = (r.left - pageRect.left) + 'px';
      overlay.style.top = (r.top - pageRect.top) + 'px';
      overlay.style.width = r.width + 'px';
      overlay.style.height = r.height + 'px';
      pageEl.appendChild(overlay);
    }
  }
}

// Paint a single overlay box for a rect-anchored entry. Coords are stored as
// %-of-page, so the box reflows naturally with zoom.
function paintRectEntry(pageEl: HTMLElement, pageRect: DOMRect, entry: HighlightEntry): void {
  if (!entry.rect) return;
  const { leftPct, topPct, widthPct, heightPct } = entry.rect;
  const left = (leftPct / 100) * pageRect.width;
  const top = (topPct / 100) * pageRect.height;
  const width = (widthPct / 100) * pageRect.width;
  const height = (heightPct / 100) * pageRect.height;
  if (width < 1 || height < 1) return;
  const overlay = activeDocument.createElement('div');
  overlay.className = 'sr-pdf-highlight sr-pdf-highlight-rect sr-tg-' + cssTag(entry.tag);
  tintCustomTag(overlay, entry.tag);
  overlay.setAttribute('data-block-id', entry.blockId);
  overlay.style.left = left + 'px';
  overlay.style.top = top + 'px';
  overlay.style.width = width + 'px';
  overlay.style.height = height + 'px';
  pageEl.appendChild(overlay);
}

interface FlatTextInfo {
  flat: string;
  nodes: Text[];
  // Cumulative character offset where each node starts in `flat`.
  starts: number[];
}

function buildFlatText(root: Element): FlatTextInfo | null {
  const walker = activeDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  const starts: number[] = [];
  let flat = '';
  let n: Node | null;
  while ((n = walker.nextNode())) {
    starts.push(flat.length);
    nodes.push(n as Text);
    flat += (n as Text).data;
  }
  return nodes.length === 0 ? null : { flat, nodes, starts };
}

// Find the first occurrence of `needle` in `haystack` that doesn't overlap any
// already-used [start, end) range. Returns null if no match exists.
function findFirstUnusedMatch(
  haystack: string,
  needle: string,
  used: Array<[number, number]>,
): { start: number; end: number } | null {
  if (!needle) return null;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) return null;
    const end = idx + needle.length;
    const conflicts = used.some(([s, e]) => idx < e && end > s);
    if (!conflicts) return { start: idx, end };
    from = idx + 1;
  }
  return null;
}

function rangeFromOffsets(info: FlatTextInfo, start: number, end: number): Range | null {
  const startLoc = locateOffset(info, start);
  const endLoc = locateOffset(info, end);
  if (!startLoc || !endLoc) return null;
  const range = activeDocument.createRange();
  try {
    range.setStart(startLoc.node, startLoc.offset);
    range.setEnd(endLoc.node, endLoc.offset);
  } catch {
    return null;
  }
  return range;
}

function locateOffset(info: FlatTextInfo, offset: number): { node: Text; offset: number } | null {
  // Binary search would be nicer but the node count per page is small (~hundreds).
  for (let i = 0; i < info.nodes.length; i++) {
    const start = info.starts[i];
    const nodeLen = info.nodes[i].data.length;
    if (offset <= start + nodeLen) {
      return { node: info.nodes[i], offset: Math.max(0, offset - start) };
    }
  }
  // After the last node — clamp to its end (legal for setEnd).
  const last = info.nodes[info.nodes.length - 1];
  return { node: last, offset: last.data.length };
}

function cssTag(t: string): string {
  return t.replace(/[^A-Za-z0-9_-]/g, '_');
}
