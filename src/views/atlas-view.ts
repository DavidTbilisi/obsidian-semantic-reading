import { ItemView, WorkspaceLeaf, MarkdownView, TFile } from 'obsidian';
import { parseBody, Paragraph } from '../syntax';
import { cssTag } from '../constants';
import { stripFrontmatter } from './cards-view';

export const ATLAS_VIEW_TYPE = 'semantic-reading-atlas';

interface Node {
  key: string;
  label: string;
  paras: Set<number>;
  x: number;
  y: number;
}

interface Edge {
  a: string;
  b: string;
  weight: number;
  paras: Set<number>;
}

export class AtlasView extends ItemView {
  private currentFile: TFile | null = null;
  private paragraphs: Paragraph[] = [];
  private refreshHandle: number | null = null;

  constructor(leaf: WorkspaceLeaf) { super(leaf); }

  getViewType(): string { return ATLAS_VIEW_TYPE; }
  getDisplayText(): string { return 'Semantic Atlas'; }
  getIcon(): string { return 'git-fork'; }

  async onOpen(): Promise<void> {
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.scheduleRefresh()));
    this.registerEvent(this.app.workspace.on('editor-change', () => this.scheduleRefresh(250)));
    this.refresh();
  }

  async onClose(): Promise<void> {
    if (this.refreshHandle !== null) window.clearTimeout(this.refreshHandle);
  }

  private scheduleRefresh(delay = 80): void {
    if (this.refreshHandle !== null) window.clearTimeout(this.refreshHandle);
    this.refreshHandle = window.setTimeout(() => {
      this.refreshHandle = null;
      this.refresh();
    }, delay);
  }

  private async refresh(): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const file = view?.file ?? null;
    this.currentFile = file;
    if (!file) {
      this.paragraphs = [];
      this.render();
      return;
    }
    const body = view!.editor ? view!.editor.getValue() : await this.app.vault.read(file);
    this.paragraphs = parseBody(stripFrontmatter(body));
    this.render();
  }

  private render(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('sr-view-root');
    root.createEl('h3', { text: this.currentFile?.basename ?? 'No active note' });

    if (!this.currentFile) {
      root.createDiv({ cls: 'sr-view-empty', text: 'Open a note to see its concept atlas.' });
      return;
    }

    const norm = (s: string) =>
      s.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.,;:!?"']+$/, '');

    const nodeMap = new Map<string, Node>();
    this.paragraphs.forEach((segs, pi) => {
      segs.forEach(s => {
        if (s.tag !== 'Def') return;
        const key = norm(s.text);
        if (!key) return;
        if (!nodeMap.has(key)) {
          nodeMap.set(key, { key, label: s.text.trim(), paras: new Set(), x: 0, y: 0 });
        }
        nodeMap.get(key)!.paras.add(pi);
      });
    });
    const nodes = Array.from(nodeMap.values());

    const edgeMap = new Map<string, Edge>();
    this.paragraphs.forEach((segs, pi) => {
      const here = Array.from(new Set(
        segs.filter(s => s.tag === 'Def').map(s => norm(s.text))
      )).filter(Boolean);
      for (let i = 0; i < here.length; i++) {
        for (let j = i + 1; j < here.length; j++) {
          const pair = [here[i], here[j]].sort();
          const k = pair[0] + '||' + pair[1];
          if (!edgeMap.has(k)) edgeMap.set(k, { a: pair[0], b: pair[1], weight: 0, paras: new Set() });
          const e = edgeMap.get(k)!;
          e.weight += 1;
          e.paras.add(pi);
        }
      }
    });
    const edges = Array.from(edgeMap.values());

    if (!nodes.length) {
      root.createDiv({
        cls: 'sr-view-empty',
        text: 'No Def tags in this note yet. Tag concepts with d (Def) to see them as connected nodes.',
      });
      return;
    }

    const W = Math.max(this.containerEl.clientWidth - 24, 360);
    const H = Math.max(360, 80 + nodes.length * 22);
    const cx = W / 2;
    const cy = H / 2;
    const ringR = Math.min(W, H) / 2 - 50;
    nodes.forEach((n, i) => {
      if (nodes.length === 1) { n.x = cx; n.y = cy; }
      else {
        const a = (i / nodes.length) * Math.PI * 2 - Math.PI / 2;
        n.x = cx + Math.cos(a) * ringR;
        n.y = cy + Math.sin(a) * ringR;
      }
    });

    const byKey = new Map(nodes.map(n => [n.key, n]));
    const maxW = edges.reduce((m, e) => Math.max(m, e.weight), 1);

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(H));
    svg.classList.add('sr-atlas-svg');

    const edgeGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    edges.forEach(e => {
      const a = byKey.get(e.a);
      const b = byKey.get(e.b);
      if (!a || !b) return;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', a.x.toFixed(1));
      line.setAttribute('y1', a.y.toFixed(1));
      line.setAttribute('x2', b.x.toFixed(1));
      line.setAttribute('y2', b.y.toFixed(1));
      line.setAttribute('stroke-width', (1 + (e.weight / maxW) * 2.5).toFixed(2));
      line.classList.add('sr-atlas-edge');
      if (e.weight > 1) line.classList.add('thick');
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = `shares ${e.weight} paragraph(s)`;
      line.appendChild(title);
      edgeGroup.appendChild(line);
    });
    svg.appendChild(edgeGroup);

    const nodeGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    nodes.forEach(n => {
      const label = truncate(n.label, 22);
      const w = Math.max(70, label.length * 7 + 16);
      const h = 28;
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('transform', `translate(${(n.x - w / 2).toFixed(1)},${(n.y - h / 2).toFixed(1)})`);
      g.classList.add('sr-atlas-node');
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('width', String(w));
      rect.setAttribute('height', String(h));
      g.appendChild(rect);
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', String(w / 2));
      text.setAttribute('y', String(h / 2));
      text.textContent = label;
      g.appendChild(text);
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = `${n.label} — appears in ${n.paras.size} paragraph(s)`;
      g.appendChild(title);
      nodeGroup.appendChild(g);
    });
    svg.appendChild(nodeGroup);

    root.appendChild(svg);

    const legend = root.createDiv({ cls: 'sr-atlas-legend' });
    legend.createEl('div', {
      text: 'Nodes = Def tags (deduped). Edges = two definitions co-occur in a paragraph. Thicker = more co-occurrences.',
    });

    // Touch cssTag so esbuild keeps the import even if not used inline above.
    void cssTag;
  }
}

function truncate(s: string, n: number): string {
  const cleaned = s.replace(/\s+/g, ' ').trim();
  return cleaned.length > n ? cleaned.slice(0, n - 1) + '…' : cleaned;
}
