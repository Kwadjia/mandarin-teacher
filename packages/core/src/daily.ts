/**
 * The daily habit layer: streak, points, and today's target.
 *
 * The original brief said ability, not gamification, and that instinct was right about
 * one thing — a number that rewards clicking is worse than no number, because it can be
 * satisfied without learning anything. It was wrong about the rest. The binding
 * constraint on this project is *days used*, not reps per day: 122 reps happened in a
 * single sitting, on one day. Nothing here needs to make him work harder in a session.
 * It needs to make tomorrow happen.
 *
 * So the rules are built to be honest rather than flattering:
 *
 *   - Points come from reps that moved a card, weighted by what the rep cost. Attempting
 *     something hard and failing earns more than breezing a review, because the
 *     alternative teaches avoidance of exactly the material worth practising.
 *   - The daily target is derived from the schedule — what is genuinely due — not a
 *     round number. Some days that is four minutes, and it should say so.
 *   - The streak forgives a missed day. A newborn is arriving; a counter that punishes
 *     one bad night gets abandoned in the first week, and then it is worse than nothing
 *     because the loss itself becomes a reason to stop.
 */

import type { Grade, Modality } from './types.ts';

/** Reps below this do not count as a day — enough to be real, low enough to be daily. */
export const DAY_MINIMUM_REPS = 8;

export interface RepPoints {
  modality: Modality;
  /** A first exposure costs more attention than a repeat. */
  isNew: boolean;
  grade: Grade;
}

/**
 * Points for one rep.
 *
 * Effort is paid first and success is a bonus, so a hard word is never worth avoiding.
 * Speaking pays more than listening because producing is harder than recognising — not
 * because it matters more; listening is still the priority, and it appears first in the
 * plan for that reason.
 */
export function repPoints({ modality, isNew, grade }: RepPoints): number {
  const base = isNew ? 15 : modality === 'speak' ? 12 : 8;
  const bonus = grade === 'easy' ? 6 : grade === 'good' ? 4 : grade === 'hard' ? 2 : 1;
  return base + bonus;
}

/** Points needed to reach a given level. Deliberately gentle early, then linear. */
export function levelFor(points: number): { level: number; into: number; span: number } {
  let level = 1;
  let span = 150;
  let remaining = points;
  while (remaining >= span) {
    remaining -= span;
    level++;
    span = Math.round(span * 1.15);
  }
  return { level, into: remaining, span };
}

export interface StreakInput {
  /** Local dates, `YYYY-MM-DD`, on which at least DAY_MINIMUM_REPS reps happened. */
  activeDays: Set<string>;
  today: string;
  /** Missed days forgiven per seven days of streak. One newborn's worth. */
  gracePerWeek?: number;
}

export interface StreakReport {
  days: number;
  /** True once today's minimum is met, so the UI can say "safe" rather than "at risk". */
  todayDone: boolean;
  /** Forgiven misses inside the current streak. */
  graceUsed: number;
}

const shift = (iso: string, days: number): string => {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d!));
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
};

/**
 * Consecutive active days ending today, forgiving the occasional miss.
 *
 * Today never breaks a streak — the day is not over. Walking back starts at yesterday
 * when today is still empty, so opening the app in the morning does not show a streak
 * already lost.
 */
export function computeStreak({ activeDays, today, gracePerWeek = 1 }: StreakInput): StreakReport {
  const todayDone = activeDays.has(today);
  let cursor = todayDone ? today : shift(today, -1);
  let days = 0;
  let graceUsed = 0;
  // Forgiveness is provisional until an earlier active day proves the streak continued
  // through it. Counting it immediately reported grace spent on the empty days *before*
  // the streak began — a three-day streak claimed to have used a life it never needed.
  let pending = 0;
  const skipped: string[] = [];

  // A generous bound; nobody's streak predates the project.
  for (let i = 0; i < 3650; i++) {
    if (activeDays.has(cursor)) {
      days++;
      graceUsed += pending;
      pending = 0;
    } else {
      // Forgive only if no other forgiven day sits within the preceding week, so grace
      // accrues at roughly one per seven days rather than all at once.
      const recent = skipped.filter((s) => s > shift(cursor, -7)).length;
      if (recent >= gracePerWeek || days === 0) break;
      skipped.push(cursor);
      pending++;
    }
    cursor = shift(cursor, -1);
  }

  return { days, todayDone, graceUsed };
}

export interface DailyTarget {
  /** The whole day's work: what has been done plus what the schedule still wants. */
  reps: number;
  done: number;
  /** Enough reps for the day to count toward the streak. */
  met: boolean;
  /** Nothing left in the plan. */
  planCleared: boolean;
}

/**
 * Today's target, taken from the schedule rather than invented.
 *
 * The total is done-plus-remaining, not remaining alone: 122 reps against a target of
 * 19 reads as a broken bar, when what actually happened is a finished day.
 *
 * `met` and `planCleared` are deliberately different questions. Clearing a forty-card
 * backlog is not a fair condition for the day to count — on a bad night it guarantees
 * the streak breaks, which is how these counters get abandoned. Showing up properly is
 * enough to keep the day; finishing the plan is the separate, visible goal.
 */
export function dailyTarget(plannedRemaining: number, doneToday: number): DailyTarget {
  return {
    reps: Math.max(doneToday + plannedRemaining, DAY_MINIMUM_REPS),
    done: doneToday,
    met: doneToday >= DAY_MINIMUM_REPS,
    planCleared: plannedRemaining === 0,
  };
}
