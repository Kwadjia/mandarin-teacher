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
import { existsSync, readFileSync } from 'node:fs';
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

const TONES_DIR = join(REPO, 'pipeline', 'out', 'tones');
const tonesManifest = join(TONES_DIR, 'manifest.json');
const tones = existsSync(tonesManifest)
  ? (JSON.parse(readFileSync(tonesManifest, 'utf8')) as { sets: never[] }).sets
  : [];
if (!tones.length) console.warn('No tone drills — run: python pipeline/build_tones.py');

/**
 * Client for the local speech scorer (pipeline/speech_server.py).
 *
 * A separate process because loading large-v3 takes about fifty seconds; keeping it
 * resident there means an attempt costs a few hundred milliseconds instead. If it is
 * not running, `scoreSpeech` stays undefined and the API reports speaking as
 * unavailable rather than failing per request.
 */
const SPEECH_URL = process.env.MT_SPEECH_URL ?? 'http://127.0.0.1:8790';

/**
 * Asked per request rather than once at boot.
 *
 * The app starts in about a second; the scorer spends several loading a 3GB model. A
 * single `npm start` therefore came up with speaking disabled and stayed that way,
 * with nothing on screen explaining why. Cached briefly so a burst of requests does
 * not mean a burst of probes.
 */
let speechCache = { at: 0, up: false };
async function speechAvailable(): Promise<boolean> {
  if (Date.now() - speechCache.at < 5000) return speechCache.up;
  let up = false;
  try {
    const res = await fetch(`${SPEECH_URL}/health`, { signal: AbortSignal.timeout(1500) });
    up = res.ok;
  } catch {
    up = false;
  }
  speechCache = { at: Date.now(), up };
  return up;
}

const scoreSpeech = async (input: {
  audio: ArrayBuffer;
  mimeType: string;
  hanzi: string;
  pinyin: string;
  reference: string | null;
}) => {
  const form = new FormData();
  form.set('audio', new Blob([input.audio], { type: input.mimeType }), 'attempt.webm');
  form.set('hanzi', input.hanzi);
  form.set('pinyin', input.pinyin);
  if (input.reference) form.set('reference', input.reference);

  // Generous, because the very first attempt after startup can still be loading the
  // model. Steady state is well under a second.
  const res = await fetch(`${SPEECH_URL}/score`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`speech service ${res.status}: ${await res.text()}`);
  return res.json() as Promise<Awaited<ReturnType<NonNullable<Parameters<typeof createApp>[0]['scoreSpeech']>>>>;
};

const db = new NodeDb(DB_PATH);
const speechUp = await speechAvailable();
// Always wired up; whether it is reachable is decided per request by speechReady.
const app = createApp({ db, tones, scoreSpeech, speechReady: speechAvailable });

// serveStatic resolves relative to cwd, so express the audio directory that way.
const audioRoot = relative(process.cwd(), AUDIO_DIR).replaceAll('\\', '/');
app.use('/audio/*', serveStatic({ root: audioRoot, rewriteRequestPath: (p) => p.replace(/^\/audio/, '') }));

const tonesRoot = relative(process.cwd(), TONES_DIR).replaceAll('\\', '/');
app.use('/tones/*', serveStatic({ root: tonesRoot, rewriteRequestPath: (p) => p.replace(/^\/tones/, '') }));

// Serve the built web app from the same origin when it exists. This is how the
// Worker will serve it too — one origin, no proxy, no CORS. `npm run dev -w @mt/web`
// is still the fast path while editing the UI.
const WEB_DIST = join(REPO, 'packages', 'web', 'dist');
if (existsSync(WEB_DIST)) {
  const webRoot = relative(process.cwd(), WEB_DIST).replaceAll('\\', '/');
  app.use('/assets/*', serveStatic({ root: webRoot }));
  app.get('/', serveStatic({ root: webRoot, path: 'index.html' }));
  // Single-page app: anything not an API or asset route falls through to the shell.
  app.get('*', serveStatic({ root: webRoot, path: 'index.html' }));
}

const counts = db.raw
  .prepare(
    `SELECT (SELECT count(*) FROM concept)   AS concepts,
            (SELECT count(*) FROM utterance) AS utterances,
            (SELECT count(*) FROM audio)     AS clips,
            (SELECT count(*) FROM event)     AS events`,
  )
  .get() as Record<string, number>;

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`mandarin-teacher api  http://localhost:${info.port}`);
  console.log(
    `  ${counts.concepts} concepts · ${counts.utterances} utterances · ` +
      `${counts.clips} clips · ${counts.events} events logged`,
  );
  console.log(`  audio served from ${audioRoot}`);
  console.log(
    speechUp
      ? `  speaking enabled — scorer at ${SPEECH_URL}`
      : `  speaking scorer not up at ${SPEECH_URL} yet — rechecked per request, so it ` +
        `works as soon as the scorer finishes loading`,
  );
});

// A stale server on the port is the most likely startup failure, and the default
// unhandled-'error' stack trace buries what to do about it.
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `Port ${PORT} is already in use — an older server is probably still running.\n` +
        `  Windows:  Get-NetTCPConnection -LocalPort ${PORT} -State Listen | ` +
        `ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }\n` +
        `  or run on another port:  PORT=8788 npm run api`,
    );
  } else {
    console.error(err);
  }
  db.close();
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    db.close();
    process.exit(0);
  });
}
