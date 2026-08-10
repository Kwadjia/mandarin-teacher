/**
 * Speaking route tests.
 *
 * The scorer is injected, so grading, card advance and the event log are all exercised
 * without a GPU or a running Python service. What is tested here is the API's
 * behaviour; whether the measurement itself is any good is a different question,
 * answered by pipeline/speech_score.py --calibrate against real audio.
 *
 *   node --test --experimental-strip-types test/speech.test.ts
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
const clock = new Date('2026-03-01T09:00:00.000Z');

let dir: string;
let db: NodeDb;
let conceptIds: number[];
let utteranceId: number;
let audioId: number;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'mt-speech-'));
  db = new NodeDb(join(dir, 'test.db'));
  migrate(db, join(SCHEMA, 'migrations'));

  const now = clock.getTime();
  const concept = db.raw.prepare(
    `INSERT INTO concept (kind, headword, headword_trad, pinyin, gloss_en, hsk_level, freq_rank, source, created_at)
     VALUES ('word', ?, ?, ?, ?, 1, ?, 'core', ?) RETURNING id`,
  );
  conceptIds = [
    (concept.get('宝宝', '寶寶', 'bǎobao', 'baby', 1, now) as { id: number }).id,
    (concept.get('睡觉', '睡覺', 'shuìjiào', 'to sleep', 2, now) as { id: number }).id,
    (concept.get('了', '了', 'le', 'aspect particle', 3, now) as { id: number }).id,
  ];

  utteranceId = (
    db.raw
      .prepare(
        `INSERT INTO utterance (hanzi, hanzi_trad, pinyin, gloss_en, created_at)
         VALUES (?, ?, ?, ?, ?) RETURNING id`,
      )
      .get('宝宝睡觉了。', '寶寶睡覺了。', 'bǎobao shuìjiào le', "The baby's asleep.", now) as {
      id: number;
    }
  ).id;
  conceptIds.forEach((cid, i) =>
    db.raw
      .prepare('INSERT INTO utterance_concept (utterance_id, concept_id, position) VALUES (?,?,?)')
      .run(utteranceId, cid, i),
  );
  audioId = Number(
    db.raw
      .prepare(
        `INSERT INTO audio (utterance_id, storage_key, provider, voice, variety, rate, created_at)
         VALUES (?, 'u1.mp3', 'edge', 'zh-TW-HsiaoChenNeural', 'tw', '+0%', ?)`,
      )
      .run(utteranceId, now).lastInsertRowid,
  );
});

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const syllable = (char: string, verdict: string, correct = true) => ({
  char,
  said: correct ? char : '？',
  pinyin: 'baoˇ',
  saidPinyin: correct ? 'baoˇ' : 'ba4',
  tone: 3,
  heardTone: 3,
  correct,
  distance: correct ? 0.4 : null,
  verdict,
  learner: [0, 1],
  reference: [0, 1],
});

/** A scorer returning whatever the test asks for, recording what it was handed. */
function stub(overrides: Record<string, unknown> = {}) {
  const calls: any[] = [];
  const fn = async (input: any) => {
    calls.push(input);
    return {
      unusable: false,
      reason: null,
      transcript: '宝宝睡觉了',
      target: '宝宝睡觉了',
      syllables: [],
      totalSyllables: 5,
      correctSyllables: 5,
      toneErrors: 0,
      scoredSyllables: 5,
      meanToneDistance: 0.4,
      ...overrides,
    } as any;
  };
  return { fn, calls };
}

const appWith = (scoreSpeech?: any) => createApp({ db, now: () => clock, scoreSpeech });

async function speak(
  app: ReturnType<typeof createApp>,
  fields: Record<string, string>,
  withAudio = true,
) {
  const form = new FormData();
  if (withAudio) form.set('audio', new Blob(['fake-audio'], { type: 'audio/webm' }), 'a.webm');
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const res = await app.request('/api/speak', { method: 'POST', body: form });
  return { status: res.status, body: (await res.json()) as any };
}

describe('POST /api/speak', () => {
  it('reports unavailable, with the remedy, when no scorer is configured', async () => {
    const { status, body } = await speak(appWith(undefined), {
      conceptId: String(conceptIds[0]),
      utteranceId: String(utteranceId),
    });
    assert.equal(status, 503);
    assert.match(body.error, /npm run speech/);
  });

  /**
   * Imitation is not production. A perfect first attempt right after hearing the
   * sentence would otherwise grade `easy`, which FSRS turns into a two-week interval
   * for a motor skill that has been performed exactly once.
   */
  it('caps a flawless first attempt at good, then allows easy on the next', async () => {
    const cid = conceptIds[0]!;
    const first = await speak(appWith(stub().fn), {
      conceptId: String(cid),
      utteranceId: String(utteranceId),
      replays: '0',
    });

    assert.equal(first.status, 200);
    assert.equal(first.body.grade, 'good');
    assert.ok(first.body.intervalDays < 7, `first interval was ${first.body.intervalDays}d`);
    assert.equal(first.body.score.transcript, '宝宝睡觉了');

    const card = db.raw
      .prepare("SELECT introduced_at FROM card WHERE concept_id = ? AND modality = 'speak'")
      .get(cid) as { introduced_at: number } | undefined;
    assert.ok(card?.introduced_at, 'the attempt should have introduced a speak card');

    const second = await speak(appWith(stub().fn), {
      conceptId: String(cid),
      utteranceId: String(utteranceId),
      replays: '0',
    });
    assert.equal(second.body.grade, 'easy');
  });

  // The ordering the whole exercise rests on: a wrong word is a recall failure the
  // scheduler should act on, a drifting tone is a motor skill that more reps fix.
  it('ranks a wrong word below a wrong tone', async () => {
    const cid = String(conceptIds[1]);

    const toneOff = await speak(
      appWith(stub({ toneErrors: 3, syllables: [syllable('睡', 'off')] }).fn),
      { conceptId: cid, utteranceId: String(utteranceId) },
    );
    assert.equal(toneOff.body.grade, 'hard');

    const wrongWord = await speak(
      appWith(stub({ correctSyllables: 2, syllables: [syllable('睡', 'wrong', false)] }).fn),
      { conceptId: cid, utteranceId: String(utteranceId) },
    );
    assert.equal(wrongWord.body.grade, 'again');
  });

  it('logs the verdicts but not the pitch contours', async () => {
    const cid = conceptIds[2]!;
    await speak(
      appWith(stub({ syllables: [syllable('了', 'good'), syllable('宝', 'off')] }).fn),
      { conceptId: String(cid), utteranceId: String(utteranceId), replays: '2' },
    );

    const row = db.raw
      .prepare(
        "SELECT exercise_type, replays, payload FROM event WHERE concept_id = ? AND modality = 'speak' ORDER BY id DESC LIMIT 1",
      )
      .get(cid) as { exercise_type: string; replays: number; payload: string };

    assert.equal(row.exercise_type, 'shadow');
    assert.equal(row.replays, 2);
    const payload = JSON.parse(row.payload);
    assert.deepEqual(payload.verdicts, ['good', 'off']);
    // Hundreds of floats per attempt, worth drawing once and never reading again.
    assert.equal(payload.syllables, undefined);
  });

  it('compares against the clip that was actually heard', async () => {
    const { fn, calls } = stub();
    await speak(appWith(fn), {
      conceptId: String(conceptIds[0]),
      utteranceId: String(utteranceId),
      audioId: String(audioId),
    });
    assert.equal(calls.at(-1).reference, 'u1.mp3');
    assert.equal(calls.at(-1).hanzi, '宝宝睡觉了。');
    assert.equal(calls.at(-1).pinyin, 'bǎobao shuìjiào le');
  });

  it('rejects a request carrying no recording', async () => {
    const { status } = await speak(
      appWith(stub().fn),
      { conceptId: String(conceptIds[0]), utteranceId: String(utteranceId) },
      false,
    );
    assert.equal(status, 400);
  });

  it('rejects an unknown utterance', async () => {
    const { status } = await speak(appWith(stub().fn), {
      conceptId: String(conceptIds[0]),
      utteranceId: '99999',
    });
    assert.equal(status, 404);
  });

  /**
   * The failure that mattered most in real use. Whisper hallucinates on unclear input —
   * live attempts came back as "99888" and "宝宝SOLA" — and grading those wrote `again`
   * against words that were probably said fine. A microphone problem must never be
   * recorded as a failure to speak Mandarin.
   */
  it('does not grade or touch the card when the recording is unusable', async () => {
    const cid = conceptIds[1]!;
    const cardBefore = db.raw
      .prepare("SELECT fsrs_state, due_at FROM card WHERE concept_id = ? AND modality = 'speak'")
      .get(cid) as { fsrs_state: string; due_at: number } | undefined;
    const reviewsBefore = (
      db.raw
        .prepare("SELECT count(*) AS n FROM event WHERE concept_id = ? AND kind = 'review'")
        .get(cid) as { n: number }
    ).n;

    const { status, body } = await speak(
      appWith(
        stub({
          unusable: true,
          reason: 'no speech in the recording — check the microphone',
          transcript: '',
          totalSyllables: 0,
          correctSyllables: 0,
        }).fn,
      ),
      { conceptId: String(cid), utteranceId: String(utteranceId) },
    );

    assert.equal(status, 200);
    assert.equal(body.unusable, true);
    assert.match(body.reason, /no speech/);
    assert.equal(body.grade, undefined, 'an unusable recording must not produce a grade');

    const cardAfter = db.raw
      .prepare("SELECT fsrs_state, due_at FROM card WHERE concept_id = ? AND modality = 'speak'")
      .get(cid) as { fsrs_state: string; due_at: number } | undefined;
    assert.deepEqual(cardAfter, cardBefore, 'the card must be untouched');

    const reviewsAfter = (
      db.raw
        .prepare("SELECT count(*) AS n FROM event WHERE concept_id = ? AND kind = 'review'")
        .get(cid) as { n: number }
    ).n;
    assert.equal(reviewsAfter, reviewsBefore, 'no review event should be written');

    // It is still recorded, as a note — visible in the log, invisible to every stat,
    // all of which filter on kind = 'review'.
    const note = db.raw
      .prepare("SELECT payload FROM event WHERE concept_id = ? AND kind = 'note' ORDER BY id DESC LIMIT 1")
      .get(cid) as { payload: string } | undefined;
    assert.ok(note, 'the attempt should be logged as a note');
    assert.equal(JSON.parse(note!.payload).unusable, true);
  });

  it('counts a wrong tone on a correct sound as a tone error, not a wrong word', async () => {
    const cid = conceptIds[2]!;
    // 尿 heard as 鸟: same base syllable, tone 4 against tone 3.
    const { body } = await speak(
      appWith(
        stub({
          correctSyllables: 4,
          totalSyllables: 4,
          toneErrors: 1,
          scoredSyllables: 4,
          syllables: [
            {
              char: '尿', said: '鸟', pinyin: 'niaoˋ', saidPinyin: 'niaoˇ',
              tone: 4, heardTone: 3, correct: true, distance: null,
              verdict: 'tone', learner: [], reference: [],
            },
          ],
        }).fn,
      ),
      { conceptId: String(cid), utteranceId: String(utteranceId) },
    );

    // Every sound landed, so this is not `again` — it is a tone to work on.
    assert.equal(body.grade, 'good');
    const row = db.raw
      .prepare("SELECT payload FROM event WHERE concept_id = ? AND kind = 'review' ORDER BY id DESC LIMIT 1")
      .get(cid) as { payload: string };
    assert.deepEqual(JSON.parse(row.payload).verdicts, ['tone']);
  });

  it('surfaces a scorer crash as unavailable rather than a 500', async () => {
    const { status, body } = await speak(
      appWith(async () => {
        throw new Error('CUDA out of memory');
      }),
      { conceptId: String(conceptIds[0]), utteranceId: String(utteranceId) },
    );
    assert.equal(status, 503);
    assert.match(body.error, /CUDA out of memory/);
  });
});

describe('GET /api/next?modality=speak', () => {
  /**
   * Listening first, enforced rather than assumed. Without this the speak queue would
   * introduce its own new vocabulary and ask for production of a word never heard —
   * which is how a mispronunciation gets drilled in before there is anything to
   * compare it against.
   */
  it('offers only words whose listening card already exists', async () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'mt-speak-order-'));
    const db2 = new NodeDb(join(dir2, 'test.db'));
    migrate(db2, join(SCHEMA, 'migrations'));
    const now = clock.getTime();

    const cid = (
      db2.raw
        .prepare(
          `INSERT INTO concept (kind, headword, headword_trad, pinyin, gloss_en, hsk_level, freq_rank, source, created_at)
           VALUES ('word','好','好','hǎo','good',1,1,'core',?) RETURNING id`,
        )
        .get(now) as { id: number }
    ).id;
    const uid = (
      db2.raw
        .prepare(
          `INSERT INTO utterance (hanzi, hanzi_trad, pinyin, gloss_en, created_at)
           VALUES ('好。','好。','hǎo','good.',?) RETURNING id`,
        )
        .get(now) as { id: number }
    ).id;
    db2.raw
      .prepare('INSERT INTO utterance_concept (utterance_id, concept_id, position) VALUES (?,?,0)')
      .run(uid, cid);
    db2.raw
      .prepare(
        `INSERT INTO audio (utterance_id, storage_key, provider, voice, variety, rate, created_at)
         VALUES (?, 'x.mp3', 'edge', 'v', 'tw', '+0%', ?)`,
      )
      .run(uid, now);

    const app2 = createApp({ db: db2, now: () => clock });

    const before = (await (await app2.request('/api/next?modality=speak')).json()) as any;
    assert.equal(before.type, 'idle', 'nothing is speakable before anything is heard');
    assert.equal(before.queue.total, 0);

    db2.raw
      .prepare(
        `INSERT INTO card (concept_id, modality, fsrs_state, due_at, introduced_at)
         VALUES (?, 'listen', '{}', ?, ?)`,
      )
      .run(cid, now, now);

    const after = (await (await app2.request('/api/next?modality=speak')).json()) as any;
    assert.equal(after.type, 'introduce');
    assert.equal(after.concept.id, cid);
    assert.equal(after.queue.total, 1);

    db2.close();
    rmSync(dir2, { recursive: true, force: true });
  });
});
