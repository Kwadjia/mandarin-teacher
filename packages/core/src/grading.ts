/**
 * Turning what happened into an FSRS grade.
 *
 * The important constraint is docs/design.md §2.9: a grade is only trustworthy if
 * the learner committed *before* the answer was revealed. `committedBeforeReveal`
 * is carried through to the event log so a future analysis can discard, or
 * down-weight, any rep that failed that condition.
 */

import type { Grade } from './types.ts';

export interface CommitOutcome {
  /** Did they say they understood it? */
  gotIt: boolean;
  /** Replays before committing. Needing the audio twice is not the same as knowing it. */
  replays: number;
  /** Audio-end → commitment. Null when not measurable. */
  latencyMs: number | null;
  committedBeforeReveal: boolean;
}

/** Below this, comprehension was automatic rather than reconstructed. */
export const FLUENT_MS = 2500;
/** Above this, they worked it out rather than recognised it. */
export const LABOURED_MS = 6000;

/**
 * Self-reported comprehension → grade.
 *
 * Replays are treated as evidence against the self-report, which is the point:
 * "I got it (on the third listen)" is a `hard`, not a `good`, and the learner
 * should not have to be honest enough to say so.
 */
export function gradeCommit(o: CommitOutcome): Grade {
  if (!o.gotIt) return 'again';
  if (o.replays >= 2) return 'hard';
  if (o.replays === 1) return o.latencyMs !== null && o.latencyMs > LABOURED_MS ? 'again' : 'hard';
  if (o.latencyMs !== null && o.latencyMs <= FLUENT_MS) return 'easy';
  if (o.latencyMs !== null && o.latencyMs > LABOURED_MS) return 'hard';
  return 'good';
}

export interface AutoOutcome {
  correct: boolean;
  replays: number;
  latencyMs: number | null;
}

/**
 * Objectively-graded exercises (Meaning Match, Cloze, Tone ID). No self-report to
 * discount, so correctness dominates and timing only separates good from easy.
 */
export function gradeAuto(o: AutoOutcome): Grade {
  if (!o.correct) return 'again';
  if (o.replays >= 2) return 'hard';
  if (o.latencyMs !== null && o.latencyMs <= FLUENT_MS && o.replays === 0) return 'easy';
  if (o.replays === 1) return 'hard';
  return 'good';
}

export interface DictationOutcome {
  correctSyllables: number;
  /** Right syllable, wrong tone. Counted separately — it is the interesting failure. */
  toneErrors: number;
  totalSyllables: number;
  replays: number;
}

/**
 * Partial credit. A dictation that got every syllable but one tone wrong is a very
 * different signal from one that got nothing, and collapsing both to "wrong" throws
 * away the most useful thing this exercise produces.
 */
export function gradeDictation(o: DictationOutcome): Grade {
  if (o.totalSyllables === 0) return 'again';
  const exact = o.correctSyllables / o.totalSyllables;
  const nearly = (o.correctSyllables + o.toneErrors) / o.totalSyllables;

  if (exact === 1) return o.replays === 0 ? 'easy' : 'good';
  if (exact >= 0.8) return 'good';
  if (nearly >= 0.8) return 'hard'; // segmentals fine, tones shaky
  return 'again';
}
