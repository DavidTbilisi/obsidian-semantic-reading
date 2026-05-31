// R-tag relation graph generator. Parses R-tagged spans in the current note
// for arrow keywords ("causes", "supports", "depends on", "blocks", "requires",
// …), then emits either a Mermaid flowchart block inserted into the note or a
// sibling `.canvas` file.
//
// Mermaid insertion is idempotent: a marker comment (`%% sr-relation-graph`)
// fences the generated block so re-running the command updates instead of
// duplicating.

import { App, normalizePath, TFile } from 'obsidian';
import { Paragraph, canonicalize, flatExtracts } from '../syntax';

export const MERMAID_MARKER = '%% sr-relation-graph';

export interface RelationEdge {
  left: string;
  right: string;
  kind: string;        // canonical verb after normalization
  paraIndex: number;   // 0-based paragraph this edge came from
}

// Phrase -> canonical kind. Reversed phrases swap left/right at parse time.
// Lowercased; longest phrases first when matching.
interface KeywordMap {
  forward: Record<string, string>;
  reverse: Record<string, string>;
}

export const DEFAULT_KEYWORDS: KeywordMap = {
  forward: {
    'depends on': 'depends on',
    'leads to': 'causes',
    'gives rise to': 'causes',
    'results in': 'causes',
    'causes': 'causes',
    'supports': 'supports',
    'evidences': 'supports',
    'implies': 'implies',
    'entails': 'implies',
    'contradicts': 'contradicts',
    'blocks': 'blocks',
    'requires': 'requires',
    'precedes': 'precedes',
  },
  reverse: {
    'caused by': 'causes',
    'depends upon': 'depends on',
    'blocked by': 'blocks',
    'follows': 'precedes',
    'follows from': 'implies',
    'required by': 'requires',
    'supported by': 'supports',
    'contradicted by': 'contradicts',
  },
};

// Find the longest matching keyword phrase in text. Returns the matched phrase
// (lowercase), its index, its length, and whether it was reverse-oriented.
function findKeyword(text: string, kw: KeywordMap): { phrase: string; index: number; kind: string; reverse: boolean } | null {
  const lower = text.toLowerCase();
  const candidates: Array<{ phrase: string; kind: string; reverse: boolean }> = [];
  for (const [phrase, kind] of Object.entries(kw.forward)) {
    candidates.push({ phrase, kind, reverse: false });
  }
  for (const [phrase, kind] of Object.entries(kw.reverse)) {
    candidates.push({ phrase, kind, reverse: true });
  }
  // Longest first so "depends on" beats "depends".
  candidates.sort((a, b) => b.phrase.length - a.phrase.length);
  for (const c of candidates) {
    const idx = lower.indexOf(c.phrase);
    if (idx < 0) continue;
    // Word-boundary check: char before must be start or non-word; char after must be end or non-word.
    const before = idx === 0 ? ' ' : lower[idx - 1];
    const after = idx + c.phrase.length >= lower.length ? ' ' : lower[idx + c.phrase.length];
    if (/\w/.test(before) || /\w/.test(after)) continue;
    return { phrase: c.phrase, index: idx, kind: c.kind, reverse: c.reverse };
  }
  return null;
}

// Parse a single R-tag's text. "X causes Y" -> {left:'X', kind:'causes', right:'Y'}.
// Strip surrounding punctuation/articles to keep node labels tidy.
export function parseRelation(text: string, kw: KeywordMap = DEFAULT_KEYWORDS): { left: string; right: string; kind: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const hit = findKeyword(trimmed, kw);
  if (!hit) return null;
  const leftRaw = trimmed.slice(0, hit.index).trim();
  const rightRaw = trimmed.slice(hit.index + hit.phrase.length).trim();
  const left = cleanNodeLabel(leftRaw);
  const right = cleanNodeLabel(rightRaw);
  if (!left || !right) return null;
  return hit.reverse
    ? { left: right, right: left, kind: hit.kind }
    : { left, right, kind: hit.kind };
}

function cleanNodeLabel(s: string): string {
  return s
    .replace(/^[\s,;:.\-—–]+|[\s,;:.\-—–]+$/g, '')
    .replace(/^(the|a|an)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractRelations(paragraphs: Paragraph[], kw: KeywordMap = DEFAULT_KEYWORDS): RelationEdge[] {
  const ex = flatExtracts(paragraphs, s => s.tag === 'R');
  const edges: RelationEdge[] = [];
  for (const e of ex) {
    const parsed = parseRelation(e.text, kw);
    if (parsed) {
      edges.push({
        left: parsed.left,
        right: parsed.right,
        kind: parsed.kind,
        paraIndex: e.paragraph - 1, // flatExtracts is 1-based
      });
    }
  }
  return edges;
}

// Mermaid node id from a label. Mermaid permits quoted labels but ids must be
// alphanumeric. We slug the label and prefix to avoid digit-leading.
function nodeId(label: string): string {
  const slug = canonicalize(label).replace(/-/g, '_') || 'n';
  return 'n_' + slug;
}

function escapeMermaidLabel(label: string): string {
  return label.replace(/"/g, '#quot;');
}

export function buildMermaid(edges: RelationEdge[]): string {
  if (!edges.length) {
    return 'flowchart TD\n  empty["No R-tag relations parsed"]';
  }
  const lines: string[] = ['flowchart TD'];
  const declared = new Set<string>();
  const declare = (label: string) => {
    const id = nodeId(label);
    if (!declared.has(id)) {
      declared.add(id);
      lines.push(`  ${id}["${escapeMermaidLabel(label)}"]`);
    }
    return id;
  };
  for (const e of edges) {
    const a = declare(e.left);
    const b = declare(e.right);
    lines.push(`  ${a} -->|${escapeMermaidLabel(e.kind)}| ${b}`);
  }
  return lines.join('\n');
}

export function mermaidBlock(edges: RelationEdge[]): string {
  return [
    MERMAID_MARKER + ' (generated — re-run the command to update)',
    '```mermaid',
    buildMermaid(edges),
    '```',
    MERMAID_MARKER + '-end',
  ].join('\n');
}

// Replace an existing marker-fenced block in-place, or append under a
// `## Relation graph` heading at the end of the body.
export function insertOrReplaceMermaid(body: string, block: string): string {
  const start = body.indexOf(MERMAID_MARKER);
  if (start >= 0) {
    const endMarker = MERMAID_MARKER + '-end';
    const end = body.indexOf(endMarker, start);
    if (end >= 0) {
      const tail = end + endMarker.length;
      return body.slice(0, start) + block + body.slice(tail);
    }
  }
  const sep = body.endsWith('\n') ? '\n' : '\n\n';
  return body + sep + '## Relation graph\n\n' + block + '\n';
}

export async function writeRelationMermaid(
  app: App,
  file: TFile,
  paragraphs: Paragraph[],
  kw: KeywordMap = DEFAULT_KEYWORDS,
): Promise<{ edges: number }> {
  const edges = extractRelations(paragraphs, kw);
  const block = mermaidBlock(edges);
  const body = await app.vault.read(file);
  const next = insertOrReplaceMermaid(body, block);
  if (next !== body) await app.vault.modify(file, next);
  return { edges: edges.length };
}

// Canvas output: one text node per unique concept, one edge per relation.
// Sibling file: <dir>/<basename>.relations.canvas.
interface CanvasNode {
  id: string;
  type: 'text';
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
}

interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  label?: string;
}

export function buildRelationCanvas(edges: RelationEdge[]): string {
  const labels: string[] = [];
  const idByLabel = new Map<string, string>();
  const addLabel = (label: string) => {
    if (idByLabel.has(label)) return;
    const id = 'n-' + idByLabel.size;
    idByLabel.set(label, id);
    labels.push(label);
  };
  for (const e of edges) { addLabel(e.left); addLabel(e.right); }

  const cell = 260;
  const cols = Math.max(3, Math.ceil(Math.sqrt(labels.length || 1)));
  const w = 220;
  const h = 80;
  const nodes: CanvasNode[] = labels.map((label, i) => ({
    id: idByLabel.get(label)!,
    type: 'text',
    text: label,
    x: (i % cols) * cell,
    y: Math.floor(i / cols) * cell,
    width: w,
    height: h,
  }));
  const canvasEdges: CanvasEdge[] = edges.map((e, i) => ({
    id: 'e-' + i,
    fromNode: idByLabel.get(e.left)!,
    toNode: idByLabel.get(e.right)!,
    label: e.kind,
  }));
  return JSON.stringify({ nodes, edges: canvasEdges }, null, 2);
}

export async function writeRelationCanvas(
  app: App,
  file: TFile,
  paragraphs: Paragraph[],
  kw: KeywordMap = DEFAULT_KEYWORDS,
): Promise<{ edges: number; nodes: number; path: string }> {
  const edges = extractRelations(paragraphs, kw);
  const content = buildRelationCanvas(edges);
  const parsed = JSON.parse(content) as { nodes: CanvasNode[]; edges: CanvasEdge[] };
  const dir = file.parent && file.parent.path !== '/' ? file.parent.path + '/' : '';
  const path = normalizePath(`${dir}${file.basename}.relations.canvas`);
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) await app.vault.modify(existing, content);
  else await app.vault.create(path, content);
  return { edges: parsed.edges.length, nodes: parsed.nodes.length, path };
}
