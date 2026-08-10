/**
 * Return one modality's scheduler state to zero, keeping the event log intact.
 *
 *   npm run reset-cards -w @mt/api -- speak --yes
 *
 * `card` is a cache and the event log is the truth (docs/design.md §2.1), so this
 * loses no history. What it discards is the FSRS state built from that history — which
 * is the point when the measurements behind it turn out to have been broken. The
 * speaking scorer graded `again` off Whisper hallucinations like "欢迎订阅我的频道", and
 * the scheduler cannot tell those from real failures.
 *
 * Deliberately *not* a replay of the log. Replaying would faithfully reapply the same
 * bad grades: the events are an honest record of what the system measured, and the
 * measurements were wrong. Only starting clean actually removes the damage.
 *
 * Rows are reset in place rather than deleted, for two reasons. Deleting them fires
 * `ON DELETE SET NULL` on `event.card_id`, which is an UPDATE against an append-only
 * table and is refused by the trigger — correctly. And keeping the row keeps its id,
 * so every event that referenced it still points somewhere meaningful. A card whose
 * `introduced_at` is null is invisible to selection, review and the introduced count
 * alike, so this is behaviourally identical to a card that never existed.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeDb } from '@mt/schema/node';
import { newCard, type Modality } from '@mt/core';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(resolve(HERE, '../../..'), 'data', 'mandarin.db');
const MODALITIES: Modality[] = ['listen', 'speak', 'read'];

const args = process.argv.slice(2);
const modality = args.find((a) => !a.startsWith('--')) as Modality | undefined;

if (!modality || !MODALITIES.includes(modality)) {
  console.error(`Usage: reset-cards.ts <${MODALITIES.join('|')}> [--yes]`);
  process.exit(1);
}
if (!existsSync(DB_PATH)) {
  console.error(`No database at ${DB_PATH}`);
  process.exit(1);
}

const db = new NodeDb(DB_PATH);
const count = (sql: string) => (db.raw.prepare(sql).get(modality) as { n: number }).n;

const cards = count('SELECT count(*) AS n FROM card WHERE modality = ?');
const introduced = count(
  'SELECT count(*) AS n FROM card WHERE modality = ? AND introduced_at IS NOT NULL',
);
const events = count("SELECT count(*) AS n FROM event WHERE modality = ? AND kind = 'review'");

console.log(`${modality}:`);
console.log(`  ${cards} cards, ${introduced} introduced — will be reset to never-seen`);
console.log(`  ${events} review events — untouched; the log is the record of what happened`);

if (!introduced) {
  console.log('\nNothing to reset.');
  db.close();
  process.exit(0);
}
if (!args.includes('--yes')) {
  console.log('\nDry run. Re-run with --yes to apply.');
  db.close();
  process.exit(0);
}

const fresh = newCard(0, modality, new Date());
db.raw
  .prepare('UPDATE card SET fsrs_state = ?, due_at = ?, introduced_at = NULL WHERE modality = ?')
  .run(JSON.stringify(fresh.fsrs), fresh.dueAt, modality);

console.log(
  `\nReset. ${modality}: ${count(
    'SELECT count(*) AS n FROM card WHERE modality = ? AND introduced_at IS NOT NULL',
  )} introduced, ${count(
    "SELECT count(*) AS n FROM event WHERE modality = ? AND kind = 'review'",
  )} review events still logged.`,
);
console.log('Words will be offered again by the scheduler as they come up.');
db.close();
