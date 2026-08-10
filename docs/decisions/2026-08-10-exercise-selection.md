# Exercise selection and build order

**Date:** 2026-08-10
**Input:** [`2026-08-10-lab-verdicts.json`](2026-08-10-lab-verdicts.json) — Arthur's
verdicts after playing all 24 lab prototypes.

## Result: 21 keep, 3 cut

Cut: **Speed Ladder**, **Voice Roulette**, **Traditional ↔ Simplified**.

Two notes came back, and both changed something:

> *Pinyin Dictation — "This is REALLY hard for me but seems like a great exercise"*

> *Tone ID — "This one is surprisingly helpful"*

## The question was wrong

I asked "keep or cut", but all 24 prototypes already exist and keeping one in the lab
costs nothing. Arthur's stated reason for keeping the hard ones — *"I can see if they're
doable at some point"* — is correct for a personal multi-year project with no product
team to starve.

So keep/cut is not the useful axis. **Build order is.** The verdicts are re-read below
as sequencing signal rather than as a filter.

## The three cuts: kill the mode, keep the function

Each cut exercise was doing something worth preserving. In every case the fix is to
stop treating it as a separate mode and fold the behaviour into the core loop, which
is better design regardless of the verdict.

| Cut | Function worth keeping | Where it goes |
|---|---|---|
| **Voice Roulette** | Robustness across speakers and speeds | **Becomes the default clip-selection policy everywhere.** Voice variety should not be a mode you opt into; every drill should draw a random voice and speed unless it has a reason not to. This is strictly better than the mode was. |
| **Speed Ladder** | Comprehension speed as a metric | Already captured — `latency_ms` on every event is a better automaticity signal than a self-reported ceiling, and it costs nothing. The exercise was measuring by hand what the log measures for free. |
| **Traditional ↔ Simplified** | Script mapping | Absorbed passively. Traditional is primary with Simplified on reveal, so the mapping is learned without a drill. |

This is the one disagreement worth recording: I had rated Voice Roulette "cheap and
valuable". Arthur cut it. Both are right — the *function* is cheap and valuable, the
*mode* was redundant with Listen & Commit. Resolution above.

## Dictation was too hard, so it got difficulty levels

"REALLY hard" for a near-beginner is expected: full pinyin dictation asks you to
produce both segmentals and tones for an entire sentence, from scratch. An exercise
you cannot attempt teaches nothing, and the fix is not to defer it — the skill it
trains is the one that matters most.

Three levels, persisted, defaulting to the easiest:

1. **Tones only** — syllables are given (`ni shuo shen me`), type just the numbers
   (`1413` or `1 4 1 3`). Isolates the hard part, removes the rest. Also prefers
   shorter sentences.
2. **First letters** — `d… x… z… c… s…` as scaffolding.
3. **Full pinyin** — the original.

Tones-only is a genuinely different exercise: it is the sentence-level counterpart to
Tone ID, which Arthur found "surprisingly helpful". That pairing is the tone track.

## Tone work moves earlier

The open question was whether Minimal Pairs would feel impossible, which would have
forced tone remediation into phase 1. It did not — all three tone drills were kept and
Tone ID was called out as helpful. So tones are workable, and they are *engaging*,
which is the more useful finding. Tone drills move into the early mix rather than
being deferred to phase 3.

## Build order

**Phase 1 — the MVP.** A complete loop: introduce a word, drill it, capture new ones.
- Listen & Commit (with random voice/speed as default policy)
- First Exposure
- Add Mandarin
- Tone ID *(promoted — cheap, auto-graded, and it works for him today)*

**Phase 2 — after three weeks of real use.**
- Pinyin Dictation, starting at Tones Only
- Listening Cloze
- Mixed Session
- Minimal Pairs, Same or Different

**Phase 3 — speaking.**
- Shadow, Say It, local `faster-whisper` scoring

**Phase 4 and beyond.** Meaning Match, Which One?, Story Mode, Speed Round, Reading
Sprint, Flash Recognition, Build the Sentence, Grammar Sense, Immersion, Progress.
All kept, all already prototyped, none blocking.

## What is not settled

Story Mode is still built on random sentences rather than actual narrative sequences,
and is worth less than its "keep" implies until that changes. Immersion needs the
learner model before it means anything. Progress needs real data. None of these are
reasons to cut them; they are reasons they sit late in the order.
