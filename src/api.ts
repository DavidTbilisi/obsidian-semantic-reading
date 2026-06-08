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

import { TFile } from 'obsidian';
import type SemanticReadingPlugin from '../main';
import { canonicalize, parseBody, serializeParagraph, Paragraph, Segment } from './syntax';
import type { ConceptEntry, Mention, VaultIndex } from './graph/vault-index';
import { buildCards, Card } from './study/card-builder';
import { isDue, newCard, CardState, Rating } from './study/fsrs';
import { applyReview } from './study/grade';
import { applyTagInBody } from './edit/apply-tag';
import { stripFrontmatter } from './views/cards-view';
import type { DomainProfile } from './domains';
import { LANGUAGE_CARD_TAGS, type TagDef } from './constants';

// Options for cards.due(). All fields optional and backward-compatible —
// calling due() with no args preserves the prior `Def + Q, all languages,
// no coverage filter` behavior.
export interface DueOptions {
  /** ISO code matching `language:` frontmatter. When set, only that language's L2 cards are considered. */
  language?: string;
  /** Krashen i+1 threshold (0..1, default 0.95). Cards whose paragraph context falls below are filtered out. Only applies when `language` is set. */
  minCoverage?: number;
}

/** Result of grading a card via `cards.review`. */
export interface ReviewOutput {
  cardId: string;
  state: CardState;
  due: number;            // epoch ms of the next review
  reviewedToday: number;
  streak: number;
}

/** Arguments for `edits.applyTag`. */
export interface ApplyTagInput {
  notePath: string;       // vault-relative path
  paraIndex: number;      // 0-based paragraph index (matches Mention.paraIndex)
  span: string;           // verbatim substring of the paragraph's plain text
  tag: string;            // tag sigil to apply
  note?: string;          // optional `note=` annotation
}

/** Result of `edits.applyTag`. */
export interface ApplyTagOutput {
  notePath: string;
  paraIndex: number;
  blockId: string;
  tag: string;
  span: string;
  paragraph: string;      // the rewritten paragraph markup (without block id)
}

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
    /**
     * Cards due now. Without args: Def + Q across the vault (legacy behavior).
     * With `{ language }`: also includes L2 + Pattern cards from notes tagged with
     * that language. With `{ language, minCoverage }`: applies the Krashen i+1
     * coverage filter to L2/Pattern cards (default threshold 0.95).
     */
    due(opts?: DueOptions): Card[];
    /** Persisted FSRS state for a card id, if any. */
    state(cardId: string): CardState | undefined;
    /**
     * Grade a card (FSRS rating 1=Again, 2=Hard, 3=Good, 4=Easy), persist the
     * new state, and roll the day/streak counters — the same path the review
     * UI uses. Returns the next state and the next due timestamp.
     */
    review(cardId: string, rating: Rating): Promise<ReviewOutput>;
  };

  /**
   * Subscribe to vault-index changes. Returns an unsubscribe function.
   * Fired after each incremental rebuild.
   */
  onIndexChange(cb: () => void): () => void;

  /** Vault-mutating edits. Side-effecting — these write to your notes. */
  readonly edits: {
    /**
     * Wrap a verbatim `span` inside paragraph `paraIndex` of `notePath` with
     * `{{tag|…}}` markup, ensuring the paragraph carries a stable block id.
     * Frontmatter is preserved. The indexer picks up the change on save.
     */
    applyTag(input: ApplyTagInput): Promise<ApplyTagOutput>;
  };

  /** Domain profiles: per-note tag toolkits selected via `semantic_domain:`. */
  readonly domains: {
    /** All configured profiles, in settings order (including disabled). */
    list(): DomainProfile[];
    /** The active profile for a given note path, or null if none. */
    forNote(notePath: string): DomainProfile | null;
    /** Effective TAGS dictionary for a given note (respects mergeMode). */
    tagsFor(notePath: string): Record<string, TagDef>;
  };
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
      due(opts?: DueOptions) {
        const idx = indexer().get();
        const now = Date.now();
        const states = study().states;
        // When a language filter is set, also surface L2/Pattern cards.
        const enabledTags = opts?.language
          ? new Set<string>(['Def', 'Q', ...LANGUAGE_CARD_TAGS])
          : new Set<string>(['Def', 'Q']);
        let cards = buildCards(idx, { enabledTags })
          .filter(c => isDue(states[c.id] || newCard(), now));
        if (opts?.language) {
          // Restrict to cards whose source note opted into this language. Def/Q
          // cards in non-L2 notes are dropped — the caller asked for a language
          // session, not a mixed queue.
          cards = cards.filter(c => c.source.language === opts.language);
        }
        if (opts?.language && opts.minCoverage !== undefined) {
          const minCov = opts.minCoverage;
          const seenDefs = computeSeenDefs(idx, opts.language);
          cards = cards
            .map(c => decorateCoverage(c, idx, seenDefs))
            .filter(c => (c.coverage ?? 0) >= minCov);
        }
        return cards;
      },
      state(cardId) {
        return study().states[cardId];
      },
      async review(cardId, rating) {
        if (!cardId) throw new Error('cardId is required');
        if (![1, 2, 3, 4].includes(rating)) {
          throw new Error('rating must be 1 (Again), 2 (Hard), 3 (Good), or 4 (Easy)');
        }
        const data = study();
        const r = applyReview(data, cardId, rating);
        await plugin.saveSettings();
        return {
          cardId,
          state: r.state,
          due: r.state.due,
          reviewedToday: r.reviewedToday,
          streak: r.streak,
        };
      },
    },

    onIndexChange(cb) {
      return indexer().subscribe('changed', cb);
    },

    edits: {
      async applyTag(input) {
        const { notePath, paraIndex, span, tag, note } = input;
        if (!notePath) throw new Error('notePath is required');
        if (!span) throw new Error('span is required');
        if (!/^[A-Za-z][A-Za-z0-9]*$/.test(tag || '')) {
          throw new Error(`invalid tag sigil ${JSON.stringify(tag)} — letters/digits, must start with a letter`);
        }
        const file = plugin.app.vault.getAbstractFileByPath(notePath);
        if (!(file instanceof TFile)) throw new Error(`note not found: ${notePath}`);
        const content = await plugin.app.vault.read(file);
        const stripped = stripFrontmatter(content);
        const prefix = content.slice(0, content.length - stripped.length);
        const r = applyTagInBody(stripped, { paraIndex, span, tag, note });
        await plugin.app.vault.modify(file, prefix + r.body);
        return { notePath, paraIndex, blockId: r.blockId, tag, span, paragraph: r.paragraph };
      },
    },

    domains: {
      list() {
        return plugin.settings.domains || [];
      },
      forNote(notePath) {
        const file = plugin.app.vault.getAbstractFileByPath(notePath);
        if (!(file instanceof TFile)) return null;
        const fm = plugin.app.metadataCache.getFileCache(file)?.frontmatter;
        const name = readDomainName(fm);
        if (!name) return null;
        return (plugin.settings.domains || []).find(d => d.name === name && !d.disabled) || null;
      },
      tagsFor(notePath) {
        const file = plugin.app.vault.getAbstractFileByPath(notePath);
        if (!(file instanceof TFile)) return {};
        return plugin.resolveTagsForFile(file);
      },
    },
  };
}

function readDomainName(fm: Record<string, unknown> | undefined): string | null {
  if (!fm) return null;
  const d = (fm as Record<string, unknown>).semantic_domain;
  return typeof d === 'string' && d.trim() ? d.trim() : null;
}

// === i+1 coverage support (Krashen comprehensible-input rule) ===
//
// `cards.due({language, minCoverage})` filters L2/Pattern cards by how much of
// their surrounding paragraph the reader can already parse. A card whose
// paragraph is mostly unknown vocabulary is below i+1 and should not surface —
// it would force learning multiple new items at once.

const TOKEN_SEP = /[\s\p{P}]+/u; // whitespace + Unicode punctuation
const MAX_MISSING_TOKENS = 10;

// Tokenize a paragraph into canonicalized word forms. Empty strings filtered.
function tokenize(paragraph: string): string[] {
  return paragraph
    .split(TOKEN_SEP)
    .map(t => canonicalize(t))
    .filter(Boolean);
}

// "Seen Def" predicate for i+1 coverage: any concept with at least one
// recorded mention counts as known. Matches Krashen's exposure model — the
// bar is "you've encountered this morpheme in context," not retention. The
// filter becomes more permissive as the reading corpus grows, which mirrors
// the wiki's frequency-governed-encoding rule. Cross-language leakage is
// accepted as a known limitation for V1 (a word tagged in one language
// counts toward coverage in any language).
function computeSeenDefs(idx: VaultIndex, language: string): Set<string> {
  void language; // reserved for future per-language predicates
  const seen = new Set<string>();
  for (const canonical of Object.keys(idx.concepts)) {
    if (idx.concepts[canonical].mentions.length > 0) seen.add(canonical);
  }
  return seen;
}

// Decorate a card with coverage data: ratio of paragraph tokens that map to a
// seen Def, plus the list of unknown tokens (capped). Cards from notes with
// no cached paragraph text get coverage=0 (effectively filtered out at any
// non-zero threshold).
function decorateCoverage(card: Card, idx: VaultIndex, seen: Set<string>): Card {
  const paragraphs = idx.languageParagraphs[card.source.notePath];
  const paragraph = paragraphs?.[card.source.paraIndex];
  if (!paragraph) {
    return { ...card, coverage: 0, missingTokens: [], paragraphText: '' };
  }
  const tokens = tokenize(paragraph);
  if (!tokens.length) {
    return { ...card, coverage: 1, missingTokens: [], paragraphText: paragraph };
  }
  const missing: string[] = [];
  let known = 0;
  for (const t of tokens) {
    if (seen.has(t)) known++;
    else if (missing.length < MAX_MISSING_TOKENS) missing.push(t);
  }
  return {
    ...card,
    coverage: known / tokens.length,
    missingTokens: missing,
    paragraphText: paragraph,
  };
}
