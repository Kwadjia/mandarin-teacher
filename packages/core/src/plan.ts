/**
 * What to do next, and roughly how long it will take.
 *
 * This exists because the event log showed the opposite of the stated priorities: 53
 * speaking reps against 25 listening ones, when listening is first and speaking second
 * (docs/design.md §1). A tab bar treats every activity as equally worth opening. An
 * ordered plan does not, and the ordering is the whole point.
 *
 * Two rules produce the order:
 *
 *   1. Modality priority — listening, then speaking. Speaking is gated on having heard
 *      the word anyway, so this is also the only order that can work.
 *   2. Within a modality, reviews before new material. A due card is knowledge actively
 *      decaying; an unlearned word is not going anywhere. Adding new words while
 *      reviews pile up is the classic way an SRS collapses under its own backlog.
 *
 * Deliberately not here: streaks, points, goals met. Ability, not gamification
 * (docs/design.md §2). The plan says what is worth doing, and stops.
 */

import type { Modality } from './types.ts';

export interface ModalityState {
  modality: Modality;
  /** Introduced cards whose due date has passed. */
  due: number;
  /** Eligible concepts not yet introduced — for speaking, only ones already heard. */
  newAvailable: number;
  introducedToday: number;
  /** Guard against bingeing, not a rule; the client can raise it for a session. */
  dailyCap: number;
}

export interface Block {
  kind: 'review' | 'new';
  modality: Modality;
  reps: number;
  /** Why this, now — shown to the learner rather than left implicit. */
  reason: string;
  /** Null when there is no measured pace for this activity yet. */
  estimateMs: number | null;
}

export interface PlanInput {
  states: ModalityState[];
  /**
   * Measured seconds per rep, keyed `${modality}:${kind}`. Taken from real gaps between
   * logged events rather than assumed — a made-up "about 10 minutes" is worse than no
   * estimate, because it will be wrong in a direction the learner cannot predict.
   */
  paceMs?: Map<string, number>;
}

/** Priority order from the brief. Reading and beyond are not built yet. */
const ORDER: Modality[] = ['listen', 'speak', 'read'];

const LABEL: Record<Modality, string> = {
  listen: 'Listening',
  speak: 'Speaking',
  read: 'Reading',
};

export function planSession({ states, paceMs }: PlanInput): Block[] {
  const blocks: Block[] = [];
  const pace = (m: Modality, k: 'review' | 'new') => paceMs?.get(`${m}:${k}`) ?? null;

  for (const modality of ORDER) {
    const s = states.find((x) => x.modality === modality);
    if (!s) continue;

    if (s.due > 0) {
      blocks.push({
        kind: 'review',
        modality,
        reps: s.due,
        reason:
          modality === 'listen'
            ? `${s.due} word${s.due === 1 ? '' : 's'} due — these are the ones actively fading`
            : `${s.due} due to say again`,
        estimateMs: mul(pace(modality, 'review'), s.due),
      });
    }

    const room = Math.max(0, s.dailyCap - s.introducedToday);
    const fresh = Math.min(room, s.newAvailable);
    if (fresh > 0) {
      blocks.push({
        kind: 'new',
        modality,
        reps: fresh,
        reason:
          modality === 'speak'
            ? `${fresh} word${fresh === 1 ? '' : 's'} you can hear but have never said`
            : `${fresh} new word${fresh === 1 ? '' : 's'} available today`,
        estimateMs: mul(pace(modality, 'new'), fresh),
      });
    }
  }

  return blocks;
}

const mul = (ms: number | null, n: number) => (ms === null ? null : Math.round(ms * n));

/** Total estimate, or null when nothing in the plan has a measured pace. */
export function planDuration(blocks: Block[]): number | null {
  const known = blocks.filter((b) => b.estimateMs !== null);
  return known.length ? known.reduce((a, b) => a + (b.estimateMs ?? 0), 0) : null;
}

export const modalityLabel = (m: Modality) => LABEL[m];

/**
 * Median gap between consecutive reps, in milliseconds.
 *
 * Median rather than mean because a session contains pauses — a phone call between two
 * reps would drag an average into uselessness. Gaps outside the plausible range are
 * dropped for the same reason: below a second is a double-submit, above five minutes is
 * someone having left.
 */
export function measurePace(gapsMs: number[]): number | null {
  const usable = gapsMs.filter((g) => g >= 1000 && g <= 300_000).sort((a, b) => a - b);
  if (usable.length < 3) return null;
  return usable[Math.floor(usable.length / 2)]!;
}
