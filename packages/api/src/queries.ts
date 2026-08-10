/**
 * Every SQL query in the application, in one file.
 *
 * With no ORM this is the type boundary: rows come back shaped by the interfaces in
 * @mt/schema, and everything above this layer works in domain types from @mt/core.
 *
 * The scheduler needs the whole concept and card set to make one decision, so these
 * load everything rather than paginating. At 151 concepts that is obviously fine; at
 * 5,000 it is still a few hundred kilobytes, and a single-user app gets to make that
 * trade for a large amount of simplicity.
 */

import type { Card, Concept, Modality, UtteranceRef } from '@mt/core';
import type { Db, SqlValue } from '@mt/schema';
import type { ConceptRow } from '@mt/schema';

export interface UtteranceDetail {
  id: number;
  hanzi: string;
  hanziTrad: string;
  pinyin: string;
  glossEn: string;
  clips: ClipDetail[];
}

export interface ClipDetail {
  id: number;
  url: string;
  voice: string;
  variety: 'tw' | 'cn';
  rate: string;
}

const toConcept = (r: ConceptRow): Concept => ({
  id: r.id,
  kind: r.kind,
  headword: r.headword,
  headwordTrad: r.headword_trad,
  pinyin: r.pinyin,
  glossEn: r.gloss_en,
  hskLevel: r.hsk_level,
  freqRank: r.freq_rank,
  source: r.source,
});

export async function loadConcepts(db: Db): Promise<Concept[]> {
  const rows = await db.all<ConceptRow>('SELECT * FROM concept ORDER BY id');
  return rows.map(toConcept);
}

export async function loadConcept(db: Db, id: number): Promise<Concept | undefined> {
  const r = await db.first<ConceptRow>('SELECT * FROM concept WHERE id = ?', id);
  return r ? toConcept(r) : undefined;
}

export async function loadCards(db: Db, modality: Modality): Promise<Card[]> {
  const rows = await db.all<{
    concept_id: number;
    modality: Modality;
    fsrs_state: string;
    due_at: number;
    introduced_at: number | null;
  }>('SELECT concept_id, modality, fsrs_state, due_at, introduced_at FROM card WHERE modality = ?', modality);

  return rows.map((r) => ({
    conceptId: r.concept_id,
    modality: r.modality,
    fsrs: JSON.parse(r.fsrs_state),
    dueAt: r.due_at,
    introducedAt: r.introduced_at,
  }));
}

/**
 * Utterances with the concepts they contain and when each was last heard.
 * `last_seen_at` drives the least-recently-heard tie-break in selection, which is
 * what stops one sentence being drilled into the ground.
 */
export async function loadUtteranceRefs(db: Db): Promise<UtteranceRef[]> {
  const rows = await db.all<{ id: number; concept_ids: string; last_seen_at: number | null }>(`
    SELECT u.id,
           group_concat(uc.concept_id) AS concept_ids,
           (SELECT max(ts) FROM event e WHERE e.utterance_id = u.id) AS last_seen_at
    FROM utterance u
    JOIN utterance_concept uc ON uc.utterance_id = u.id
    WHERE u.status = 'approved'
    GROUP BY u.id
  `);
  return rows.map((r) => ({
    id: r.id,
    conceptIds: r.concept_ids ? r.concept_ids.split(',').map(Number) : [],
    lastSeenAt: r.last_seen_at,
  }));
}

export async function utteranceCounts(db: Db): Promise<Map<number, number>> {
  const rows = await db.all<{ concept_id: number; n: number }>(`
    SELECT uc.concept_id, count(*) AS n
    FROM utterance_concept uc
    JOIN utterance u ON u.id = uc.utterance_id AND u.status = 'approved'
    GROUP BY uc.concept_id
  `);
  return new Map(rows.map((r) => [r.concept_id, r.n]));
}

export async function loadUtteranceDetail(
  db: Db,
  id: number,
): Promise<UtteranceDetail | undefined> {
  const u = await db.first<{
    id: number;
    hanzi: string;
    hanzi_trad: string;
    pinyin: string;
    gloss_en: string;
  }>('SELECT id, hanzi, hanzi_trad, pinyin, gloss_en FROM utterance WHERE id = ?', id);
  if (!u) return undefined;

  const clips = await db.all<{
    id: number;
    storage_key: string;
    voice: string;
    variety: 'tw' | 'cn';
    rate: string;
  }>('SELECT id, storage_key, voice, variety, rate FROM audio WHERE utterance_id = ? ORDER BY id', id);

  return {
    id: u.id,
    hanzi: u.hanzi,
    hanziTrad: u.hanzi_trad,
    pinyin: u.pinyin,
    glossEn: u.gloss_en,
    clips: clips.map((c) => ({
      id: c.id,
      url: `/audio/${c.storage_key}`,
      voice: c.voice,
      variety: c.variety,
      rate: c.rate,
    })),
  };
}

export async function conceptIdsForUtterance(db: Db, utteranceId: number): Promise<number[]> {
  const rows = await db.all<{ concept_id: number }>(
    'SELECT concept_id FROM utterance_concept WHERE utterance_id = ? ORDER BY position',
    utteranceId,
  );
  return rows.map((r) => r.concept_id);
}

// ── writes ──────────────────────────────────────────────────────────────────

export async function saveCard(db: Db, card: Card): Promise<number> {
  await db.run(
    `INSERT INTO card (concept_id, modality, fsrs_state, due_at, introduced_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (concept_id, modality) DO UPDATE SET
       fsrs_state    = excluded.fsrs_state,
       due_at        = excluded.due_at,
       introduced_at = COALESCE(card.introduced_at, excluded.introduced_at)`,
    card.conceptId,
    card.modality,
    JSON.stringify(card.fsrs),
    card.dueAt,
    card.introducedAt,
  );
  const row = await db.first<{ id: number }>(
    'SELECT id FROM card WHERE concept_id = ? AND modality = ?',
    card.conceptId,
    card.modality,
  );
  return row!.id;
}

export interface EventInput {
  ts: number;
  sessionId: number | null;
  kind: 'review' | 'exposure' | 'capture' | 'note';
  conceptId?: number | null;
  cardId?: number | null;
  utteranceId?: number | null;
  audioId?: number | null;
  modality?: Modality | null;
  exerciseType?: string | null;
  result?: 'again' | 'hard' | 'good' | 'easy' | null;
  latencyMs?: number | null;
  replays?: number;
  committedBeforeReveal?: boolean | null;
  payload?: unknown;
}

/** Append-only by database trigger — there is deliberately no update or delete. */
export async function insertEvent(db: Db, e: EventInput): Promise<number> {
  const r = await db.run(
    `INSERT INTO event (ts, session_id, kind, concept_id, card_id, utterance_id, audio_id,
                        modality, exercise_type, result, latency_ms, replays,
                        committed_before_reveal, payload)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    e.ts,
    e.sessionId,
    e.kind,
    e.conceptId ?? null,
    e.cardId ?? null,
    e.utteranceId ?? null,
    e.audioId ?? null,
    e.modality ?? null,
    e.exerciseType ?? null,
    e.result ?? null,
    e.latencyMs ?? null,
    e.replays ?? 0,
    e.committedBeforeReveal === null || e.committedBeforeReveal === undefined
      ? null
      : e.committedBeforeReveal
        ? 1
        : 0,
    e.payload === undefined ? null : (JSON.stringify(e.payload) as SqlValue),
  );
  return r.lastInsertRowid;
}

export async function startSession(db: Db, kind = 'drill'): Promise<number> {
  const r = await db.run('INSERT INTO session (started_at, kind) VALUES (?, ?)', Date.now(), kind);
  return r.lastInsertRowid;
}

export async function endSession(db: Db, id: number): Promise<void> {
  await db.run('UPDATE session SET ended_at = ? WHERE id = ? AND ended_at IS NULL', Date.now(), id);
}

// ── reads for the stats view ────────────────────────────────────────────────

export async function introducedSince(db: Db, since: number, modality: Modality): Promise<number> {
  const r = await db.first<{ n: number }>(
    `SELECT count(*) AS n FROM card WHERE modality = ? AND introduced_at >= ?`,
    modality,
    since,
  );
  return r?.n ?? 0;
}

export async function recentLatencies(db: Db, limit = 200): Promise<number[]> {
  const rows = await db.all<{ latency_ms: number }>(
    `SELECT latency_ms FROM event
     WHERE kind = 'review' AND latency_ms IS NOT NULL
     ORDER BY ts DESC LIMIT ?`,
    limit,
  );
  return rows.map((r) => r.latency_ms);
}

export async function countEventsSince(db: Db, since: number): Promise<number> {
  const r = await db.first<{ n: number }>(
    `SELECT count(*) AS n FROM event WHERE kind = 'review' AND ts >= ?`,
    since,
  );
  return r?.n ?? 0;
}

export async function addCapture(
  db: Db,
  text: string,
  capturedBy: string | null,
): Promise<number> {
  const r = await db.run(
    `INSERT INTO capture (ts, raw_text, captured_by, status) VALUES (?, ?, ?, 'new')`,
    Date.now(),
    text,
    capturedBy,
  );
  return r.lastInsertRowid;
}

export async function listCaptures(db: Db, limit = 50) {
  return db.all<{
    id: number;
    ts: number;
    raw_text: string | null;
    captured_by: string | null;
    status: string;
  }>(
    `SELECT id, ts, raw_text, captured_by, status FROM capture ORDER BY ts DESC LIMIT ?`,
    limit,
  );
}

export async function knownHeadwords(db: Db): Promise<{ headword: string; id: number }[]> {
  return db.all<{ headword: string; id: number }>('SELECT id, headword FROM concept');
}
