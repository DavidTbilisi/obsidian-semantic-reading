import { ItemView, WorkspaceLeaf, App, Notice } from 'obsidian';
import { VaultIndexer } from '../graph/vault-index';
import { buildCards, Card } from '../study/card-builder';
import { CardState, Rating, isDue, newCard, rate, DEFAULT_PARAMS } from '../study/fsrs';

export const REVIEW_VIEW_TYPE = 'semantic-reading-review';

export interface StudyData {
  states: Record<string, CardState>;
  reviewedToday: number;
  lastReviewDate: string; // YYYY-MM-DD
  streak: number;
}

export class ReviewView extends ItemView {
  private indexer: VaultIndexer;
  private dataAccess: { get: () => StudyData; save: (d: StudyData) => Promise<void> };
  private queue: Card[] = [];
  private currentIndex = 0;
  private showingBack = false;
  private keyHandler: (e: KeyboardEvent) => void;

  constructor(
    leaf: WorkspaceLeaf,
    indexer: VaultIndexer,
    dataAccess: { get: () => StudyData; save: (d: StudyData) => Promise<void> }
  ) {
    super(leaf);
    this.indexer = indexer;
    this.dataAccess = dataAccess;
    this.keyHandler = (e: KeyboardEvent) => this.onKey(e);
  }

  getViewType(): string { return REVIEW_VIEW_TYPE; }
  getDisplayText(): string { return 'Semantic Review'; }
  getIcon(): string { return 'graduation-cap'; }

  async onOpen(): Promise<void> {
    this.registerDomEvent(document, 'keydown', this.keyHandler);
    this.registerEvent(this.indexer.on('changed', () => this.rebuildQueue()));
    this.rebuildQueue();
  }

  async onClose(): Promise<void> {}

  private rebuildQueue(): void {
    const data = this.dataAccess.get();
    const cards = buildCards(this.indexer.get(), { enabledTags: new Set(['Def', 'Q']) });
    const now = Date.now();
    const due: Card[] = [];
    for (const c of cards) {
      const state = data.states[c.id] || newCard();
      if (isDue(state, now)) due.push(c);
    }
    // Sort by due date ascending (oldest first), then by tag for stability.
    due.sort((a, b) => {
      const sa = data.states[a.id]?.due ?? 0;
      const sb = data.states[b.id]?.due ?? 0;
      return sa - sb;
    });
    this.queue = due;
    this.currentIndex = 0;
    this.showingBack = false;
    this.render();
  }

  private render(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('sr-view-root');

    const data = this.dataAccess.get();
    const header = root.createDiv({ cls: 'sr-review-header' });
    header.createSpan({ cls: 'sr-review-stat', text: `Queue: ${Math.max(0, this.queue.length - this.currentIndex)}` });
    header.createSpan({ cls: 'sr-review-stat', text: `Today: ${data.reviewedToday}` });
    header.createSpan({ cls: 'sr-review-stat', text: `Streak: ${data.streak}` });

    const card = this.queue[this.currentIndex];
    if (!card) {
      root.createDiv({
        cls: 'sr-view-empty',
        text: 'No cards due. Tag some Defs / Qs in your notes and they will appear here.',
      });
      return;
    }

    const cardBox = root.createDiv({ cls: 'sr-review-card' });
    cardBox.createDiv({ cls: 'sr-review-tag sr-tg-' + card.tag, text: card.tag });
    cardBox.createDiv({ cls: 'sr-review-front', text: card.front });

    if (this.showingBack) {
      cardBox.createDiv({ cls: 'sr-review-divider' });
      cardBox.createDiv({ cls: 'sr-review-back', text: card.back });
      const src = cardBox.createDiv({ cls: 'sr-review-source' });
      const link = src.createEl('a', { text: `Open ${card.source.notePath}#^${card.source.blockId}` });
      link.onclick = (e) => {
        e.preventDefault();
        this.openSource(card);
      };

      const buttons = cardBox.createDiv({ cls: 'sr-review-ratings' });
      const labels: { rating: Rating; label: string; cls: string }[] = [
        { rating: 1, label: '1 · Again', cls: 'rate-1' },
        { rating: 2, label: '2 · Hard',  cls: 'rate-2' },
        { rating: 3, label: '3 · Good',  cls: 'rate-3' },
        { rating: 4, label: '4 · Easy',  cls: 'rate-4' },
      ];
      labels.forEach(({ rating, label, cls }) => {
        const btn = buttons.createEl('button', { cls: 'sr-review-btn ' + cls, text: label });
        btn.onclick = () => this.rateCurrent(rating);
      });
    } else {
      const showBtn = cardBox.createEl('button', { cls: 'sr-review-show', text: 'Show answer (space)' });
      showBtn.onclick = () => { this.showingBack = true; this.render(); };
    }
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.containerEl.isShown()) return;
    if (!this.queue[this.currentIndex]) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === ' ' && !this.showingBack) { e.preventDefault(); this.showingBack = true; this.render(); }
    else if (this.showingBack && /^[1-4]$/.test(e.key)) {
      e.preventDefault();
      this.rateCurrent(parseInt(e.key, 10) as Rating);
    }
  }

  private async rateCurrent(rating: Rating): Promise<void> {
    const card = this.queue[this.currentIndex];
    if (!card) return;
    const data = this.dataAccess.get();
    const prev = data.states[card.id] || newCard();
    const next = rate(prev, rating, DEFAULT_PARAMS);
    data.states[card.id] = next;

    const today = ymd(new Date());
    if (data.lastReviewDate === today) {
      data.reviewedToday += 1;
    } else {
      // New day: bump streak if yesterday was the last review date.
      const wasYesterday = data.lastReviewDate === ymd(new Date(Date.now() - 86_400_000));
      data.streak = wasYesterday ? data.streak + 1 : 1;
      data.reviewedToday = 1;
      data.lastReviewDate = today;
    }
    await this.dataAccess.save(data);

    this.currentIndex += 1;
    this.showingBack = false;
    this.render();
  }

  private async openSource(card: Card): Promise<void> {
    const path = card.source.notePath;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file) { new Notice('Source note not found'); return; }
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file as any);
  }
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function emptyStudyData(): StudyData {
  return { states: {}, reviewedToday: 0, lastReviewDate: '', streak: 0 };
}
