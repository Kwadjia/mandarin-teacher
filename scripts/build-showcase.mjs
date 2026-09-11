/**
 * Generate the public showcase page — a static, read-only snapshot for
 * mandarin.arthurnemeth.com.
 *
 *   npm run showcase           (writes showcase/index.html)
 *
 * The live app stays private behind Cloudflare Access; recruiters and passers-by get
 * this page instead. It is deliberately static: no endpoint of the real server is
 * reachable from it, nothing breaks when the home PC is asleep, and the only data on
 * it are aggregates — counts, coverage, response times. No vocabulary lists, no
 * per-word history, nothing personal beyond "this person studies".
 *
 * Numbers come from the running API (which already knows how to compute standing,
 * streak and coverage — reimplementing those here would just let them drift) plus a
 * few totals read straight from the database, read-only.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.MT_API_URL ?? 'http://localhost:8787';
const OUT = join(REPO, 'showcase', 'index.html');

async function getJson(path) {
  const res = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
  if (!res || !res.ok) {
    console.error(`Cannot reach ${API}${path} — is the app running?  npm start`);
    process.exit(1);
  }
  return res.json();
}

const [listen, speak, plan] = await Promise.all([
  getJson('/api/stats'),
  getJson('/api/stats?modality=speak'),
  getJson('/api/plan'),
]);

// Totals the API has no reason to serve. Read-only: this script must never be able
// to touch the event log, however it is invoked.
const db = new DatabaseSync(join(REPO, 'data', 'mandarin.db'), { readOnly: true });
const one = (sql) => Object.values(db.prepare(sql).get())[0];
const reps = one(`SELECT count(*) FROM event WHERE session_id IS NOT NULL`);
const clips = one(`SELECT count(*) FROM audio`);
const sentences = one(`SELECT count(*) FROM utterance`);
const tsRows = db
  .prepare(`SELECT DISTINCT date(ts / 1000, 'unixepoch', 'localtime') AS d FROM event
            WHERE session_id IS NOT NULL ORDER BY d`)
  .all();
const studyDays = tsRows.length;
const since = tsRows[0]?.d ?? null;
db.close();

const fmtDate = (iso) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
const seconds = (ms) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)}s`);
const generated = new Date().toLocaleDateString('en-US', {
  year: 'numeric', month: 'long', day: 'numeric',
});

// ── HSK coverage bars ────────────────────────────────────────────────────────
// One bar per level. The track is the official level size — the honest denominator
// — with two ordinal steps of one blue on it: lighter = in the corpus, darker =
// known by listening. Ramp endpoints are the documented ordinal limits of the
// palette (light mode floor #86b6ef, dark mode floor #184f95), validated with the
// dataviz palette checker in both modes.
const BAR_W = 560;
const BAR_H = 22;
const GAP = 14;
const LABEL_W = 74;
// Values live in a fixed right gutter, never at the end of the fill — HSK 1's corpus
// fill runs the track nearly full, and a label chasing it would leave the canvas.
const VALUE_W = 84;
const TRACK_W = BAR_W - LABEL_W - VALUE_W;
const levels = listen.hsk.perLevel;
const svgH = levels.length * (BAR_H + GAP) - GAP;

const bars = levels
  .map((lv, i) => {
    const y = i * (BAR_H + GAP);
    const w = (n) => Math.max(0, Math.round((n / lv.total) * TRACK_W));
    const known = lv.known ? Math.max(w(lv.known), 4) : 0;
    const corpus = Math.max(w(lv.inCorpus), known);
    return `
    <g>
      <text x="0" y="${y + BAR_H / 2}" dominant-baseline="central" class="bar-name">HSK ${lv.level}</text>
      <rect x="${LABEL_W}" y="${y}" width="${TRACK_W}" height="${BAR_H}" rx="4" class="track">
        <title>HSK ${lv.level}: ${lv.total} words in the official list</title>
      </rect>
      <rect x="${LABEL_W}" y="${y}" width="${corpus}" height="${BAR_H}" rx="4" class="in-corpus">
        <title>${lv.inCorpus} of ${lv.total} words have sentences and audio in the corpus</title>
      </rect>
      <rect x="${LABEL_W}" y="${y}" width="${known}" height="${BAR_H}" rx="4" class="known">
        <title>${lv.known} known by ear so far</title>
      </rect>
      <text x="${BAR_W}" y="${y + BAR_H / 2}" dominant-baseline="central" text-anchor="end" class="bar-value">${lv.known} / ${lv.total}</text>
    </g>`;
  })
  .join('');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mandarin Teacher — a personal learning engine</title>
<meta name="description" content="A single-user Mandarin learning engine: spaced repetition from an append-only event log, GPU speech scoring on local hardware, zero recurring costs. Built by Arthur Nemeth.">
<style>
  :root {
    color-scheme: light dark;
    --plane: #f9f9f7; --surface: #fcfcfb;
    --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
    --hairline: rgba(11, 11, 11, 0.10); --track: #e1e0d9;
    --blue: #2a78d6; --blue-light: #86b6ef;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --plane: #0d0d0d; --surface: #1a1a19;
      --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
      --hairline: rgba(255, 255, 255, 0.10); --track: #2c2c2a;
      --blue: #3987e5; --blue-light: #184f95;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--plane); color: var(--ink);
    font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 880px; margin: 0 auto; padding: 48px 24px 64px; }
  header h1 { font-size: 2rem; margin: 0 0 4px; letter-spacing: -0.02em; }
  header .hanzi { color: var(--blue); font-weight: 600; }
  header p.tagline { color: var(--ink-2); margin: 0; max-width: 60ch; }
  .tiles {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 12px; margin: 36px 0;
  }
  .tile {
    background: var(--surface); border: 1px solid var(--hairline); border-radius: 10px;
    padding: 14px 16px;
  }
  .tile .value { font-size: 1.7rem; font-weight: 650; line-height: 1.2; }
  .tile .label { color: var(--muted); font-size: 0.8rem; margin-top: 2px; }
  section { margin-top: 44px; }
  h2 { font-size: 1.15rem; margin: 0 0 10px; }
  .card {
    background: var(--surface); border: 1px solid var(--hairline); border-radius: 10px;
    padding: 20px;
  }
  .chart-note { color: var(--muted); font-size: 0.8rem; margin: 10px 0 0; }
  .legend { display: flex; gap: 18px; margin: 0 0 14px; font-size: 0.85rem; color: var(--ink-2); }
  .legend .swatch {
    display: inline-block; width: 12px; height: 12px; border-radius: 3px;
    margin-right: 6px; vertical-align: -1px;
  }
  svg { display: block; width: 100%; height: auto; }
  svg text { font: 13px system-ui, -apple-system, "Segoe UI", sans-serif; }
  .bar-name { fill: var(--ink-2); }
  .bar-value { fill: var(--ink-2); font-variant-numeric: tabular-nums; }
  .track { fill: var(--track); }
  .in-corpus { fill: var(--blue-light); }
  .known { fill: var(--blue); }
  .how p { color: var(--ink-2); max-width: 68ch; }
  .how h3 { font-size: 0.95rem; margin: 22px 0 4px; }
  .how h3 + p { margin-top: 0; }
  .stack { color: var(--muted); font-size: 0.85rem; margin-top: 28px; }
  footer {
    margin-top: 56px; padding-top: 20px; border-top: 1px solid var(--hairline);
    color: var(--muted); font-size: 0.85rem;
  }
  footer a { color: var(--ink-2); }
</style>
</head>
<body>
<main>
  <header>
    <h1><span class="hanzi">中文</span> Mandarin Teacher</h1>
    <p class="tagline">A single-user Mandarin learning engine I built for myself — spaced
    repetition driven by an append-only event log, with speech scoring on my own GPU.
    One learner, one machine, zero recurring costs.</p>
  </header>

  <div class="tiles">
    <div class="tile"><div class="value">${listen.introduced}</div><div class="label">words in training</div></div>
    <div class="tile"><div class="value">${plan.standing.solid}</div><div class="label">proven solid (passed a retention test)</div></div>
    <div class="tile"><div class="value">${reps.toLocaleString('en-US')}</div><div class="label">reps logged since ${since ? fmtDate(since) : 'the start'}</div></div>
    <div class="tile"><div class="value">${seconds(plan.standing.medianLatencyMs)}</div><div class="label">median time to comprehend a sentence</div></div>
    <div class="tile"><div class="value">${studyDays}</div><div class="label">study days</div></div>
    <div class="tile"><div class="value">${plan.points.level}</div><div class="label">level · ${plan.points.total.toLocaleString('en-US')} points</div></div>
  </div>

  <section>
    <h2>HSK coverage, by ear</h2>
    <div class="card">
      <div class="legend">
        <span><span class="swatch" style="background: var(--blue)"></span>known by listening</span>
        <span><span class="swatch" style="background: var(--blue-light)"></span>in the corpus</span>
        <span><span class="swatch" style="background: var(--track)"></span>official level size</span>
      </div>
      <svg viewBox="0 0 ${BAR_W} ${svgH}" role="img" aria-label="Words known per HSK level, against the official level sizes">${bars}
      </svg>
      <p class="chart-note">Denominators are the official HSK level sizes, not the corpus —
      coverage is only claimed against the real target. The corpus currently spans
      HSK 1–3: ${sentences.toLocaleString('en-US')} sentences with ${clips.toLocaleString('en-US')} audio clips
      across ${listen.total} words, and it grows ahead of the learning frontier.</p>
    </div>
  </section>

  <section class="how">
    <h2>How it works</h2>

    <h3>The event log is the source of truth</h3>
    <p>Every rep is one row in an append-only log — SQLite triggers physically refuse
    updates and deletes. Scheduling state is a cache rebuilt by replaying the log, so a
    scheduling bug can never destroy history: fix the code, replay, and the past is
    reinterpreted rather than lost.</p>

    <h3>Scheduling that separates skills</h3>
    <p>FSRS spaced repetition, with a card per (word, skill) pair — hearing 累 and
    saying 累 are tracked as different memories, because they are. Listening gates
    speaking: nothing is asked of the mouth before the ear can verify it. New
    vocabulary is capped per day; past the cap, the system serves practice on known
    words instead of more novelty.</p>

    <h3>Speech scoring on local hardware</h3>
    <p>Attempts are transcribed by faster-whisper (large-v3, CUDA) and pitch-tracked
    with Praat. Tone feedback does not depend on the transcript: MFCC features aligned
    by dynamic time warping carry native syllable boundaries onto the learner's audio,
    so tones are judged even when recognition fails. And a recogniser failure is never
    graded as a learner failure — undecodable or hallucinated results are discarded,
    not scored.</p>

    <h3>Honest grading</h3>
    <p>The interface commits before it reveals. Quiz answers are graded server-side,
    dictation withholds the text until the answer is locked in, and replays are counted
    against the grade automatically — the learner never has to be disciplined enough to
    self-report.</p>

    <h3>Local by construction</h3>
    <p>Everything — database, scheduler, models, audio — runs on one machine. Voice
    recordings never leave it, and there is no per-request bill anywhere in the loop:
    the marginal cost of a rep is electricity.</p>

    <p class="stack">TypeScript · Hono · React · SQLite (node:sqlite) · ts-fsrs ·
    Python · faster-whisper · Praat/parselmouth · CUDA</p>
  </section>

  <footer>
    Built by <a href="https://arthurnemeth.com">Arthur Nemeth</a>. The live app is
    private by design — this page is a read-only snapshot, generated ${generated}.
  </footer>
</main>
</body>
</html>
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html);
console.log(`showcase → ${OUT}`);
