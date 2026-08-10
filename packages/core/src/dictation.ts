/**
 * Pinyin dictation: hear a sentence, type it back with tone numbers.
 *
 * This is the exercise the design named for tones (docs/design.md §7, phase 2) and the
 * measurements have been asking for ever since: tone identification has sat at 7/31 —
 * chance for a four-way choice — across every session, and nothing in the app trains
 * it. Listen & Commit lets a learner say "got it" on the gist while the tones wash
 * past; Shadow measures production, not perception. Typing `bao3 bao5 shui4 jiao4 le5`
 * cannot be satisfied without hearing every tone individually.
 *
 * It also grades deterministically, with no model and no API call, which is what makes
 * it affordable to run on every rep forever.
 *
 * Everything here is pure comparison. The parsing is deliberately generous about how
 * the answer is typed and utterly strict about what it means: spacing and notation are
 * not the skill, tones are.
 */

import type { Grade } from './types.ts';

/** One syllable of an answer, checked. */
export interface SyllableResult {
  /** Expected, tone-numbered: `bao3`. */
  expected: string;
  /** What was typed in this position, or null if nothing was. */
  given: string | null;
  /** Right sound, right tone. */
  correct: boolean;
  verdict: 'correct' | 'tone' | 'wrong' | 'missing';
}

export interface DictationCheck {
  syllables: SyllableResult[];
  totalSyllables: number;
  correctSyllables: number;
  /** Right syllable, wrong tone — the number this exercise exists to produce. */
  toneErrors: number;
  /** Syllables typed beyond the length of the sentence. */
  extra: number;
}

const DIACRITIC_TONE: Record<string, number> = {
  '̄': 1, // macron  ā
  '́': 2, // acute   á
  '̌': 3, // caron   ǎ
  '̀': 4, // grave   à
};

/**
 * Normalise a typed answer into tone-numbered syllables.
 *
 * Accepts what a person actually types: `ni3 hao3`, `ni3hao3`, `NI3 HAO3`, `nǐ hǎo`,
 * `nv3` or `nü3`. Rejecting an answer over a missing space would be teaching typing.
 *
 * A syllable with no tone marked becomes tone 0, which never equals the expected 1–5
 * — including neutral, written 5. Silence about the tone is the thing being tested, so
 * it cannot be allowed to pass as neutral by default.
 */
export function parseAnswer(input: string): string[] {
  const VOWEL = /[aeiouv]/;
  let s = '';
  let pendingTone = 0;
  let inVowels = false;

  /**
   * A diacritic marks a vowel, but tone-numbered notation puts the digit at the end of
   * the syllable — after the whole vowel run and any final -n/-ng. Emitting it the
   * moment the vowels stop turns bǎobao into bao3bao rather than baobao3, which is
   * what then lets the token split cleanly into two syllables.
   */
  const flush = () => {
    if (pendingTone) {
      s += String(pendingTone);
      pendingTone = 0;
    }
    inVowels = false;
  };

  for (const raw of input.normalize('NFD')) {
    const tone = DIACRITIC_TONE[raw];
    if (tone) {
      pendingTone = tone;
      continue;
    }
    if (raw === '̈') {
      // Combining diaeresis: ǚ decomposes to u + ¨ + caron.
      if (s.endsWith('u')) s = s.slice(0, -1) + 'v';
      continue;
    }

    const ch = raw.toLowerCase() === 'ü' ? 'v' : raw.toLowerCase();

    if (/[a-z]/.test(ch)) {
      if (VOWEL.test(ch)) {
        inVowels = true;
      } else if (inVowels) {
        // A consonant after vowels usually ends the syllable — except -n and -ng,
        // which belong to it, so the digit waits for them.
        if (ch !== 'n' && ch !== 'g') flush();
      }
      s += ch;
    } else if (/\d/.test(ch)) {
      pendingTone = 0; // an explicit number wins over any pending mark
      inVowels = false;
      s += ch;
    } else if (/\s/.test(ch)) {
      flush();
      s += ' ';
    }
    // anything else — apostrophes, punctuation — is not part of the answer
  }
  flush();

  // Split on whitespace *and* after every tone digit, so `ni3hao3`, `ni3 hao3` and a
  // converted `bǎobao` all arrive as the same syllables.
  const tokens = s
    .split(/\s+/)
    .flatMap((t) => t.split(/(?<=\d)/))
    .map((t) => t.trim())
    .filter(Boolean);

  // What an unmarked syllable means depends on the notation. Writing numbers and
  // leaving one off is not answering; writing diacritics and leaving one off is how
  // neutral tone is spelt. Penalising `bǎobao` for its second syllable would be marking
  // correct pinyin wrong, which is the one failure this exercise cannot afford.
  const usedDigits = /\d/.test(input);
  const usedMarks = input.normalize('NFD').split('').some((c) => DIACRITIC_TONE[c]);
  if (usedMarks && !usedDigits) {
    return tokens.map((t) => (/\d$/.test(t) ? t : `${t}5`));
  }
  return tokens;
}

const baseOf = (syllable: string) => syllable.replace(/\d+$/, '');
const toneOf = (syllable: string) => {
  const m = syllable.match(/(\d)$/);
  return m ? Number(m[1]) : 0;
};

/**
 * Compare an answer against the expected syllables.
 *
 * Aligned on base syllables rather than compared position by position, because one
 * dropped syllable would otherwise shift everything after it and report a sentence the
 * learner mostly got right as entirely wrong — the same failure that made the speaking
 * scorer useless before it aligned (docs/design.md §2.12).
 */
export function checkDictation(expected: string[], answer: string): DictationCheck {
  const given = parseAnswer(answer);
  const eBase = expected.map(baseOf);
  const gBase = given.map(baseOf);

  // Levenshtein over base syllables, then walk the backtrace.
  const n = eBase.length;
  const m = gBase.length;
  const d: number[][] = Array.from({ length: n + 1 }, (_, i) =>
    Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      d[i]![j] = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + (eBase[i - 1] === gBase[j - 1] ? 0 : 1),
      );
    }
  }

  const pairs: (number | null)[] = new Array(n).fill(null);
  let extra = 0;
  let i = n;
  let j = m;
  while (i > 0) {
    if (j > 0 && d[i]![j] === d[i - 1]![j - 1]! + (eBase[i - 1] === gBase[j - 1] ? 0 : 1)) {
      pairs[i - 1] = j - 1;
      i--;
      j--;
    } else if (d[i]![j] === d[i - 1]![j]! + 1) {
      i--; // nothing typed for this syllable
    } else {
      j--;
      extra++; // typed a syllable the sentence does not have
    }
  }
  extra += j;

  const syllables: SyllableResult[] = expected.map((exp, k) => {
    const gi = pairs[k];
    if (gi === null || gi === undefined) {
      return { expected: exp, given: null, correct: false, verdict: 'missing' as const };
    }
    const got = given[gi]!;
    if (baseOf(got) !== baseOf(exp)) {
      return { expected: exp, given: got, correct: false, verdict: 'wrong' as const };
    }
    if (toneOf(got) !== toneOf(exp)) {
      return { expected: exp, given: got, correct: false, verdict: 'tone' as const };
    }
    return { expected: exp, given: got, correct: true, verdict: 'correct' as const };
  });

  return {
    syllables,
    totalSyllables: expected.length,
    correctSyllables: syllables.filter((s) => s.correct).length,
    toneErrors: syllables.filter((s) => s.verdict === 'tone').length,
    extra,
  };
}

/**
 * Per-tone accuracy across a set of checks — which tones are actually the problem.
 *
 * "Bad at tones" is not actionable; "third tone is heard as fourth" is. Only syllables
 * whose sound was right are counted, since a wrong syllable says nothing about tone
 * perception.
 */
export function tonePerformance(
  checks: { expected: string; given: string | null; verdict: SyllableResult['verdict'] }[],
): { tone: number; correct: number; total: number; heardAs: Record<number, number> }[] {
  const byTone = new Map<number, { correct: number; total: number; heardAs: Record<number, number> }>();
  for (const s of checks) {
    if (s.verdict !== 'correct' && s.verdict !== 'tone') continue;
    const tone = toneOf(s.expected);
    const bucket = byTone.get(tone) ?? { correct: 0, total: 0, heardAs: {} };
    bucket.total++;
    if (s.verdict === 'correct') bucket.correct++;
    else if (s.given) {
      const heard = toneOf(s.given);
      bucket.heardAs[heard] = (bucket.heardAs[heard] ?? 0) + 1;
    }
    byTone.set(tone, bucket);
  }
  return [...byTone.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([tone, b]) => ({ tone, ...b }));
}

/** Re-exported for symmetry with the other exercises; the rule lives in grading.ts. */
export type { Grade };
