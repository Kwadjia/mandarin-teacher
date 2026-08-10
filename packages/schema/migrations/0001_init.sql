-- Mandarin Teacher — initial schema.
-- SQLite dialect, D1-compatible (D1 *is* SQLite, so this file runs unmodified
-- against both a local file and Cloudflare D1).
--
-- Architectural rule (docs/design.md §2.1): `event` is the source of truth and is
-- append-only. `card` is a rebuildable cache — dropping it and replaying the event
-- log must reproduce it. The triggers at the bottom enforce the append-only part
-- rather than leaving it as a convention nobody remembers.

PRAGMA foreign_keys = ON;

-- ══ KNOWLEDGE SPINE ═════════════════════════════════════════════════════════

CREATE TABLE concept (
  id             INTEGER PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('word', 'grammar', 'character')),
  headword       TEXT NOT NULL,              -- Simplified; authored form
  headword_trad  TEXT NOT NULL,              -- Traditional; derived via opencc s2twp
  pinyin         TEXT NOT NULL,              -- part of identity: 长 cháng ≠ 长 zhǎng
  sense          TEXT,                       -- nullable discriminator, unused for now
  gloss_en       TEXT NOT NULL,
  hsk_level      INTEGER,
  freq_rank      INTEGER,
  source         TEXT NOT NULL DEFAULT 'core'
                 CHECK (source IN ('core', 'personal', 'emergent')),
  notes          TEXT,
  created_at     INTEGER NOT NULL,           -- epoch ms
  UNIQUE (kind, headword, pinyin, sense)
);

CREATE INDEX concept_source_idx ON concept (source);
CREATE INDEX concept_order_idx  ON concept (hsk_level, freq_rank);

-- Sparse by design. Real prerequisite edges are for grammar only — vocabulary
-- prerequisites are largely fiction (docs/design.md §2.5).
CREATE TABLE concept_edge (
  src_id    INTEGER NOT NULL REFERENCES concept (id) ON DELETE CASCADE,
  dst_id    INTEGER NOT NULL REFERENCES concept (id) ON DELETE CASCADE,
  relation  TEXT NOT NULL CHECK (relation IN
              ('prerequisite', 'confusable_with', 'contains', 'commonly_used_with')),
  PRIMARY KEY (src_id, dst_id, relation)
);

CREATE INDEX concept_edge_dst_idx ON concept_edge (dst_id, relation);

-- ══ CONTENT SPINE ═══════════════════════════════════════════════════════════

CREATE TABLE utterance (
  id             INTEGER PRIMARY KEY,
  hanzi          TEXT NOT NULL UNIQUE,
  hanzi_trad     TEXT NOT NULL,
  pinyin         TEXT NOT NULL,
  gloss_en       TEXT NOT NULL,
  source         TEXT NOT NULL DEFAULT 'generated'
                 CHECK (source IN ('generated', 'family', 'corpus')),
  source_detail  TEXT,                       -- "wife, 2026-08-14, changing table"
  status         TEXT NOT NULL DEFAULT 'approved'
                 CHECK (status IN ('draft', 'approved', 'retired')),
  notes          TEXT,                       -- native-reviewer comment
  created_at     INTEGER NOT NULL
);

CREATE INDEX utterance_status_idx ON utterance (status);

CREATE TABLE utterance_concept (
  utterance_id  INTEGER NOT NULL REFERENCES utterance (id) ON DELETE CASCADE,
  concept_id    INTEGER NOT NULL REFERENCES concept (id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  PRIMARY KEY (utterance_id, position)
);

CREATE INDEX utterance_concept_concept_idx ON utterance_concept (concept_id);

CREATE TABLE audio (
  id            INTEGER PRIMARY KEY,
  utterance_id  INTEGER NOT NULL REFERENCES utterance (id) ON DELETE CASCADE,
  storage_key   TEXT NOT NULL UNIQUE,        -- local path now, R2 key later; same string
  provider      TEXT NOT NULL,               -- 'edge' | 'azure' | 'native'
  voice         TEXT NOT NULL,               -- 'zh-TW-HsiaoChenNeural'
  variety       TEXT NOT NULL CHECK (variety IN ('tw', 'cn')),
  rate          TEXT NOT NULL,               -- '+0%' | '-15%'
  is_native     INTEGER NOT NULL DEFAULT 0,  -- 1 = an actual family recording
  duration_ms   INTEGER,
  created_at    INTEGER NOT NULL
);

CREATE INDEX audio_utterance_idx ON audio (utterance_id);

-- ══ SCHEDULER — a cache, rebuildable by replaying events ════════════════════

CREATE TABLE card (
  id             INTEGER PRIMARY KEY,
  concept_id     INTEGER NOT NULL REFERENCES concept (id) ON DELETE CASCADE,
  modality       TEXT NOT NULL CHECK (modality IN ('listen', 'speak', 'read')),
  fsrs_state     TEXT NOT NULL,              -- JSON, owned entirely by ts-fsrs
  due_at         INTEGER NOT NULL,           -- epoch ms
  introduced_at  INTEGER,                    -- null = never shown
  UNIQUE (concept_id, modality)
);

CREATE INDEX card_due_idx         ON card (modality, due_at);
CREATE INDEX card_introduced_idx  ON card (modality, introduced_at);

-- ══ TRUTH — append-only ═════════════════════════════════════════════════════

CREATE TABLE session (
  id          INTEGER PRIMARY KEY,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  kind        TEXT NOT NULL DEFAULT 'drill'
);

CREATE TABLE event (
  id                      INTEGER PRIMARY KEY,
  ts                      INTEGER NOT NULL,
  session_id              INTEGER REFERENCES session (id) ON DELETE SET NULL,
  kind                    TEXT NOT NULL CHECK (kind IN
                            ('review', 'exposure', 'capture', 'note')),
  concept_id              INTEGER REFERENCES concept (id) ON DELETE SET NULL,
  card_id                 INTEGER REFERENCES card (id) ON DELETE SET NULL,
  utterance_id            INTEGER REFERENCES utterance (id) ON DELETE SET NULL,
  audio_id                INTEGER REFERENCES audio (id) ON DELETE SET NULL,
  modality                TEXT CHECK (modality IN ('listen', 'speak', 'read')),
  exercise_type           TEXT,
  result                  TEXT CHECK (result IN ('again', 'hard', 'good', 'easy')),
  latency_ms              INTEGER,           -- audio-end → commitment. Precious.
  replays                 INTEGER NOT NULL DEFAULT 0,
  committed_before_reveal INTEGER,           -- data-integrity flag, docs/design.md §2.9
  payload                 TEXT               -- JSON escape hatch
);

CREATE INDEX event_ts_idx       ON event (ts);
CREATE INDEX event_concept_idx  ON event (concept_id, ts);
CREATE INDEX event_card_idx     ON event (card_id, ts);
CREATE INDEX event_kind_idx     ON event (kind, ts);

-- The append-only rule, enforced. If replaying the log can't rebuild `card`, the
-- entire learner-model design falls apart — so mutation is blocked at the database
-- rather than trusted to discipline.
CREATE TRIGGER event_no_update BEFORE UPDATE ON event
BEGIN
  SELECT RAISE(ABORT, 'event is append-only: UPDATE is not permitted');
END;

CREATE TRIGGER event_no_delete BEFORE DELETE ON event
BEGIN
  SELECT RAISE(ABORT, 'event is append-only: DELETE is not permitted');
END;

-- ══ INBOX ═══════════════════════════════════════════════════════════════════

-- Friction-free dump for anything heard around the house. Never blocks the person
-- capturing; the pipeline resolves it into concepts and utterances later.
CREATE TABLE capture (
  id             INTEGER PRIMARY KEY,
  ts             INTEGER NOT NULL,
  raw_text       TEXT,
  raw_audio_key  TEXT,
  captured_by    TEXT,                       -- 'arthur' | 'jasmine' | 'nainai'
  status         TEXT NOT NULL DEFAULT 'new'
                 CHECK (status IN ('new', 'processed', 'rejected')),
  notes          TEXT
);

CREATE INDEX capture_status_idx ON capture (status, ts);
