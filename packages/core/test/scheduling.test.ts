import { describe, expect, it } from 'vitest';
import {
  isKnown,
  isRetained,
  MS_PER_DAY,
  newCard,
  projectedRetrievability,
  retrievability,
  review,
  type Card,
} from '../src/index.ts';

const T0 = new Date('2026-01-01T09:00:00.000Z');
const days = (n: number) => new Date(T0.getTime() + n * MS_PER_DAY);

describe('newCard', () => {
  it('starts unintroduced and immediately due', () => {
    const c = newCard(1, 'listen', T0);
    expect(c.introducedAt).toBeNull();
    expect(isKnown(c)).toBe(false);
    expect(c.dueAt).toBe(T0.getTime());
    expect(c.fsrs.reps).toBe(0);
    expect(c.fsrs.state).toBe(0);
  });
});

describe('review', () => {
  it('marks a card introduced on its first grade and never moves that date again', () => {
    const first = review(newCard(1, 'listen', T0), 'good', T0);
    expect(first.card.introducedAt).toBe(T0.getTime());

    const later = review(first.card, 'good', days(3));
    expect(later.card.introducedAt).toBe(T0.getTime());
  });

  it('does not mutate the card it is given', () => {
    const card = newCard(1, 'listen', T0);
    const snapshot = JSON.stringify(card);
    review(card, 'easy', T0);
    expect(JSON.stringify(card)).toBe(snapshot);
  });

  it('orders intervals again < hard < good < easy', () => {
    // Take a card through a couple of successes so it is in the Review state,
    // where interval differences between grades are meaningful.
    let card: Card = review(newCard(1, 'listen', T0), 'good', T0).card;
    card = review(card, 'good', days(1)).card;
    card = review(card, 'good', days(4)).card;

    const at = days(12);
    const iv = (g: 'again' | 'hard' | 'good' | 'easy') => review(card, g, at).intervalMs;

    expect(iv('again')).toBeLessThan(iv('hard'));
    expect(iv('hard')).toBeLessThan(iv('good'));
    expect(iv('good')).toBeLessThan(iv('easy'));
  });

  it('counts a lapse and shortens the interval when a mature card is failed', () => {
    let card: Card = review(newCard(1, 'listen', T0), 'easy', T0).card;
    card = review(card, 'easy', days(5)).card;
    card = review(card, 'good', days(20)).card;
    const matureInterval = card.dueAt - days(20).getTime();

    const lapsed = review(card, 'again', days(60));
    expect(lapsed.card.fsrs.lapses).toBe(card.fsrs.lapses + 1);
    expect(lapsed.intervalMs).toBeLessThan(matureInterval);
  });

  it('grows stability across repeated successes', () => {
    let card: Card = newCard(1, 'listen', T0);
    let previous = 0;
    for (let i = 0; i < 6; i++) {
      const at = new Date(card.dueAt);
      card = review(card, 'good', at).card;
      expect(card.fsrs.stability).toBeGreaterThan(previous);
      previous = card.fsrs.stability;
    }
  });

  it('round-trips through JSON without drift', () => {
    const card = review(newCard(7, 'listen', T0), 'good', T0).card;
    const revived = JSON.parse(JSON.stringify(card)) as Card;
    expect(review(revived, 'good', days(2)).card).toEqual(review(card, 'good', days(2)).card);
  });
});

describe('retrievability', () => {
  it('is zero for a card that has never been reviewed', () => {
    expect(retrievability(newCard(1, 'listen', T0).fsrs, T0)).toBe(0);
  });

  it('decays monotonically after a review', () => {
    const card = review(newCard(1, 'listen', T0), 'good', T0).card;
    const series = [1, 5, 20, 60, 200].map((d) => retrievability(card.fsrs, days(d)));
    for (let i = 1; i < series.length; i++) {
      expect(series[i]!).toBeLessThanOrEqual(series[i - 1]!);
    }
    expect(series.at(-1)!).toBeLessThan(0.9);
  });

  it('projects forward consistently with direct evaluation', () => {
    const card = review(newCard(1, 'listen', T0), 'good', T0).card;
    expect(projectedRetrievability(card.fsrs, T0, 14)).toBeCloseTo(
      retrievability(card.fsrs, days(14)),
      10,
    );
  });
});

describe('isRetained', () => {
  it('is false for a card never introduced', () => {
    expect(isRetained(newCard(1, 'listen', T0), T0)).toBe(false);
  });

  it('becomes true once a card is well established', () => {
    let card: Card = newCard(1, 'listen', T0);
    for (let i = 0; i < 8; i++) card = review(card, 'easy', new Date(card.dueAt)).card;
    expect(isRetained(card, new Date(card.fsrs.last_review!))).toBe(true);
  });

  it('is false for something just barely met', () => {
    const card = review(newCard(1, 'listen', T0), 'hard', T0).card;
    expect(isRetained(card, T0)).toBe(false);
  });
});
