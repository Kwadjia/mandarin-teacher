/**
 * The HSK proficiency estimate (docs/design.md §4).
 *
 * This measures *vocabulary coverage by modality*, not exam readiness. It is
 * reported per modality precisely so the asymmetry this project exists to avoid —
 * reading fluently while understanding nothing spoken — is visible rather than
 * hidden behind one aggregate number.
 */

import { isRetained } from './scheduling.ts';
import type { Card, Concept, Modality } from './types.ts';

export interface LevelCoverage {
  level: number;
  /** The official size of the level — the denominator that matters. */
  total: number;
  known: number;
  /** How much of the level the corpus can even teach yet. */
  inCorpus: number;
  coverage: number;
}

export interface CoverageReport {
  modality: Modality;
  /** e.g. 2.4 — level 2 solid, 40% of the way into level 3. */
  estimate: number;
  perLevel: LevelCoverage[];
  /** Concepts met but not retained — the natural "weak list". */
  shaky: number;
}

export interface CoverageOptions {
  /** Retrievability a concept must hold to count as known. */
  threshold?: number;
  /** How far ahead to project. Retention now is easy; retention in a fortnight is not. */
  horizonDays?: number;
  /** Fraction of a level that must be known before that level counts as cleared. */
  levelPass?: number;
  /**
   * Official HSK 2.0 level sizes, used as the coverage denominator.
   *
   * Dividing by the corpus instead would let "HSK 2 complete" be reached by knowing
   * every level-2 word we happen to have written a sentence for — the estimate would
   * measure our content, not his Chinese, and would silently deflate every time the
   * corpus grew. Against the real sizes, a thin level reads as thin, which is true and
   * also tells us where to write next.
   */
  levelSizes?: Record<number, number>;
}

/** HSK 2.0, the ordering backbone (docs/design.md §4). */
export const HSK_SIZES: Record<number, number> = {
  1: 150,
  2: 150,
  3: 300,
  4: 600,
  5: 1300,
  6: 2500,
};

export function hskCoverage(
  concepts: Concept[],
  cards: Card[],
  modality: Modality,
  now: Date,
  opts: CoverageOptions = {},
): CoverageReport {
  const {
    threshold = 0.85,
    horizonDays = 14,
    levelPass = 0.8,
    levelSizes = HSK_SIZES,
  } = opts;

  const byConcept = new Map<number, Card>();
  for (const c of cards) if (c.modality === modality) byConcept.set(c.conceptId, c);

  const levels = new Map<number, { inCorpus: number; known: number }>();
  let shaky = 0;

  for (const concept of concepts) {
    if (concept.hskLevel === null) continue;
    const bucket = levels.get(concept.hskLevel) ?? { inCorpus: 0, known: 0 };
    bucket.inCorpus++;

    const card = byConcept.get(concept.id);
    if (card && isRetained(card, now, threshold, horizonDays)) bucket.known++;
    else if (card && card.introducedAt !== null) shaky++;

    levels.set(concept.hskLevel, bucket);
  }

  const perLevel: LevelCoverage[] = [...levels.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([level, b]) => {
      // The level's real size, not how much of it we happen to have written.
      const total = levelSizes[level] ?? b.inCorpus;
      return {
        level,
        total,
        known: b.known,
        inCorpus: b.inCorpus,
        coverage: total === 0 ? 0 : b.known / total,
      };
    });

  // Highest contiguous level that clears the bar, plus partial progress into the next.
  let cleared = 0;
  for (const l of perLevel) {
    if (l.coverage >= levelPass) cleared = l.level;
    else break;
  }
  const next = perLevel.find((l) => l.level === cleared + 1);
  const estimate = cleared + (next ? Math.min(next.coverage, 0.99) : 0);

  return { modality, estimate: Math.round(estimate * 100) / 100, perLevel, shaky };
}

/**
 * Median response latency. For listening, *speed* of comprehension is the skill, and
 * its trend over months is a better longitudinal signal than any mastery percentage —
 * and it falls out of the event log for free.
 */
export function medianLatency(latenciesMs: readonly number[]): number | null {
  const xs = latenciesMs.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid]! : Math.round(((xs[mid - 1] ?? 0) + (xs[mid] ?? 0)) / 2);
}
