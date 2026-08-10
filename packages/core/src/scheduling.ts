/**
 * FSRS wrapper. Spaced repetition is solved; inventing a scheduler is the most
 * reliable way to spend three months not learning Mandarin (docs/design.md §2.3).
 *
 * This module owns every conversion between our serialised state and ts-fsrs's
 * `Date`-based card, so nothing else in the codebase needs to know ts-fsrs exists.
 */

import {
  createEmptyCard,
  fsrs,
  generatorParameters,
  Rating,
  State,
  type Card as FsrsCard,
  type FSRS,
  // ts-fsrs narrows its own `Grade` to Rating minus Manual — `next` will not accept
  // a bare Rating. Aliased because we export a `Grade` of our own.
  type Grade as FsrsGrade,
} from 'ts-fsrs';
import type { Card, FsrsState, Grade, Modality } from './types.ts';
import { MS_PER_DAY } from './types.ts';

const GRADE_TO_RATING: Record<Grade, FsrsGrade> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
};

/**
 * Fuzz is disabled. It exists to stop large shared decks from clumping reviews on
 * the same day; with one user and a few thousand cards it only makes the scheduler
 * non-deterministic, which makes it far harder to test and reason about.
 */
let scheduler: FSRS | null = null;
function sched(): FSRS {
  scheduler ??= fsrs(generatorParameters({ enable_fuzz: false }));
  return scheduler;
}

/** Override the FSRS parameters — used once the review log is large enough to optimise. */
export function configure(w?: number[], requestRetention = 0.9): void {
  scheduler = fsrs(
    generatorParameters({
      enable_fuzz: false,
      request_retention: requestRetention,
      ...(w ? { w } : {}),
    }),
  );
}

function toFsrs(s: FsrsState): FsrsCard {
  return {
    due: new Date(s.due),
    stability: s.stability,
    difficulty: s.difficulty,
    elapsed_days: s.elapsed_days,
    scheduled_days: s.scheduled_days,
    reps: s.reps,
    lapses: s.lapses,
    state: s.state as State,
    ...(s.last_review ? { last_review: new Date(s.last_review) } : {}),
  } as FsrsCard;
}

function fromFsrs(c: FsrsCard): FsrsState {
  return {
    due: c.due.toISOString(),
    stability: c.stability,
    difficulty: c.difficulty,
    elapsed_days: c.elapsed_days,
    scheduled_days: c.scheduled_days,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state as 0 | 1 | 2 | 3,
    ...(c.last_review ? { last_review: c.last_review.toISOString() } : {}),
  };
}

/** A card that has never been shown. `introducedAt` stays null until First Exposure. */
export function newCard(conceptId: number, modality: Modality, now: Date): Card {
  const empty = fromFsrs(createEmptyCard(now));
  return {
    conceptId,
    modality,
    fsrs: empty,
    dueAt: new Date(empty.due).getTime(),
    introducedAt: null,
  };
}

export interface ReviewResult {
  card: Card;
  intervalMs: number;
  /** Predicted probability of recall at the moment it comes due again. */
  retentionAtDue: number;
}

/** Apply a grade. Pure: returns a new card, never mutates the input. */
export function review(card: Card, grade: Grade, now: Date): ReviewResult {
  const { card: next } = sched().next(toFsrs(card.fsrs), now, GRADE_TO_RATING[grade]);
  const state = fromFsrs(next);
  const dueAt = new Date(state.due).getTime();
  return {
    card: {
      ...card,
      fsrs: state,
      dueAt,
      introducedAt: card.introducedAt ?? now.getTime(),
    },
    intervalMs: dueAt - now.getTime(),
    retentionAtDue: retrievability(state, new Date(dueAt)),
  };
}

/** Probability of recall at `at`. 1 for a card that has never been reviewed. */
export function retrievability(state: FsrsState, at: Date): number {
  if (state.state === State.New || state.reps === 0) return 0;
  const r = sched().get_retrievability(toFsrs(state), at, false);
  return typeof r === 'number' ? r : 0;
}

/** Probability of recall `days` from `from`. The basis of the HSK metric (§4). */
export function projectedRetrievability(state: FsrsState, from: Date, days: number): number {
  return retrievability(state, new Date(from.getTime() + days * MS_PER_DAY));
}

/**
 * Is this concept "known" for the purposes of comprehensible-input selection?
 *
 * Deliberately generous: an utterance is usable if you have *met* every other word
 * in it, not if you have mastered them. A stricter bar starves the queue — early on
 * almost nothing would qualify, and you would never hear a full sentence.
 */
export function isKnown(card: Card | undefined): boolean {
  return !!card && card.introducedAt !== null;
}

/** The stricter bar, used for the HSK coverage estimate rather than for selection. */
export function isRetained(card: Card, now: Date, threshold = 0.85, horizonDays = 14): boolean {
  if (card.introducedAt === null) return false;
  return projectedRetrievability(card.fsrs, now, horizonDays) >= threshold;
}

export { Rating, State };
