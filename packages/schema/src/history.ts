/**
 * Export and restore the irreplaceable part of the database.
 *
 *   npm run backup -w @mt/schema            # write data/history.jsonl
 *   npm run backup -w @mt/schema -- --check # compare without writing
 *   npm run restore -w @mt/schema -- --yes  # load it back into an empty log
 *
 * Almost everything in the database is derived and can be rebuilt for nothing:
 * concepts, sentences and audio rows come from the corpus JSON via `npm run seed`, the
 * clips themselves regenerate from edge-tts, and cards replay from events
 * (rebuild-cards.ts). The event log is the exception — it is the record of what was
 * actually studied, it is the source of truth the whole learner model rests on
 * (docs/design.md §2.1), and nothing can reconstruct it.
 *
 * The database is gitignored, and rightly: a 3MB binary that changes every session
 * makes a poor thing to version. JSON Lines does not have that problem. The log is
 * append-only, so successive exports differ only by lines added, and git stores that
 * as a small delta rather than a new copy of everything.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeDb } from './node.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DB_PATH = join(REPO, 'data', 'mandarin.db');
const OUT_PATH = join(REPO, 'data', 'history.jsonl');

/** Only what cannot be derived. Ordered by id so the file appends rather than churns. */
const TABLES = ['session', 'event', 'capture'] as const;

export function exportHistory(db: NodeDb): string {
  const lines: string[] = [];
  for (const table of TABLES) {
    const rows = db.raw.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
    for (const row of rows) lines.push(JSON.stringify({ t: table, ...row }));
  }
  return lines.join('\n') + (lines.length ? '\n' : '');
}

/**
 * Load an exported log back in.
 *
 * Order matters: run `npm run seed` first. Events reference concepts, utterances and
 * audio by id, and those ids come from the corpus JSON in a deterministic order — so a
 * seeded database has them, and a bare schema does not.
 */
export function importHistory(db: NodeDb, text: string): Record<string, number> {
  const counts: Record<string, number> = {};
  db.raw.exec('BEGIN');
  try {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const { t, ...row } = JSON.parse(line) as { t: string } & Record<string, unknown>;
      // card_id is dropped deliberately. `card` is a rebuildable cache whose row ids are
      // reassigned when it is rebuilt, so a restored id would point at a different card
      // — worse than pointing at none. The link that matters, concept plus modality, is
      // already on the event.
      if (t === 'event') row.card_id = null;
      const cols = Object.keys(row);
      // OR IGNORE so a partial restore can be re-run: ids are preserved, and the
      // append-only trigger blocks UPDATE anyway, so replacing is not an option.
      db.raw
        .prepare(
          `INSERT OR IGNORE INTO ${t} (${cols.join(', ')})
           VALUES (${cols.map(() => '?').join(', ')})`,
        )
        .run(...(cols.map((c) => row[c]) as never[]));
      counts[t] = (counts[t] ?? 0) + 1;
    }
    db.raw.exec('COMMIT');
  } catch (e) {
    db.raw.exec('ROLLBACK');
    throw e;
  }
  return counts;
}

/** True when this file was run directly rather than imported. */
function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry) === resolve(fileURLToPath(import.meta.url));
}

if (isMain()) {
  if (!existsSync(DB_PATH)) {
    console.error(`No database at ${DB_PATH}`);
    process.exit(1);
  }
  const db = new NodeDb(DB_PATH);
  const restoring = process.argv.includes('--restore');

  if (restoring) {
    if (!existsSync(OUT_PATH)) {
      console.error(`Nothing to restore from — ${OUT_PATH} does not exist`);
      process.exit(1);
    }
    const existing = db.raw.prepare('SELECT count(*) AS n FROM event').get() as { n: number };
    console.log(`${existing.n} events already in the database`);
    if (!process.argv.includes('--yes')) {
      console.log('Dry run. Re-run with --yes to load history.jsonl into it.');
      process.exit(0);
    }
    const counts = importHistory(db, readFileSync(OUT_PATH, 'utf8'));
    console.log('restored:', counts);
    console.log('Now run:  npm run seed  &&  npm run rebuild-cards -w @mt/api -- --yes');
  } else {
    const text = exportHistory(db);
    const rows = text.split('\n').filter(Boolean).length;
    const before = existsSync(OUT_PATH) ? readFileSync(OUT_PATH, 'utf8') : '';
    if (process.argv.includes('--check')) {
      console.log(text === before ? `up to date — ${rows} rows` : `stale — ${rows} rows to write`);
    } else {
      writeFileSync(OUT_PATH, text, 'utf8');
      const added = text.split('\n').length - before.split('\n').length;
      console.log(`wrote ${rows} rows to data/history.jsonl (+${added} since last time)`);
    }
  }
  db.close();
}
