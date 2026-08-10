/** Domain types. Deliberately not database row types — `core` never touches I/O. */

export type Modality = 'listen' | 'speak' | 'read';
export type Grade = 'again' | 'hard' | 'good' | 'easy';
export type ConceptSource = 'core' | 'personal' | 'emergent';
export type ConceptKind = 'word' | 'grammar' | 'character';

/**
 * The FSRS card, serialised. ts-fsrs works in `Date`s; we persist epoch-ms and ISO
 * strings so a card round-trips through JSON and SQLite without losing precision.
 */
export interface FsrsState {
  due: string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  reps: number;
  lapses: number;
  state: 0 | 1 | 2 | 3; // New | Learning | Review | Relearning
  last_review?: string;
}

/** A scheduling unit: one concept in one modality (docs/design.md §2.3). */
export interface Card {
  conceptId: number;
  modality: Modality;
  fsrs: FsrsState;
  dueAt: number;
  introducedAt: number | null;
}

export interface Concept {
  id: number;
  kind: ConceptKind;
  headword: string;
  headwordTrad: string;
  pinyin: string;
  glossEn: string;
  hskLevel: number | null;
  freqRank: number | null;
  source: ConceptSource;
}

/** Just enough of an utterance for selection to work. */
export interface UtteranceRef {
  id: number;
  conceptIds: number[];
  lastSeenAt: number | null;
}

export const MS_PER_DAY = 86_400_000;
