// Public API surface for other plugins / Templater / Dataview JS / QuickAdd / MCP clients.
//
// Stability promise: methods on this object will not be removed or have their
// signatures narrowed within a major version. New methods may be added.
// Access from outside the plugin as:
//
//     const sr = app.plugins.plugins['semantic-reading']?.api;
//     if (sr) sr.queries.byTag('Q').forEach(m => console.log(m));
//
// Consumers should guard against `undefined` (plugin disabled / not installed).

import type SemanticReadingPlugin from '../main';
import { canonicalize, parseBody, serializeParagraph, Paragraph, Segment } from './syntax';
import type { ConceptEntry, Mention, VaultIndex } from './graph/vault-index';
import { buildCards, Card } from './study/card-builder';
import { isDue, newCard, CardState } from './study/fsrs';

export interface SemanticReadingAPI {
  /** Plugin version (mirrors manifest.json). */
  readonly version: string;

  /** Read-only queries against the live vault tag index. Cheap; the index is in memory. */
  readonly queries: {
    /** All mentions of a tag across the vault. */
    byTag(tag: string): Mention[];
    /** All concept (Def) hub entries, in arbitrary order. */
    concepts(): ConceptEntry[];
    /** A single concept by canonical slug (`canonicalize(text)`). */
    concept(canonical: string): ConceptEntry | undefined;
    /** All open questions across the vault. */
    openQuestions(): Mention[];
    /** All actions across the vault. */
    actions(): Mention[];
    /** Tag -> mention count across the whole vault. */
    tagCounts(): Record<string, number>;
    /** Monotonic index revision. Bump means the index has changed. */
    rev(): number;
    /** The raw underlying index. Mutation is not supported. */
    raw(): VaultIndex;
  };

  /** Pure parsing & serialization helpers. No side effects. */
  readonly parse: {
    body(body: string): Paragraph[];
    serializeParagraph(segs: Segment[]): string;
    canonicalize(text: string): string;
  };

  /** Card scheduling (FSRS) data. */
  readonly cards: {
    /** All cards derivable from the current index (per the current enabled-tags policy). */
    all(): Card[];
    /** Cards due now. */
    due(): Card[];
    /** Persisted FSRS state for a card id, if any. */
    state(cardId: string): CardState | undefined;
  };

  /**
   * Subscribe to vault-index changes. Returns an unsubscribe function.
   * Fired after each incremental rebuild.
   */
  onIndexChange(cb: () => void): () => void;
}

export function createApi(plugin: SemanticReadingPlugin, version: string): SemanticReadingAPI {
  const indexer = () => plugin.indexer;
  const study = () => plugin.settings.study;

  return {
    version,

    queries: {
      byTag(tag) {
        return indexer().get().byTag[tag] || [];
      },
      concepts() {
        return Object.values(indexer().get().concepts);
      },
      concept(canonical) {
        return indexer().get().concepts[canonical];
      },
      openQuestions() {
        return indexer().get().byTag['Q'] || [];
      },
      actions() {
        return indexer().get().byTag['A'] || [];
      },
      tagCounts() {
        const counts: Record<string, number> = {};
        const idx = indexer().get();
        for (const tag of Object.keys(idx.byTag)) counts[tag] = idx.byTag[tag].length;
        return counts;
      },
      rev() {
        return indexer().get().rev;
      },
      raw() {
        return indexer().get();
      },
    },

    parse: {
      body: parseBody,
      serializeParagraph,
      canonicalize,
    },

    cards: {
      all() {
        return buildCards(indexer().get(), { enabledTags: new Set(['Def', 'Q']) });
      },
      due() {
        const now = Date.now();
        return buildCards(indexer().get(), { enabledTags: new Set(['Def', 'Q']) })
          .filter(c => isDue(study().states[c.id] || newCard(), now));
      },
      state(cardId) {
        return study().states[cardId];
      },
    },

    onIndexChange(cb) {
      return indexer().subscribe('changed', cb);
    },
  };
}
