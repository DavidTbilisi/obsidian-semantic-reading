// Native Obsidian Canvas export. `.canvas` files are JSON with `nodes` + `edges`;
// docs: https://jsoncanvas.org/spec/1.0/
//
// We pick the top-N most-mentioned concepts, drop them on a deterministic grid,
// and connect them with edges weighted by co-occurrence. Each node is a `file`
// node pointing at the concept's hub page so double-clicking jumps into it.

import { App, normalizePath, TFile } from 'obsidian';
import { VaultIndex } from '../graph/vault-index';

interface CanvasNode {
  id: string;
  type: 'file' | 'text';
  x: number;
  y: number;
  width: number;
  height: number;
  file?: string;
  text?: string;
}

interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  label?: string;
}

export interface CanvasOptions {
  conceptsFolder: string;     // e.g. "Concepts"
  maxNodes?: number;          // default 80
  minCoOccurrence?: number;   // default 2 — drop weaker edges to keep the canvas readable
  cellSize?: number;          // grid cell, default 300px
  cols?: number;              // explicit column count; default ~sqrt(N)
  nodeWidth?: number;         // default 250
  nodeHeight?: number;        // default 80
}

export function buildCanvas(index: VaultIndex, opts: CanvasOptions): string {
  const max = opts.maxNodes ?? 80;
  const minCo = opts.minCoOccurrence ?? 2;
  const cell = opts.cellSize ?? 300;
  const w = opts.nodeWidth ?? 250;
  const h = opts.nodeHeight ?? 80;

  const entries = Object.values(index.concepts)
    .sort((a, b) => b.mentions.length - a.mentions.length || a.canonical.localeCompare(b.canonical))
    .slice(0, max);

  const cols = opts.cols ?? Math.max(4, Math.ceil(Math.sqrt(entries.length || 1)));
  const idByCanonical = new Map<string, string>();
  const nodes: CanvasNode[] = entries.map((entry, i) => {
    const id = 'sr-' + entry.canonical;
    idByCanonical.set(entry.canonical, id);
    const col = i % cols;
    const row = Math.floor(i / cols);
    return {
      id,
      type: 'file',
      file: opts.conceptsFolder + '/' + entry.canonical + '.md',
      x: col * cell,
      y: row * cell,
      width: w,
      height: h,
    };
  });

  const edges: CanvasEdge[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const fromId = idByCanonical.get(entry.canonical);
    if (!fromId) continue;
    for (const [other, count] of Object.entries(entry.coOccurs)) {
      if (count < minCo) continue;
      const toId = idByCanonical.get(other);
      if (!toId || toId === fromId) continue;
      const key = [fromId, toId].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        id: 'e-' + edges.length,
        fromNode: fromId,
        toNode: toId,
        label: count > 2 ? String(count) : undefined,
      });
    }
  }

  return JSON.stringify({ nodes, edges }, null, 2);
}

export async function writeConceptCanvas(
  app: App,
  index: VaultIndex,
  path: string,
  opts: CanvasOptions
): Promise<{ nodes: number; edges: number; path: string }> {
  const content = buildCanvas(index, opts);
  const parsed = JSON.parse(content) as { nodes: CanvasNode[]; edges: CanvasEdge[] };
  const norm = normalizePath(path);
  const existing = app.vault.getAbstractFileByPath(norm);
  if (existing instanceof TFile) await app.vault.modify(existing, content);
  else await app.vault.create(norm, content);
  return { nodes: parsed.nodes.length, edges: parsed.edges.length, path: norm };
}
