// MCP tool registry: thin handlers that wrap the public plugin API and the
// AIClient. Returning the underlying objects (Mention[], ConceptEntry, …)
// keeps the schemas readable — the server stringifies them as the tool result.
//
// Also builds the resources + prompts context (axis 3): concept hubs / open
// questions / notes as MCP resources, and the AI tag-suggest / synthesis
// templates as MCP prompts.

import { App, TFile } from 'obsidian';
import { SemanticReadingAPI } from '../api';
import { AIClient } from '../ai/client';
import { LANGUAGE_MISS_TAGS } from '../constants';
import { Rating } from '../study/fsrs';
import { buildTagSchemaSystemPrompt, suggestUserPrompt, synthesisUserPrompt } from '../ai/prompts';
import {
  PromptDef,
  PromptResult,
  ResourceContent,
  ResourceDef,
  ResourceTemplateDef,
  ServerContext,
  ToolDefinition,
  ToolHandler,
} from './server';

export interface ToolDeps {
  app: App;
  api: SemanticReadingAPI;
  ai: AIClient;
  conceptsFolder: () => string;
  activeMode: () => number;
  // Vault-wide write commands surfaced as MCP tools (gated by allowWrites).
  rebuildHubs: () => Promise<{ created: number; updated: number; skipped: number }>;
  exportMarkdown: (notePath: string) => Promise<{ path: string }>;
}

const CONCEPT_URI = 'sr://concept/';
const NOTE_URI = 'sr://note/';
const OPEN_QUESTIONS_URI = 'sr://questions/open';

export function buildMcpContext(serverVersion: string, deps: ToolDeps): ServerContext {
  const tools: ToolDefinition[] = [
    {
      name: 'sr_query_by_tag',
      description: 'List every Mention of a tag across the vault. Tag sigils: Def, Q, A, R, M, C, B, L, T, X, N, D, P, Mn, Ex, An, Ev, Opp, Assump, or any user-defined custom tag.',
      inputSchema: {
        type: 'object',
        properties: { tag: { type: 'string', description: 'Tag sigil (case-sensitive)' } },
        required: ['tag'],
      },
    },
    {
      name: 'sr_list_concepts',
      description: 'All concept (Def) hub entries with mention counts and top co-occurring concepts, sorted by mentions desc.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max results (default 100)' },
        },
      },
    },
    {
      name: 'sr_get_concept',
      description: 'Single concept by canonical slug — use sr_canonicalize first if the user provided free-form text.',
      inputSchema: {
        type: 'object',
        properties: { canonical: { type: 'string', description: 'Canonical slug, e.g. "cognition"' } },
        required: ['canonical'],
      },
    },
    {
      name: 'sr_canonicalize',
      description: 'Convert free-form display text into the canonical slug used internally for hub lookups.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
    {
      name: 'sr_open_questions',
      description: 'Every open question (Q-tagged span) across the vault, with note path + block id.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'sr_due_cards',
      description: 'Cards (Def + Q) currently due for review per the FSRS scheduler.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max results (default 50)' },
        },
      },
    },
    {
      name: 'sr_tag_counts',
      description: 'tag -> mention count across the whole vault.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'sr_get_hub_content',
      description: 'Read the markdown body of a concept hub page (Concepts/<canonical>.md).',
      inputSchema: {
        type: 'object',
        properties: { canonical: { type: 'string' } },
        required: ['canonical'],
      },
    },
    {
      name: 'sr_domains_list',
      description: 'List configured domain profiles. Each profile bundles a per-note tag toolkit activated by `semantic_domain: <name>` frontmatter.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'sr_domains_for_note',
      description: 'Resolve the active domain profile and effective tag dictionary for a note path. Use to learn which sigils are valid in a given note.',
      inputSchema: {
        type: 'object',
        properties: { notePath: { type: 'string', description: 'Vault-relative path, e.g. "Inbox/today.md"' } },
        required: ['notePath'],
      },
    },
    {
      name: 'sr_l2_due_cards',
      description: 'L2 + Pattern cards currently due, filtered by the Krashen i+1 rule. Returns coverage data, missing tokens per card, and a miss-tag histogram for the language. Notes opt in by adding `language: <code>` frontmatter; cards inherit that code via Mention.language.',
      inputSchema: {
        type: 'object',
        properties: {
          language: { type: 'string', description: 'ISO code matching the note\'s `language:` frontmatter (e.g. "de")' },
          minCoverage: { type: 'number', description: 'i+1 coverage threshold, 0..1 (default 0.95 per Krashen)' },
          limit: { type: 'number', description: 'Max cards returned (default 50)' },
        },
        required: ['language'],
      },
    },
    {
      name: 'sr_suggest_tags',
      description: 'Ask the AI co-reader to propose semantic tags for a paragraph of prose, using the active reading mode\'s palette. Returns {suggestions: [{tag, span, confidence?, rationale?}]}. Requires the plugin\'s Anthropic API key to be configured.',
      inputSchema: {
        type: 'object',
        properties: {
          paragraph: { type: 'string', description: 'The paragraph text to analyze' },
          mode: { type: 'number', description: 'Reading mode 1–5; defaults to the plugin\'s active mode' },
          existingTags: {
            type: 'array',
            description: 'Tags already applied in the paragraph (optional)',
            items: {
              type: 'object',
              properties: { tag: { type: 'string' }, text: { type: 'string' } },
              required: ['tag', 'text'],
            },
          },
        },
        required: ['paragraph'],
      },
    },

    // === Axis 1: more read API surfaced as tools ===
    {
      name: 'sr_actions',
      description: 'Every action (A-tagged span) across the vault, with note path + block id. Symmetric with sr_open_questions.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'sr_all_cards',
      description: 'All cards derivable from the index (Def + Q), regardless of due state. Use sr_due_cards for the review queue.',
      inputSchema: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'Max results (default 100)' } },
      },
    },
    {
      name: 'sr_card_state',
      description: 'Persisted FSRS scheduling state (stability, difficulty, due date, reps, lapses) for a card id. Card ids come from sr_due_cards / sr_all_cards.',
      inputSchema: {
        type: 'object',
        properties: { cardId: { type: 'string', description: 'Card id, e.g. "Notes/x.md#p2-sr#Def#1a2b3c4d"' } },
        required: ['cardId'],
      },
    },
    {
      name: 'sr_parse_body',
      description: 'Parse markdown body text (frontmatter already stripped) into the plugin\'s paragraph/segment model. Lets a client read {{Tag|…}} markup without re-implementing the parser.',
      inputSchema: {
        type: 'object',
        properties: { body: { type: 'string', description: 'Markdown body (no frontmatter)' } },
        required: ['body'],
      },
    },
    {
      name: 'sr_serialize_paragraph',
      description: 'Serialize an array of segments ({text, tag?, note?, wikilink?}) back into {{Tag|…}} markup. Inverse of sr_parse_body.',
      inputSchema: {
        type: 'object',
        properties: {
          segments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                tag: { type: 'string' },
                note: { type: 'string' },
                wikilink: { type: 'string' },
              },
              required: ['text'],
            },
          },
        },
        required: ['segments'],
      },
    },

    // === Axis 2: write tools (gated by the MCP "Allow write tools" setting) ===
    {
      name: 'sr_review_card',
      description: 'Grade a due card and advance its FSRS schedule. rating: 1=Again, 2=Hard, 3=Good, 4=Easy. Persists state and rolls the day/streak counters, exactly like the review UI.',
      scope: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          cardId: { type: 'string', description: 'Card id from sr_due_cards / sr_all_cards' },
          rating: { type: 'number', description: '1=Again, 2=Hard, 3=Good, 4=Easy' },
        },
        required: ['cardId', 'rating'],
      },
    },
    {
      name: 'sr_apply_tag',
      description: 'Wrap a verbatim span inside a paragraph with {{tag|…}} markup, ensuring the paragraph gets a stable block id. Frontmatter is preserved. Closes the loop on sr_suggest_tags: suggest → apply.',
      scope: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          notePath: { type: 'string', description: 'Vault-relative path' },
          paraIndex: { type: 'number', description: '0-based paragraph index (matches Mention.paraIndex)' },
          span: { type: 'string', description: 'Verbatim substring of the paragraph\'s plain text to tag' },
          tag: { type: 'string', description: 'Tag sigil to apply' },
          note: { type: 'string', description: 'Optional note= annotation' },
        },
        required: ['notePath', 'paraIndex', 'span', 'tag'],
      },
    },
    {
      name: 'sr_synthesize',
      description: 'Ask the AI to synthesize a Markdown document from a slice of vault content, citing sources as [[Note#^block-id]]. Returns the generated text (does not write a file). Requires the Anthropic API key.',
      inputSchema: {
        type: 'object',
        properties: {
          templateName: { type: 'string', description: 'A label for the kind of document (e.g. "Literature note")' },
          instruction: { type: 'string', description: 'What to produce from the slice' },
          slice: { type: 'string', description: 'The vault content the model may cite (the only data it sees)' },
          mode: { type: 'number', description: 'Reading mode 1–5; defaults to the active mode' },
        },
        required: ['templateName', 'instruction', 'slice'],
      },
    },
    {
      name: 'sr_rebuild_hubs',
      description: 'Rebuild concept hub pages (Concepts/<slug>.md), the open-questions index, and per-language hubs from the current index. Creates/updates plugin-owned pages only.',
      scope: 'write',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'sr_export_markdown',
      description: 'Export a note\'s tagged spans to a plain-markdown "<name>.annotated.md" sidecar next to it. Returns the written path.',
      scope: 'write',
      inputSchema: {
        type: 'object',
        properties: { notePath: { type: 'string', description: 'Vault-relative path of the source note' } },
        required: ['notePath'],
      },
    },
  ];

  const handlers: Record<string, ToolHandler> = {
    sr_query_by_tag: (args) => {
      const tag = String(args.tag || '');
      const mentions = deps.api.queries.byTag(tag);
      return { tag, count: mentions.length, mentions };
    },
    sr_list_concepts: (args) => {
      const limit = Number(args.limit ?? 100);
      const all = deps.api.queries.concepts();
      const slice = all
        .slice()
        .sort((a, b) => b.mentions.length - a.mentions.length)
        .slice(0, limit)
        .map(c => ({
          canonical: c.canonical,
          display: c.display,
          mentions: c.mentions.length,
          coOccurs: Object.entries(c.coOccurs).sort((a, b) => b[1] - a[1]).slice(0, 10),
        }));
      return { totalConcepts: all.length, returned: slice.length, concepts: slice };
    },
    sr_get_concept: (args) => {
      const canonical = String(args.canonical || '');
      const c = deps.api.queries.concept(canonical);
      if (!c) return { error: 'not found', canonical };
      return c;
    },
    sr_canonicalize: (args) => {
      const text = String(args.text || '');
      return { input: text, canonical: deps.api.parse.canonicalize(text) };
    },
    sr_open_questions: () => {
      const qs = deps.api.queries.openQuestions();
      return { count: qs.length, questions: qs };
    },
    sr_due_cards: (args) => {
      const limit = Number(args.limit ?? 50);
      const due = deps.api.cards.due();
      return { totalDue: due.length, returned: Math.min(due.length, limit), cards: due.slice(0, limit) };
    },
    sr_tag_counts: () => {
      const counts = deps.api.queries.tagCounts();
      return { counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
    },
    sr_get_hub_content: async (args) => {
      const canonical = String(args.canonical || '');
      const path = `${deps.conceptsFolder()}/${canonical}.md`;
      const file = deps.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) return { error: 'hub not found', path };
      const content = await deps.app.vault.read(file);
      return { path, content };
    },
    sr_domains_list: () => {
      const domains = deps.api.domains.list();
      return {
        count: domains.length,
        domains: domains.map(d => ({
          name: d.name,
          label: d.label,
          mergeMode: d.mergeMode,
          keepBuiltins: d.keepBuiltins || [],
          tagSigils: d.tags.map(t => t.sigil),
          defaultMode: d.defaultMode,
          disabled: !!d.disabled,
        })),
      };
    },
    sr_domains_for_note: (args) => {
      const notePath = String(args.notePath || '');
      if (!notePath) throw new Error('notePath is required');
      const profile = deps.api.domains.forNote(notePath);
      const tags = deps.api.domains.tagsFor(notePath);
      return {
        notePath,
        domain: profile ? { name: profile.name, label: profile.label, mergeMode: profile.mergeMode } : null,
        tags: Object.keys(tags).map(sigil => ({ sigil, ...tags[sigil] })),
      };
    },
    sr_l2_due_cards: (args) => {
      const language = String(args.language || '').trim().toLowerCase();
      if (!language) throw new Error('language is required (ISO code matching `language:` frontmatter)');
      const minCoverage = args.minCoverage !== undefined ? Number(args.minCoverage) : 0.95;
      const limit = Number(args.limit ?? 50);

      // Two passes so we can report how many cards were blocked by coverage —
      // that's the i+1 signal itself, not noise.
      const all = deps.api.cards.due({ language });
      const filtered = deps.api.cards.due({ language, minCoverage });

      const missByType: Record<string, number> = {};
      for (const tag of LANGUAGE_MISS_TAGS) {
        const all = deps.api.queries.byTag(tag);
        missByType[tag] = all.filter(m => m.language === language).length;
      }
      const coverages = filtered.map(c => c.coverage ?? 0).sort((a, b) => a - b);
      const coverageMedian = coverages.length
        ? coverages[Math.floor(coverages.length / 2)]
        : null;

      return {
        language,
        minCoverage,
        totalDue: all.length,
        belowCoverage: all.length - filtered.length,
        returned: Math.min(filtered.length, limit),
        coverageMedian,
        missByType,
        cards: filtered.slice(0, limit),
      };
    },
    sr_suggest_tags: async (args) => {
      if (!deps.ai.isReady()) {
        throw new Error('AI client not configured. Enable AI features and set the Anthropic API key in plugin settings.');
      }
      const paragraph = String(args.paragraph || '');
      if (!paragraph) throw new Error('paragraph is required and must be non-empty');
      const mode = Number(args.mode ?? deps.activeMode());
      const existingTags = Array.isArray(args.existingTags)
        ? (args.existingTags as Array<{ tag: string; text: string }>)
        : [];
      return await deps.ai.suggest(paragraph, existingTags, mode);
    },

    // === Axis 1 ===
    sr_actions: () => {
      const actions = deps.api.queries.actions();
      return { count: actions.length, actions };
    },
    sr_all_cards: (args) => {
      const limit = Number(args.limit ?? 100);
      const all = deps.api.cards.all();
      return { total: all.length, returned: Math.min(all.length, limit), cards: all.slice(0, limit) };
    },
    sr_card_state: (args) => {
      const cardId = String(args.cardId || '');
      if (!cardId) throw new Error('cardId is required');
      const state = deps.api.cards.state(cardId);
      return { cardId, state: state ?? null };
    },
    sr_parse_body: (args) => {
      const body = String(args.body || '');
      return { paragraphs: deps.api.parse.body(body) };
    },
    sr_serialize_paragraph: (args) => {
      const segments = Array.isArray(args.segments) ? args.segments : [];
      return { text: deps.api.parse.serializeParagraph(segments as Parameters<typeof deps.api.parse.serializeParagraph>[0]) };
    },

    // === Axis 2 ===
    sr_review_card: async (args) => {
      const cardId = String(args.cardId || '');
      const rating = Number(args.rating);
      return await deps.api.cards.review(cardId, rating as Rating);
    },
    sr_apply_tag: async (args) => {
      return await deps.api.edits.applyTag({
        notePath: String(args.notePath || ''),
        paraIndex: Number(args.paraIndex),
        span: String(args.span || ''),
        tag: String(args.tag || ''),
        note: args.note !== undefined ? String(args.note) : undefined,
      });
    },
    sr_synthesize: async (args) => {
      if (!deps.ai.isReady()) {
        throw new Error('AI client not configured. Enable AI features and set the Anthropic API key in plugin settings.');
      }
      const templateName = String(args.templateName || '');
      const instruction = String(args.instruction || '');
      const slice = String(args.slice || '');
      if (!templateName || !instruction || !slice) {
        throw new Error('templateName, instruction, and slice are all required');
      }
      const mode = Number(args.mode ?? deps.activeMode());
      return await deps.ai.synthesize(templateName, instruction, slice, mode);
    },
    sr_rebuild_hubs: async () => {
      return await deps.rebuildHubs();
    },
    sr_export_markdown: async (args) => {
      const notePath = String(args.notePath || '');
      if (!notePath) throw new Error('notePath is required');
      return await deps.exportMarkdown(notePath);
    },
  };

  // === Axis 3: resources ===
  const resources = (): ResourceDef[] => {
    const out: ResourceDef[] = [
      {
        uri: OPEN_QUESTIONS_URI,
        name: 'Open questions',
        description: 'Every Q-tagged span across the vault, as JSON.',
        mimeType: 'application/json',
      },
    ];
    for (const c of deps.api.queries.concepts()) {
      out.push({
        uri: CONCEPT_URI + encodeURIComponent(c.canonical),
        name: c.display,
        description: `Concept hub — ${c.mentions.length} mention(s)`,
        mimeType: 'text/markdown',
      });
    }
    return out;
  };

  const resourceTemplates: ResourceTemplateDef[] = [
    {
      uriTemplate: NOTE_URI + '{path}',
      name: 'Vault note',
      description: 'Raw markdown of any vault note by its vault-relative path (URL-encoded).',
      mimeType: 'text/markdown',
    },
  ];

  const readResource = async (uri: string): Promise<ResourceContent> => {
    if (uri === OPEN_QUESTIONS_URI) {
      const qs = deps.api.queries.openQuestions();
      return { uri, mimeType: 'application/json', text: JSON.stringify({ count: qs.length, questions: qs }, null, 2) };
    }
    if (uri.startsWith(CONCEPT_URI)) {
      const canonical = decodeURIComponent(uri.slice(CONCEPT_URI.length));
      const path = `${deps.conceptsFolder()}/${canonical}.md`;
      const file = deps.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        const content = await deps.app.vault.read(file);
        return { uri, mimeType: 'text/markdown', text: content };
      }
      // No hub page built yet — fall back to the index entry as JSON.
      const c = deps.api.queries.concept(canonical);
      if (!c) throw new Error(`concept not found: ${canonical}`);
      return { uri, mimeType: 'application/json', text: JSON.stringify(c, null, 2) };
    }
    if (uri.startsWith(NOTE_URI)) {
      const path = decodeURIComponent(uri.slice(NOTE_URI.length));
      const file = deps.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) throw new Error(`note not found: ${path}`);
      const content = await deps.app.vault.read(file);
      return { uri, mimeType: 'text/markdown', text: content };
    }
    throw new Error(`unsupported resource uri: ${uri}`);
  };

  // === Axis 3: prompts ===
  const prompts: PromptDef[] = [
    {
      name: 'suggest_tags',
      description: 'Reusable prompt for proposing semantic tags on a paragraph, with the full tag schema for the given reading mode.',
      arguments: [
        { name: 'paragraph', description: 'The paragraph text to tag', required: true },
        { name: 'mode', description: 'Reading mode 1–5 (default: active mode)', required: false },
      ],
    },
    {
      name: 'synthesize',
      description: 'Reusable prompt for synthesizing a cited Markdown document from a slice of vault content.',
      arguments: [
        { name: 'templateName', description: 'A label for the kind of document', required: true },
        { name: 'instruction', description: 'What to produce', required: true },
        { name: 'slice', description: 'The vault content the model may cite', required: true },
        { name: 'mode', description: 'Reading mode 1–5 (default: active mode)', required: false },
      ],
    },
  ];

  const getPrompt = (name: string, args: Record<string, unknown>): PromptResult => {
    const mode = Number(args.mode ?? deps.activeMode());
    if (name === 'suggest_tags') {
      const paragraph = String(args.paragraph || '');
      if (!paragraph) throw new Error('paragraph argument is required');
      const text = buildTagSchemaSystemPrompt(mode) + '\n\n---\n\n' + suggestUserPrompt(paragraph, []);
      return { description: 'Tag-suggestion prompt', messages: [{ role: 'user', content: { type: 'text', text } }] };
    }
    if (name === 'synthesize') {
      const templateName = String(args.templateName || '');
      const instruction = String(args.instruction || '');
      const slice = String(args.slice || '');
      if (!templateName || !instruction || !slice) {
        throw new Error('templateName, instruction, and slice arguments are required');
      }
      const text = buildTagSchemaSystemPrompt(mode) + '\n\n---\n\n' + synthesisUserPrompt(templateName, instruction, slice);
      return { description: 'Synthesis prompt', messages: [{ role: 'user', content: { type: 'text', text } }] };
    }
    throw new Error(`unknown prompt: ${name}`);
  };

  return {
    serverName: 'semantic-reading',
    serverVersion,
    tools,
    handlers,
    resources,
    resourceTemplates,
    readResource,
    prompts,
    getPrompt,
    onChange: (cb) => deps.api.onIndexChange(cb),
  };
}
