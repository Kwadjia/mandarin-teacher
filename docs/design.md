# Mandarin Teacher — Design

Status: agreed direction, phase 0 in progress.
Last updated: 2026-08-08.

---

## 1. What this is

> A pipeline that converts spare attention into Mandarin listening reps, and a log
> honest enough to tell me whether it's working.

Everything else — the knowledge graph, immersion generation, YouTube comprehensibility
scoring — is downstream of that and worthless if the core loop doesn't get used daily.

**Priority order:** listening (very high) > speaking (high) > reading (medium) >
typing (not modeled) > handwriting (not modeled).

**Not goals:** replacing textbooks, YouTube, family conversation, or passive
immersion. This complements them.

### The three dominant risks

1. **I stop using it.** Highest probability of failure by a wide margin.
2. **The audio is fake.** Synthetic Mandarin that is subtly wrong trains me on a
   language nobody speaks. For an audio-first app this is existential.
3. **Generated sentences are subtly unnatural.** LLM Mandarin is often grammatical,
   textbook, and not what anyone says.

None are solved by code. They are solved by making the loop cheap to start,
validating TTS before building on it, and putting a native speaker in the review loop.

### Design constraints

- **Desktop-first.** Keyboard-driven. Sessions range from 5 minutes to 2 hours.
- **No pay-per-API-call in steady state.** All AI spend is batch work, explicitly
  triggered, with a printed cost estimate and a confirmation prompt. Steady-state
  runtime cost is $0.
- **A baby arrives imminently.** Sessions must be resumable and interruptible at any
  point. Nothing may require more than a few seconds of setup.

---

## 2. Core architectural decisions

### 2.1 Events are the source of truth; learner state is a materialized view

> It must be possible to delete the entire scheduler state table and rebuild it by
> replaying the event log.

This is the highest-leverage decision in the project. It buys the freedom to redesign
the learner model repeatedly over five years without ever losing history — which is
exactly what longitudinal analysis requires.

Consequence: almost everything that looks like learner state is a query, not a column.

| Looks like state | Actually is |
|---|---|
| exposure / success / fail count | `COUNT(*)` over events |
| last exposure, last active recall | `MAX(ts)` over events |
| confidence | FSRS stability |
| personal relevance | derived from `source` + family-utterance frequency |
| response latency | a column on the **event**, not the concept |
| contexts encountered | a join through events → utterances |
| listening / speaking / reading mastery | FSRS card state per `(concept, modality)` |

### 2.2 Three modalities, not five

`listen`, `speak`, `read`. Typing and handwriting are **absent from the schema**, not
merely unimplemented — adding an enum value later is free; carrying dead columns for
two years is not. Only `listen` is active in the MVP.

### 2.3 FSRS, not a homegrown scheduler

Spaced repetition is solved. [FSRS](https://github.com/open-spaced-repetition) is
open-source (`ts-fsrs`), is what modern Anki uses, and self-optimizes its parameters
from the review log — free personalization from data already being kept.

> **A card is a `(concept, modality)` pair.** `宝宝/listen` and `宝宝/speak` are
> independent FSRS cards with independent difficulty and stability.

Scheduling splits cleanly in two:

- **When to review something known** → FSRS. Do not touch it.
- **What to introduce next** → a ~20-line weighted sort. This is where HSK level,
  corpus frequency, personal relevance, and grammar prerequisites live.

Keeping introduction priority out of the review scheduler means fiddling with
priorities can't break retention math.

### 2.4 Core / personal / emergent are a `source` column, not three subsystems

One concept table, one queue, one scheduler. `source` is an input to the
introduction-priority score. Modeling them separately would triple the code for zero
behavioral difference.

### 2.5 Prerequisites are for grammar only

Grammar has real prerequisites (`了` aspect before `了` change-of-state). Vocabulary
essentially does not — you don't need 妈妈 before 宝宝. Building a prerequisite DAG
over 5,000 words is heavy authoring work encoding a relationship that doesn't exist.
Words are ordered by HSK level + corpus frequency; genuine `prerequisite` edges are
reserved for the ~200 grammar patterns where they matter.

### 2.6 No graph database

At ~10k concepts, ~50k edges, one user, a graph DB buys nothing and costs SQL,
transactions, and portability. A `concept_edge(src, dst, relation)` table gives 95% of
the value; recursive CTEs handle the traversals actually run. Revisit only when
writing variable-depth path queries in anger.

### 2.7 Content spine and knowledge spine are separate

- **Content spine** — what gets played: `utterance` + `audio`. The atomic unit of
  listening practice is a sentence with audio.
- **Knowledge spine** — what gets tracked: `concept` + `card`.
- **The join** — `utterance_concept`.

The core content-selection algorithm falls out of the split:

> Pick the most-due card. Choose an utterance containing that concept **where every
> other concept in it is already known.** Play it.

That is the comprehensible-input engine, and it's one SQL query. The same query with a
relaxed filter becomes immersion mode later.

### 2.8 Concept identity includes pinyin

`长` is `cháng` or `zhǎng`. `想` is want / think / miss. Keyed on the character alone,
mastery is meaningless.

**Concept key = `(kind, headword, pinyin, sense)`**, with `sense` nullable and ignored
until needed. Costs nothing now; retrofitting across a two-year event log is miserable.

### 2.9 Commit before reveal

Audio plays → I think I understood → I reveal → I see the answer → I decide "yeah, I
got that." **Hindsight bias.** This would systematically overrate ability, poison
FSRS, and make the dashboard lie for years.

The UI **forces an overt commitment before the reveal button exists**. `latency_ms`
from audio-end to commitment is logged: for listening, *speed of comprehension is the
actual skill*, and its trend is a better longitudinal metric than any mastery percentage.

### 2.10 No AI in the hot path

The system splits in two:

- **Content pipeline** — offline, run from the laptop. Ingests word lists, generates
  sentences, verifies them, calls TTS, writes rows. Slow, expensive, occasional.
- **App runtime** — serves pre-generated content, records events, runs FSRS. Fast,
  cheap, boring.

This is both a latency decision (audio-first means audio must be instant) and a cost
decision (steady-state spend is $0). It also removes queues, job state, streaming, and
cost surprise from the runtime entirely.

### 2.11 Generated sentences are programmatically verified

An LLM asked for "a sentence using only HSK1 vocabulary" will confidently return one
containing HSK4 words. Every time.

Generate → segment the result → assert every token is in the allowed set → reject and
retry. Deterministic, ~30 lines, and the difference between a comprehensible-input
engine and a random-sentence firehose. Non-negotiable.

Then a **human gate**: a native speaker reviews a sample. Not all of them — 50
sentences, 20 minutes, thumbs up/down/fix. Below ~85% pass rate, the generation prompt
is wrong and that needs to be known before generating hundreds more.

### 2.12 Speaking is scored by two signals, because one is not enough

Speech recognition cannot judge pronunciation. Whisper decodes to the most probable
*text*, so a mispronounced tone comes back as the correct character — measured, not
assumed: `small` returned 它的 for 他的, both *tā*. Scoring an attempt by its transcript
alone would certify bad pronunciation as correct, which is worse than no feedback,
because it is confidently wrong about the one thing that most needs correcting.

So an attempt is measured twice:

| signal | tool | answers |
|---|---|---|
| words | `faster-whisper` large-v3 | did I say the right words |
| tones | `praat-parselmouth` pitch track | did I say them with the right pitch shape |

The pitch half only works if it is speaker-invariant. A tone is a *relative* movement,
and a male learner is compared against a female TTS voice roughly an octave up, so
contours are converted to semitones relative to each speaker's own median and aligned
with DTW. Validated before anything was built on it: the same sentence read by a female
and a male voice scored 0.59 semitones apart, two different sentences 1.13, ranked
correctly 18/20.

Thresholds are **measured, not chosen**. Two natives reading the same sentence still
differ, and that spread is the noise floor; a threshold below it marks correct speech
as wrong, which destroys trust in the green marks as well as the red. `--calibrate`
reports the distribution (p50 0.66, p85 1.25, p98 2.19 semitones over 209 syllables)
and the thresholds sit at p85 and p98. Re-run it if the voices change.

Two rules follow from what these signals mean:

- **Words outrank tones when grading.** A wrong word is a recall failure and the
  scheduler should act on it; a drifting tone on the right word is a motor skill, and
  burying the word in the queue does not make the mouth learn faster.
- **A first attempt is capped at `good`.** Repeating a sentence seconds after hearing
  it is imitation, not production. `easy` on a new card means a fortnight, and a mouth
  that has done something once does not remember how in two weeks.

### 2.13 Listening gates speaking

A word becomes eligible to speak only once its listening card exists. Without the gate
the speak queue introduces its own vocabulary and asks for production of a word never
heard — backwards for this learner's priority order, and the fastest way to drill in a
mispronunciation before there is anything to compare it against.

### 2.14 Speech scoring is local, and that is a privacy decision as much as a cost one

Scoring runs on the GPU here (`pipeline/speech_server.py`, ~275ms per attempt, $0
forever). Recordings of the learner's voice — and, later, of family speech around the
house — never leave the machine. That holds by construction rather than by policy,
which is the only version of it worth relying on.

The model lives in a separate process because loading large-v3 takes ~50 seconds;
paying that per attempt would be intolerable, paying it once at startup is invisible.
If the service is not running the API reports speaking as unavailable and the UI says
how to start it, rather than failing in a way that looks like a bug.

---

## 3. Data model

Nine tables. Deliberately close to the minimum that doesn't paint us into a corner.

```sql
-- ══ KNOWLEDGE SPINE ══

concept (
  id, kind,                    -- 'word' | 'grammar' | 'character'
  headword,                    -- 宝宝  |  V + 了  |  好
  pinyin,                      -- bǎo bao   (part of identity — §2.8)
  sense,                       -- nullable discriminator; ignore until needed
  gloss_en,
  hsk_level,                   -- nullable
  freq_rank,                   -- nullable, from a corpus frequency list
  source,                      -- 'core' | 'personal' | 'emergent'
  notes, created_at,
  UNIQUE(kind, headword, pinyin, sense)
)

concept_edge (src_id, dst_id, relation)
  -- 'prerequisite' (grammar only), 'confusable_with', 'contains',
  -- 'commonly_used_with'.  Sparse. Add edges only when they earn it.

-- ══ CONTENT SPINE ══

utterance (
  id, hanzi, pinyin, gloss_en,
  source,                      -- 'generated' | 'family' | 'corpus'
  source_detail,               -- "wife, 2026-08-14, changing table"
  status,                      -- 'draft' | 'approved' | 'retired'
  notes,                       -- native-reviewer comment
  created_at
)

utterance_concept (utterance_id, concept_id, position)

audio (
  id, utterance_id,
  storage_key,                 -- local path → R2 key, same string
  provider, voice, rate,       -- 'azure', 'zh-CN-XiaoxiaoNeural', 0.85
  is_native,                   -- true = an actual family recording
  duration_ms, created_at
)

-- ══ SCHEDULER (a cache — rebuildable by replaying events) ══

card (
  id, concept_id,
  modality,                    -- 'listen' | 'speak' | 'read'
  fsrs_state,                  -- JSON blob owned entirely by ts-fsrs
  due_at, introduced_at,
  UNIQUE(concept_id, modality)
)

-- ══ TRUTH (append-only; never UPDATE, never DELETE) ══

session (id, started_at, ended_at, kind)

event (
  id, ts, session_id,
  kind,                        -- 'review' | 'exposure' | 'capture' | 'note'
  concept_id, card_id, utterance_id, audio_id,   -- all nullable
  modality, exercise_type,
  result,                      -- 'again' | 'hard' | 'good' | 'easy' | null
  latency_ms,                  -- audio-end → commitment.  Precious.
  replays,                     -- how many times I re-listened
  committed_before_reveal,     -- data-integrity flag; see §2.9
  payload                      -- JSON escape hatch for anything new
)

-- ══ INBOX ══

capture (id, ts, raw_text, raw_audio_key, captured_by, status, notes)
  -- friction-free dump. Processed later by the pipeline into
  -- utterances + concepts. Never blocks the person capturing.
```

Two notes worth stating explicitly:

**`review` vs `exposure` events.** When a drill targets 宝宝, that's a `review` and it
drives FSRS. When 宝宝 merely *appears* in a sentence targeting 睡觉, that's an
`exposure` — logged, counted, shown in stats, but it does **not** touch FSRS. Mixing
incidental exposure into a scheduler that assumes discrete scheduled reviews is how
these systems quietly break. Revisit later with real data.

**`payload` JSON column.** The escape hatch. A new exercise type invented in 2027 logs
into `payload` on day one and is promoted to a real column only if it proves useful.
This is what lets the schema stay small without losing information.

---

## 3.5 Language variety — Taiwan

Jasmine's family is from Taiwan. Everything built before 2026-08-08 assumed mainland
Mandarin; these decisions correct that. They were settled by native-speaker A/B
(`pipeline/compare_variety.py`), not by argument.

| Dimension | Decision |
|---|---|
| **Accent (listening)** | **Mixed, weighted to Taiwan.** 2 zh-TW + 2 zh-CN voices in rotation. Training on one accent produces someone who understands one accent; both will be encountered for life. |
| **Accent (speaking)** | **Lean Taiwan.** Fewer neutral tones, softer retroflex, no erhua. He should sound like his family. |
| **Script** | **Traditional primary, Simplified stored alongside.** Nainai writes Traditional. Every concept and utterance carries both; the UI shows Traditional with Simplified on reveal, so the mapping is absorbed passively at no extra cost — and outside resources (HSK, Anki, graded readers) stay usable. |
| **Grandma** | **Always 奶奶.** 外婆 dropped from the vocabulary; 阿嬤 never used. |
| **"Where"** | **哪裡 / 哪里**, never the mainland 哪儿. |
| **Rice** | **白飯 / 白饭**, not 米饭. |

**Schema consequence:** `concept.headword_trad` and `utterance.hanzi_trad` are
first-class columns, populated by `opencc` with the `s2twp` config (Taiwan standard
*with* Taiwanese phrasing — plain `s2t` yields 哪里 rather than 哪裡). Conversion is
deterministic and one-directional-safe from Simplified, so Simplified stays the
authored form and Traditional is derived. Retrofitting this across a two-year corpus
would have been painful; adding it at 136 sentences cost one script.

**Measured overlap:** 33% of the seed vocabulary and 77% of sentences differ between
scripts — meaning two-thirds of the *words* he learns are identical in both systems.
That is the empirical basis for judging Traditional a ~10–15% surcharge on the reading
track rather than a second alphabet.

**HSK stays the backbone.** It is a frequency-ordered word list and is >95% identical
across varieties. Household vocabulary overrides it where the family differs; the
curriculum spine is not rebuilt over pronunciation and a few dozen lexical items.

---

## 4. HSK proficiency estimate

HSK 2.0 (6 levels) is the ordering backbone: mature, cleanly available word lists,
and most third-party materials and YouTube content target it. HSK 3.0 levels are
carried as metadata. No exam is planned.

```
known(L)     = concepts at HSK level L whose listen-card has FSRS
               retrievability ≥ 0.85 projected 14 days out
coverage(L)  = known(L) / total(L)
reported     = highest L where coverage(L) ≥ 0.80,  plus fraction into L+1
```

Displayed as **`HSK 2.4 · listening`** — level 2 solid, 40% into level 3. The same
calculation runs per modality, so listening at 2.4 and speaking at 1.6 becomes visible
— exactly the asymmetry this project exists to avoid being blind to.

The UI states the caveat plainly: this measures **vocabulary coverage**, not grammar
or exam readiness.

---

## 5. Stack

| Layer | Choice |
|---|---|
| Frontend | Vite + React 19 + TypeScript + Tailwind 4 (matches arthurnemeth.com) |
| API | Cloudflare Workers + Hono |
| DB | SQLite locally → Cloudflare D1 (D1 *is* SQLite; same schema, same SQL) |
| Query layer | Drizzle — typed queries + migrations |
| Audio | local disk → Cloudflare R2 |
| Auth | **Cloudflare Access** |
| Scheduler | `ts-fsrs` |
| Pipeline | Python 3.11, offline, writes to the same schema |
| TTS | Azure Speech (zh-CN neural) |
| STT / pronunciation | Azure Speech Pronunciation Assessment, or local `faster-whisper` (later) |
| LLM | Claude (`claude-opus-5`), pipeline only, never at runtime |

**Cloudflare Access** sits in front of `mandarin.arthurnemeth.com` and authenticates by
email against Google. Zero lines of auth code, ever — no sessions, no passwords, no JWT
handling — and adding family members later is typing email addresses into a dashboard.

**Python for the pipeline, TypeScript for the app.** The pipeline is data work
(segmentation, pinyin, frequency lists, corpus analysis) where Python's tooling is
meaningfully better. The seam is a SQLite file and a folder of MP3s — about as clean as
seams get. Two languages is fine when the boundary is data, not RPC.

**Azure for the whole speech layer** because it uniquely combines: multiple distinct
zh-CN neural voices (training on one voice produces someone who understands one voice),
SSML `<phoneme>` for forcing pinyin on polyphonic characters, `<prosody rate>` for
speed laddering, and Pronunciation Assessment for the later speaking phase.

Honest caveat: **tone-level feedback is unreliable everywhere.** Azure's phoneme scores
are decent on segmentals and mushy on tones. Do not build a tone-scoring feature on it.

### Deployment is deferred, for free

D1 *is* SQLite. So the MVP is built against a **local SQLite file** with a
D1-compatible schema, running the API via `wrangler dev`, and deploys to
`mandarin.arthurnemeth.com` when phone or cross-device access is actually wanted —
probably week 3+. Zero rework; deployment off the critical path.

### Cost

| Item | Cost |
|---|---|
| Azure TTS | F0 free tier currently covers 0.5M chars/month; a 5,000-sentence corpus is ~360k chars. Effectively free; ~$5 if it overflows to paid. |
| Sentence generation | Claude Batch API at 50% off. A 500-sentence corpus is roughly $1–2; 5,000 sentences well under $20. One-time. |
| Cloudflare | Workers / D1 / R2 free tiers, with large headroom for one user. Audio ≈ 600MB against R2's 10GB; zero egress fees. |
| **Steady state** | **$0** — nothing calls an AI at runtime. |

The one thing the no-pay-per-call constraint genuinely rules out is **real-time AI
voice conversation**. That stays deferred.

### Local compute

Workstation: RTX 5070 Ti (16GB VRAM, Blackwell), Ryzen 7 7800X3D, 64GB DDR5.

That comfortably runs `faster-whisper` large-v3 in fp16 with room to spare, at well
above real time for short utterances — so **the entire speaking-feedback phase costs
$0 and never leaves the machine.** Local STT is the default plan for phase 4, with
Azure Pronunciation Assessment as a comparison point rather than a dependency.

**Measured, 2026-08-10** (`pipeline/check_gpu_speech.py`, against our own clips where
the ground truth is exact):

| | accuracy | latency |
|---|---|---|
| `small` on GPU | 11/12 | 90ms |
| `large-v3` on GPU | 12/12 | 185ms |
| `small` on CPU | 11/12 | 860ms |

`large-v3` it is — 185ms is inside the threshold where feedback feels immediate, and
3GB of fp16 weights leaves most of the 16GB free. End to end through the API, including
upload and pitch analysis, an attempt costs ~275ms warm.

Two practical notes:
- Blackwell (sm_120) works, with ctranslate2 4.8.1 + cuDNN 9.24 from the pip
  `nvidia-*-cu12` wheels. Windows needs `os.add_dll_directory` for those — since 3.8 it
  does not search PATH for extension DLLs, and `speech_score.py` registers them itself
  so the service starts from any shell. CPU fallback on a 7800X3D is still usable.
- Models cache to `D:/ml-cache/huggingface`. `large-v3` alone is 3GB and the C: drive
  on this machine does not have room for it.
- Local TTS is *not* recommended — open Mandarin TTS quality is well below Azure's
  neural voices, and Azure's free tier already covers the corpus. Keep TTS remote,
  STT local.

Local LLM inference is possible at this VRAM but not planned: Mandarin generation
quality from 16GB-class local models is materially worse than Claude's, and generation
is one-time batch work where quality matters far more than cost.

---

## 6. Repository structure

```
mandarin-teacher/
├─ docs/
│  ├─ design.md                    # this file
│  └─ decisions/                   # short ADRs: 0001-fsrs.md, 0002-azure-tts.md
│
├─ packages/
│  ├─ schema/                      # THE contract between pipeline and app
│  │  ├─ migrations/               # plain .sql, D1-compatible
│  │  └─ src/                      # Drizzle schema + shared TS types
│  │
│  ├─ core/                        # pure domain logic, zero I/O, heavily tested
│  │  ├─ scheduling/               # ts-fsrs wrapper, due-card selection
│  │  ├─ selection/                # utterance picking, introduction priority
│  │  └─ grading/                  # event → FSRS rating mapping
│  │
│  ├─ api/                         # Cloudflare Worker (Hono)
│  │  ├─ src/routes/               # /session /review /capture /stats
│  │  └─ wrangler.toml
│  │
│  └─ web/                         # Vite + React + Tailwind
│     └─ src/features/{drill,capture,stats}/
│
├─ pipeline/                       # Python — offline content, plus the speech scorer
│  ├─ day0_validate.py             # sentence generation + TTS + review page
│  ├─ merge_expansion.py           # ← vocabulary-constraint enforcement (§2.11)
│  ├─ build_tones.py               # tone minimal-pair clips
│  ├─ resolve_captures.py          # English capture → verified Mandarin (needs API key)
│  ├─ speech_score.py              # scoring library: whisper + pitch (§2.12)
│  ├─ speech_server.py             # resident model, localhost:8790 (§2.14)
│  ├─ check_gpu_speech.py          # regression: is CUDA transcription still working
│  ├─ check_gpu_pitch.py           # regression: is the contour metric still valid
│  ├─ requirements.txt
│  └─ data/
│     ├─ seed_vocab.json           # phase-0 seed list
│     ├─ raw/                      # HSK lists, frequency lists (vendored)
│     └─ out/                      # generated audio before upload
│
└─ data/
   └─ mandarin.db                  # local SQLite; gitignored, backed up nightly
```

`packages/core` having **zero I/O** is the part that matters. Scheduling and selection
are what will be rewritten most and what most needs to be correct. Pure functions over
plain data means a test can simulate 500 days of study in a millisecond and show what
the scheduler actually does — enormously valuable when you can't wait two years to
find out.

---

## 7. Phase plan

> **Phase-0 amendment (2026-08-08).** Both paid dependencies were removed from the
> validation loop without weakening it. The 136 seed sentences were written directly
> in-session rather than through the Batch API — same model, and at this corpus size
> the API contributes a signup step and nothing else. Audio uses `edge-tts`, which
> serves the *identical* zh-CN neural voices as Azure with no key, so a positive
> result transfers to Azure exactly. Both API paths remain in `day0_validate.py`
> (`--tts azure`, no `--sentences` flag) for when scale actually needs them: the
> Anthropic path earns its keep at coverage-driven generation across thousands of
> sentences, and Azure earns its keep as a supported endpoint with an SLA.

### Phase 0 — validate before writing code (~2 hours, zero app code)

`pipeline/day0_validate.py`. Generate 20 vocabulary-constrained sentences, synthesize
with 3 Azure voices × 2 speeds, review with a native speaker: does it sound natural?
Would anyone say this? Is the TTS pronunciation right? Any tone errors?

If TTS quality fails, the entire audio-first premise needs rethinking — for two hours
of cost. **Do not skip this.**

### Phase 1 — MVP (target: two weekends)

**In:**
- Schema + local SQLite
- Seed: HSK1 (~150 words) + ~40 personal words collected on paper
- ~400 generated sentences, vocabulary-verified, natively spot-checked
- Azure TTS: 2 voices × 2 speeds per sentence, files on local disk
- **One screen**, keyboard-driven: big play button → replay (max 2) →
  `Got it / Missed it` → reveal hanzi + pinyin + English → FSRS grade → next
- FSRS on `(concept, listen)` only
- Full event logging with latency
- A capture box: text in, straight to the `capture` table, no processing
- One line of stats: `142 concepts · 38 due · 21 reviews today · median 2.4s`

**Explicitly out** (all cheap to add later, expensive to carry now): dashboard, charts,
reading cards, speaking, microphone, grammar-as-concepts, prerequisite edges, immersion
mode, YouTube, deployment, auth, R2, D1, native audio recording, capture processing.

### Then: use it for three weeks and build nothing.

Not "mostly nothing" — nothing. Twenty real sessions will teach more about what this
should be than twenty more hours of design, and phase 2 gets designed against real
event data.

### Phase 2 (+1 weekend, after the three weeks)

- **Pinyin dictation with tone numbers** — hear `他明天要去医院` → type
  `ta1 ming2 tian1 yao4 qu4 yi1 yuan4`. Forces tone discrimination, the hardest and
  most-neglected listening skill, and is **deterministically auto-gradable with zero
  AI** — perfect fit for the cost constraint.
- Capture-processing pipeline (transcribe → segment → propose concepts)
- Deploy to `mandarin.arthurnemeth.com` behind Cloudflare Access

### Phase 3 (month 2–3)

- **Native audio recording tool** — a page that shows a sentence, records,
  auto-advances. ~200 of the highest-frequency family phrases in one ~20-minute
  sitting, rather than 200 individual asks. Native audio is an enhancement layer that
  slots beside TTS for the same utterance and is preferred when present; **nothing ever
  blocks on it.** Mother-in-law recording the same set later is a bonus — a different
  voice and register is genuinely valuable for listening robustness.
- Reading cards
- Longitudinal stats page

### Phase 4+ (month 4 and beyond)

Speaking with local `faster-whisper` · pronunciation feedback · immersion generation ·
emergent vocabulary from captures · external media analysis · YouTube comprehensibility
scoring · recommendations.

---

## 8. Deferred decisions

Graph database · prerequisite DAG for vocabulary · pronunciation and tone scoring ·
immersion generation · YouTube analysis · typing and handwriting · multi-user ·
word senses · gamification · dashboard · AI conversation mode.

Every one is reachable from the schema in §3 without a migration. That is the point of
keeping it small.

---

## 9. Risk register

| # | Risk | Mitigation |
|---|---|---|
| 1 | **I stop using it.** New baby, time collapses. | Ship in two weekends. Resumable sessions. Three-week usage gate before any further build. |
| 2 | **TTS trains wrong pronunciation.** | Phase-0 validation with a native speaker. Multiple voices. SSML phoneme overrides for polyphones. Native audio for high-frequency family phrases in phase 3. |
| 3 | **Generated Mandarin is unnatural.** | Programmatic vocabulary verification + native spot-check. Weight family-captured utterances above generated ones. |
| 4 | **Self-grading corrupts the model.** | Commit-before-reveal, enforced in UI, flagged in data (§2.9). |
| 5 | **Building the fun parts instead of using it.** | The graph, immersion, and YouTube scorer are the fun parts. That's the trap. |
| 6 | Single voice / single register → brittle comprehension | Voice + speed variation from day one. It's free. |
| 7 | Content coverage gaps — a due concept has no clean utterance | Pipeline reports coverage; generate on demand for gaps. |
| 8 | Data loss over 5 years | SQLite is one file. Nightly copy into the existing backup path. Ten lines, done on day one. |
