import { App, TFile } from 'obsidian';
import { Paragraph, flatExtracts } from './syntax';
import { TAGS } from './constants';
import { CustomTagDef, customTagsUsedIn, serializeForFrontmatter } from './custom-tags';

export interface SemanticTagEntry {
  tag: string;
  text: string;
  para: number;
  note?: string;
}

// Rebuild the `semantic_tags` frontmatter array from the parsed body.
// Inline syntax is the source of truth; frontmatter is just a cache for fast queries.
export async function rebuildFrontmatter(
  app: App,
  file: TFile,
  paragraphs: Paragraph[],
  mode: number,
  customTags: CustomTagDef[] = []
): Promise<void> {
  const extracts = flatExtracts(paragraphs).filter(e => TAGS[e.tag]);
  const entries: SemanticTagEntry[] = extracts.map(e => {
    const out: SemanticTagEntry = { tag: e.tag, text: e.text, para: e.paragraph };
    if (e.note) out.note = e.note;
    return out;
  });
  const used = customTagsUsedIn(extracts.map(e => e.tag), customTags);
  await app.fileManager.processFrontMatter(file, (fm) => {
    if (entries.length) fm.semantic_tags = entries;
    else delete fm.semantic_tags;
    fm.semantic_mode = mode;
    if (used.length) fm.semantic_tags_def = serializeForFrontmatter(used);
    else delete fm.semantic_tags_def;
  });
}

export function readModeFrom(fm: Record<string, unknown> | null | undefined, fallback: number): number {
  if (!fm) return fallback;
  const m = fm.semantic_mode;
  if (typeof m === 'number' && m >= 1 && m <= 5) return m;
  return fallback;
}

export function readDomainFrom(fm: Record<string, unknown> | null | undefined): string | null {
  if (!fm) return null;
  const d = fm.semantic_domain;
  if (typeof d !== 'string') return null;
  const trimmed = d.trim();
  return trimmed || null;
}
