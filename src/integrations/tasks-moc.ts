// Tasks-plugin bridge. Writes an Actions.md MOC with `- [ ] {text} [[source#^id]]`
// rows for every A-tagged span across the vault. The native Tasks plugin
// (or just Obsidian's built-in checkboxes) handles these out of the box.
//
// Stamped with `sr_hub: true` so the VaultIndexer skips it on rescan.

import { App, normalizePath, TFile } from 'obsidian';
import { VaultIndex, Mention } from '../graph/vault-index';

const HUB_MARKER = 'sr_hub: true';

export function buildActionsMoc(index: VaultIndex): string {
  const actions = (index.byTag['A'] || []).slice();
  const lines: string[] = [];
  lines.push('---');
  lines.push(HUB_MARKER);
  lines.push('sr_hub_tag: A');
  lines.push('---');
  lines.push('');
  lines.push('# Actions');
  lines.push('');
  lines.push(`> [!note] Auto-generated. ${actions.length} action${actions.length === 1 ? '' : 's'} across the vault.`);
  lines.push('');

  if (actions.length === 0) {
    lines.push('_No A-tagged spans in the vault yet. Tag actionable text with `A` to populate this list._');
    return lines.join('\n');
  }

  const byNote = new Map<string, Mention[]>();
  for (const a of actions) {
    const list = byNote.get(a.notePath) || [];
    list.push(a);
    byNote.set(a.notePath, list);
  }

  // Sort note groups alphabetically so the file is stable across runs.
  const sortedPaths = Array.from(byNote.keys()).sort();
  for (const notePath of sortedPaths) {
    const list = byNote.get(notePath)!;
    const linkBase = notePath.replace(/\.md$/, '');
    lines.push(`## [[${linkBase}]]`);
    for (const a of list) {
      lines.push(`- [ ] ${a.text} [[${linkBase}#^${a.blockId}|↗]]`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export async function writeActionsMoc(
  app: App,
  index: VaultIndex,
  path: string
): Promise<{ path: string; created: boolean; count: number }> {
  const norm = normalizePath(path);
  const content = buildActionsMoc(index);
  const count = (index.byTag['A'] || []).length;
  const existing = app.vault.getAbstractFileByPath(norm);
  if (existing instanceof TFile) {
    await app.vault.modify(existing, content);
    return { path: norm, created: false, count };
  }
  await app.vault.create(norm, content);
  return { path: norm, created: true, count };
}
