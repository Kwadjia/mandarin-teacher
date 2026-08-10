/**
 * What to show next. Two separate problems, deliberately kept apart
 * (docs/design.md §2.3):
 *
 *   - When to review something known  → FSRS. Not touched here.
 *   - What to introduce next          → a weighted sort. All of it lives here.
 *
 * Keeping introduction priority out of the review scheduler means fiddling with
 * priorities can never break retention maths.
 */

import { isKnown } from './scheduling.js';
import type { Card, Concept, Modality, UtteranceRef } from './types.js';

// ── review queue ────────────────────────────────────────────────────────────

export function dueCards(cards: Card[], modality: Modality, now: Date, limit = 50): Card[] {
  const t = now.getTime();
  return cards
    .filter((c) => c.modality === modality && c.introducedAt !== null && c.dueAt <= t)
    .sort((a, b) => a.dueAt - b.dueAt)
    .slice(0, limit);
}

// ── utterance choice — the comprehensible-input engine ──────────────────────

export interface UtterancePick {
  utterance: UtteranceRef;
  /** Concepts in this utterance the learner has not met. Zero is ideal. */
  unknownCount: number;
}

/**
 * Pick a sentence to drill `targetConceptId` with.
 *
 * Preference order:
 *   1. every other concept already met  (true comprehensible input)
 *   2. fewest unmet concepts            (graceful degradation — never return nothing)
 *   3. least recently heard             (avoid drilling one sentence into the ground)
 *
 * The degradation matters: on day one almost nothing is known, and a selector that
 * insists on perfect coverage would simply refuse to show you anything.
 */
export function pickUtterance(
  targetConceptId: number,
  utterances: UtteranceRef[],
  knownConceptIds: ReadonlySet<number>,
): UtterancePick | null {
  let best: UtterancePick | null = null;

  for (const u of utterances) {
    if (!u.conceptIds.includes(targetConceptId)) continue;
    const unknownCount = u.conceptIds.filter(
      (id) => id !== targetConceptId && !knownConceptIds.has(id),
    ).length;

    if (
      best === null ||
      unknownCount < best.unknownCount ||
      (unknownCount === best.unknownCount &&
        (u.lastSeenAt ?? 0) < (best.utterance.lastSeenAt ?? 0))
    ) {
      best = { utterance: u, unknownCount };
    }
  }
  return best;
}

export function knownConceptIds(cards: Card[], modality: Modality): Set<number> {
  const s = new Set<number>();
  for (const c of cards) if (c.modality === modality && isKnown(c)) s.add(c.conceptId);
  return s;
}

// ── introduction priority ───────────────────────────────────────────────────

export interface PriorityWeights {
  /** Earlier HSK levels first. */
  hsk: number;
  /** Corpus frequency — common words earn their slot. */
  frequency: number;
  /** Words that actually occur in this household. */
  personal: number;
  /** Words that already have sentences we can drill them with. */
  coverage: number;
}

export const DEFAULT_WEIGHTS: PriorityWeights = {
  hsk: 1.0,
  frequency: 0.6,
  personal: 1.4,
  coverage: 0.8,
};

export interface PriorityInput {
  concepts: Concept[];
  cards: Card[];
  modality: Modality;
  /** conceptId → how many approved utterances contain it. */
  utteranceCount: Map<number, number>;
  /** Grammar prerequisites: conceptId → concept ids that must be met first. */
  prerequisites?: Map<number, number[]>;
  weights?: Partial<PriorityWeights>;
}

export interface ScoredConcept {
  concept: Concept;
  score: number;
  blockedBy: number[];
}

/**
 * Rank not-yet-introduced concepts. Vocabulary has no real prerequisites, so
 * ordering is frequency- and relevance-driven; genuine prerequisite edges are for
 * grammar only and simply block until met (docs/design.md §2.5).
 */
export function introductionQueue(input: PriorityInput, limit = 20): ScoredConcept[] {
  const w = { ...DEFAULT_WEIGHTS, ...input.weights };
  const known = knownConceptIds(input.cards, input.modality);
  const introduced = new Set(
    input.cards.filter((c) => c.modality === input.modality && c.introducedAt !== null)
      .map((c) => c.conceptId),
  );

  const maxFreq = Math.max(1, ...input.concepts.map((c) => c.freqRank ?? 0));

  const scored: ScoredConcept[] = [];
  for (const concept of input.concepts) {
    if (introduced.has(concept.id)) continue;

    // Hard gate, not a weight. A concept with no sentence to play cannot be reviewed,
    // so introducing it creates a card whose due date can never advance — it becomes
    // permanently the oldest due card and clogs the head of the queue forever. Found
    // by the two-year simulation, which stalled on exactly this.
    const n = input.utteranceCount.get(concept.id) ?? 0;
    if (n === 0) continue;

    const blockedBy = (input.prerequisites?.get(concept.id) ?? []).filter((p) => !known.has(p));

    // HSK 1 → 1.0, HSK 6 → ~0.17. Unlevelled concepts sit mid-pack rather than last.
    const hsk = concept.hskLevel ? 1 / concept.hskLevel : 0.4;
    // Rank 1 is the most common word; invert so common scores high.
    const frequency = concept.freqRank ? 1 - concept.freqRank / maxFreq : 0.3;
    const personal = concept.source === 'personal' ? 1 : concept.source === 'emergent' ? 0.9 : 0;
    // Beyond the gate, more sentences is still better — it means less repetition.
    const coverage = Math.min(1, n / 4);

    const score =
      w.hsk * hsk + w.frequency * frequency + w.personal * personal + w.coverage * coverage;

    scored.push({ concept, score: blockedBy.length ? score - 100 : score, blockedBy });
  }

  return scored
    .filter((s) => s.blockedBy.length === 0 && s.score > 0)
    .sort((a, b) => b.score - a.score || a.concept.id - b.concept.id)
    .slice(0, limit);
}

// ── the actual "what next" decision ─────────────────────────────────────────

export type NextAction =
  | { type: 'review'; card: Card; pick: UtterancePick }
  | { type: 'introduce'; concept: Concept; pick: UtterancePick | null }
  | { type: 'idle'; reason: string; strandedConceptIds?: number[] };

/**
 * Cards that are due but have no sentence to drill them with — they can never be
 * reviewed, so their due date never advances and they sit at the head of the queue
 * indefinitely. `introductionQueue` will not create these, but a corpus edit can
 * strand an existing card, so it is worth being able to detect them.
 */
export function strandedCards(
  cards: Card[],
  modality: Modality,
  utterances: UtteranceRef[],
): Card[] {
  const withUtterance = new Set<number>();
  for (const u of utterances) for (const id of u.conceptIds) withUtterance.add(id);
  return cards.filter(
    (c) => c.modality === modality && c.introducedAt !== null && !withUtterance.has(c.conceptId),
  );
}

export interface NextInput extends PriorityInput {
  utterances: UtteranceRef[];
  now: Date;
  /** Introduce a new concept when fewer than this many reviews are waiting. */
  introduceBelowDue?: number;
  maxNewPerDay?: number;
  introducedToday?: number;
}

/**
 * Reviews come first — a backlog you never clear is how SRS systems die. New
 * material is only introduced once the queue is short enough to absorb it.
 */
export function nextAction(input: NextInput): NextAction {
  const {
    now, utterances, modality, introduceBelowDue = 5,
    maxNewPerDay = 12, introducedToday = 0,
  } = input;

  const known = knownConceptIds(input.cards, modality);
  const due = dueCards(input.cards, modality, now);

  if (due.length >= introduceBelowDue) {
    for (const card of due) {
      const pick = pickUtterance(card.conceptId, utterances, known);
      if (pick) return { type: 'review', card, pick };
    }
  }

  if (introducedToday < maxNewPerDay) {
    const queue = introductionQueue(input, 5);
    const head = queue[0];
    if (head) {
      return {
        type: 'introduce',
        concept: head.concept,
        pick: pickUtterance(head.concept.id, utterances, known),
      };
    }
  }

  for (const card of due) {
    const pick = pickUtterance(card.conceptId, utterances, known);
    if (pick) return { type: 'review', card, pick };
  }

  if (due.length) {
    const stranded = strandedCards(due, modality, utterances).map((c) => c.conceptId);
    return {
      type: 'idle',
      reason: 'due cards have no usable utterance — corpus needs sentences for these',
      strandedConceptIds: stranded,
    };
  }
  return { type: 'idle', reason: 'nothing due, no new material' };
}
