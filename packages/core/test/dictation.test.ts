import { describe, expect, it } from 'vitest';
import { checkDictation, parseAnswer, tonePerformance } from '../src/index.ts';

describe('parseAnswer', () => {
  // Spacing and notation are not the skill. Rejecting an answer over a missing space
  // would be teaching typing.
  it('accepts the ways a person actually types', () => {
    const want = ['ni3', 'hao3'];
    expect(parseAnswer('ni3 hao3')).toEqual(want);
    expect(parseAnswer('ni3hao3')).toEqual(want);
    expect(parseAnswer('NI3  HAO3')).toEqual(want);
    expect(parseAnswer(' ni3 hao3 ')).toEqual(want);
  });

  it('accepts tone marks as well as numbers', () => {
    expect(parseAnswer('nǐ hǎo')).toEqual(['ni3', 'hao3']);
  });

  /**
   * The digit belongs at the end of the syllable, not on the marked vowel, so bǎobao
   * has to become bao3 bao and not baobao3 — which is also what lets a word-grouped
   * answer split into syllables at all.
   */
  it('converts word-grouped diacritics into separate syllables', () => {
    expect(parseAnswer('bǎobao shuìjiào le')).toEqual(['bao3', 'bao5', 'shui4', 'jiao4', 'le5']);
    expect(parseAnswer('xiǎng')).toEqual(['xiang3']); // -ng belongs to the syllable
  });

  /**
   * An unmarked syllable means different things in the two notations: writing numbers
   * and omitting one is not answering, while omitting a diacritic is how neutral tone
   * is spelt. Marking correct pinyin wrong is the one failure this exercise cannot
   * afford.
   */
  it('reads an unmarked syllable as neutral only in diacritic notation', () => {
    expect(parseAnswer('bǎobao')).toEqual(['bao3', 'bao5']);
    expect(parseAnswer('bao3 bao')).toEqual(['bao3', 'bao']);
  });

  it('folds ü and v together', () => {
    expect(parseAnswer('nv3')).toEqual(['nv3']);
    expect(parseAnswer('nü3')).toEqual(['nv3']);
  });

  it('ignores apostrophes and punctuation', () => {
    expect(parseAnswer("xi1'an1")).toEqual(['xi1', 'an1']);
    expect(parseAnswer('ni3 hao3!')).toEqual(['ni3', 'hao3']);
  });

  it('returns nothing for an empty answer', () => {
    expect(parseAnswer('')).toEqual([]);
    expect(parseAnswer('   ')).toEqual([]);
  });
});

describe('checkDictation', () => {
  const expected = ['bao3', 'bao5', 'shui4', 'jiao4', 'le5'];

  it('accepts a perfect answer', () => {
    const r = checkDictation(expected, 'bao3 bao5 shui4 jiao4 le5');
    expect(r.correctSyllables).toBe(5);
    expect(r.toneErrors).toBe(0);
    expect(r.syllables.every((s) => s.verdict === 'correct')).toBe(true);
  });

  // The whole point of the exercise: right sound, wrong tone is its own category.
  it('separates a tone error from a wrong syllable', () => {
    const r = checkDictation(expected, 'bao3 bao5 shui4 jiao1 le5');
    expect(r.toneErrors).toBe(1);
    expect(r.correctSyllables).toBe(4);
    expect(r.syllables[3]).toMatchObject({ verdict: 'tone', expected: 'jiao4', given: 'jiao1' });

    const wrong = checkDictation(expected, 'bao3 bao5 shui4 xiao4 le5');
    expect(wrong.toneErrors).toBe(0);
    expect(wrong.syllables[3]!.verdict).toBe('wrong');
  });

  /**
   * Silence about the tone is exactly what is being tested, so an untoned syllable
   * cannot quietly pass as neutral.
   */
  it('does not let a missing tone pass as neutral', () => {
    const r = checkDictation(['le5'], 'le');
    expect(r.syllables[0]!.verdict).toBe('tone');
    expect(r.correctSyllables).toBe(0);
  });

  /**
   * A dropped syllable would otherwise shift everything after it and report a mostly
   * correct sentence as entirely wrong — the failure that made the speaking scorer
   * useless before it aligned.
   */
  it('survives a dropped syllable without cascading', () => {
    const r = checkDictation(expected, 'bao3 bao5 jiao4 le5');
    expect(r.syllables[2]).toMatchObject({ expected: 'shui4', verdict: 'missing' });
    expect(r.correctSyllables).toBe(4);
  });

  it('survives an inserted syllable', () => {
    const r = checkDictation(expected, 'bao3 bao5 shui4 hen3 jiao4 le5');
    expect(r.correctSyllables).toBe(5);
    expect(r.extra).toBe(1);
  });

  it('marks everything missing for an empty answer', () => {
    const r = checkDictation(expected, '');
    expect(r.correctSyllables).toBe(0);
    expect(r.syllables.every((s) => s.verdict === 'missing')).toBe(true);
  });

  it('accepts an unspaced answer', () => {
    expect(checkDictation(expected, 'bao3bao5shui4jiao4le5').correctSyllables).toBe(5);
  });
});

describe('tonePerformance', () => {
  /**
   * "Bad at tones" is not actionable. "Third tone is being heard as fourth" is, and it
   * is the thing 31 reps of tone ID at chance never revealed.
   */
  it('reports which tone is wrong and what it was heard as', () => {
    const r = tonePerformance([
      { expected: 'bao3', given: 'bao4', verdict: 'tone' },
      { expected: 'hao3', given: 'hao4', verdict: 'tone' },
      { expected: 'ma1', given: 'ma1', verdict: 'correct' },
      { expected: 'ni3', given: 'ni3', verdict: 'correct' },
    ]);
    const third = r.find((x) => x.tone === 3)!;
    expect(third).toMatchObject({ total: 3, correct: 1 });
    expect(third.heardAs[4]).toBe(2);
  });

  // A wrong syllable says nothing about tone perception, so it must not be counted.
  it('ignores syllables whose sound was wrong', () => {
    const r = tonePerformance([{ expected: 'bao3', given: 'gao1', verdict: 'wrong' }]);
    expect(r).toEqual([]);
  });
});
