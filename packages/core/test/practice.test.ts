import { describe, expect, it } from 'vitest';
import {
  MS_PER_DAY,
  newCard,
  practiceQueue,
  review,
  sampleForQuiz,
  shouldReschedule,
  type Card,
} from '../src/index.ts';

const T0 = new Date('2026-01-01T09:00:00.000Z');

/** Same generator the simulation uses — a toy LCG had too short a cycle to sample with. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}


/** A card drilled n times, so it has some stability to compare against. */
function drilled(conceptId: number, times: number): Card {
  let card = newCard(conceptId, 'listen', T0);
  for (let i = 0; i < times; i++) card = review(card, 'easy', new Date(card.dueAt)).card;
  return { ...card, introducedAt: T0.getTime() };
}

describe('practiceQueue', () => {
  it('offers only words already introduced', () => {
    const fresh = newCard(1, 'listen', T0); // introducedAt null
    const known = drilled(2, 2);
    const q = practiceQueue({ cards: [fresh, known], modality: 'listen', now: T0 });
    expect(q.map((c) => c.conceptId)).toEqual([2]);
  });

  it('never runs out while there is anything introduced', () => {
    const cards = [1, 2, 3].map((i) => drilled(i, 1));
    expect(practiceQueue({ cards, modality: 'listen', now: T0 })).toHaveLength(3);
  });

  /**
   * In practice everything is early, so due dates carry no information. Predicted
   * recall does, and it points at the words about to be forgotten — the best use of
   * an extra hour.
   */
  it('puts the weakest word first', () => {
    const solid = drilled(1, 6);
    const shaky = drilled(2, 1);
    const later = new Date(T0.getTime() + 30 * MS_PER_DAY);
    const q = practiceQueue({ cards: [solid, shaky], modality: 'listen', now: later });
    expect(q[0]!.conceptId).toBe(2);
  });

  it('skips what this run has already served, so it cycles', () => {
    const cards = [1, 2].map((i) => drilled(i, 1));
    const q = practiceQueue({ cards, modality: 'listen', now: T0, seen: new Set([1]) });
    expect(q.map((c) => c.conceptId)).toEqual([2]);
  });

  it('reads only the requested modality', () => {
    const listen = drilled(1, 1);
    const speak: Card = { ...drilled(2, 1), modality: 'speak' };
    const q = practiceQueue({ cards: [listen, speak], modality: 'speak', now: T0 });
    expect(q.map((c) => c.conceptId)).toEqual([2]);
  });

  it('returns nothing when nothing has been introduced', () => {
    expect(practiceQueue({ cards: [newCard(1, 'listen', T0)], modality: 'listen', now: T0 }))
      .toEqual([]);
  });
});

describe('shouldReschedule', () => {
  /**
   * The rule that makes an hour of practice safe. Recalling a word early is not
   * evidence it would have survived to the due date; crediting it would push the
   * interval out on no evidence, which is how enthusiasm destroys an SRS.
   */
  it('leaves the schedule alone when an early answer is correct', () => {
    expect(shouldReschedule('good', false)).toBe(false);
    expect(shouldReschedule('easy', false)).toBe(false);
    expect(shouldReschedule('hard', false)).toBe(false);
  });

  // Failing is evidence whenever it happens, and a word just forgotten should not wait.
  it('moves the card when an early answer is wrong', () => {
    expect(shouldReschedule('again', false)).toBe(true);
  });

  // Reaching a genuinely due card through the practice screen is still a real review.
  it('schedules normally for a card that was actually due', () => {
    for (const g of ['again', 'hard', 'good', 'easy'] as const) {
      expect(shouldReschedule(g, true)).toBe(true);
    }
  });
});

describe('practiceQueue ordering', () => {
  /**
   * The bug this replaced. Retrievability measures "would this be recalled right now",
   * which is near 1.0 for anything just studied — so every word learned today sorted to
   * the bottom and was never offered. Twelve new words appeared in none of 25 questions.
   */
  it('puts a word learned an hour ago ahead of one drilled for a fortnight', () => {
    const fresh = { ...drilled(1, 1), introducedAt: T0.getTime() };
    const solid = { ...drilled(2, 8), introducedAt: T0.getTime() };
    const q = practiceQueue({ cards: [solid, fresh], modality: 'listen', now: T0 });
    expect(q[0]!.conceptId).toBe(fresh.conceptId);
  });

  it('still surfaces a word that keeps being forgotten', () => {
    const forgotten = { ...newCard(3, 'listen', T0), introducedAt: T0.getTime() };
    const solid = { ...drilled(2, 8), introducedAt: T0.getTime() };
    const q = practiceQueue({ cards: [solid, forgotten], modality: 'listen', now: T0 });
    expect(q[0]!.conceptId).toBe(3);
  });
});

describe('sampleForQuiz', () => {
  /** Explicit stabilities, so this tests the sampler rather than FSRS's curve. */
  const withStability = (id: number, stability: number): Card => ({
    ...newCard(id, 'listen', T0),
    introducedAt: T0.getTime(),
    fsrs: { ...newCard(id, 'listen', T0).fsrs, stability },
  });
  // Six fragile (a day or two) and six settled (a fortnight) — the real spread in the
  // corpus after a week of use.
  const many = [
    ...Array.from({ length: 6 }, (_, i) => withStability(i + 1, 1 + i * 0.3)),
    ...Array.from({ length: 6 }, (_, i) => withStability(i + 7, 12 + i)),
  ];

  it('returns null when nothing is introduced', () => {
    expect(sampleForQuiz([newCard(1, 'listen', T0)], 'listen')).toBe(null);
  });

  /**
   * A hard weakest-ten window concentrated 25 questions onto 8 words, one of them seven
   * times, and never once offered a word learned that day. Every known word has to stay
   * reachable or the session loops.
   */
  it('can reach every introduced word', () => {
    const seen = new Set<number>();
    const rng = mulberry32(7);
    for (let i = 0; i < 2000; i++) seen.add(sampleForQuiz(many, 'listen', rng)!.conceptId);
    expect(seen.size).toBe(many.length);
  });

  it('favours the fragile ones', () => {
    const rng = mulberry32(3);
    let weak = 0;
    for (let i = 0; i < 2000; i++) {
      if (sampleForQuiz(many, 'listen', rng)!.conceptId <= 6) weak++;
    }
    expect(weak).toBeGreaterThan(1200); // well above the 1000 a flat draw would give
  });
});
