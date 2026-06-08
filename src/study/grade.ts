// Shared card-grading logic: advance an FSRS card state and roll the per-day /
// streak bookkeeping. Extracted from ReviewView so the MCP layer (sr_review_card)
// and the review UI grade cards identically — same streak rules, same persistence
// shape. Pure w.r.t. I/O: it mutates the passed StudyData in place and returns
// the new state; the caller persists. `now` is injectable for tests.

import { CardState, Rating, newCard, rate, DEFAULT_PARAMS, FSRSParams } from './fsrs';
import type { StudyData } from '../views/review-view';

export interface ReviewResult {
  state: CardState;
  reviewedToday: number;
  streak: number;
}

export function applyReview(
  data: StudyData,
  cardId: string,
  rating: Rating,
  now: number = Date.now(),
  params: FSRSParams = DEFAULT_PARAMS,
): ReviewResult {
  const prev = data.states[cardId] || newCard();
  const next = rate(prev, rating, params, now);
  data.states[cardId] = next;

  const today = ymd(new Date(now));
  if (data.lastReviewDate === today) {
    data.reviewedToday += 1;
  } else {
    // New day: bump streak if yesterday was the last review date, else reset to 1.
    const wasYesterday = data.lastReviewDate === ymd(new Date(now - 86_400_000));
    data.streak = wasYesterday ? data.streak + 1 : 1;
    data.reviewedToday = 1;
    data.lastReviewDate = today;
  }
  return { state: next, reviewedToday: data.reviewedToday, streak: data.streak };
}

export function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
