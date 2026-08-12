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
 * Introduced cards ordered weakest first — weakest meaning *least durable*.
 *
 * Ordering by retrievability was wrong, and wrong in a way that hid itself. It measures
 * "would this be recalled right now", which is near 1.0 for anything just studied — so
 * every word learned today sorted to the bottom and was never offered. A quiz drawn
 * from the weakest ten served only day-one vocabulary, and the twelve new words of the
 * day never appeared at all.
 *
 * Stability is the right axis: how long the memory would survive. It is low for a word
 * met an hour ago and low for one that keeps being forgotten, which are exactly the two
 * groups worth drilling. Retrievability then breaks ties, so between two equally fragile
 * words the one closer to being lost comes first.
 */
export function practiceQueue({ cards, modality, now, seen }: PracticeInput): Card[] {
  const eligible = cards.filter(
    (c) => c.modality === modality && c.introducedAt !== null && !seen?.has(c.conceptId),
  );
  return eligible.sort((a, b) => {
    const byStability = (a.fsrs.stability ?? 0) - (b.fsrs.stability ?? 0);
    if (Math.abs(byStability) > 0.01) return byStability;
    return retrievability(a.fsrs, now) - retrievability(b.fsrs, now);
  });
}

/**
 * One card to quiz on, drawn from the whole introduced set with a bias toward fragile
 * words.
 *
 * A hard "weakest ten" window concentrates every question on a handful of words: 25
 * questions produced eight distinct targets, one of them seven times. Weighted sampling
 * keeps the bias — a fragile word is several times likelier than a solid one — while
 * leaving every known word reachable, which is what makes a session feel like it covers
 * what has been learned rather than looping.
 */
export function sampleForQuiz(
  cards: Card[],
  modality: Modality,
  random: () => number = Math.random,
): Card | null {
  const eligible = cards.filter((c) => c.modality === modality && c.introducedAt !== null);
  if (!eligible.length) return null;

  // 1/(stability + 1): a brand-new word is worth about four of a fortnight-old one,
  // and nothing ever drops to zero.
  const weights = eligible.map((c) => 1 / ((c.fsrs.stability ?? 0) + 1));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = random() * total;
  for (let i = 0; i < eligible.length; i++) {
    r -= weights[i]!;
    if (r <= 0) return eligible[i]!;
  }
  return eligible[eligible.length - 1]!;
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
