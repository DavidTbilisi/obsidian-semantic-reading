import { describe, it, expect } from 'vitest';
import { applyReview } from '../src/study/grade';

function fresh() {
  return { states: {}, reviewedToday: 0, lastReviewDate: '', streak: 0 };
}

const NOON = Date.parse('2026-06-09T10:00:00Z'); // ymd → 2026-06-09
const DAY = 86_400_000;

describe('applyReview', () => {
  it('advances FSRS state and seeds day/streak counters', () => {
    const data = fresh();
    const r = applyReview(data, 'c1', 3, NOON);
    expect(data.states['c1']).toBeDefined();
    expect(data.states['c1'].reps).toBe(1);
    expect(r.state.due).toBeGreaterThan(NOON); // scheduled into the future
    expect(r.reviewedToday).toBe(1);
    expect(r.streak).toBe(1);
    expect(data.lastReviewDate).toBe('2026-06-09');
  });

  it('counts multiple reviews on the same day without bumping streak', () => {
    const data = fresh();
    applyReview(data, 'c1', 3, NOON);
    const r = applyReview(data, 'c2', 4, NOON);
    expect(r.reviewedToday).toBe(2);
    expect(r.streak).toBe(1);
  });

  it('bumps the streak when the previous review was yesterday', () => {
    const data = fresh();
    applyReview(data, 'c1', 3, NOON);
    const r = applyReview(data, 'c2', 3, NOON + DAY);
    expect(r.streak).toBe(2);
    expect(r.reviewedToday).toBe(1);
    expect(data.lastReviewDate).toBe('2026-06-10');
  });

  it('resets the streak to 1 after a missed day', () => {
    const data = { states: {}, reviewedToday: 5, lastReviewDate: '2026-06-01', streak: 9 };
    const r = applyReview(data, 'c', 3, NOON);
    expect(r.streak).toBe(1);
    expect(r.reviewedToday).toBe(1);
  });
});
