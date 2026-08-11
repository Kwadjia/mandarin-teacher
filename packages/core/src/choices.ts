/**
 * Distractors for multiple-choice listening.
 *
 * Listen & Commit asks "did you get it?" and believes the answer. That is cheap to
 * build and weak to learn from: there is no way to be wrong, hindsight makes every
 * revealed answer feel familiar, and the log fills with a self-report that the grader
 * then has to discount by replay count. Meaning Match, Which One and Cloze all ask a
 * question with a wrong answer available.
 *
 * Which makes the distractors the entire exercise. Four random words are a vocabulary
 * test — the target is obvious from meaning alone and the audio can be ignored. The
 * options have to be near enough that the only way through is to have actually heard
 * the sounds and the tones:
 *
 *   bǎo / bào    same syllable, different tone — the best distractor there is, and
 *                exactly the confusion the speaking data shows is real
 *   gǒu / gāo    same initial, different vowel
 *   chē / qù     different initial, and the retroflex/palatal pair English speakers
 *                collapse
 *
 * Everything is drawn from words already introduced, so a wrong answer means "misheard"
 * and never "never met it".
 */

import type { Concept } from './types.ts';

const TONE_LETTERS: Record<string, string> = {
  ā: 'a', á: 'a', ǎ: 'a', à: 'a',
  ē: 'e', é: 'e', ě: 'e', è: 'e',
  ī: 'i', í: 'i', ǐ: 'i', ì: 'i',
  ō: 'o', ó: 'o', ǒ: 'o', ò: 'o',
  ū: 'u', ú: 'u', ǔ: 'u', ù: 'u',
  ǖ: 'v', ǘ: 'v', ǚ: 'v', ǜ: 'v', ü: 'v',
};

/** Pinyin with tones and spacing removed: `bǎobao` → `baobao`. */
export function bareSyllables(pinyin: string): string {
  return [...pinyin.toLowerCase()]
    .map((c) => TONE_LETTERS[c] ?? c)
    .filter((c) => /[a-z]/.test(c))
    .join('');
}

// Longest first, so zh/ch/sh are not read as z/c/s.
const INITIALS = ['zh', 'ch', 'sh', 'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k',
  'h', 'j', 'q', 'x', 'r', 'z', 'c', 's', 'y', 'w'];

function split(base: string): { initial: string; final: string } {
  for (const i of INITIALS) {
    if (base.startsWith(i)) return { initial: i, final: base.slice(i.length) };
  }
  return { initial: '', final: base };
}

/**
 * How confusable two words are by ear. Higher is a better distractor.
 *
 * Identical bare pinyin scores highest: the words differ only in tone, so the choice
 * cannot be made without hearing the tone. That is the whole point of the exercise
 * against a learner whose measured weakness is precisely tones.
 */
export function confusability(a: Concept, b: Concept): number {
  const x = bareSyllables(a.pinyin);
  const y = bareSyllables(b.pinyin);
  if (!x || !y || x === y) return x && x === y ? 100 : 0;

  const sx = split(x);
  const sy = split(y);
  let score = 0;
  if (sx.final === sy.final) score += 50; // rhymes — differs only at the front
  if (sx.initial === sy.initial) score += 30;
  if (x.length === y.length) score += 10;
  // A shared opening sound still costs a beat to tell apart.
  if (x[0] === y[0]) score += 5;
  return score;
}

export interface ChoiceInput {
  target: Concept;
  /** Only words already introduced — a wrong answer must mean misheard, not unmet. */
  pool: Concept[];
  /**
   * Concepts that must never be offered, beyond the target.
   *
   * In practice: every other word in the sentence being played. Offering one makes the
   * question unanswerable — 狗也累了 with 狗 among the options has two words that were
   * genuinely in the audio, and marking 狗 wrong is simply incorrect.
   */
  exclude?: ReadonlySet<number>;
  count?: number;
  /** Deterministic shuffling, so a test can assert on the result. */
  random?: () => number;
}

/**
 * `count` distractors, hardest first, then shuffled with the target by `choices`.
 *
 * Not purely the top-scoring options: taking the four most similar words every time
 * makes the exercise a narrow tone drill on the same handful of pairs. One easier
 * option keeps a wrong answer informative — missing an obvious one says something
 * different from missing a near-minimal pair.
 */
export function distractors({
  target,
  pool,
  exclude,
  count = 3,
  random = Math.random,
}: ChoiceInput): Concept[] {
  const candidates = pool
    .filter(
      (c) => c.id !== target.id && c.glossEn !== target.glossEn && !exclude?.has(c.id),
    )
    .map((c) => ({ c, score: confusability(target, c) }))
    .sort((a, b) => b.score - a.score);

  if (candidates.length <= count) return candidates.map((x) => x.c);

  const hard = candidates.slice(0, Math.max(1, count - 1)).map((x) => x.c);
  // The remainder comes from anywhere else in the pool, so the option set is not always
  // four variations of one sound.
  const rest = candidates.slice(Math.max(1, count - 1)).map((x) => x.c);
  const picked = [...hard];
  while (picked.length < count && rest.length) {
    picked.push(rest.splice(Math.floor(random() * rest.length), 1)[0]!);
  }
  return picked;
}

/** The target and its distractors in random order. */
export function choices(input: ChoiceInput): Concept[] {
  const random = input.random ?? Math.random;
  const all = [input.target, ...distractors(input)];
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [all[i], all[j]] = [all[j]!, all[i]!];
  }
  return all;
}
