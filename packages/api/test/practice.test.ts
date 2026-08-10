/**
 * Practice mode: unlimited drilling of known words, without disturbing the schedule.
 *
 * The scheduling rule is the part worth testing hard. An hour of enthusiastic practice
 * must not push every card's due date into the far future — that is the failure mode
 * that quietly destroys an SRS, and it would take weeks to notice from inside the app.
 *
 *   node --test --experimental-strip-types test/practice.test.ts
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
let clock = new Date('2026-03-01T09:00:00.000Z');

let dir: string;
let db: NodeDb;
let app: ReturnType<typeof createApp>;
let firstConcept: number;
let secondConcept: number;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'mt-practice-'));
  db = new NodeDb(join(dir, 'test.db'));
  migrate(db, join(SCHEMA, 'migrations'));

  const now = clock.getTime();
  const concept = db.raw.prepare(
    `INSERT INTO concept (kind, headword, headword_trad, pinyin, gloss_en, hsk_level, freq_rank, source, created_at)
     VALUES ('word', ?, ?, ?, ?, 1, ?, 'core', ?) RETURNING id`,
  );
  firstConcept = (concept.get('好', '好', 'hǎo', 'good', 1, now) as { id: number }).id;
  secondConcept = (concept.get('人', '人', 'rén', 'person', 2, now) as { id: number }).id;

  const uid = (
    db.raw
      .prepare(
        `INSERT INTO utterance (hanzi, hanzi_trad, pinyin, gloss_en, created_at)
         VALUES ('好人。', '好人。', 'hǎo rén', 'a good person', ?) RETURNING id`,
      )
      .get(now) as { id: number }
  ).id;
  [firstConcept, secondConcept].forEach((cid, i) =>
    db.raw
      .prepare('INSERT INTO utterance_concept (utterance_id, concept_id, position) VALUES (?,?,?)')
      .run(uid, cid, i),
  );
  db.raw
    .prepare(
      `INSERT INTO audio (utterance_id, storage_key, provider, voice, variety, rate, created_at)
       VALUES (?, 'x.mp3', 'edge', 'v', 'tw', '+0%', ?)`,
    )
    .run(uid, now);

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
const post = async (path: string, body: unknown) => {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

const card = (conceptId: number) =>
  db.raw
    .prepare("SELECT due_at, fsrs_state FROM card WHERE concept_id = ? AND modality = 'listen'")
    .get(conceptId) as { due_at: number; fsrs_state: string } | undefined;

describe('practice mode', () => {
  it('offers nothing to practise before anything is learned', async () => {
    const { body } = await get('/api/next?modality=listen&mode=practice');
    assert.equal(body.type, 'idle');
  });

  it('offers a known word once one has been introduced', async () => {
    // Introduce the first word through the normal path.
    await post('/api/answer', {
      conceptId: firstConcept,
      exerciseType: 'first-exposure',
      outcome: { kind: 'commit', gotIt: true, replays: 0, latencyMs: null },
    });

    const { body } = await get('/api/next?modality=listen&mode=practice');
    assert.equal(body.type, 'review');
    assert.equal(body.practice, true);
    assert.equal(body.concept.id, firstConcept);
  });

  it('never introduces a new word, however long the session runs', async () => {
    for (let i = 0; i < 12; i++) {
      const { body } = await get('/api/next?modality=listen&mode=practice');
      assert.notEqual(body.type, 'introduce', 'practice must not introduce vocabulary');
      if (body.type === 'review') assert.equal(body.concept.id, firstConcept);
    }
    const introduced = db.raw
      .prepare("SELECT count(*) AS n FROM card WHERE modality = 'listen' AND introduced_at IS NOT NULL")
      .get() as { n: number };
    assert.equal(introduced.n, 1, 'still only the one word ever introduced');
  });

  /**
   * The rule that makes an hour of practice safe. Recalling a word early is not
   * evidence it would still be there on the due date, and crediting it would push the
   * interval out on no evidence at all.
   */
  it('does not move the card when an early answer is correct', async () => {
    const before = card(firstConcept);
    assert.ok(before);

    for (let i = 0; i < 5; i++) {
      await post('/api/answer', {
        conceptId: firstConcept,
        exerciseType: 'listen-commit',
        practice: true,
        outcome: { kind: 'commit', gotIt: true, replays: 0, latencyMs: 900 },
      });
    }

    assert.deepEqual(card(firstConcept), before, 'five correct practice reps changed nothing');
  });

  it('still logs the reps, so the work counts', async () => {
    const n = (
      db.raw
        .prepare("SELECT count(*) AS n FROM event WHERE kind = 'review' AND concept_id = ?")
        .get(firstConcept) as { n: number }
    ).n;
    assert.ok(n >= 6, `expected the practice reps to be logged, saw ${n}`);
  });

  // Failing is evidence whenever it happens, and a word just forgotten should not wait.
  it('does move the card when an early answer is wrong', async () => {
    const before = card(firstConcept);
    await post('/api/answer', {
      conceptId: firstConcept,
      exerciseType: 'listen-commit',
      practice: true,
      outcome: { kind: 'commit', gotIt: false, replays: 0, latencyMs: 4000 },
    });
    assert.notDeepEqual(card(firstConcept), before, 'a failed practice rep must reschedule');
  });

  // Reaching a genuinely due card through practice is still a real review.
  it('schedules normally once the card is actually due', async () => {
    const due = card(firstConcept)!.due_at;
    clock = new Date(due + 60_000);

    const before = card(firstConcept);
    await post('/api/answer', {
      conceptId: firstConcept,
      exerciseType: 'listen-commit',
      practice: true,
      outcome: { kind: 'commit', gotIt: true, replays: 0, latencyMs: 900 },
    });
    assert.notDeepEqual(card(firstConcept), before, 'a due card reviewed in practice advances');
  });
});
