import { VaultIndex, Mention } from '../graph/vault-index';
import { TAGS, LANGUAGE_CARD_TAGS } from '../constants';

export type CardKind = 'cloze' | 'question' | 'action' | 'relation' | 'l2' | 'pattern';

export interface Card {
  id: string;             // stable hash
  kind: CardKind;
  tag: string;
  source: Mention;
  front: string;
  back: string;
  context?: string;
  // Populated by api.ts `cards.due({minCoverage})` for L2/Pattern cards only —
  // describes how much of the surrounding paragraph the reader can already parse.
  coverage?: number;        // 0..1, fraction of paragraph tokens that map to a seen Def
  missingTokens?: string[]; // tokens not yet seen (cap'd at ~10 for payload size)
  paragraphText?: string;   // surrounding paragraph plain text (for caller context)
}

export interface CardBuilderOptions {
  enabledTags: Set<string>;  // which tags become cards
}

const DEFAULT_OPTIONS: CardBuilderOptions = {
  enabledTags: new Set(['Def', 'Q']),
};

export function buildCards(index: VaultIndex, opts: Partial<CardBuilderOptions> = {}): Card[] {
  const o = { ...DEFAULT_OPTIONS, ...opts };
  const cards: Card[] = [];

  // Def cards (cloze).
  if (o.enabledTags.has('Def')) {
    for (const canonical of Object.keys(index.concepts)) {
      const entry = index.concepts[canonical];
      for (const m of entry.mentions) {
        cards.push({
          id: cardId(m, 'Def'),
          kind: 'cloze',
          tag: 'Def',
          source: m,
          front: `Concept defined here: "____"`,
          back: m.text,
          context: m.text,
        });
      }
    }
  }

  // Q cards + language cards (L2, Pattern) + other tag-specific cards.
  for (const tag of o.enabledTags) {
    if (tag === 'Def') continue; // already handled
    const list = index.byTag[tag] || [];
    for (const m of list) {
      cards.push(buildOneCard(tag, m));
    }
  }

  return cards;
}

// Build only the language-family cards. Used by cards.due({language}) so the
// caller doesn't have to spell out the L2/Pattern tag set every time.
export function buildLanguageCards(index: VaultIndex): Card[] {
  return buildCards(index, { enabledTags: new Set<string>(LANGUAGE_CARD_TAGS) });
}

function buildOneCard(tag: string, m: Mention): Card {
  const def = TAGS[tag];
  const name = def ? def.name : tag;
  switch (tag) {
    case 'Q':
      return {
        id: cardId(m, tag),
        kind: 'question',
        tag,
        source: m,
        front: m.text,
        back: 'Open question — revisit in the source note.',
      };
    case 'A':
      return {
        id: cardId(m, tag),
        kind: 'action',
        tag,
        source: m,
        front: `Have you done this? — ${m.text}`,
        back: 'Mark complete in the source note if done.',
      };
    case 'R':
      return {
        id: cardId(m, tag),
        kind: 'relation',
        tag,
        source: m,
        front: `Recall this relation: ${m.text}`,
        back: m.text,
      };
    case 'L2':
      // Back uses the Gloss attached as `note=` when present; otherwise the user
      // hasn't recorded the meaning yet and the card prompts them to add one.
      return {
        id: cardId(m, tag),
        kind: 'l2',
        tag,
        source: m,
        front: m.text,
        back: m.note ? m.note : '(no gloss yet — open the source note and add one)',
        context: m.text,
      };
    case 'Pattern':
      return {
        id: cardId(m, tag),
        kind: 'pattern',
        tag,
        source: m,
        front: `Pattern: ${m.text}`,
        back: m.note || m.text,
        context: m.text,
      };
    default:
      return {
        id: cardId(m, tag),
        kind: 'question',
        tag,
        source: m,
        front: `${name}: ${m.text}`,
        back: name,
      };
  }
}

function cardId(m: Mention, tag: string): string {
  return [m.notePath, m.blockId, tag, hash32(m.text)].join('#');
}

// Cheap deterministic 32-bit string hash (FNV-1a).
function hash32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}
