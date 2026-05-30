import Anthropic from '@anthropic-ai/sdk';
import { buildTagSchemaSystemPrompt } from './prompts';

export interface AIProviderConfig {
  enabled: boolean;
  apiKey: string;
  suggestModel: string;   // default 'claude-sonnet-4-6'
  synthesisModel: string; // default 'claude-opus-4-7'
}

export const DEFAULT_AI_CONFIG: AIProviderConfig = {
  enabled: false,
  apiKey: '',
  suggestModel: 'claude-sonnet-4-6',
  synthesisModel: 'claude-opus-4-7',
};

export interface TagSuggestion {
  tag: string;
  span: string;
  confidence?: number;
  rationale?: string;
}

export interface SuggestResult {
  suggestions: TagSuggestion[];
  cacheHit: boolean;
  inputTokens: number;
  outputTokens: number;
}

export interface SynthesizeResult {
  text: string;
  cacheHit: boolean;
  inputTokens: number;
  outputTokens: number;
}

const SUGGEST_TOOL = {
  name: 'propose_tags',
  description: 'Return a list of proposed semantic tags for the paragraph.',
  input_schema: {
    type: 'object' as const,
    properties: {
      suggestions: {
        type: 'array',
        description: '0–5 proposed tags; empty array if none justified.',
        items: {
          type: 'object',
          properties: {
            tag: { type: 'string', description: 'Sigil from the mode\'s palette.' },
            span: { type: 'string', description: 'Verbatim substring of the paragraph.' },
            confidence: { type: 'number', description: 'Self-assessed 0–1.' },
            rationale: { type: 'string', description: 'One short sentence.' },
          },
          required: ['tag', 'span'],
        },
      },
    },
    required: ['suggestions'],
  },
};

export class AIClient {
  private cfg: AIProviderConfig;
  private client: Anthropic | null = null;

  constructor(cfg: AIProviderConfig) {
    this.cfg = cfg;
    this.rebuild();
  }

  update(cfg: AIProviderConfig): void {
    this.cfg = cfg;
    this.rebuild();
  }

  isReady(): boolean {
    return this.cfg.enabled && !!this.cfg.apiKey && !!this.client;
  }

  private rebuild(): void {
    if (this.cfg.enabled && this.cfg.apiKey) {
      this.client = new Anthropic({
        apiKey: this.cfg.apiKey,
        dangerouslyAllowBrowser: true, // Obsidian's renderer is Electron, not a real browser
      });
    } else {
      this.client = null;
    }
  }

  async suggest(paragraph: string, existingTags: { tag: string; text: string }[], mode: number): Promise<SuggestResult> {
    if (!this.client) throw new Error('AI client not configured');
    const { suggestUserPrompt } = await import('./prompts');
    const response = await this.client.messages.create({
      model: this.cfg.suggestModel,
      max_tokens: 1024,
      system: [{
        type: 'text',
        text: buildTagSchemaSystemPrompt(mode),
        cache_control: { type: 'ephemeral' },
      }],
      tools: [SUGGEST_TOOL],
      tool_choice: { type: 'tool', name: 'propose_tags' },
      messages: [{ role: 'user', content: suggestUserPrompt(paragraph, existingTags) }],
    });
    const usage = response.usage;
    const cacheHit = (usage.cache_read_input_tokens || 0) > 0;
    let suggestions: TagSuggestion[] = [];
    for (const block of response.content) {
      if (block.type === 'tool_use' && block.name === 'propose_tags') {
        const input = block.input as { suggestions?: TagSuggestion[] };
        suggestions = input.suggestions || [];
        break;
      }
    }
    // Filter: must be verbatim substring of paragraph.
    suggestions = suggestions.filter(s => s.span && paragraph.includes(s.span));
    return {
      suggestions,
      cacheHit,
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
    };
  }

  async synthesize(templateName: string, instruction: string, slice: string, mode: number): Promise<SynthesizeResult> {
    if (!this.client) throw new Error('AI client not configured');
    const { synthesisUserPrompt } = await import('./prompts');
    const response = await this.client.messages.create({
      model: this.cfg.synthesisModel,
      max_tokens: 16000,
      system: [{
        type: 'text',
        text: buildTagSchemaSystemPrompt(mode),
        cache_control: { type: 'ephemeral' },
      }],
      messages: [{ role: 'user', content: synthesisUserPrompt(templateName, instruction, slice) }],
    });
    const usage = response.usage;
    const cacheHit = (usage.cache_read_input_tokens || 0) > 0;
    let text = '';
    for (const block of response.content) {
      if (block.type === 'text') text += block.text;
    }
    return {
      text,
      cacheHit,
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
    };
  }
}
