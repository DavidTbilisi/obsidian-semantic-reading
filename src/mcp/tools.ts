// MCP tool registry: thin handlers that wrap the public plugin API and the
// AIClient. Returning the underlying objects (Mention[], ConceptEntry, …)
// keeps the schemas readable — the server stringifies them as the tool result.

import { App, TFile } from 'obsidian';
import { SemanticReadingAPI } from '../api';
import { AIClient } from '../ai/client';
import { ServerContext, ToolDefinition, ToolHandler } from './server';

export interface ToolDeps {
  app: App;
  api: SemanticReadingAPI;
  ai: AIClient;
  conceptsFolder: () => string;
  activeMode: () => number;
}

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
  };

  return {
    serverName: 'semantic-reading',
    serverVersion,
    tools,
    handlers,
  };
}
