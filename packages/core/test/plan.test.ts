import { describe, expect, it } from 'vitest';
import { measurePace, planDuration, planSession, type ModalityState } from '../src/index.ts';

const state = (o: Partial<ModalityState> & { modality: ModalityState['modality'] }): ModalityState => ({
  due: 0,
  newAvailable: 0,
  introducedToday: 0,
  dailyCap: 15,
  ...o,
});

describe('planSession', () => {
  /**
   * The reason this module exists. The event log showed 53 speaking reps against 25
   * listening ones, with listening the stated first priority — a tab bar makes every
   * activity look equally worth opening, and an ordered plan does not.
   */
  it('puts listening ahead of speaking', () => {
    const blocks = planSession({
      states: [
        state({ modality: 'speak', due: 9 }),
        state({ modality: 'listen', due: 4 }),
      ],
    });
    expect(blocks.map((b) => b.modality)).toEqual(['listen', 'speak']);
  });

  // A due card is knowledge actively decaying; an unlearned word is not going anywhere.
  it('puts reviews ahead of new material within a modality', () => {
    const blocks = planSession({
      states: [state({ modality: 'listen', due: 3, newAvailable: 20 })],
    });
    expect(blocks.map((b) => b.kind)).toEqual(['review', 'new']);
  });

  it('respects the daily cap on new words, and counts what was already introduced', () => {
    const [block] = planSession({
      states: [state({ modality: 'listen', newAvailable: 50, introducedToday: 11, dailyCap: 15 })],
    });
    expect(block!.reps).toBe(4);
  });

  it('offers no new block once the cap is used up', () => {
    const blocks = planSession({
      states: [state({ modality: 'listen', newAvailable: 50, introducedToday: 15, dailyCap: 15 })],
    });
    expect(blocks).toEqual([]);
  });

  it('never offers more new words than exist', () => {
    const [block] = planSession({
      states: [state({ modality: 'speak', newAvailable: 2, dailyCap: 15 })],
    });
    expect(block!.reps).toBe(2);
  });

  it('returns nothing to do when everything is caught up', () => {
    expect(planSession({ states: [state({ modality: 'listen' }), state({ modality: 'speak' })] }))
      .toEqual([]);
  });

  it('estimates from measured pace, and admits when it has none', () => {
    const states = [state({ modality: 'listen', due: 10 })];
    expect(planSession({ states })[0]!.estimateMs).toBe(null);
    const paced = planSession({ states, paceMs: new Map([['listen:review', 8000]]) });
    expect(paced[0]!.estimateMs).toBe(80_000);
  });
});

describe('planDuration', () => {
  it('sums what it knows and returns null when it knows nothing', () => {
    expect(planDuration([])).toBe(null);
    expect(
      planDuration([
        { kind: 'review', modality: 'listen', reps: 2, reason: '', estimateMs: 5000 },
        { kind: 'new', modality: 'listen', reps: 2, reason: '', estimateMs: null },
      ]),
    ).toBe(5000);
  });
});

describe('measurePace', () => {
  it('takes the median so one interruption does not distort it', () => {
    expect(measurePace([5000, 6000, 7000, 8000, 250_000])).toBe(7000);
  });

  // Below a second is a double-submit; above five minutes is someone having left.
  it('discards implausible gaps', () => {
    expect(measurePace([10, 20, 30, 400_000])).toBe(null);
  });

  it('declines to guess from too little data', () => {
    expect(measurePace([5000, 6000])).toBe(null);
  });
});
