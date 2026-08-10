/**
 * Integration tests against a real SQLite database.
 *
 * With no ORM, this is what replaces compile-time query checking: every constraint
 * the schema claims to enforce is exercised here, so a typo or a missing index
 * surfaces in CI rather than at 6am with a baby on my shoulder.
 *
 * Uses Node's built-in test runner rather than Vitest — this package is pure Node
 * with no bundler in the picture, and Vite cannot resolve `node:sqlite`.
 *
 *   node --test --experimental-strip-types test/database.test.ts
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, NodeDb } from '../src/node.ts';
import { segment } from '../src/segment.ts';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');

let dir: string;
let db: NodeDb;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'mt-schema-'));
  db = new NodeDb(join(dir, 'test.db'));
  migrate(db, MIGRATIONS);
});

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const now = () => Date.now();

function insertConcept(headword: string, over: Record<string, string> = {}): number {
  return (
    db.raw
      .prepare(
        `INSERT INTO concept (kind, headword, headword_trad, pinyin, gloss_en, source, created_at)
         VALUES ('word', ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        headword,
        over.trad ?? headword,
        over.pinyin ?? 'x',
        over.gloss ?? 'g',
        over.source ?? 'core',
        now(),
      ) as { id: number }
  ).id;
}

const count = (table: string): number =>
  (db.raw.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('migrations', () => {
  it('creates every table the design calls for', () => {
    const tables = (
      db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
        name: string;
      }[]
    ).map((t) => t.name);
    for (const t of [
      'concept', 'concept_edge', 'utterance', 'utterance_concept', 'audio',
      'card', 'session', 'event', 'capture',
    ]) {
      assert.ok(tables.includes(t), `missing table ${t}`);
    }
  });

  it('is idempotent — re-running applies nothing', () => {
    assert.deepEqual(migrate(db, MIGRATIONS), []);
  });
});

describe('concept identity', () => {
  it('keys on pinyin as well as headword, so 长 cháng and 长 zhǎng coexist', () => {
    const a = insertConcept('长', { pinyin: 'cháng', gloss: 'long' });
    const b = insertConcept('长', { pinyin: 'zhǎng', gloss: 'to grow' });
    assert.notEqual(a, b);
  });

  it('rejects a true duplicate', () => {
    insertConcept('重复', { pinyin: 'chóngfù' });
    assert.throws(() => insertConcept('重复', { pinyin: 'chóngfù' }));
  });

  // SQLite treats NULLs as distinct inside UNIQUE, so a nullable `sense` would
  // make this constraint vacuous. It did, and a re-seed doubled the corpus.
  it('constrains identity even though sense is normally unset', () => {
    insertConcept('身份', { pinyin: 'shēnfèn' });
    assert.throws(() => insertConcept('身份', { pinyin: 'shēnfèn' }));
  });

  it('defaults sense to empty string rather than null', () => {
    const id = insertConcept('默认', { pinyin: 'mòrèn' });
    const row = db.raw.prepare('SELECT sense FROM concept WHERE id = ?').get(id) as {
      sense: string;
    };
    assert.equal(row.sense, '');
  });

  it('still allows a genuine sense split on the same headword and pinyin', () => {
    db.raw
      .prepare(
        `INSERT INTO concept (kind, headword, headword_trad, pinyin, sense, gloss_en, source, created_at)
         VALUES ('word','想','想','xiǎng','want','to want','core',?)`,
      )
      .run(now());
    db.raw
      .prepare(
        `INSERT INTO concept (kind, headword, headword_trad, pinyin, sense, gloss_en, source, created_at)
         VALUES ('word','想','想','xiǎng','miss','to miss someone','core',?)`,
      )
      .run(now());
    const n = (
      db.raw.prepare("SELECT count(*) AS n FROM concept WHERE headword = '想'").get() as {
        n: number;
      }
    ).n;
    assert.equal(n, 2);
  });

  it('rejects an invalid source', () => {
    assert.throws(() => insertConcept('无效', { pinyin: 'wúxiào', source: 'invented' }));
  });
});

// The architectural rule everything else depends on (docs/design.md §2.1).
// If the log can be edited, it is not a source of truth.
describe('event is append-only', () => {
  let eventId: number;

  before(() => {
    eventId = (
      db.raw
        .prepare(`INSERT INTO event (ts, kind, replays) VALUES (?, 'review', 0) RETURNING id`)
        .get(now()) as { id: number }
    ).id;
  });

  it('accepts inserts', () => {
    assert.ok(eventId > 0);
  });

  it('refuses UPDATE', () => {
    assert.throws(
      () => db.raw.prepare('UPDATE event SET result = ? WHERE id = ?').run('good', eventId),
      /append-only/,
    );
  });

  it('refuses DELETE', () => {
    assert.throws(
      () => db.raw.prepare('DELETE FROM event WHERE id = ?').run(eventId),
      /append-only/,
    );
  });

  it('still holds the row after both attempts', () => {
    assert.notEqual(db.raw.prepare('SELECT * FROM event WHERE id = ?').get(eventId), undefined);
  });

  it('rejects a result value outside the grade set', () => {
    assert.throws(() =>
      db.raw
        .prepare(
          `INSERT INTO event (ts, kind, result, replays) VALUES (?, 'review', 'brilliant', 0)`,
        )
        .run(now()),
    );
  });
});

describe('card', () => {
  it('allows one card per concept per modality and rejects a second', () => {
    const cid = insertConcept('卡片', { pinyin: 'kǎpiàn' });
    const ins = db.raw.prepare(
      `INSERT INTO card (concept_id, modality, fsrs_state, due_at) VALUES (?, ?, '{}', ?)`,
    );
    ins.run(cid, 'listen', now());
    ins.run(cid, 'read', now()); // different modality — fine
    assert.throws(() => ins.run(cid, 'listen', now()));
  });

  it('rejects an unknown modality', () => {
    const cid = insertConcept('模态', { pinyin: 'mótài' });
    assert.throws(() =>
      db.raw
        .prepare(
          `INSERT INTO card (concept_id, modality, fsrs_state, due_at) VALUES (?, 'telepathy', '{}', ?)`,
        )
        .run(cid, now()),
    );
  });
});

describe('foreign keys', () => {
  it('are enforced', () => {
    assert.throws(() =>
      db.raw
        .prepare(
          `INSERT INTO card (concept_id, modality, fsrs_state, due_at) VALUES (?, 'listen', '{}', ?)`,
        )
        .run(999_999, now()),
    );
  });

  it('cascade from utterance to its links and audio', () => {
    const cid = insertConcept('级联', { pinyin: 'jílián' });
    const uid = (
      db.raw
        .prepare(
          `INSERT INTO utterance (hanzi, hanzi_trad, pinyin, gloss_en, created_at)
           VALUES ('级联测试','級聯測試','jílián cèshì','cascade test',?) RETURNING id`,
        )
        .get(now()) as { id: number }
    ).id;
    db.raw
      .prepare('INSERT INTO utterance_concept (utterance_id, concept_id, position) VALUES (?,?,0)')
      .run(uid, cid);
    db.raw
      .prepare(
        `INSERT INTO audio (utterance_id, storage_key, provider, voice, variety, rate, created_at)
         VALUES (?, 'cascade.mp3', 'edge', 'v', 'tw', '+0%', ?)`,
      )
      .run(uid, now());

    db.raw.prepare('DELETE FROM utterance WHERE id = ?').run(uid);

    const links = db.raw
      .prepare('SELECT count(*) AS n FROM utterance_concept WHERE utterance_id = ?')
      .get(uid) as { n: number };
    const clips = db.raw
      .prepare('SELECT count(*) AS n FROM audio WHERE utterance_id = ?')
      .get(uid) as { n: number };
    assert.equal(links.n, 0);
    assert.equal(clips.n, 0);
  });
});

describe('the async Db adapter', () => {
  it('round-trips through the interface the API will use', async () => {
    const cid = insertConcept('异步', { pinyin: 'yìbù' });
    const row = await db.first<{ headword: string }>(
      'SELECT headword FROM concept WHERE id = ?',
      cid,
    );
    assert.equal(row?.headword, '异步');

    const all = await db.all<{ n: number }>('SELECT count(*) AS n FROM concept');
    assert.ok(all[0]!.n > 0);
  });

  it('returns undefined rather than throwing when nothing matches', async () => {
    assert.equal(await db.first('SELECT id FROM concept WHERE id = ?', -1), undefined);
  });

  it('rolls a failed batch back entirely', async () => {
    const before = count('concept');
    await assert.rejects(
      db.batch([
        {
          sql: `INSERT INTO concept (kind, headword, headword_trad, pinyin, gloss_en, source, created_at)
                VALUES ('word','事务','事務','shìwù','transaction','core',?)`,
          params: [now()],
        },
        // Violates the source CHECK, so the whole batch must roll back.
        {
          sql: `INSERT INTO concept (kind, headword, headword_trad, pinyin, gloss_en, source, created_at)
                VALUES ('word','回滚','回滾','huígǔn','rollback','nonsense',?)`,
          params: [now()],
        },
      ]),
    );
    assert.equal(count('concept'), before);
  });

  it('reports the inserted row id', async () => {
    const r = await db.run(
      `INSERT INTO capture (ts, raw_text, captured_by, status) VALUES (?, ?, 'jasmine', 'new')`,
      now(),
      '宝宝该睡觉了',
    );
    assert.ok(r.lastInsertRowid > 0);
  });
});

describe('segment', () => {
  const vocab = ['宝宝', '睡觉', '了', '我', '在', '哪里', '奶奶'];

  it('prefers the longest match', () => {
    assert.deepEqual(segment('宝宝睡觉了', vocab).tokens, ['宝宝', '睡觉', '了']);
  });

  it('reports characters it cannot cover', () => {
    assert.deepEqual(segment('宝宝看电视', vocab).unknown, ['看', '电', '视']);
  });

  it('skips punctuation without reporting it as unknown', () => {
    assert.deepEqual(segment('宝宝，睡觉了。', vocab).unknown, []);
  });

  it('handles an empty string', () => {
    assert.deepEqual(segment('', vocab), { tokens: [], unknown: [] });
  });
});
