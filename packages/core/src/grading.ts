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

export interface SpeakOutcome {
  /** Syllables whose character the recogniser matched. */
  correctSyllables: number;
  totalSyllables: number;
  /** Said correctly but with the wrong pitch shape. Whisper cannot see these. */
  toneErrors: number;
  /** Syllables a pitch contour could actually be measured for. */
  scoredSyllables: number;
  /** Replays of the native clip before speaking. */
  replays: number;
}

/**
 * Speaking, from measurements produced by pipeline/speech_score.py.
 *
 * Words first, tones second, and deliberately so. Saying the wrong word is a failure
 * of recall — the thing a scheduler exists to fix. A tone that drifts on the right
 * word is a motor skill that improves with reps, and demoting it to `again` would
 * bury the word in the queue for a problem more practice will not solve any faster.
 *
 * `toneErrors` is judged as a share of the syllables actually measured, never of the
 * whole sentence. Roughly 8% of syllables cannot be scored — too short, or unvoiced —
 * and counting those as passes would quietly inflate every grade.
 */
export function gradeSpeak(o: SpeakOutcome): Grade {
  if (o.totalSyllables === 0) return 'again';
  const said = o.correctSyllables / o.totalSyllables;

  // The word signal is measured by a recogniser that is reliable on native speech and
  // demonstrably shaky on a beginner's: across 34 real attempts it returned things like
  // "童谣不拔" for 换尿布吧, and half of them scored below the confidence it gives pink
  // noise. Attempts with no overlap at all are already refused upstream as unscorable,
  // so what reaches here is a genuine attempt measured imprecisely.
  //
  // Hence `again` needs half the sentence to be wrong, not a third. An unfair `again`
  // buries a word the learner may well have said correctly, and the log keeps it; an
  // over-generous `hard` costs one extra review. The asymmetry is not close.
  if (said < 0.5) return 'again';
  if (said < 1) return 'hard';

  // Every word right from here on; tones decide the rest.
  const toneRate = o.scoredSyllables > 0 ? o.toneErrors / o.scoredSyllables : 0;
  if (toneRate > 0.34) return 'hard';
  if (o.replays >= 2) return 'good';
  return toneRate === 0 && o.replays === 0 ? 'easy' : 'good';
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
