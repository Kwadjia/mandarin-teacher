/**
 * Node entry point. Opens the local SQLite file, serves the generated audio, and
 * starts the app.
 *
 * Deployment stays off the critical path (docs/design.md §5): this runs locally
 * today, and the Workers entry point later imports the same `createApp` with a D1
 * adapter and an R2 binding for audio.
 *
 *   npm run dev -w @mt/api
 */

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeDb } from '@mt/schema/node';
import { createApp } from './app.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const DB_PATH = join(REPO, 'data', 'mandarin.db');
const AUDIO_DIR = join(REPO, 'pipeline', 'out', 'day0');
const PORT = Number(process.env.PORT ?? 8787);

if (!existsSync(DB_PATH)) {
  console.error(
    `No database at ${DB_PATH}.\nRun:  npm run seed  (after generating audio with the pipeline)`,
  );
  process.exit(1);
}
if (!existsSync(AUDIO_DIR)) {
  console.error(`No audio at ${AUDIO_DIR}.\nRun:  python pipeline/day0_validate.py --sentences --tts edge`);
  process.exit(1);
}

const db = new NodeDb(DB_PATH);
const app = createApp({ db });

// serveStatic resolves relative to cwd, so express the audio directory that way.
const audioRoot = relative(process.cwd(), AUDIO_DIR).replaceAll('\\', '/');
app.use('/audio/*', serveStatic({ root: audioRoot, rewriteRequestPath: (p) => p.replace(/^\/audio/, '') }));

const counts = db.raw
  .prepare(
    `SELECT (SELECT count(*) FROM concept)   AS concepts,
            (SELECT count(*) FROM utterance) AS utterances,
            (SELECT count(*) FROM audio)     AS clips,
            (SELECT count(*) FROM event)     AS events`,
  )
  .get() as Record<string, number>;

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`mandarin-teacher api  http://localhost:${info.port}`);
  console.log(
    `  ${counts.concepts} concepts · ${counts.utterances} utterances · ` +
      `${counts.clips} clips · ${counts.events} events logged`,
  );
  console.log(`  audio served from ${audioRoot}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    db.close();
    process.exit(0);
  });
}
