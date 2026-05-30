import { App, TFile, TFolder, normalizePath } from 'obsidian';
import { VaultIndex, Mention } from './vault-index';

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

  return { created, updated, skipped };
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
      lines.push(`- [[${m.notePath.replace(/\.md$/, '')}#^${m.blockId}]]: ${truncate(m.text, 200)}`);
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
    lines.push(`- [[${q.notePath.replace(/\.md$/, '')}#^${q.blockId}]]: ${truncate(q.text, 200)}`);
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
      lines.push(`- [[${notePath.replace(/\.md$/, '')}#^${q.blockId}]]: ${truncate(q.text, 200)}`);
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
