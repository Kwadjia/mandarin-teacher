import { describe, expect, it } from 'vitest';
import {
  MS_PER_DAY,
  newCard,
  practiceQueue,
  review,
  shouldReschedule,
  type Card,
} from '../src/index.ts';

const T0 = new Date('2026-01-01T09:00:00.000Z');

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
