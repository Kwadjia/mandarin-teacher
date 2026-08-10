/**
 * Practice: unlimited drilling of what you already know, without touching the schedule.
 *
 * There are two walls in a session and they are different problems. The first is the
 * daily cap on *new* vocabulary, which exists on purpose — twelve unfamiliar words is
 * already a lot to carry into tomorrow, and lifting it just moves the debt. The second
 * is running out of *due reviews*, which is not a reason to stop at all: there are
 * hundreds of known words and an hour of appetite.
 *
 * The old "Keep learning" button conflated them by raising the new-word cap, which
 * answered the second wall by breaking the first.
 *
 * The scheduling rule is what makes this safe to do for an hour:
 *
 *   answered correctly  →  nothing changes. Recalling a word early is not evidence you
 *                          would still have it at the due date, and crediting it would
 *                          push the interval out on no evidence — the classic way an
 *                          SRS is destroyed by enthusiasm.
 *   answered wrong      →  the card moves. Failing *is* evidence, whenever it happens,
 *                          and a word you have just forgotten should not sit waiting.
 *
 * The asymmetry is the point: early success proves nothing, early failure proves
 * something.
 */

import { retrievability } from './scheduling.ts';
import type { Card, Grade, Modality } from './types.ts';

/**
 * New words per day. One number, in one place — /api/next defaulted to 20 while
 * /api/plan defaulted to 15, so the plan and the drill disagreed about when the wall
 * arrived.
 *
 * Twelve because that is what was actually sustainable in use, and because the cap is
 * about tomorrow rather than today: every new word is a review debt that comes due for
 * weeks. Practice is the release valve for wanting to do more, not a higher cap.
 */
export const NEW_WORDS_PER_DAY = 12;

export interface PracticeInput {
  cards: Card[];
  modality: Modality;
  now: Date;
  /** Concept ids already served this practice run, so it cycles rather than repeats. */
  seen?: Set<number>;
}

/**
 * Introduced cards ordered weakest first.
 *
 * Weakest by predicted recall rather than by due date: in practice everything is
 * "early", so due dates say nothing useful, while retrievability points straight at
 * the words about to be forgotten. Drilling those is the best use of an extra hour.
 */
export function practiceQueue({ cards, modality, now, seen }: PracticeInput): Card[] {
  const eligible = cards.filter(
    (c) => c.modality === modality && c.introducedAt !== null && !seen?.has(c.conceptId),
  );
  return eligible.sort(
    (a, b) => retrievability(a.fsrs, now) - retrievability(b.fsrs, now),
  );
}

/**
 * Whether a practice answer should move the card.
 *
 * `wasDue` matters: a card that was genuinely due is a real review even if it was
 * reached through the practice screen, so it schedules normally. Only answers on cards
 * reached ahead of time get the asymmetric treatment.
 */
export function shouldReschedule(grade: Grade, wasDue: boolean): boolean {
  return wasDue || grade === 'again';
}
