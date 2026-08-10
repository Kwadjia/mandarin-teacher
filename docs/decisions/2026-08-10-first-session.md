# First real session — what the log said

**Date:** 2026-08-10. First study session against the real app.
Self-report: *"I think it's all working? I was able to drill 12 new words, and the
tones section worked as well."*

The log disagreed on two counts.

## 1. Every introduction was graded `hard` instead of `good`

12 first-exposure reps, 12 `hard` grades, and every one had `replays >= 1` — six of
them exactly 1, which is the minimum possible.

**Cause.** First Exposure deliberately does not autoplay: it shows the word and its
meaning before you hear it. So the user must click Play — and the caller passed
`isReplay: true` for that click, because every other call site was a genuine replay.
The first listen of a brand-new word was therefore counted as evidence the learner
needed a second listen, and `gradeCommit` downgraded `good` to `hard` accordingly.

**Fix.** `useAudio` now decides for itself: the first play of an item is never a
replay, whoever triggers it. Deciding this at the call site was the mistake — it made
correctness depend on each caller remembering which case it was in.

**Not repaired retroactively.** `hard` on a new card produces a *shorter* interval
than `good`, so the twelve affected cards are over-scheduled rather than lost, and
self-correct within a few reviews. The event log is append-only and the stored grades
stay as they are; inventing corrected history would be worse than a slightly
conservative schedule.

## 2. Tone perception is at chance, and I had concluded otherwise

**7 of 31 correct on Tone ID — 23%, where chance on a four-way choice is 25%.**

| was | answered 1 | 2 | 3 | 4 |
|---|---|---|---|---|
| **1** | **5** | 3 | 1 | 0 |
| **2** | 3 | **0** | 3 | 1 |
| **3** | 7 | 0 | **1** | 1 |
| **4** | 2 | 1 | 2 | **1** |

Tone 1 is audible (5/9). Tone 2 was never once identified (0/7). Tone 3 was heard as
tone 1 seven times out of nine. Seventeen of thirty-one answers were "1" — a strong
bias toward hearing everything as level.

**This corrects the conclusion in `2026-08-10-exercise-selection.md`.** That record
said tone work was *"workable, and engaging"* on the strength of the note *"Tone ID —
this one is surprisingly helpful"*, and moved it into phase 1 as an ordinary drill
rather than as remediation. That inference was wrong: "helpful" described how the
exercise felt, not how accurate it was. Thirty-one measured reps say something the
self-report did not.

Which is the §2.9 principle — that a subjective sense of comprehension is not
evidence of comprehension — applied to my reading of feedback rather than to a drill.
Worth noticing that I built the safeguard into the product and then skipped it myself.

**Response.** Added **Same or Different** to the app: hear two syllables, say whether
the tones match. No naming step, so it isolates discrimination from labelling. It is
now the default tone mode, because if Tone ID is at chance then naming is not the
bottleneck and drilling it harder will not help. Per-tone accuracy is shown under the
drill with 25% marked as the chance line, so this stops being invisible.

n=31 is small. The point is not that the number is precise; it is that the number
exists at all and disagrees with the impression.
