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
  /** Tone-numbered syllables for dictation; null when the split was unverifiable. */
  pinyinSyllables: string | null;
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
    pinyin_syllables: string | null;
  }>(
    'SELECT id, hanzi, hanzi_trad, pinyin, pinyin_syllables, gloss_en FROM utterance WHERE id = ?',
    id,
  );
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
    pinyinSyllables: u.pinyin_syllables,
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

/**
 * Gaps between consecutive reps within a session, grouped by modality and whether the
 * rep introduced a word.
 *
 * Real elapsed time per rep, so a session estimate is measured rather than invented. A
 * made-up "about ten minutes" is worse than no estimate: it is wrong in a direction the
 * learner cannot predict, and they stop believing the next one.
 */
export async function repGaps(
  db: Db,
): Promise<{ modality: Modality; kind: 'review' | 'new'; gap: number }[]> {
  const rows = await db.all<{ modality: Modality; exercise_type: string; gap: number }>(`
    SELECT modality, exercise_type, gap FROM (
      SELECT modality,
             exercise_type,
             ts - LAG(ts) OVER (PARTITION BY session_id ORDER BY ts) AS gap
      FROM event
      WHERE kind = 'review' AND session_id IS NOT NULL AND modality IS NOT NULL
        -- Tone drills are logged as listening reviews but are a different activity and
        -- several times quicker; including them made a listening block look faster than
        -- it is, which is precisely the kind of estimate that stops being believed.
        AND exercise_type NOT IN ('tone_id', 'tone_same_diff')
    ) WHERE gap IS NOT NULL
  `);
  return rows.map((r) => ({
    modality: r.modality,
    kind: r.exercise_type === 'first-exposure' ? 'new' : 'review',
    gap: r.gap,
  }));
}


export async function countEventsSince(db: Db, since: number): Promise<number> {
  const r = await db.first<{ n: number }>(
    `SELECT count(*) AS n FROM event WHERE kind = 'review' AND ts >= ?`,
    since,
  );
  return r?.n ?? 0;
}

/**
 * Reps per local day, and the points earned, for the streak and level.
 *
 * Local dates rather than UTC: a session at 11pm belongs to that evening, and a streak
 * that rolls over mid-evening would be both wrong and infuriating.
 */
export async function dailyActivity(
  db: Db,
): Promise<{ day: string; reps: number; modality: Modality | null; isNew: number; result: string | null }[]> {
  return db.all(`
    SELECT date(ts / 1000, 'unixepoch', 'localtime') AS day,
           count(*) AS reps,
           modality,
           CASE WHEN exercise_type = 'first-exposure' THEN 1 ELSE 0 END AS isNew,
           result
    FROM event
    WHERE kind = 'review'
    GROUP BY day, modality, isNew, result
  `);
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

/**
 * A sentence suitable for dictation: every word in it already introduced, and a
 * verified syllable split to grade against.
 *
 * Restricted to fully-known sentences because dictation demands every syllable at once
 * — an unknown word in the middle makes the whole item unanswerable, and the learner
 * cannot tell whether they misheard a tone or simply never met the word. Ordered by
 * least recently heard so the same handful do not repeat.
 */
export async function pickDictation(
  db: Db,
  introducedConceptIds: number[],
): Promise<{ id: number } | undefined> {
  if (!introducedConceptIds.length) return undefined;
  const list = introducedConceptIds.join(',');
  return db.first<{ id: number }>(`
    SELECT u.id
    FROM utterance u
    JOIN utterance_concept uc ON uc.utterance_id = u.id
    WHERE u.status = 'approved' AND u.pinyin_syllables IS NOT NULL
    GROUP BY u.id
    HAVING count(*) = sum(CASE WHEN uc.concept_id IN (${list}) THEN 1 ELSE 0 END)
    ORDER BY COALESCE(
      (SELECT max(ts) FROM event e
        WHERE e.utterance_id = u.id AND e.exercise_type = 'dictation'), 0
    ), u.id
    LIMIT 1
  `);
}

/** The card's row id without touching its state — for logging a practice rep. */
export async function cardId(
  db: Db,
  conceptId: number,
  modality: Modality,
): Promise<number | null> {
  const r = await db.first<{ id: number }>(
    'SELECT id FROM card WHERE concept_id = ? AND modality = ?',
    conceptId,
    modality,
  );
  return r?.id ?? null;
}


/**
 * Other sentences to use as wrong answers in sentence-level Meaning Match.
 *
 * The options are English, so there is no need for the learner to know the Chinese in
 * them — requiring that made the exercise unavailable at twenty known words, since
 * almost no sentence was fully covered.
 *
 * Preference goes to sentences sharing a word with the target, and then to similar
 * length. Both matter: four sentences on unrelated topics can be eliminated without
 * listening at all, and a long sentence beside three short ones gives the answer away
 * by shape.
 */
export async function sentenceOptions(
  db: Db,
  excludeUtteranceId: number,
  targetLength: number,
  limit = 3,
): Promise<{ id: number; glossEn: string }[]> {
  return db.all<{ id: number; glossEn: string }>(
    `SELECT u.id, u.gloss_en AS glossEn,
            EXISTS (
              SELECT 1 FROM utterance_concept a
              JOIN utterance_concept b ON b.concept_id = a.concept_id
              WHERE a.utterance_id = u.id AND b.utterance_id = ?
            ) AS shares
     FROM utterance u
     WHERE u.status = 'approved' AND u.id != ? AND u.gloss_en != ''
     ORDER BY shares DESC, abs(length(u.hanzi) - ?), random()
     LIMIT ?`,
    excludeUtteranceId,
    excludeUtteranceId,
    targetLength,
    limit,
  );
}

/**
 * A sentence to actually say to someone today.
 *
 * The strongest asset in this project is not a counter — it is a fluent speaker in the
 * same house. A phrase used on a real person once beats a great deal of drilling: it is
 * retrieval under pressure, it has a consequence, and someone is waiting for it.
 *
 * Ranked by how many of its words are still unknown, then by how much *personal*
 * vocabulary it uses — the baby, the house, the two of them — because those are the
 * ones there will be an occasion to say.
 *
 * Requiring every word to be known was too strict to work: at twenty introduced words
 * exactly one sentence in the corpus qualified, so the "phrase of the day" was the same
 * phrase every day. A sentence with one unfamiliar word is perfectly sayable when it is
 * being read off a screen, provided the UI does not claim otherwise — hence
 * `unknownCount` comes back with it.
 */
export async function phraseOfTheDay(
  db: Db,
  modality: Modality,
  dayIndex: number,
): Promise<{
  hanzi: string;
  hanziTrad: string;
  pinyin: string;
  glossEn: string;
  unknownCount: number;
} | null> {
  const rows = await db.all<{
    hanzi: string;
    hanzi_trad: string;
    pinyin: string;
    gloss_en: string;
    unknown: number;
    personal: number;
  }>(
    `SELECT u.hanzi, u.hanzi_trad, u.pinyin, u.gloss_en,
            sum(CASE WHEN EXISTS (
              SELECT 1 FROM card k
              WHERE k.concept_id = c.id AND k.modality = ? AND k.introduced_at IS NOT NULL
            ) THEN 0 ELSE 1 END) AS unknown,
            sum(CASE WHEN c.source = 'personal' THEN 1 ELSE 0 END) AS personal
     FROM utterance u
     JOIN utterance_concept uc ON uc.utterance_id = u.id
     JOIN concept c            ON c.id = uc.concept_id
     WHERE u.status = 'approved'
     GROUP BY u.id
     HAVING unknown <= 1 AND personal > 0
     ORDER BY unknown, personal DESC, u.id`,
    modality,
  );
  if (!rows.length) return null;

  // Rotate within the best tier so the phrase changes daily without drifting into
  // sentences there is no occasion to use.
  const top = rows.filter((r) => r.unknown === rows[0]!.unknown && r.personal === rows[0]!.personal);
  const pool = top.length > 1 ? top : rows;
  const pick = pool[dayIndex % pool.length]!;
  return {
    hanzi: pick.hanzi,
    hanziTrad: pick.hanzi_trad,
    pinyin: pick.pinyin,
    glossEn: pick.gloss_en,
    unknownCount: pick.unknown,
  };
}
