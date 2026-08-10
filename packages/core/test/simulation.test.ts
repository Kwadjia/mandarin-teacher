/**
 * Two years of study, in a few milliseconds.
 *
 * This is the payoff for keeping `core` free of I/O (docs/design.md §6). Scheduling
 * and selection are the parts most likely to be rewritten and the parts whose bugs
 * take months to notice in real use — a wrong interval curve or a queue that
 * silently starves would otherwise only surface long after the damage was done.
 */

import { describe, expect, it } from 'vitest';
import {
  dueCards,
  gradeCommit,
  strandedCards,
  hskCoverage,
  knownConceptIds,
  MS_PER_DAY,
  newCard,
  nextAction,
  review,
  type Card,
  type Concept,
  type UtteranceRef,
} from '../src/index.ts';

/** Deterministic PRNG — a flaky scheduler test is worse than no scheduler test. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const T0 = new Date('2026-01-01T09:00:00.000Z');
const CONCEPTS = 400;
const SENTENCES = 600;

function buildCorpus() {
  const concepts: Concept[] = Array.from({ length: CONCEPTS }, (_, i) => ({
    id: i + 1,
    kind: 'word',
    headword: `w${i + 1}`,
    headwordTrad: `w${i + 1}`,
    pinyin: `p${i + 1}`,
    glossEn: `g${i + 1}`,
    hskLevel: Math.min(6, 1 + Math.floor(i / 70)),
    freqRank: i + 1,
    source: i % 9 === 0 ? 'personal' : 'core',
  }));

  // Sentences drawn from a sliding window so early concepts co-occur with early
  // concepts — mirroring a real graded corpus rather than uniform random noise.
  const rng = mulberry32(99);
  const utterances: UtteranceRef[] = Array.from({ length: SENTENCES }, (_, i) => {
    const centre = Math.floor((i / SENTENCES) * CONCEPTS);
    const ids = new Set<number>();
    while (ids.size < 4) {
      const off = Math.floor((rng() - 0.5) * 60);
      ids.add(Math.min(CONCEPTS, Math.max(1, centre + off)));
    }
    return { id: 1000 + i, conceptIds: [...ids], lastSeenAt: null };
  });

  const utteranceCount = new Map<number, number>();
  for (const u of utterances) {
    for (const id of u.conceptIds) utteranceCount.set(id, (utteranceCount.get(id) ?? 0) + 1);
  }
  return { concepts, utterances, utteranceCount };
}

interface SimResult {
  cards: Card[];
  reviews: number;
  introduced: number;
  idleDays: number;
  /** Idle reason → count. "Nothing due" is healthy; "no usable utterance" is a bug. */
  idleReasons: Map<string, number>;
  maxBacklog: number;
  finalBacklog: number;
  accuracy: number;
}

/**
 * @param skill probability of recalling a card whose predicted retrievability is high;
 *              scaled down for weaker cards so failure correlates with actual difficulty.
 */
function simulate(dayCount: number, repsPerDay: number, skill: number, seed = 7): SimResult {
  const { concepts, utterances, utteranceCount } = buildCorpus();
  const rng = mulberry32(seed);
  const cards = new Map<number, Card>();

  let reviews = 0;
  let introduced = 0;
  let idleDays = 0;
  const idleReasons = new Map<string, number>();
  let maxBacklog = 0;
  let correct = 0;
  let graded = 0;

  for (let day = 0; day < dayCount; day++) {
    const dayStart = new Date(T0.getTime() + day * MS_PER_DAY);
    let introducedToday = 0;
    let didSomething = false;

    const backlog = dueCards([...cards.values()], 'listen', dayStart, 10_000).length;
    maxBacklog = Math.max(maxBacklog, backlog);

    for (let rep = 0; rep < repsPerDay; rep++) {
      // Spread reps across the study session so intervals inside a day still advance.
      const now = new Date(dayStart.getTime() + rep * 90_000);
      const action = nextAction({
        concepts,
        cards: [...cards.values()],
        modality: 'listen',
        utteranceCount,
        utterances,
        now,
        introduceBelowDue: 5,
        maxNewPerDay: 10,
        introducedToday,
      });

      if (action.type === 'idle') {
        if (rep === 0) idleReasons.set(action.reason, (idleReasons.get(action.reason) ?? 0) + 1);
        break;
      }
      didSomething = true;

      if (action.type === 'introduce') {
        const fresh = newCard(action.concept.id, 'listen', now);
        cards.set(action.concept.id, review(fresh, 'good', now).card);
        introduced++;
        introducedToday++;
        continue;
      }

      // A review. Success probability tracks how well the card is actually held.
      const card = action.card;
      const overdueDays = (now.getTime() - card.dueAt) / MS_PER_DAY;
      const p = skill * Math.max(0.35, 1 - overdueDays / 60) * (card.fsrs.lapses > 2 ? 0.8 : 1);
      const gotIt = rng() < p;
      const replays = gotIt && rng() < 0.25 ? 1 : 0;
      const latencyMs = gotIt ? 900 + rng() * 3500 : 7000;

      const grade = gradeCommit({ gotIt, replays, latencyMs, committedBeforeReveal: true });
      cards.set(card.conceptId, review(card, grade, now).card);
      reviews++;
      graded++;
      if (gotIt) correct++;
    }
    if (!didSomething) idleDays++;
  }

  const end = new Date(T0.getTime() + dayCount * MS_PER_DAY);
  return {
    cards: [...cards.values()],
    reviews,
    introduced,
    idleDays,
    idleReasons,
    maxBacklog,
    finalBacklog: dueCards([...cards.values()], 'listen', end, 10_000).length,
    accuracy: graded ? correct / graded : 0,
  };
}

describe('two years of simulated study', () => {
  const DAYS = 730;
  const r = simulate(DAYS, 25, 0.88);

  it('runs 730 days without stalling', () => {
    expect(r.reviews + r.introduced).toBeGreaterThan(5_000);
  });

  // The distinction that matters. Running out of work once the corpus is exhausted
  // and everything sits on months-long intervals is correct behaviour. Having due
  // cards you cannot play is a stranded card, and a stranded card is stuck forever.
  it('is never idle because a due card has no sentence', () => {
    const stranding = [...r.idleReasons].filter(([reason]) => reason.includes('no usable'));
    expect(stranding).toEqual([]);
  });

  it('only ever idles because the corpus is genuinely exhausted', () => {
    for (const reason of r.idleReasons.keys()) {
      expect(reason).toBe('nothing due, no new material');
    }
  });

  it('strands nothing — every introduced concept stays reviewable', () => {
    const { utterances } = buildCorpus();
    expect(strandedCards(r.cards, 'listen', utterances)).toEqual([]);
  });

  it('introduces the whole corpus rather than starving the queue', () => {
    expect(r.introduced).toBeGreaterThan(CONCEPTS * 0.9);
    expect(r.introduced).toBeLessThanOrEqual(CONCEPTS);
  });

  it('keeps the review backlog bounded — no runaway debt', () => {
    // The pathology this guards against: due cards accumulating faster than they
    // are cleared, so the queue grows without limit and the app becomes a chore.
    expect(r.maxBacklog).toBeLessThan(CONCEPTS);
    expect(r.finalBacklog).toBeLessThan(120);
  });

  it('grows intervals — most cards should be on multi-week schedules by the end', () => {
    const scheduled = r.cards.map((c) => c.fsrs.scheduled_days).sort((a, b) => a - b);
    const median = scheduled[scheduled.length >> 1]!;
    expect(median).toBeGreaterThan(14);
  });

  it('reaches meaningful HSK coverage', () => {
    const end = new Date(T0.getTime() + DAYS * MS_PER_DAY);
    const concepts = buildCorpus().concepts;
    // Sized to this synthetic corpus. Against the real HSK denominators a corpus this
    // small could never clear a level however well the scheduler performed, and this
    // test is about the scheduler.
    const levelSizes: Record<number, number> = {};
    for (const c of concepts) {
      if (c.hskLevel !== null) levelSizes[c.hskLevel] = (levelSizes[c.hskLevel] ?? 0) + 1;
    }
    const report = hskCoverage(concepts, r.cards, 'listen', end, { levelSizes });
    expect(report.estimate).toBeGreaterThan(1);
    expect(report.perLevel[0]!.coverage).toBeGreaterThan(0.7);
  });

  it('holds every card in a valid state', () => {
    for (const c of r.cards) {
      expect(Number.isFinite(c.dueAt)).toBe(true);
      expect(c.fsrs.stability).toBeGreaterThan(0);
      expect(c.fsrs.difficulty).toBeGreaterThan(0);
      expect(c.introducedAt).not.toBeNull();
      expect([0, 1, 2, 3]).toContain(c.fsrs.state);
    }
  });

  it('never selects a sentence containing an unmet word once past the cold start', () => {
    // Warm up, then confirm the comprehensible-input constraint actually holds.
    const warm = simulate(60, 25, 0.9);
    const { utterances } = buildCorpus();
    const known = knownConceptIds(warm.cards, 'listen');
    const action = nextAction({
      ...buildCorpusInput(),
      cards: warm.cards,
      utterances,
      now: new Date(T0.getTime() + 61 * MS_PER_DAY),
    });
    if (action.type === 'review') {
      expect(action.pick.unknownCount).toBe(0);
      for (const id of action.pick.utterance.conceptIds) {
        if (id !== action.card.conceptId) expect(known.has(id)).toBe(true);
      }
    }
  });
});

function buildCorpusInput() {
  const { concepts, utteranceCount } = buildCorpus();
  return { concepts, utteranceCount, modality: 'listen' as const };
}

describe('a weaker learner', () => {
  it('still converges without the backlog exploding', () => {
    const weak = simulate(365, 25, 0.62, 21);
    expect(weak.idleDays).toBe(0);
    expect(weak.finalBacklog).toBeLessThan(200);
    // Failing more often should mean more lapses and shorter intervals — the
    // scheduler adapting, not breaking.
    const lapses = weak.cards.reduce((n, c) => n + c.fsrs.lapses, 0);
    expect(lapses).toBeGreaterThan(0);
  });
});

describe('a learner who disappears for a month', () => {
  it('comes back to a large but finite backlog and clears it', () => {
    const { concepts, utterances, utteranceCount } = buildCorpus();
    const cards = new Map<number, Card>();
    const rng = mulberry32(5);

    const runDay = (day: number, reps: number) => {
      const dayStart = new Date(T0.getTime() + day * MS_PER_DAY);
      let introducedToday = 0;
      for (let rep = 0; rep < reps; rep++) {
        const now = new Date(dayStart.getTime() + rep * 90_000);
        const a = nextAction({
          concepts, cards: [...cards.values()], modality: 'listen',
          utteranceCount, utterances, now, introducedToday, maxNewPerDay: 10,
        });
        if (a.type === 'idle') break;
        if (a.type === 'introduce') {
          cards.set(a.concept.id, review(newCard(a.concept.id, 'listen', now), 'good', now).card);
          introducedToday++;
        } else {
          const grade = rng() < 0.85 ? 'good' : 'again';
          cards.set(a.card.conceptId, review(a.card, grade, now).card);
        }
      }
    };

    for (let d = 0; d < 60; d++) runDay(d, 25);
    const beforeGap = dueCards([...cards.values()], 'listen',
      new Date(T0.getTime() + 60 * MS_PER_DAY), 10_000).length;

    // 30 days off.
    const afterGap = dueCards([...cards.values()], 'listen',
      new Date(T0.getTime() + 90 * MS_PER_DAY), 10_000).length;
    expect(afterGap).toBeGreaterThan(beforeGap);

    // Two weeks of catching up.
    for (let d = 90; d < 104; d++) runDay(d, 30);
    const recovered = dueCards([...cards.values()], 'listen',
      new Date(T0.getTime() + 104 * MS_PER_DAY), 10_000).length;
    expect(recovered).toBeLessThan(afterGap);
  });
});
