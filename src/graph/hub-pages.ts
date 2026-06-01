import { App, TFile, TFolder, normalizePath } from 'obsidian';
import { VaultIndex, Mention } from './vault-index';
import { LANGUAGE_MISS_TAGS } from '../constants';

export interface HubPageOptions {
  conceptsFolder: string;   // e.g. "Concepts"
  questionsFolder: string;  // e.g. "Questions"
}

const HUB_MARKER = 'sr_hub: true';

// Rebuild all concept hub pages from the index. Creates missing pages, updates content
// of plugin-owned pages (those with `sr_hub: true` frontmatter), never touches others.
export async function rebuildHubs(
  app: App,
  index: VaultIndex,
  opts: HubPageOptions
): Promise<{ created: number; updated: number; skipped: number }> {
  await ensureFolder(app, opts.conceptsFolder);
  await ensureFolder(app, opts.questionsFolder);

  let created = 0, updated = 0, skipped = 0;

  // === Concepts ===
  for (const canonical of Object.keys(index.concepts)) {
    const entry = index.concepts[canonical];
    const path = normalizePath(`${opts.conceptsFolder}/${canonical}.md`);
    const content = renderConceptHub(entry, index);
    const r = await writeHubFile(app, path, content);
    if (r === 'created') created++;
    else if (r === 'updated') updated++;
    else skipped++;
  }

  // === Questions: single index page (one per question would create noise) ===
  const qs = index.byTag['Q'] || [];
  if (qs.length) {
    const path = normalizePath(`${opts.questionsFolder}/Open questions.md`);
    const r = await writeHubFile(app, path, renderQuestionsIndex(qs));
    if (r === 'created') created++;
    else if (r === 'updated') updated++;
    else skipped++;
  }

  // === Per-language hubs: one page per language seen across L2 mentions ===
  const langs = collectLanguages(index);
  for (const lang of langs) {
    const path = normalizePath(`${opts.conceptsFolder}/lang-${lang}.md`);
    const r = await writeHubFile(app, path, renderLanguageHub(lang, index));
    if (r === 'created') created++;
    else if (r === 'updated') updated++;
    else skipped++;
  }

  return { created, updated, skipped };
}

// Distinct ISO codes appearing on any L2-tagged mention. Pattern/Sound/Gloss/Miss*
// also carry language but L2 is the canonical anchor — no L2 spans, no hub.
function collectLanguages(index: VaultIndex): string[] {
  const set = new Set<string>();
  for (const m of (index.byTag['L2'] || [])) {
    if (m.language) set.add(m.language);
  }
  return Array.from(set).sort();
}

function renderLanguageHub(lang: string, index: VaultIndex): string {
  const filterLang = (list: Mention[]): Mention[] => list.filter(m => m.language === lang);
  const l2     = filterLang(index.byTag['L2']      || []);
  const patt   = filterLang(index.byTag['Pattern'] || []);
  const pron   = filterLang(index.byTag['Pron']    || []);
  const gloss  = filterLang(index.byTag['Gloss']   || []);

  const lines: string[] = [];
  lines.push('---');
  lines.push(HUB_MARKER);
  lines.push('sr_hub_tag: L2');
  lines.push(`sr_language: ${lang}`);
  lines.push('---');
  lines.push('');
  lines.push(`# Language hub — ${lang}`);
  lines.push('');
  lines.push('> [!note] Auto-generated. Aggregates L2/Pattern/Pron/Gloss/Miss* mentions across notes carrying `language: ' + lang + '`.');
  lines.push('');
  lines.push(`- L2 spans: ${l2.length}`);
  lines.push(`- Patterns: ${patt.length}`);
  lines.push(`- Pronunciation notes: ${pron.length}`);
  lines.push(`- Glosses: ${gloss.length}`);
  for (const tag of LANGUAGE_MISS_TAGS) {
    const ms = filterLang(index.byTag[tag] || []);
    lines.push(`- ${tag}: ${ms.length}`);
  }
  lines.push('');

  if (l2.length) {
    lines.push('## L2 vocabulary (most recent first)');
    for (const m of l2.slice(-50).reverse()) {
      const inlineGloss = m.note ? ` — ${truncate(m.note, 80)}` : '';
      lines.push(`- [[${backlinkTarget(m)}]]: **${m.text}**${inlineGloss}`);
    }
    lines.push('');
  }

  if (patt.length) {
    lines.push('## Grammar patterns');
    for (const m of patt) {
      lines.push(`- [[${backlinkTarget(m)}]]: ${truncate(m.text, 200)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// Backlink target for a mention. PDF-sourced mentions (the wikilink carries a
// `#page=` anchor) link straight into the PDF page; everything else links to
// the source paragraph's block id, as before.
function backlinkTarget(m: Mention): string {
  if (m.wikilink && /[#&]page=/.test(m.wikilink)) return m.wikilink;
  return `${m.notePath.replace(/\.md$/, '')}#^${m.blockId}`;
}

function renderConceptHub(entry: { canonical: string; display: string; mentions: Mention[]; coOccurs: Record<string, number> }, index: VaultIndex): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push(HUB_MARKER);
  lines.push('sr_hub_tag: Def');
  lines.push(`sr_canonical: ${entry.canonical}`);
  lines.push('---');
  lines.push('');
  lines.push(`# ${entry.display}`);
  lines.push('');
  lines.push('> [!note] Concept hub — auto-generated. Edits outside the regions below are preserved on rebuild.');
  lines.push('');
  lines.push('## Definitions across the vault');
  if (entry.mentions.length === 0) {
    lines.push('- _none yet_');
  } else {
    for (const m of entry.mentions) {
      lines.push(`- [[${backlinkTarget(m)}]]: ${truncate(m.text, 200)}`);
    }
  }
  lines.push('');

  const co = Object.entries(entry.coOccurs).sort((a, b) => b[1] - a[1]).slice(0, 12);
  lines.push('## Co-occurring concepts');
  if (!co.length) lines.push('- _no co-occurrences yet_');
  else for (const [k, count] of co) {
    const display = index.concepts[k]?.display || k;
    lines.push(`- [[${k}|${display}]] (${count})`);
  }
  lines.push('');

  // Questions that share a note with this concept.
  const noteSet = new Set(entry.mentions.map(m => m.notePath));
  const relatedQs = (index.byTag['Q'] || []).filter(q => noteSet.has(q.notePath));
  lines.push('## Open questions in the same notes');
  if (!relatedQs.length) lines.push('- _no related questions_');
  else for (const q of relatedQs) {
    lines.push(`- [[${backlinkTarget(q)}]]: ${truncate(q.text, 200)}`);
  }
  lines.push('');
  return lines.join('\n');
}

function renderQuestionsIndex(qs: Mention[]): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push(HUB_MARKER);
  lines.push('sr_hub_tag: Q');
  lines.push('---');
  lines.push('');
  lines.push('# Open questions');
  lines.push('');
  lines.push(`> [!note] Auto-generated. ${qs.length} question${qs.length === 1 ? '' : 's'} across the vault.`);
  lines.push('');
  const byNote = new Map<string, Mention[]>();
  for (const q of qs) {
    const list = byNote.get(q.notePath) || [];
    list.push(q);
    byNote.set(q.notePath, list);
  }
  for (const [notePath, list] of byNote.entries()) {
    lines.push(`## [[${notePath.replace(/\.md$/, '')}]]`);
    for (const q of list) {
      lines.push(`- [[${backlinkTarget(q)}]]: ${truncate(q.text, 200)}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function writeHubFile(app: App, path: string, content: string): Promise<'created' | 'updated' | 'skipped'> {
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    const current = await app.vault.read(existing);
    if (!current.includes(HUB_MARKER)) return 'skipped'; // refuse to overwrite user file
    if (current === content) return 'skipped';
    await app.vault.modify(existing, content);
    return 'updated';
  }
  await app.vault.create(path, content);
  return 'created';
}

async function ensureFolder(app: App, folder: string): Promise<void> {
  if (!folder) return;
  const norm = normalizePath(folder);
  const existing = app.vault.getAbstractFileByPath(norm);
  if (existing instanceof TFolder) return;
  if (existing) return; // a file by that name already exists; bail rather than clobber
  try { await app.vault.createFolder(norm); } catch { /* race-safe */ }
}

function truncate(s: string, n: number): string {
  const cleaned = s.replace(/\s+/g, ' ').trim();
  return cleaned.length > n ? cleaned.slice(0, n - 1) + '…' : cleaned;
}
