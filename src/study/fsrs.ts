// Vendored FSRS-v5 (minimal). Pure TypeScript, no dependencies.
// Based on the FSRS-5 algorithm: github.com/open-spaced-repetition/fsrs4anki/wiki/ABC-of-FSRS
// References for default weights: https://github.com/open-spaced-repetition/ts-fsrs

export type Rating = 1 | 2 | 3 | 4; // 1=Again, 2=Hard, 3=Good, 4=Easy
export type State = 'new' | 'learning' | 'review' | 'relearning';

export interface CardState {
  due: number;            // epoch ms
  stability: number;      // days
  difficulty: number;     // 1–10
  reps: number;
  lapses: number;
  lastReview: number | null;
  state: State;
}

export interface FSRSParams {
  weights: number[];
  requestRetention: number; // target retention, default 0.9
  maximumInterval: number;  // days, default 36500
}

export const DEFAULT_WEIGHTS = [
  0.4072, 1.1829, 3.1262, 15.4722, 7.2102, 0.5316, 1.0651, 0.0234,
  1.616, 0.1544, 1.0824, 1.9813, 0.0953, 0.2975, 2.2042, 0.2407,
  2.9466, 0.5034, 0.6567,
];

export const DEFAULT_PARAMS: FSRSParams = {
  weights: DEFAULT_WEIGHTS,
  requestRetention: 0.9,
  maximumInterval: 36500,
};

const DECAY = -0.5;
const FACTOR = Math.pow(0.9, 1 / DECAY) - 1;

export function newCard(): CardState {
  return {
    due: Date.now(),
    stability: 0,
    difficulty: 0,
    reps: 0,
    lapses: 0,
    lastReview: null,
    state: 'new',
  };
}

// Days between two epoch-ms timestamps, floored at 0.
function elapsedDays(a: number, b: number): number {
  return Math.max(0, (a - b) / 86_400_000);
}

// Retrievability after t days for current stability.
function forgettingCurve(t: number, stability: number): number {
  return Math.pow(1 + FACTOR * t / stability, DECAY);
}

function initStability(w: number[], rating: Rating): number {
  return Math.max(w[rating - 1], 0.1);
}

function initDifficulty(w: number[], rating: Rating): number {
  return clampDifficulty(w[4] - Math.exp(w[5] * (rating - 1)) + 1);
}

function clampDifficulty(d: number): number {
  return Math.min(Math.max(d, 1), 10);
}

function meanReversion(w: number[], init: number, current: number): number {
  return w[7] * init + (1 - w[7]) * current;
}

function nextDifficulty(w: number[], d: number, rating: Rating): number {
  const dDelta = -w[6] * (rating - 3);
  return clampDifficulty(meanReversion(w, w[4] - Math.exp(w[5] * 2) + 1, d + dDelta));
}

function nextRecallStability(w: number[], d: number, s: number, r: number, rating: Rating): number {
  const hardPenalty = rating === 2 ? w[15] : 1;
  const easyBonus = rating === 4 ? w[16] : 1;
  return s * (1 +
    Math.exp(w[8]) *
    (11 - d) *
    Math.pow(s, -w[9]) *
    (Math.exp((1 - r) * w[10]) - 1) *
    hardPenalty *
    easyBonus
  );
}

function nextForgetStability(w: number[], d: number, s: number, r: number): number {
  return w[11] *
    Math.pow(d, -w[12]) *
    (Math.pow(s + 1, w[13]) - 1) *
    Math.exp((1 - r) * w[14]);
}

// Interval in days for the next review given a stability.
function nextInterval(stability: number, requestRetention: number, maxInterval: number): number {
  const i = stability / FACTOR * (Math.pow(requestRetention, 1 / DECAY) - 1);
  return Math.min(Math.max(Math.round(i), 1), maxInterval);
}

// Apply a rating to a card and return the next card state.
export function rate(card: CardState, rating: Rating, params: FSRSParams = DEFAULT_PARAMS, now = Date.now()): CardState {
  const w = params.weights;
  let { stability, difficulty, reps, lapses, lastReview, state } = card;

  if (state === 'new' || lastReview === null) {
    stability = initStability(w, rating);
    difficulty = initDifficulty(w, rating);
    if (rating === 1) {
      state = 'learning';
      lapses += 1;
    } else if (rating === 4) {
      state = 'review';
    } else {
      state = 'learning';
    }
  } else {
    const elapsed = elapsedDays(now, lastReview);
    const r = forgettingCurve(elapsed, stability);
    difficulty = nextDifficulty(w, difficulty, rating);
    if (rating === 1) {
      stability = nextForgetStability(w, difficulty, stability, r);
      lapses += 1;
      state = 'relearning';
    } else {
      stability = nextRecallStability(w, difficulty, stability, r, rating);
      state = 'review';
    }
  }

  const intervalDays = nextInterval(stability, params.requestRetention, params.maximumInterval);
  return {
    stability,
    difficulty,
    reps: reps + 1,
    lapses,
    lastReview: now,
    state,
    due: now + intervalDays * 86_400_000,
  };
}

export function isDue(card: CardState, now = Date.now()): boolean {
  return card.due <= now;
}
