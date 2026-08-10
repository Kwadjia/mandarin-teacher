/**
 * API integration tests. Real database, real scheduler, no HTTP server — Hono's
 * `app.request()` exercises the whole stack in-process.
 *
 *   node --test --experimental-strip-types test/api.test.ts
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, NodeDb } from '@mt/schema/node';
import { createApp } from '../src/app.ts';

const SCHEMA = resolve(dirname(fileURLToPath(import.meta.url)), '../../schema');

let dir: string;
let db: NodeDb;
let app: ReturnType<typeof createApp>;
let clock = new Date('2026-03-01T09:00:00.000Z');

const DAY = 86_400_000;
const advance = (days: number) => {
  clock = new Date(clock.getTime() + days * DAY);
};

/** A tiny corpus: three words, two sentences, one clip each. */
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'mt-api-'));
  db = new NodeDb(join(dir, 'test.db'));
  migrate(db, join(SCHEMA, 'migrations'));

  const now = clock.getTime();
  const concept = db.raw.prepare(
    `INSERT INTO concept (kind, headword, headword_trad, pinyin, gloss_en, hsk_level, freq_rank, source, created_at)
     VALUES ('word', ?, ?, ?, ?, 1, ?, ?, ?) RETURNING id`,
  );
  const ids = [
    (concept.get('宝宝', '寶寶', 'bǎobao', 'baby', 1, 'personal', now) as { id: number }).id,
    (concept.get('睡觉', '睡覺', 'shuìjiào', 'to sleep', 2, 'core', now) as { id: number }).id,
    (concept.get('了', '了', 'le', 'aspect particle', 3, 'core', now) as { id: number }).id,
  ];

  const utt = db.raw.prepare(
    `INSERT INTO utterance (hanzi, hanzi_trad, pinyin, gloss_en, created_at)
     VALUES (?, ?, ?, ?, ?) RETURNING id`,
  );
  const link = db.raw.prepare(
    'INSERT INTO utterance_concept (utterance_id, concept_id, position) VALUES (?,?,?)',
  );
  const audio = db.raw.prepare(
    `INSERT INTO audio (utterance_id, storage_key, provider, voice, variety, rate, created_at)
     VALUES (?, ?, 'edge', 'zh-TW-HsiaoChenNeural', 'tw', '+0%', ?)`,
  );

  const u1 = (utt.get('宝宝睡觉了。', '寶寶睡覺了。', 'bǎobao shuìjiào le', "The baby's asleep.", now) as { id: number }).id;
  ids.forEach((cid, i) => link.run(u1, cid, i));
  audio.run(u1, 'u1.mp3', now);

  const u2 = (utt.get('宝宝了。', '寶寶了。', 'bǎobao le', 'baby (test)', now) as { id: number }).id;
  link.run(u2, ids[0]!, 0);
  link.run(u2, ids[2]!, 1);
  audio.run(u2, 'u2.mp3', now);

  app = createApp({ db, now: () => clock });
});

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = async (path: string) => {
  const res = await app.request(path);
  return { status: res.status, body: (await res.json()) as any };
};
const post = async (path: string, body?: unknown) => {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

describe('health and sessions', () => {
  it('reports healthy', async () => {
    assert.deepEqual((await get('/api/health')).body, { ok: true });
  });

  it('opens and closes a session', async () => {
    const { body } = await post('/api/session');
    assert.ok(body.sessionId > 0);
    assert.deepEqual((await post(`/api/session/${body.sessionId}/end`)).body, { ok: true });
  });
});

describe('GET /api/next', () => {
  it('introduces a new concept when nothing has been learned', async () => {
    const { body } = await get('/api/next');
    assert.equal(body.type, 'introduce');
    assert.ok(body.concept.id > 0);
    assert.equal(body.queue.introduced, 0);
  });

  it('prefers the personal word first', async () => {
    // 宝宝 is source=personal, which the priority weights favour.
    const { body } = await get('/api/next');
    assert.equal(body.concept.headword, '宝宝');
  });

  it('returns a playable utterance with clip urls', async () => {
    const { body } = await get('/api/next');
    assert.ok(body.utterance);
    assert.ok(body.utterance.clips.length > 0);
    assert.match(body.utterance.clips[0].url, /^\/audio\//);
    assert.ok(body.utterance.hanziTrad.length > 0);
  });
});

describe('POST /api/answer', () => {
  let sessionId: number;
  let conceptId: number;
  let utteranceId: number;

  before(async () => {
    sessionId = (await post('/api/session')).body.sessionId;
    const next = (await get('/api/next')).body;
    conceptId = next.concept.id;
    utteranceId = next.utterance.id;
  });

  it('grades a fast clean answer as easy and schedules it forward', async () => {
    const { body } = await post('/api/answer', {
      sessionId,
      conceptId,
      utteranceId,
      exerciseType: 'listen-commit',
      outcome: { kind: 'commit', gotIt: true, replays: 0, latencyMs: 1200, committedBeforeReveal: true },
    });
    assert.equal(body.grade, 'easy');
    assert.ok(body.dueAt > clock.getTime());
  });

  it('creates the card and marks it introduced', async () => {
    const card = db.raw
      .prepare('SELECT * FROM card WHERE concept_id = ? AND modality = ?')
      .get(conceptId, 'listen') as { introduced_at: number | null; fsrs_state: string };
    assert.notEqual(card.introduced_at, null);
    assert.ok(JSON.parse(card.fsrs_state).reps > 0);
  });

  it('writes a review event carrying the commit flag and latency', async () => {
    const ev = db.raw
      .prepare(`SELECT * FROM event WHERE kind = 'review' ORDER BY id DESC LIMIT 1`)
      .get() as Record<string, unknown>;
    assert.equal(ev.concept_id, conceptId);
    assert.equal(ev.result, 'easy');
    assert.equal(ev.latency_ms, 1200);
    assert.equal(ev.committed_before_reveal, 1);
    assert.equal(ev.session_id, sessionId);
  });

  // Exposure is counted but must not drive FSRS — mixing incidental exposure into a
  // scheduler that assumes discrete scheduled reviews is how these break.
  //
  // The expected set is derived from whichever sentence the selector actually chose,
  // rather than hardcoded: with 宝宝 as the target it correctly prefers 宝宝了。 over
  // 宝宝睡觉了。 because that has fewer unmet words, so the count depends on selection.
  it('logs exposure for exactly the other words in the sentence served', async () => {
    const expected = (
      db.raw
        .prepare('SELECT concept_id FROM utterance_concept WHERE utterance_id = ?')
        .all(utteranceId) as { concept_id: number }[]
    )
      .map((r) => r.concept_id)
      .filter((id) => id !== conceptId)
      .sort();

    const actual = (
      db.raw
        .prepare(`SELECT DISTINCT concept_id FROM event WHERE kind = 'exposure'`)
        .all() as { concept_id: number }[]
    )
      .map((r) => r.concept_id)
      .sort();

    assert.ok(expected.length > 0, 'the served sentence should contain other words');
    assert.deepEqual(actual, expected);
    assert.ok(!actual.includes(conceptId), 'the target must not be logged as exposure');
  });

  it('does not create cards for merely-exposed concepts', () => {
    const cards = db.raw.prepare('SELECT count(*) AS n FROM card').get() as { n: number };
    assert.equal(cards.n, 1);
  });

  it('grades a miss as again', async () => {
    const { body } = await post('/api/answer', {
      sessionId,
      conceptId,
      utteranceId,
      exerciseType: 'listen-commit',
      outcome: { kind: 'commit', gotIt: false, replays: 2, latencyMs: 9000 },
    });
    assert.equal(body.grade, 'again');
  });

  it('discounts a correct answer that needed replays', async () => {
    const { body } = await post('/api/answer', {
      sessionId,
      conceptId,
      utteranceId,
      exerciseType: 'listen-commit',
      outcome: { kind: 'commit', gotIt: true, replays: 2, latencyMs: 800 },
    });
    assert.equal(body.grade, 'hard');
  });

  it('accepts a dictation outcome and stores the detail in payload', async () => {
    const { body } = await post('/api/answer', {
      sessionId,
      conceptId,
      utteranceId,
      exerciseType: 'dictation_tones',
      outcome: { kind: 'dictation', correctSyllables: 1, toneErrors: 4, totalSyllables: 5, replays: 0 },
    });
    assert.equal(body.grade, 'hard'); // segmentals fine, tones shaky

    const ev = db.raw
      .prepare(`SELECT payload FROM event WHERE exercise_type = 'dictation_tones' LIMIT 1`)
      .get() as { payload: string };
    assert.equal(JSON.parse(ev.payload).toneErrors, 4);
  });

  it('rejects a malformed body', async () => {
    assert.equal((await post('/api/answer', { exerciseType: 'x' })).status, 400);
  });
});

describe('the review loop over time', () => {
  it('moves from introduce to review once everything is known, then goes idle', async () => {
    // Learn everything available.
    for (let i = 0; i < 12; i++) {
      const next = (await get('/api/next')).body;
      if (next.type === 'idle') break;
      await post('/api/answer', {
        conceptId: next.concept.id,
        utteranceId: next.utterance?.id ?? null,
        exerciseType: 'listen-commit',
        outcome: { kind: 'commit', gotIt: true, replays: 0, latencyMs: 1500 },
      });
    }
    const introduced = db.raw.prepare('SELECT count(*) AS n FROM card').get() as { n: number };
    assert.equal(introduced.n, 3);

    // Nothing due yet, nothing new left.
    assert.equal((await get('/api/next')).body.type, 'idle');

    // Come back later and there is review work.
    advance(30);
    const later = (await get('/api/next')).body;
    assert.equal(later.type, 'review');
    assert.ok(later.utterance);
  });

  it('never serves a sentence containing an unmet word once everything is met', async () => {
    const next = (await get('/api/next')).body;
    if (next.type === 'review') assert.equal(next.unknownCount, 0);
  });
});

describe('GET /api/stats', () => {
  it('reports coverage, queue depth, and latency', async () => {
    const { body } = await get('/api/stats');
    assert.equal(body.modality, 'listen');
    assert.equal(body.total, 3);
    assert.equal(body.introduced, 3);
    assert.ok(typeof body.hsk.estimate === 'number');
    assert.ok(body.medianLatencyMs > 0);
    assert.deepEqual(body.stranded, []);
  });
});

describe('POST /api/capture', () => {
  it('segments against known vocabulary and flags what is new', async () => {
    const { body } = await post('/api/capture', { text: '宝宝睡觉了', capturedBy: 'jasmine' });
    assert.equal(body.unknown.length, 0);
    assert.equal(body.knownFraction, 1);
    assert.ok(body.known.some((k: any) => k.headword === '宝宝'));
  });

  it('identifies words not yet in the curriculum', async () => {
    const { body } = await post('/api/capture', { text: '宝宝喝水' });
    assert.deepEqual(body.unknown, ['喝', '水']);
    assert.ok(body.knownFraction < 1);
  });

  it('stores the raw text immediately so nothing blocks the person typing', async () => {
    const { body } = await post('/api/capture', { text: '奶奶来了' });
    const row = db.raw
      .prepare('SELECT raw_text, status FROM capture WHERE id = ?')
      .get(body.captureId) as { raw_text: string; status: string };
    assert.equal(row.raw_text, '奶奶来了');
    assert.equal(row.status, 'new');
  });

  it('rejects empty text', async () => {
    assert.equal((await post('/api/capture', { text: '   ' })).status, 400);
  });

  it('lists captures newest first', async () => {
    const { body } = await get('/api/captures');
    assert.ok(body.length >= 3);
    assert.equal(body[0].raw_text, '奶奶来了');
  });
});
