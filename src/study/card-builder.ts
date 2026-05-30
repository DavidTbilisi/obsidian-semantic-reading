import { VaultIndex, Mention } from '../graph/vault-index';
import { TAGS } from '../constants';

export type CardKind = 'cloze' | 'question' | 'action' | 'relation';

export interface Card {
  id: string;             // stable hash
  kind: CardKind;
  tag: string;
  source: Mention;
  front: string;
  back: string;
  context?: string;
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

  // Q cards.
  for (const tag of o.enabledTags) {
    if (tag === 'Def') continue; // already handled
    const list = index.byTag[tag] || [];
    for (const m of list) {
      cards.push(buildOneCard(tag, m));
    }
  }

  return cards;
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
