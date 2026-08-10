# Exercise Catalog

> **Reviewed 2026-08-10 — 21 keep, 3 cut.** Verdicts and the resulting build order are
> in [`decisions/2026-08-10-exercise-selection.md`](decisions/2026-08-10-exercise-selection.md).
> Short version: keep/cut turned out to be the wrong axis (all 24 already exist and cost
> nothing to keep), so it was re-read as sequencing. Speed Ladder, Voice Roulette and
> Traditional ↔ Simplified were cut as *modes* but their functions were folded into the
> core loop. Dictation gained difficulty levels after coming back "REALLY hard".
> The "My read" column below is my pre-review opinion, kept for the record.

24 playable prototypes in `pipeline/out/lab/index.html`. Every one runs on the real
corpus and the real audio — nothing here is a mockup except the progress view.

```powershell
python pipeline\build_lab.py
start pipeline\out\lab\index.html          # 22 of 24 work from file://
# microphone exercises need a server:
cd pipeline\out; python -m http.server 8000   # → localhost:8000/lab/
```

**How to review this:** play each one for 30 seconds and answer one question — *would I
do this every day?* Not *is this clever*. Most of these should die. The point of building
24 was to make the choice by playing rather than by arguing.

Each exercise has a **Keep / Maybe / Cut** bar under its description with a one-line note
field. Judge it while you are playing it rather than trying to remember afterwards — the
sidebar tracks how many you have judged, and **Export verdicts** dumps the lot as JSON.
That file is the most useful thing you can hand back to me.

Every interaction emits a row into the live event panel, in the shape of the real
`event` table. That panel is the second thing to evaluate: it is the entire basis of
the learner model, and if the data an exercise produces is not useful, the exercise
is not useful.

---

## The catalog

**Gradability** is the important column. *Auto* means the system knows if you were
right with zero AI and zero self-report — those reps are free, honest, and produce
clean data. *Self* means you tell it how you did, which is cheaper to build and
systematically optimistic.

### Listening — priority 1

| Exercise | Trains | Graded | My read |
|---|---|---|---|
| **Listen & Commit** | Core recognition loop | Self | **MVP.** The whole product in one screen. Commit-before-reveal is what keeps the data honest. |
| **Pinyin Dictation** | Tone + segmental precision | **Auto** | **Kept — now with three difficulty levels.** Came back "REALLY hard", which is right for a beginner asked to produce segmentals *and* tones from scratch. Default is now **Tones Only**: syllables given, type just the numbers. Still phase 2, but now attemptable. |
| **Listening Cloze** | Parsing a word out of connected speech | **Auto** | **Strong.** Closest drill to real listening — you cannot pattern-match the whole sentence. |
| **Voice Roulette** | Robustness across speakers | Self | **Cheap and valuable.** Literally just randomising clips you already have. Guards against understanding one voice only. |
| **Meaning Match** | Recognition, low difficulty | **Auto** | Keep, but only for freshly introduced words. Too easy to be worth a mature card's time. |
| **Speed Ladder** | Comprehension *speed* | Self | Good metric, awkward exercise. May be better as a background measurement than a drill. |
| **Which One?** | Fine discrimination | **Auto** | Mostly redundant with Meaning Match + Reading Sprint. First cut candidate. |
| **Story Mode** | Continuous comprehension | **Auto** | Right idea, wrong implementation. Random sentences are not a story — needs curated sequences to be worth anything. |

### Tones — the diagnostic layer

None of the sentence-level drills isolate tone perception, because context lets you
infer a word without ever hearing its tone. These three remove that crutch.

| Exercise | Trains | Graded | My read |
|---|---|---|---|
| **Minimal Pairs** | Tone perception, hardest form | **Auto** | **Most diagnostic thing in the lab.** 妈 麻 马 骂. If you cannot do this, no amount of vocabulary fixes the underlying problem. |
| **Tone ID** | Naming a tone in isolation | **Auto** | Good. Cheap to drill, brutally honest as a measurement. |
| **Same or Different?** | Raw discrimination, no naming | **Auto** | The entry ramp. Start here if Minimal Pairs feels impossible. |

Worth knowing: you can reach a large vocabulary and still be near chance on Minimal
Pairs. Measuring this early is worth more than it looks.

### Speaking — priority 2

| Exercise | Trains | Graded | My read |
|---|---|---|---|
| **Shadow** | Pronunciation self-correction | Self | **Best speaking value per unit of build effort.** The A/B playback is the whole trick — you hear your own tone errors instantly. |
| **Say It** | Production recall | Self | **Keep.** Production is much harder than recognition; expect to fail words you "know". Later scored by local faster-whisper at zero cost. |

### Reading — priority 3

| Exercise | Trains | Graded | My read |
|---|---|---|---|
| **Reading Sprint** | Reading speed, Traditional | **Auto** | Fine. Nearly free to build, and how the Trad/Simp mapping gets absorbed passively. |
| **Flash Recognition** | Whole-word recognition | **Auto** | Good idea, low priority. The difference between reading Chinese and decoding it. |
| **Traditional ↔ Simplified** | Script mapping | **Auto** | Probably unnecessary — you will absorb this passively from seeing both. Cut unless you enjoy it. |
| **Build the Sentence** | Word order + written form | **Auto** | Fiddly. Unclear what it adds over Dictation. Likely cut. |
| **Grammar Sense** | Word order | **Auto** | Rebuilt. The first version generated distractors by swapping adjacent tokens, which often produced something either still grammatical or obviously broken. Now 18 hand-authored contrasts targeting real English-speaker errors (了 placement, 不 vs 没, time-before-verb), each showing the rule after you answer. Worth a look now. |

### Acquisition & input

| Exercise | Trains | Graded | My read |
|---|---|---|---|
| **Add Mandarin** | Emergent curriculum capture | **Auto** | **Build this early.** Not a drill — it is the surface that feeds everything else. Paste what Jasmine says, get it segmented against what you know, add the new words. Near-zero cost and it is the thing that makes this *your* curriculum rather than a textbook. |
| **First Exposure** | Introducing a new word | Self | **Necessary.** Every other exercise assumes you already know the word. Meaning → two contexts → check. Without this there is no on-ramp. |

### Session shapes

| Exercise | What it is | My read |
|---|---|---|
| **Mixed Session** | Weighted interleave of everything + summary | **This is the actual product.** A single drill is a component; an interleaved session with a report is a study session. |
| **Speed Round** | 60-second timed scoring | Keep as a *bad day* fallback. Shallow, but a timer will get you to open the app when a review queue will not. |
| **Immersion** | Continuous passive audio | Shape preview only. Real value needs the learner model to keep input at 80–90% known. |
| **Progress** | Stats view on synthetic data | Build late, from real data. Included so you can react to the *shape* — what would you actually look at weekly? |

---

## Two design notes worth arguing about

**Interleaving beats blocking.** Twenty reps of one exercise type feels more productive
and retains worse than twenty reps mixed across types. The Mixed Session runner is
deliberately weighted rather than grouped for this reason. It will feel less satisfying
than grinding one drill. That feeling is the point.

**Auto-graded exercises should dominate the mix.** Not because self-grading is useless,
but because every self-graded rep is a small lie in the training data (§2.9), and
because auto-graded reps cost nothing per unit forever. If a drill can be made
auto-gradable without becoming stupid, it should be.

---

## What I would actually build

**Phase 1 (the MVP):** Listen & Commit, First Exposure, Add Mandarin. That is a complete
loop — you can introduce a word, drill it, and capture new ones. Nothing else is needed
to start generating real data.

**Phase 2 (after three weeks of use):** Pinyin Dictation, Listening Cloze, Voice
Roulette, Mixed Session. This is where it stops being a flashcard app.

**Phase 3:** Minimal Pairs / Tone ID (measure the tone baseline early even if you drill
it late), Shadow, Say It.

**Later or never:** everything else. Reading Sprint and Flash when reading becomes a
real priority; Immersion when the learner model can keep input comprehensible;
Progress once there is real data to show.

**Cut candidates:** Which One?, Build the Sentence, Traditional ↔ Simplified.

---

## Open questions for you

1. **Does Minimal Pairs feel impossible or merely hard?** This calibrates how much tone
   work belongs early. If you are near chance, it moves to phase 1.
2. **Is Dictation satisfying or tedious?** I have high conviction in it on paper. Paper
   is not the test.
3. **Would you use Add Mandarin?** It only works if it is genuinely frictionless. If
   pasting a sentence feels like a chore, the emergent curriculum never happens.
4. **Does the Mixed Session feel like a session, or like being jerked around?** If
   interleaving is unpleasant enough that you skip days, blocked practice that you
   actually do beats interleaved practice that you avoid.
5. **Anything missing?** These 24 are what I could think of. The gap I am least sure
   about is anything resembling actual conversation.
