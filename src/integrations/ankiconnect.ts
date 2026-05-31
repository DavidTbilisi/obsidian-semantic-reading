// AnkiConnect direct sync. POST to localhost:8765 with the AnkiConnect protocol
// (https://foosoft.net/projects/anki-connect/). Each card carries an `srid:<id>`
// tag so re-running the sync skips cards that are already in Anki.
//
// Cards are produced by `buildCards(index)`. We use the Basic note model and
// store the card.id in tags rather than a separate field, which keeps the model
// requirement minimal — any vanilla Anki install has "Basic".

import { requestUrl } from 'obsidian';
import { Card } from '../study/card-builder';

export interface AnkiConnectOptions {
  endpoint: string;       // default http://127.0.0.1:8765
  deckName: string;       // default "Semantic Reading"
  modelName: string;      // default "Basic"
  extraTags: string[];    // always-added tags (e.g. ["sr"])
}

export const DEFAULT_ANKI_OPTIONS: AnkiConnectOptions = {
  endpoint: 'http://127.0.0.1:8765',
  deckName: 'Semantic Reading',
  modelName: 'Basic',
  extraTags: ['sr'],
};

export interface AnkiSyncResult {
  added: number;
  skipped: number;
  failed: number;
  errors: string[];
}

interface AnkiRequest {
  action: string;
  version: 6;
  params?: Record<string, unknown>;
}

async function ankiCall<T>(opts: AnkiConnectOptions, action: string, params?: Record<string, unknown>): Promise<T> {
  const req: AnkiRequest = { action, version: 6 };
  if (params) req.params = params;
  const res = await requestUrl({
    url: opts.endpoint,
    method: 'POST',
    contentType: 'application/json',
    body: JSON.stringify(req),
    throw: false,
  });
  if (res.status >= 400) throw new Error(`AnkiConnect HTTP ${res.status}`);
  const json = res.json as { result: T; error: string | null };
  if (json.error) throw new Error(json.error);
  return json.result;
}

export async function checkAnkiAvailable(opts: AnkiConnectOptions): Promise<number> {
  return ankiCall<number>(opts, 'version');
}

async function ensureDeck(opts: AnkiConnectOptions): Promise<void> {
  await ankiCall<number>(opts, 'createDeck', { deck: opts.deckName });
}

// Build the srid tag for a card so we can detect duplicates without storing it
// in a custom field.
function sridTag(card: Card): string {
  // Anki tags cannot contain spaces; the card.id may include `#` separators.
  return 'srid_' + card.id.replace(/[^A-Za-z0-9]/g, '_');
}

async function existingSrids(opts: AnkiConnectOptions): Promise<Set<string>> {
  // Anki search: tag:srid_* deck:"Deck Name"
  const query = `deck:"${opts.deckName}" tag:srid_*`;
  const noteIds = await ankiCall<number[]>(opts, 'findNotes', { query });
  if (!noteIds.length) return new Set();
  const infos = await ankiCall<Array<{ tags: string[] }>>(opts, 'notesInfo', { notes: noteIds });
  const out = new Set<string>();
  for (const info of infos) {
    for (const tag of info.tags) {
      if (tag.startsWith('srid_')) out.add(tag);
    }
  }
  return out;
}

function cardSourceLink(card: Card): string {
  const path = card.source.notePath.replace(/\.md$/, '');
  return `obsidian://open?vault=&file=${encodeURIComponent(path)}#^${card.source.blockId}`;
}

function cardBack(card: Card): string {
  const link = `<br><br><a href="${cardSourceLink(card)}">Open source</a>`;
  return (card.back || '') + link;
}

export async function syncCardsToAnki(
  cards: Card[],
  opts: AnkiConnectOptions
): Promise<AnkiSyncResult> {
  const result: AnkiSyncResult = { added: 0, skipped: 0, failed: 0, errors: [] };
  if (!cards.length) return result;

  await ensureDeck(opts);
  const existing = await existingSrids(opts);

  const toAdd = cards.filter(c => !existing.has(sridTag(c)));
  result.skipped = cards.length - toAdd.length;

  if (!toAdd.length) return result;

  const notes = toAdd.map(c => ({
    deckName: opts.deckName,
    modelName: opts.modelName,
    fields: {
      Front: c.front,
      Back: cardBack(c),
    },
    tags: Array.from(new Set([...opts.extraTags, c.tag, sridTag(c)])),
    options: { allowDuplicate: false },
  }));

  // AnkiConnect addNotes returns nulls for duplicates / failures.
  const ids = await ankiCall<(number | null)[]>(opts, 'addNotes', { notes });
  for (let i = 0; i < ids.length; i++) {
    if (ids[i] === null) {
      result.failed++;
      result.errors.push(`Failed to add "${toAdd[i].front.slice(0, 60)}" (duplicate?)`);
    } else {
      result.added++;
    }
  }
  return result;
}
