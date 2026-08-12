/**
 * Rebuild scheduler state from the event log, ignoring reps that came from tooling.
 *
 *   npm run rebuild-cards -w @mt/api -- [--yes]
 *
 * `card` is a cache and `event` is the truth (docs/design.md §2.1), which is what makes
 * this possible at all — but it is only worth doing when some of the events should not
 * have counted.
 *
 * They should not have here. Verification scripts posted 59 reps straight into the real
 * database, including deliberate wrong answers used to check that a wrong answer
 * reschedules. Five of those landed on 宝宝, dragging its stability to 0.03 and parking
 * it permanently at the front of every queue. The learner noticed it as "why do I keep
 * getting this sentence".
 *
 * Reps made through the app carry a session id; those from a script do not, because
 * nothing was calling /api/session. That distinction is what this replays on. It is a
 * heuristic rather than a guarantee, so the counts are printed before anything is
 * written and nothing happens without --yes.
 *
 * Known limitation: practice reps are replayed as ordinary reviews, because whether a
 * rep was practice is not recorded in the event. That over-advances a few cards
 * slightly. It is still far closer to the truth than leaving five injected failures in.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeDb } from '@mt/schema/node';
import { newCard, review, type Grade, type Modality } from '@mt/core';

const DB_PATH = join(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../..'),
  'data',
  'mandarin.db',
);

if (!existsSync(DB_PATH)) {
  console.error(`No database at ${DB_PATH}`);
  process.exit(1);
}

const db = new NodeDb(DB_PATH);

const rows = db.raw
  .prepare(
    `SELECT concept_id, modality, result, ts, session_id
     FROM event
     WHERE kind = 'review' AND concept_id IS NOT NULL AND modality IS NOT NULL
       AND result IS NOT NULL
     ORDER BY ts`,
  )
  .all() as {
  concept_id: number;
  modality: Modality;
  result: Grade;
  ts: number;
  session_id: number | null;
}[];

const kept = rows.filter((r) => r.session_id !== null);
const dropped = rows.length - kept.length;

const affected = new Map<string, number>();
for (const r of rows) {
  if (r.session_id === null) {
    const key = `${r.concept_id}:${r.modality}`;
    affected.set(key, (affected.get(key) ?? 0) + 1);
  }
}

console.log(`${rows.length} graded reps in the log`);
console.log(`  ${kept.length} from the app — replayed`);
console.log(`  ${dropped} with no session (tooling) — discarded`);
console.log(`  ${affected.size} cards affected`);

if (!process.argv.includes('--yes')) {
  console.log('\nDry run. Re-run with --yes to rebuild.');
  db.close();
  process.exit(0);
}

// Replay in order. A card is introduced by its first rep, exactly as in normal use.
const cards = new Map<string, ReturnType<typeof newCard>>();
for (const r of kept) {
  const key = `${r.concept_id}:${r.modality}`;
  const at = new Date(r.ts);
  const before = cards.get(key) ?? newCard(r.concept_id, r.modality, at);
  const after = review(before, r.result, at).card;
  cards.set(key, { ...after, introducedAt: before.introducedAt ?? r.ts });
}

const upsert = db.raw.prepare(
  `INSERT INTO card (concept_id, modality, fsrs_state, due_at, introduced_at)
   VALUES (?, ?, ?, ?, ?)
   ON CONFLICT (concept_id, modality) DO UPDATE SET
     fsrs_state    = excluded.fsrs_state,
     due_at        = excluded.due_at,
     introduced_at = excluded.introduced_at`,
);

db.raw.exec('BEGIN');
for (const card of cards.values()) {
  upsert.run(
    card.conceptId,
    card.modality,
    JSON.stringify(card.fsrs),
    card.dueAt,
    card.introducedAt,
  );
}
db.raw.exec('COMMIT');

console.log(`\nRebuilt ${cards.size} cards from ${kept.length} real reps.`);
console.log('The event log is untouched — the discarded reps are still recorded.');
db.close();
