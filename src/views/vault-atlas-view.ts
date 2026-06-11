import { ItemView, WorkspaceLeaf, Notice, TFile } from 'obsidian';
import { VaultIndexer } from '../graph/vault-index';

export const VAULT_ATLAS_VIEW_TYPE = 'semantic-reading-vault-atlas';

interface AtlasNode {
  key: string;
  label: string;
  weight: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface AtlasEdge {
  a: string;
  b: string;
  weight: number;
}

export class VaultAtlasView extends ItemView {
  private indexer: VaultIndexer;

  constructor(leaf: WorkspaceLeaf, indexer: VaultIndexer) {
    super(leaf);
    this.indexer = indexer;
  }

  getViewType(): string { return VAULT_ATLAS_VIEW_TYPE; }
  getDisplayText(): string { return 'Semantic Vault Atlas'; }
  getIcon(): string { return 'globe-2'; }

  async onOpen(): Promise<void> {
    this.registerEvent(this.indexer.on('changed', () => this.render()));
    this.render();
  }

  async onClose(): Promise<void> {}

  private render(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('sr-view-root');
    root.createEl('h3', { text: 'Vault concept atlas' });

    const idx = this.indexer.get();
    const conceptKeys = Object.keys(idx.concepts);
    if (!conceptKeys.length) {
      root.createDiv({
        cls: 'sr-view-empty',
        text: 'No concepts yet. Tag spans with d (Def) in any note to populate the atlas.',
      });
      return;
    }

    const nodes: AtlasNode[] = conceptKeys.map((k, i) => {
      const e = idx.concepts[k];
      return {
        key: k,
        label: e.display,
        weight: e.mentions.length,
        x: Math.cos((i / conceptKeys.length) * Math.PI * 2) * 200,
        y: Math.sin((i / conceptKeys.length) * Math.PI * 2) * 200,
        vx: 0,
        vy: 0,
      };
    });
    const nodeMap = new Map(nodes.map(n => [n.key, n]));

    const edges: AtlasEdge[] = [];
    for (const k of conceptKeys) {
      const co = idx.concepts[k].coOccurs;
      for (const other of Object.keys(co)) {
        if (k < other && nodeMap.has(other)) {
          edges.push({ a: k, b: other, weight: co[other] });
        }
      }
    }

    runForceLayout(nodes, edges, 200);

    // Re-center + scale to fit viewport.
    const W = Math.max(this.containerEl.clientWidth - 32, 480);
    const H = Math.max(this.containerEl.clientHeight - 80, 480);
    fitToBox(nodes, W, H, 60);

    const svg = activeDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(H));
    svg.classList.add('sr-atlas-svg');

    const maxEdgeWeight = edges.reduce((m, e) => Math.max(m, e.weight), 1);

    const g = activeDocument.createElementNS('http://www.w3.org/2000/svg', 'g');
    svg.appendChild(g);

    for (const e of edges) {
      const a = nodeMap.get(e.a)!;
      const b = nodeMap.get(e.b)!;
      const line = activeDocument.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', a.x.toFixed(1));
      line.setAttribute('y1', a.y.toFixed(1));
      line.setAttribute('x2', b.x.toFixed(1));
      line.setAttribute('y2', b.y.toFixed(1));
      line.setAttribute('stroke-width', (1 + (e.weight / maxEdgeWeight) * 2.5).toFixed(2));
      line.classList.add('sr-atlas-edge');
      if (e.weight > 1) line.classList.add('thick');
      g.appendChild(line);
    }

    for (const n of nodes) {
      const node = activeDocument.createElementNS('http://www.w3.org/2000/svg', 'g');
      node.setAttribute('transform', `translate(${n.x.toFixed(1)},${n.y.toFixed(1)})`);
      node.classList.add('sr-atlas-node');
      const rect = activeDocument.createElementNS('http://www.w3.org/2000/svg', 'rect');
      const label = truncate(n.label, 22);
      const w = Math.max(70, label.length * 7 + 16);
      const h = 28;
      rect.setAttribute('x', String(-w / 2));
      rect.setAttribute('y', String(-h / 2));
      rect.setAttribute('width', String(w));
      rect.setAttribute('height', String(h));
      node.appendChild(rect);
      const text = activeDocument.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', '0');
      text.setAttribute('y', '0');
      text.textContent = label;
      node.appendChild(text);
      const title = activeDocument.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = `${n.label} — ${n.weight} mention${n.weight === 1 ? '' : 's'}`;
      node.appendChild(title);
      node.addEventListener('click', () => {
        const file = this.app.vault.getAbstractFileByPath(`Concepts/${n.key}.md`);
        if (file instanceof TFile) void this.app.workspace.getLeaf(false).openFile(file);
        else new Notice('Hub page not generated yet — run "Rebuild concept hubs".');
      });
      g.appendChild(node);
    }

    root.appendChild(svg);
    root.createDiv({
      cls: 'sr-atlas-legend',
      text: `${nodes.length} concept${nodes.length === 1 ? '' : 's'} · ${edges.length} co-occurrence edge${edges.length === 1 ? '' : 's'}. Click a node to open its hub page.`,
    });
  }
}

function runForceLayout(nodes: AtlasNode[], edges: AtlasEdge[], iterations: number): void {
  const n = nodes.length;
  if (n < 2) return;
  // Target edge length scales with node count; loosely tuned constants.
  const k = 80;
  const repulsion = 4000;
  const damping = 0.85;
  const dt = 0.4;
  const adjacency = new Map<string, Map<string, number>>();
  for (const e of edges) {
    if (!adjacency.has(e.a)) adjacency.set(e.a, new Map());
    if (!adjacency.has(e.b)) adjacency.set(e.b, new Map());
    adjacency.get(e.a)!.set(e.b, e.weight);
    adjacency.get(e.b)!.set(e.a, e.weight);
  }
  for (let iter = 0; iter < iterations; iter++) {
    // Pairwise repulsion (O(n^2) — fine up to a few hundred nodes).
    for (let i = 0; i < n; i++) {
      const a = nodes[i];
      let fx = 0, fy = 0;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const b = nodes[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d2 = dx * dx + dy * dy + 0.01;
        const f = repulsion / d2;
        fx += dx * f;
        fy += dy * f;
      }
      a.vx = (a.vx + fx * dt) * damping;
      a.vy = (a.vy + fy * dt) * damping;
    }
    // Spring attraction along edges.
    for (const e of edges) {
      const a = nodes.find(nd => nd.key === e.a)!;
      const b = nodes.find(nd => nd.key === e.b)!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const target = k * (1 + Math.log(1 + 1 / e.weight));
      const f = (d - target) * 0.05;
      const ux = dx / d;
      const uy = dy / d;
      a.vx += ux * f;
      a.vy += uy * f;
      b.vx -= ux * f;
      b.vy -= uy * f;
    }
    // Integrate.
    for (const node of nodes) {
      node.x += node.vx * dt;
      node.y += node.vy * dt;
    }
  }
}

function fitToBox(nodes: AtlasNode[], W: number, H: number, pad: number): void {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.y > maxY) maxY = n.y;
  }
  const rangeX = (maxX - minX) || 1;
  const rangeY = (maxY - minY) || 1;
  const sx = (W - 2 * pad) / rangeX;
  const sy = (H - 2 * pad) / rangeY;
  const s = Math.min(sx, sy);
  for (const n of nodes) {
    n.x = pad + (n.x - minX) * s;
    n.y = pad + (n.y - minY) * s;
  }
}

function truncate(s: string, n: number): string {
  const cleaned = s.replace(/\s+/g, ' ').trim();
  return cleaned.length > n ? cleaned.slice(0, n - 1) + '…' : cleaned;
}
