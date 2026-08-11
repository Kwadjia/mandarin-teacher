import { describe, expect, it } from 'vitest';
import { bareSyllables, choices, confusability, distractors, type Concept } from '../src/index.ts';

const word = (id: number, headword: string, pinyin: string, glossEn: string): Concept => ({
  id, kind: 'word', headword, headwordTrad: headword, pinyin, glossEn,
  hskLevel: 1, freqRank: id, source: 'core',
});

const BAO3 = word(1, '宝', 'bǎo', 'treasure');
const BAO4 = word(2, '抱', 'bào', 'to hold');
const GAO1 = word(3, '高', 'gāo', 'tall');
const GOU3 = word(4, '狗', 'gǒu', 'dog');
const CHE1 = word(5, '车', 'chē', 'car');
const YIYUAN = word(6, '医院', 'yīyuàn', 'hospital');

describe('bareSyllables', () => {
  it('strips tones and spacing', () => {
    expect(bareSyllables('bǎobao')).toBe('baobao');
    expect(bareSyllables('shuìjiào')).toBe('shuijiao');
    expect(bareSyllables("nǚ'ér")).toBe('nver');
  });
});

describe('confusability', () => {
  /**
   * The best distractor there is: the words differ only in tone, so the choice cannot
   * be made without hearing the tone. Which is the exercise's entire purpose against a
   * learner whose measured weakness is tones — bǎo came back as bào ten times.
   */
  it('scores a tone-only difference highest', () => {
    expect(confusability(BAO3, BAO4)).toBe(100);
    expect(confusability(BAO3, GAO1)).toBeLessThan(100);
  });

  it('scores a shared rhyme above a shared opening', () => {
    // gāo/bǎo share the -ao ending; gǒu/gāo share only the g-.
    expect(confusability(GAO1, BAO3)).toBeGreaterThan(confusability(GAO1, GOU3));
  });

  it('scores an unrelated word low', () => {
    expect(confusability(BAO3, YIYUAN)).toBeLessThan(confusability(BAO3, GAO1));
  });

  it('is symmetric', () => {
    expect(confusability(GOU3, GAO1)).toBe(confusability(GAO1, GOU3));
  });
});

describe('distractors', () => {
  const pool = [BAO3, BAO4, GAO1, GOU3, CHE1, YIYUAN];
  const fixed = () => 0; // deterministic

  it('never offers the target itself', () => {
    const d = distractors({ target: BAO3, pool, random: fixed });
    expect(d.map((c) => c.id)).not.toContain(BAO3.id);
  });

  it('leads with the most confusable option', () => {
    expect(distractors({ target: BAO3, pool, random: fixed })[0]!.id).toBe(BAO4.id);
  });

  it('returns the requested number when the pool allows', () => {
    expect(distractors({ target: BAO3, pool, count: 3, random: fixed })).toHaveLength(3);
  });

  it('copes with a pool too small to fill the options', () => {
    const d = distractors({ target: BAO3, pool: [BAO3, BAO4], count: 3, random: fixed });
    expect(d).toHaveLength(1);
  });

  // Two words meaning the same thing make an unanswerable question.
  it('never offers an option with the same meaning as the target', () => {
    const twin = word(7, '寶', 'bǎo', 'treasure');
    const d = distractors({ target: BAO3, pool: [...pool, twin], random: fixed });
    expect(d.map((c) => c.glossEn)).not.toContain('treasure');
  });

  /**
   * The other words in the sentence being played must never appear as options.
   * 狗也累了 offered 狗 alongside the target 累 — both were genuinely in the audio, so
   * marking 狗 wrong was simply incorrect, and the question had two right answers.
   */
  it('never offers an excluded word', () => {
    const d = distractors({
      target: BAO3,
      pool,
      exclude: new Set([BAO4.id, GAO1.id]),
      random: fixed,
    });
    const ids = d.map((c) => c.id);
    expect(ids).not.toContain(BAO4.id);
    expect(ids).not.toContain(GAO1.id);
  });
});

describe('choices', () => {
  const pool = [BAO3, BAO4, GAO1, GOU3, CHE1, YIYUAN];

  it('includes the target', () => {
    const c = choices({ target: BAO3, pool, random: () => 0 });
    expect(c.map((x) => x.id)).toContain(BAO3.id);
  });

  it('returns one more than the distractor count', () => {
    expect(choices({ target: BAO3, pool, count: 3, random: () => 0 })).toHaveLength(4);
  });

  // If the answer always sat in the same slot the exercise would test nothing.
  it('does not always place the target in the same position', () => {
    const positions = new Set<number>();
    for (let seed = 0; seed < 12; seed++) {
      let n = seed;
      const rng = () => ((n = (n * 9301 + 49297) % 233280) / 233280);
      positions.add(choices({ target: BAO3, pool, random: rng }).findIndex((x) => x.id === BAO3.id));
    }
    expect(positions.size).toBeGreaterThan(1);
  });
});
