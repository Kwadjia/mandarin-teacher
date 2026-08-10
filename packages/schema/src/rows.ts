/**
 * Row shapes, mirroring migrations/0001_init.sql exactly.
 *
 * SQLite has no booleans — integer flags stay integers here rather than being
 * quietly coerced, so what the type says is what the database holds.
 */

export interface ConceptRow {
  id: number;
  kind: 'word' | 'grammar' | 'character';
  headword: string;
  headword_trad: string;
  pinyin: string;
  /** '' when the word has no sense split. Never null — see migrations/0001_init.sql. */
  sense: string;
  gloss_en: string;
  hsk_level: number | null;
  freq_rank: number | null;
  source: 'core' | 'personal' | 'emergent';
  notes: string | null;
  created_at: number;
}

export interface UtteranceRow {
  id: number;
  hanzi: string;
  hanzi_trad: string;
  pinyin: string;
  gloss_en: string;
  source: 'generated' | 'family' | 'corpus';
  source_detail: string | null;
  status: 'draft' | 'approved' | 'retired';
  notes: string | null;
  created_at: number;
}

export interface AudioRow {
  id: number;
  utterance_id: number;
  storage_key: string;
  provider: string;
  voice: string;
  variety: 'tw' | 'cn';
  rate: string;
  is_native: 0 | 1;
  duration_ms: number | null;
  created_at: number;
}

export interface CardRow {
  id: number;
  concept_id: number;
  modality: 'listen' | 'speak' | 'read';
  fsrs_state: string; // JSON
  due_at: number;
  introduced_at: number | null;
}

export interface EventRow {
  id: number;
  ts: number;
  session_id: number | null;
  kind: 'review' | 'exposure' | 'capture' | 'note';
  concept_id: number | null;
  card_id: number | null;
  utterance_id: number | null;
  audio_id: number | null;
  modality: 'listen' | 'speak' | 'read' | null;
  exercise_type: string | null;
  result: 'again' | 'hard' | 'good' | 'easy' | null;
  latency_ms: number | null;
  replays: number;
  committed_before_reveal: 0 | 1 | null;
  payload: string | null; // JSON
}

export interface SessionRow {
  id: number;
  started_at: number;
  ended_at: number | null;
  kind: string;
}

export interface CaptureRow {
  id: number;
  ts: number;
  raw_text: string | null;
  raw_audio_key: string | null;
  captured_by: string | null;
  status: 'new' | 'processed' | 'rejected';
  notes: string | null;
}
