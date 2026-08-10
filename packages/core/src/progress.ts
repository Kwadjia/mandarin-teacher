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
  total: number;
  known: number;
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
}

export function hskCoverage(
  concepts: Concept[],
  cards: Card[],
  modality: Modality,
  now: Date,
  opts: CoverageOptions = {},
): CoverageReport {
  const { threshold = 0.85, horizonDays = 14, levelPass = 0.8 } = opts;

  const byConcept = new Map<number, Card>();
  for (const c of cards) if (c.modality === modality) byConcept.set(c.conceptId, c);

  const levels = new Map<number, { total: number; known: number }>();
  let shaky = 0;

  for (const concept of concepts) {
    if (concept.hskLevel === null) continue;
    const bucket = levels.get(concept.hskLevel) ?? { total: 0, known: 0 };
    bucket.total++;

    const card = byConcept.get(concept.id);
    if (card && isRetained(card, now, threshold, horizonDays)) bucket.known++;
    else if (card && card.introducedAt !== null) shaky++;

    levels.set(concept.hskLevel, bucket);
  }

  const perLevel: LevelCoverage[] = [...levels.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([level, b]) => ({
      level,
      total: b.total,
      known: b.known,
      coverage: b.total === 0 ? 0 : b.known / b.total,
    }));

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
