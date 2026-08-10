/**
 * Load the pipeline's corpus into the database.
 *
 *   node --experimental-strip-types packages/schema/src/seed.ts [--reset]
 *
 * Idempotent: re-running updates existing rows rather than duplicating them, so a
 * corpus edit is `pipeline` → `seed` with no manual cleanup. `--reset` deletes the
 * database first, which also destroys the event log — refused unless the log is
 * empty or `--force` is given, because that log is the source of truth and there is
 * no way to recover it (docs/design.md §2.1).
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, NodeDb } from './node.ts';
import { segment } from './segment.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const MIGRATIONS = resolve(HERE, '../migrations');
const DB_PATH = join(REPO, 'data', 'mandarin.db');
const PIPE = join(REPO, 'pipeline');

interface VocabEntry {
  headword: string;
  headword_trad?: string;
  pinyin: string;
  gloss_en: string;
}
interface SentenceEntry {
  hanzi?: string;
  hanzi_trad?: string;
  pinyin?: string;
  gloss_en?: string;
}
interface ClipEntry {
  file: string;
  voice: string;
  rate: string;
}

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;

function main(): void {
  const args = new Set(process.argv.slice(2));
  const now = Date.now();

  if (args.has('--reset') && existsSync(DB_PATH)) {
    const existing = new NodeDb(DB_PATH);
    const n =
      (existing.raw.prepare('SELECT count(*) AS n FROM event').get() as { n: number } | undefined)
        ?.n ?? 0;
    existing.close();
    if (n > 0 && !args.has('--force')) {
      console.error(
        `Refusing --reset: the event log holds ${n} rows and is the source of truth.\n` +
          `Nothing can rebuild it. Re-run with --force if you genuinely mean to discard it.`,
      );
      process.exit(1);
    }
    for (const suffix of ['', '-wal', '-shm']) rmSync(DB_PATH + suffix, { force: true });
    console.log('reset: database deleted');
  }

  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new NodeDb(DB_PATH);
  const applied = migrate(db, MIGRATIONS);
  console.log(applied.length ? `migrations applied: ${applied.join(', ')}` : 'migrations: current');

  // ── concepts ──────────────────────────────────────────────────────────────
  const vocab = readJson<{ core: VocabEntry[]; personal: VocabEntry[] }>(
    join(PIPE, 'data', 'seed_vocab.json'),
  );

  const upsertConcept = db.raw.prepare(`
    INSERT INTO concept (kind, headword, headword_trad, pinyin, sense, gloss_en,
                         hsk_level, freq_rank, source, created_at)
    VALUES ('word', ?, ?, ?, '', ?, ?, ?, ?, ?)
    ON CONFLICT (kind, headword, pinyin, sense) DO UPDATE SET
      headword_trad = excluded.headword_trad,
      gloss_en      = excluded.gloss_en,
      hsk_level     = excluded.hsk_level,
      freq_rank     = excluded.freq_rank,
      source        = excluded.source
  `);

  db.raw.exec('BEGIN');
  let rank = 0;
  for (const [source, entries] of [
    ['core', vocab.core],
    ['personal', vocab.personal],
  ] as const) {
    for (const e of entries) {
      rank++;
      upsertConcept.run(
        e.headword,
        e.headword_trad ?? e.headword,
        e.pinyin,
        e.gloss_en,
        source === 'core' ? 1 : null, // the seed list is HSK1; personal words sit outside it
        rank,
        source,
        now,
      );
    }
  }
  db.raw.exec('COMMIT');

  const concepts = db.raw
    .prepare('SELECT id, headword FROM concept')
    .all() as { id: number; headword: string }[];
  const conceptId = new Map(concepts.map((c) => [c.headword, c.id]));
  console.log(`concepts: ${concepts.length}`);

  // ── utterances, their concept links, and audio ────────────────────────────
  const sentences = readJson<{ sentences: SentenceEntry[] }>(
    join(PIPE, 'data', 'seed_sentences.json'),
  ).sentences.filter((s): s is Required<SentenceEntry> => typeof s.hanzi === 'string');

  const manifestPath = join(PIPE, 'out', 'day0', 'sentences.json');
  const clipsFor = new Map<string, ClipEntry[]>();
  if (existsSync(manifestPath)) {
    const m = readJson<{ approved: { hanzi: string; clips: ClipEntry[] }[] }>(manifestPath);
    for (const item of m.approved) clipsFor.set(item.hanzi, item.clips);
  } else {
    console.warn('WARNING: no audio manifest at pipeline/out/day0 — seeding text only.');
  }

  const upsertUtterance = db.raw.prepare(`
    INSERT INTO utterance (hanzi, hanzi_trad, pinyin, gloss_en, source, status, created_at)
    VALUES (?, ?, ?, ?, 'generated', 'approved', ?)
    ON CONFLICT (hanzi) DO UPDATE SET
      hanzi_trad = excluded.hanzi_trad,
      pinyin     = excluded.pinyin,
      gloss_en   = excluded.gloss_en
    RETURNING id
  `);
  const clearLinks = db.raw.prepare('DELETE FROM utterance_concept WHERE utterance_id = ?');
  const addLink = db.raw.prepare(
    'INSERT INTO utterance_concept (utterance_id, concept_id, position) VALUES (?, ?, ?)',
  );
  const upsertAudio = db.raw.prepare(`
    INSERT INTO audio (utterance_id, storage_key, provider, voice, variety, rate,
                       is_native, created_at)
    VALUES (?, ?, 'edge', ?, ?, ?, 0, ?)
    ON CONFLICT (storage_key) DO NOTHING
  `);

  const headwords = [...conceptId.keys()];
  let links = 0;
  let clips = 0;
  const unsegmentable: string[] = [];

  db.raw.exec('BEGIN');
  for (const s of sentences) {
    const row = upsertUtterance.get(
      s.hanzi,
      s.hanzi_trad ?? s.hanzi,
      s.pinyin,
      s.gloss_en,
      now,
    ) as { id: number };
    const uid = row.id;

    const { tokens, unknown } = segment(s.hanzi, headwords);
    if (unknown.length) unsegmentable.push(`${s.hanzi} (${unknown.join(' ')})`);

    clearLinks.run(uid);
    tokens.forEach((tok, i) => {
      const cid = conceptId.get(tok);
      if (cid !== undefined) {
        addLink.run(uid, cid, i);
        links++;
      }
    });

    for (const c of clipsFor.get(s.hanzi) ?? []) {
      upsertAudio.run(
        uid,
        c.file,
        c.voice,
        c.voice.startsWith('zh-TW') ? 'tw' : 'cn',
        c.rate,
        now,
      );
      clips++;
    }
  }
  db.raw.exec('COMMIT');

  console.log(`utterances: ${sentences.length}`);
  console.log(`links:      ${links}`);
  console.log(`audio:      ${clips}`);

  // ── integrity ─────────────────────────────────────────────────────────────
  // A concept with no sentence can never be introduced (the hard coverage gate in
  // @mt/core), so it is dead weight in the curriculum. Surface it here rather than
  // letting it silently sit unreachable.
  const orphans = db.raw
    .prepare(
      `SELECT c.headword, c.pinyin FROM concept c
       LEFT JOIN utterance_concept uc ON uc.concept_id = c.id
       WHERE uc.concept_id IS NULL ORDER BY c.id`,
    )
    .all() as { headword: string; pinyin: string }[];

  // Re-seeding must update, never duplicate. A nullable `sense` once made the
  // identity constraint vacuous and a second run silently doubled the corpus.
  const dupes = db.raw
    .prepare(
      `SELECT headword, pinyin, count(*) AS n FROM concept
       GROUP BY kind, headword, pinyin, sense HAVING n > 1`,
    )
    .all() as { headword: string; pinyin: string; n: number }[];

  const silent = db.raw
    .prepare(
      `SELECT u.hanzi FROM utterance u
       LEFT JOIN audio a ON a.utterance_id = u.id
       WHERE a.id IS NULL ORDER BY u.id`,
    )
    .all() as { hanzi: string }[];

  console.log('');
  console.log(`unsegmentable sentences: ${unsegmentable.length}`);
  for (const u of unsegmentable.slice(0, 5)) console.log(`   ${u}`);
  console.log(`duplicate concepts: ${dupes.length}`);
  for (const d of dupes.slice(0, 5)) console.log(`   ${d.headword} ${d.pinyin} x${d.n}`);
  console.log(`concepts with no sentence (never introducable): ${orphans.length}`);
  for (const o of orphans.slice(0, 10)) console.log(`   ${o.headword} ${o.pinyin}`);
  console.log(`utterances with no audio: ${silent.length}`);
  for (const s of silent.slice(0, 5)) console.log(`   ${s.hanzi}`);

  const events =
    (db.raw.prepare('SELECT count(*) AS n FROM event').get() as { n: number }).n ?? 0;
  console.log('');
  console.log(`database: ${DB_PATH}`);
  console.log(`event log preserved: ${events} rows`);
  db.close();

  if (orphans.length || unsegmentable.length || dupes.length) process.exitCode = 2;
}

main();
