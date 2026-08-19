# mandarin-teacher

A personal, audio-first Mandarin learning engine. Single user (me), built to be used
daily for years rather than to be finished.

**Priority order:** listening > speaking > reading. Typing and handwriting are not
modeled at all yet — deliberately.

See [`docs/design.md`](docs/design.md) for the architecture, data model, and phase plan.

## Status

Phase 0 complete — audio-first premise validated by native review, language variety
settled (Taiwan), corpus at HSK1 completeness. No app code yet, on purpose.

**151 concepts · 212 sentences · 1,696 clips · 24 exercise prototypes**

## Study

```powershell
npm install
npm run seed          # corpus JSON -> data/mandarin.db  (idempotent)
npm start             # the app on :8787 and the speech scorer on :8790
```

## Backup

Everything in the database is derived except one thing. Concepts, sentences and audio
rebuild from the corpus JSON; cards replay from events. The **event log** is the record
of what was actually studied, and nothing can reconstruct it.

```powershell
npm run backup -w @mt/schema      # data/history.jsonl — commit this
```

It is append-only text, so each export differs from the last only by the lines added
and git stores it as a small delta. Run it after a session worth keeping.

To recover on a new machine:

```powershell
npm install
npm run seed                              # corpus -> database
python pipeline/day0_validate.py --sentences --tts edge --yes   # regenerate the audio
npm run restore -w @mt/schema -- --yes    # the event log
npm run rebuild-cards -w @mt/api -- --yes # scheduler state, replayed from events
```

Open <http://localhost:8787>. Press **Start** (browsers block audio until a gesture),
then drill with the keyboard:

| key | |
|---|---|
| `Space` | replay |
| `1` / `2` | missed it / got it |
| `Enter` | next, or accept a new word |
| `1`–`4` | tone, in the Tones drill |

Four screens: **Drill** (Listen & Commit plus First Exposure), **Tones** (Tone ID),
**Add Mandarin** (family capture), **Progress** (HSK coverage, latency, queue).

While editing the UI, `npm run web` runs Vite on :5173 with the API proxied — faster
reloads, same behaviour.

## The exercise lab

24 playable drill prototypes running on the real corpus and audio, each with a
Keep/Maybe/Cut verdict bar. See [`docs/exercises.md`](docs/exercises.md).

```powershell
.venv\Scripts\python.exe pipeline\build_lab.py
start pipeline\out\lab\index.html
```

## Layout

```
docs/          design.md (architecture) · exercises.md (drill catalog)
pipeline/      offline content pipeline
  day0_validate.py    generate/load → verify → synthesize → review page
  build_lab.py        exercise lab
  build_tones.py      tone minimal-pair audio
  normalize_corpus.py Taiwan variety rules + Traditional derivation
  expand_hsk1.py      one-off vocabulary expansion
  data/               seed vocabulary, sentences, minimal pairs, grammar pairs
  out/                generated audio and pages (gitignored)
packages/      the app — schema, core, api, web (not yet created)
data/          local SQLite database (gitignored)
```

Everything in `pipeline/out/` is regenerable and not committed. To rebuild from
scratch: `day0_validate.py --sentences --tts edge` then `build_tones.py` then
`build_lab.py`. Rendering is incremental — existing clips are left alone.

## Day 0: validate before building

Generates ~20 vocabulary-constrained sentences, synthesizes each with several
Azure voices at two speeds, and emits a review page for a native speaker to grade.
If TTS pronunciation or sentence naturalness fails here, the audio-first premise
needs rethinking — better to find out in two hours than two weekends.

The `.venv` is already created and dependencies installed.

**The current run needs no API keys and costs nothing:**

```powershell
.venv\Scripts\python.exe pipeline\day0_validate.py --sentences --tts edge
start pipeline\out\day0\review.html
```

- `--sentences` reads the 136 hand-written sentences in `pipeline/data/seed_sentences.json`
  instead of calling the Anthropic API. For a corpus this small the API adds a signup
  step and nothing else.
- `--tts edge` uses `edge-tts`, which exposes the **same zh-CN neural voices as Azure**
  (`XiaoxiaoNeural`, `YunxiNeural`, `XiaoyiNeural`) with no key. If it sounds good here
  it will sound identical on Azure. It is an undocumented endpoint with no SLA — right
  for validation and personal use, not for anything load-bearing.

Takes about two minutes and produces 816 clips (136 sentences × 3 voices × 2 speeds).

### Other modes

| Command | What it does |
|---|---|
| `--self-test` | Fixtures + sine tones. No network at all. Checks the page renders. |
| `--sentences --tts none` | Verify the corpus against the vocabulary, no audio. |
| `--tts azure` | Official Azure API. Needs `AZURE_SPEECH_KEY` + `AZURE_SPEECH_REGION`. |
| *(no flags)* | Generate fresh sentences via Claude. Needs `ANTHROPIC_API_KEY`. |

The script prints a cost estimate and waits for confirmation before any paid step.
Nothing in this repo calls a paid API without asking.
