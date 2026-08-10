import { describe, expect, it } from 'vitest';
import {
  dueCards,
  introductionQueue,
  knownConceptIds,
  MS_PER_DAY,
  newCard,
  nextAction,
  pickUtterance,
  review,
  type Card,
  type Concept,
  type UtteranceRef,
} from '../src/index.ts';

const T0 = new Date('2026-01-01T09:00:00.000Z');
const days = (n: number) => new Date(T0.getTime() + n * MS_PER_DAY);

function concept(id: number, over: Partial<Concept> = {}): Concept {
  return {
    id,
    kind: 'word',
    headword: `w${id}`,
    headwordTrad: `w${id}`,
    pinyin: `p${id}`,
    glossEn: `g${id}`,
    hskLevel: 1,
    freqRank: id,
    source: 'core',
    ...over,
  };
}

/** A card that has been met and is due at `dueDay`. */
function met(conceptId: number, dueDay: number): Card {
  const c = review(newCard(conceptId, 'listen', T0), 'good', T0).card;
  return { ...c, dueAt: days(dueDay).getTime() };
}

const utt = (id: number, conceptIds: number[], lastSeenAt: number | null = null): UtteranceRef =>
  ({ id, conceptIds, lastSeenAt });

describe('dueCards', () => {
  it('returns only introduced, due cards of the right modality, soonest first', () => {
    const cards: Card[] = [
      met(1, 5),
      met(2, 1),
      met(3, 99), // not yet due
      newCard(4, 'listen', T0), // never introduced
      { ...met(5, 0), modality: 'read' }, // wrong modality
    ];
    const out = dueCards(cards, 'listen', days(10));
    expect(out.map((c) => c.conceptId)).toEqual([2, 1]);
  });

  it('respects the limit', () => {
    const cards = [met(1, 0), met(2, 0), met(3, 0)];
    expect(dueCards(cards, 'listen', days(1), 2)).toHaveLength(2);
  });
});

describe('pickUtterance', () => {
  const known = new Set([10, 11, 12]);

  it('prefers a sentence where every other concept is already known', () => {
    const pick = pickUtterance(
      1,
      [utt(100, [1, 10, 99]), utt(101, [1, 10, 11])],
      known,
    );
    expect(pick?.utterance.id).toBe(101);
    expect(pick?.unknownCount).toBe(0);
  });

  it('degrades to the fewest unknowns rather than returning nothing', () => {
    const pick = pickUtterance(1, [utt(100, [1, 97, 98, 99]), utt(101, [1, 97])], known);
    expect(pick?.utterance.id).toBe(101);
    expect(pick?.unknownCount).toBe(1);
  });

  it('breaks ties by least recently heard', () => {
    const pick = pickUtterance(
      1,
      [utt(100, [1, 10], 5_000), utt(101, [1, 11], 1_000), utt(102, [1, 12], 9_000)],
      known,
    );
    expect(pick?.utterance.id).toBe(101);
  });

  it('treats a never-heard sentence as the least recently heard', () => {
    const pick = pickUtterance(1, [utt(100, [1, 10], 5_000), utt(101, [1, 11], null)], known);
    expect(pick?.utterance.id).toBe(101);
  });

  it('returns null when no sentence contains the target', () => {
    expect(pickUtterance(42, [utt(100, [1, 2])], known)).toBeNull();
  });

  it('does not count the target itself as unknown', () => {
    const pick = pickUtterance(999, [utt(100, [999, 10, 11])], known);
    expect(pick?.unknownCount).toBe(0);
  });
});

describe('knownConceptIds', () => {
  it('includes only introduced cards in the requested modality', () => {
    const cards: Card[] = [met(1, 0), newCard(2, 'listen', T0), { ...met(3, 0), modality: 'read' }];
    expect([...knownConceptIds(cards, 'listen')]).toEqual([1]);
  });
});

describe('introductionQueue', () => {
  const counts = new Map([
    [1, 5],
    [2, 5],
    [3, 5],
    [4, 0],
  ]);

  it('ranks personal vocabulary above core at the same level', () => {
    const q = introductionQueue({
      concepts: [concept(1), concept(2, { source: 'personal' })],
      cards: [],
      modality: 'listen',
      utteranceCount: counts,
    });
    expect(q[0]?.concept.id).toBe(2);
  });

  it('ranks earlier HSK levels above later ones', () => {
    const q = introductionQueue({
      concepts: [concept(1, { hskLevel: 4 }), concept(2, { hskLevel: 1 })],
      cards: [],
      modality: 'listen',
      utteranceCount: counts,
    });
    expect(q[0]?.concept.id).toBe(2);
  });

  // Coverage is a hard gate, not a weight. Introducing a concept with no sentence
  // creates a card that can never be reviewed: its due date never advances, so it
  // becomes permanently the oldest due card and clogs the head of the queue. The
  // two-year simulation stalled on exactly this before the gate was added.
  it('never offers a concept with no sentences to drill it with', () => {
    const q = introductionQueue({
      concepts: [concept(4, { source: 'personal', hskLevel: 1 })],
      cards: [],
      modality: 'listen',
      utteranceCount: counts,
    });
    expect(q).toHaveLength(0);
  });

  it('gates on coverage even for the highest-scoring concept available', () => {
    const q = introductionQueue({
      concepts: [concept(4, { source: 'personal', hskLevel: 1 }), concept(1, { hskLevel: 6 })],
      cards: [],
      modality: 'listen',
      utteranceCount: counts,
    });
    expect(q.map((s) => s.concept.id)).toEqual([1]);
  });

  it('excludes concepts already introduced', () => {
    const q = introductionQueue({
      concepts: [concept(1), concept(2)],
      cards: [met(1, 0)],
      modality: 'listen',
      utteranceCount: counts,
    });
    expect(q.map((s) => s.concept.id)).toEqual([2]);
  });

  it('blocks a concept whose grammar prerequisite is unmet, and unblocks it once met', () => {
    const prerequisites = new Map([[2, [1]]]);
    const blocked = introductionQueue({
      concepts: [concept(2, { kind: 'grammar' })],
      cards: [],
      modality: 'listen',
      utteranceCount: counts,
      prerequisites,
    });
    expect(blocked).toHaveLength(0);

    const unblocked = introductionQueue({
      concepts: [concept(2, { kind: 'grammar' })],
      cards: [met(1, 0)],
      modality: 'listen',
      utteranceCount: counts,
      prerequisites,
    });
    expect(unblocked.map((s) => s.concept.id)).toEqual([2]);
  });

  it('is deterministic for equal scores', () => {
    const args = {
      concepts: [concept(3), concept(1), concept(2)],
      cards: [],
      modality: 'listen' as const,
      utteranceCount: counts,
    };
    expect(introductionQueue(args).map((s) => s.concept.id)).toEqual(
      introductionQueue(args).map((s) => s.concept.id),
    );
  });
});

describe('nextAction', () => {
  const concepts = [concept(1), concept(2), concept(3)];
  const utterances = [utt(100, [1, 2]), utt(101, [2, 3]), utt(102, [3])];
  const utteranceCount = new Map([
    [1, 1],
    [2, 2],
    [3, 2],
  ]);

  it('introduces when nothing is due', () => {
    const a = nextAction({
      concepts, cards: [], modality: 'listen', utteranceCount,
      utterances, now: T0,
    });
    expect(a.type).toBe('introduce');
  });

  it('clears the review backlog before introducing anything new', () => {
    const cards = [met(1, 0), met(2, 0), met(3, 0), met(1, 0), met(2, 0)];
    const a = nextAction({
      concepts, cards, modality: 'listen', utteranceCount,
      utterances, now: days(1), introduceBelowDue: 5,
    });
    expect(a.type).toBe('review');
  });

  it('stops introducing once the daily cap is hit', () => {
    const a = nextAction({
      concepts, cards: [], modality: 'listen', utteranceCount,
      utterances, now: T0, maxNewPerDay: 3, introducedToday: 3,
    });
    expect(a.type).toBe('idle');
  });

  it('reports idle with a reason rather than throwing when there is nothing to do', () => {
    const a = nextAction({
      concepts: [], cards: [], modality: 'listen',
      utteranceCount: new Map(), utterances: [], now: T0,
    });
    expect(a).toEqual({ type: 'idle', reason: 'nothing due, no new material' });
  });

  it('falls through to review when a small due queue exists but nothing new is available', () => {
    const cards = [met(1, 0)];
    const a = nextAction({
      concepts: [concept(1)], cards, modality: 'listen',
      utteranceCount, utterances, now: days(1),
    });
    expect(a.type).toBe('review');
  });
});
