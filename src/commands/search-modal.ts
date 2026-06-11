import { App, SuggestModal, TFile } from 'obsidian';
import { VaultIndexer, Mention } from '../graph/vault-index';
import { TAGS, cssTag } from '../constants';

interface SearchItem {
  tag: string;
  text: string;
  mention: Mention;
}

export class SearchByTagModal extends SuggestModal<SearchItem> {
  private indexer: VaultIndexer;

  constructor(app: App, indexer: VaultIndexer) {
    super(app);
    this.indexer = indexer;
    this.setPlaceholder('Type a sigil to filter — e.g. "Q " for questions, "Def cog" for concept "cog…"');
  }

  getSuggestions(query: string): SearchItem[] {
    const idx = this.indexer.get();
    const trimmed = query.trim();
    if (!trimmed) {
      const all: SearchItem[] = [];
      for (const tag of Object.keys(idx.byTag)) {
        for (const m of idx.byTag[tag]) all.push({ tag, text: m.text, mention: m });
      }
      return all.slice(0, 80);
    }
    // Split into "TAG rest" — first token is interpreted as a tag if it matches.
    const match = trimmed.match(/^(\S+)(?:\s+(.*))?$/);
    if (!match) return [];
    const head = match[1];
    const rest = (match[2] || '').toLowerCase();
    const tagKey = Object.keys(TAGS).find(k => k.toLowerCase() === head.toLowerCase());
    const candidates: SearchItem[] = [];
    if (tagKey) {
      for (const m of idx.byTag[tagKey] || []) {
        if (!rest || m.text.toLowerCase().includes(rest)) {
          candidates.push({ tag: tagKey, text: m.text, mention: m });
        }
      }
    } else {
      // Treat whole string as a free-text search across all tagged spans.
      const lower = trimmed.toLowerCase();
      for (const tag of Object.keys(idx.byTag)) {
        for (const m of idx.byTag[tag]) {
          if (m.text.toLowerCase().includes(lower)) {
            candidates.push({ tag, text: m.text, mention: m });
            if (candidates.length > 80) return candidates;
          }
        }
      }
    }
    return candidates.slice(0, 80);
  }

  renderSuggestion(item: SearchItem, el: HTMLElement): void {
    const row = el.createDiv({ cls: 'sr-search-row' });
    row.createSpan({ cls: 'sr-chip sr-tg-' + cssTag(item.tag), text: item.tag });
    row.createSpan({ cls: 'sr-search-text', text: truncate(item.text, 80) });
    row.createSpan({
      cls: 'sr-search-note',
      text: `${item.mention.notePath} · ¶${item.mention.paraIndex + 1}`,
    });
  }

  onChooseSuggestion(item: SearchItem): void {
    const file = this.app.vault.getAbstractFileByPath(item.mention.notePath);
    if (!(file instanceof TFile)) return;
    void this.app.workspace.getLeaf(false).openFile(file, {
      eState: { line: 0, scroll: 0 },
    });
  }
}

function truncate(s: string, n: number): string {
  const cleaned = s.replace(/\s+/g, ' ').trim();
  return cleaned.length > n ? cleaned.slice(0, n - 1) + '…' : cleaned;
}
