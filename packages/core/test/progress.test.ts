import { describe, expect, it } from 'vitest';
import {
  hskCoverage,
  medianLatency,
  MS_PER_DAY,
  newCard,
  review,
  type Card,
  type Concept,
} from '../src/index.js';

const T0 = new Date('2026-01-01T09:00:00.000Z');

function concept(id: number, hskLevel: number | null): Concept {
  return {
    id, kind: 'word', headword: `w${id}`, headwordTrad: `w${id}`,
    pinyin: `p${id}`, glossEn: `g${id}`, hskLevel, freqRank: id, source: 'core',
  };
}

/** Drill a card until it is comfortably retained. */
function mastered(conceptId: number): Card {
  let card = newCard(conceptId, 'listen', T0);
  for (let i = 0; i < 10; i++) card = review(card, 'easy', new Date(card.dueAt)).card;
  return card;
}

describe('hskCoverage', () => {
  it('reports zero for a learner who has done nothing', () => {
    const concepts = [concept(1, 1), concept(2, 1)];
    const r = hskCoverage(concepts, [], 'listen', T0);
    expect(r.estimate).toBe(0);
    expect(r.perLevel).toEqual([{ level: 1, total: 2, known: 0, coverage: 0 }]);
  });

  it('clears a level once enough of it is retained, and counts partway into the next', () => {
    // Level 1: 4 of 5 mastered (80% — clears). Level 2: 1 of 4 (25%).
    const concepts = [
      ...[1, 2, 3, 4, 5].map((i) => concept(i, 1)),
      ...[6, 7, 8, 9].map((i) => concept(i, 2)),
    ];
    const cards = [1, 2, 3, 4, 6].map(mastered);
    const at = new Date(T0.getTime() + 200 * MS_PER_DAY);

    const r = hskCoverage(concepts, cards, 'listen', at);
    expect(r.perLevel[0]).toMatchObject({ level: 1, total: 5, known: 4 });
    expect(r.perLevel[1]).toMatchObject({ level: 2, total: 4, known: 1 });
    expect(r.estimate).toBeCloseTo(1.25, 2);
  });

  it('does not credit a later level while an earlier one is incomplete', () => {
    // Level 2 fully mastered, level 1 barely touched — the estimate must stay at 0.
    const concepts = [...[1, 2, 3, 4].map((i) => concept(i, 1)), concept(5, 2)];
    const r = hskCoverage(concepts, [mastered(5)], 'listen', T0);
    expect(r.estimate).toBe(0);
  });

  it('counts met-but-not-retained concepts as shaky', () => {
    const concepts = [concept(1, 1), concept(2, 1)];
    const barely = review(newCard(1, 'listen', T0), 'hard', T0).card;
    const r = hskCoverage(concepts, [barely], 'listen', T0);
    expect(r.shaky).toBe(1);
    expect(r.perLevel[0]?.known).toBe(0);
  });

  it('ignores concepts with no HSK level', () => {
    const r = hskCoverage([concept(1, null)], [mastered(1)], 'listen', T0);
    expect(r.perLevel).toEqual([]);
  });

  it('reads only the requested modality', () => {
    const concepts = [concept(1, 1)];
    const readCard = { ...mastered(1), modality: 'read' as const };
    expect(hskCoverage(concepts, [readCard], 'listen', T0).perLevel[0]?.known).toBe(0);
    expect(hskCoverage(concepts, [readCard], 'read', T0).perLevel[0]?.known).toBe(1);
  });
});

describe('medianLatency', () => {
  it('returns null with no usable samples', () => {
    expect(medianLatency([])).toBeNull();
    expect(medianLatency([0, -1, NaN])).toBeNull();
  });

  it('takes the middle of an odd-length sample', () => {
    expect(medianLatency([3000, 1000, 2000])).toBe(2000);
  });

  it('averages the middle two of an even-length sample', () => {
    expect(medianLatency([1000, 2000, 3000, 4000])).toBe(2500);
  });

  it('discards non-positive and non-finite values', () => {
    expect(medianLatency([1000, 0, 3000, NaN, Infinity])).toBe(2000);
  });
});
