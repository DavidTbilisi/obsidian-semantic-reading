// Daily-note injection. When the user opens today's daily note (filename
// matches YYYY-MM-DD), prepend a one-line summary of vault tag state:
//
//     <!--sr-daily--> 📚 12 cards due · 5 open questions · 47 concepts
//
// The HTML comment marker makes the injection idempotent — we never insert
// twice into the same note, and the user can delete it to suppress future
// reinjection that day.

import { App, TFile } from 'obsidian';
import { VaultIndex } from '../graph/vault-index';
import { buildCards } from '../study/card-builder';
import { isDue, newCard, CardState } from '../study/fsrs';

const MARKER = '<!--sr-daily-->';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface DailyInjectionDeps {
  index(): VaultIndex;
  cardStates(): Record<string, CardState>;
}

export function todayString(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function isDailyNote(file: TFile, today: string): boolean {
  if (file.extension !== 'md') return false;
  return file.basename === today && DATE_RE.test(file.basename);
}

export function buildInjectionLine(deps: DailyInjectionDeps): string {
  const index = deps.index();
  const states = deps.cardStates();
  const cards = buildCards(index, { enabledTags: new Set(['Def', 'Q']) });
  const now = Date.now();
  const due = cards.filter(c => isDue(states[c.id] || newCard(), now)).length;
  const qs = (index.byTag['Q'] || []).length;
  const concepts = Object.keys(index.concepts).length;
  return `${MARKER} 📚 ${due} card${due === 1 ? '' : 's'} due · ${qs} open question${qs === 1 ? '' : 's'} · ${concepts} concept${concepts === 1 ? '' : 's'}`;
}

export async function maybeInjectDaily(
  app: App,
  file: TFile,
  deps: DailyInjectionDeps,
  now = new Date()
): Promise<boolean> {
  if (!isDailyNote(file, todayString(now))) return false;
  const content = await app.vault.read(file);
  if (content.includes(MARKER)) return false;
  const line = buildInjectionLine(deps);
  // Prepend the line after any frontmatter block.
  let inserted: string;
  if (content.startsWith('---\n')) {
    const end = content.indexOf('\n---\n', 4);
    if (end >= 0) {
      const idx = end + 5;
      inserted = content.slice(0, idx) + line + '\n\n' + content.slice(idx);
    } else {
      inserted = line + '\n\n' + content;
    }
  } else {
    inserted = line + '\n\n' + content;
  }
  await app.vault.modify(file, inserted);
  return true;
}
