"""Does the speaking loop actually run on this GPU, for free, fast enough to feel live?

Three things have to be true before any speaking exercise is worth designing, and
none of them are safe to assume on a Blackwell card (sm_120 is new enough that
CUDA wheels often predate it):

  1. faster-whisper loads on CUDA at all
  2. it transcribes Mandarin accurately enough to judge whether I said the words
  3. it does so in well under the ~1s that makes feedback feel immediate

The test material is our own TTS corpus, which is the honest choice available: we
know the exact ground truth for all 4,280 clips, so accuracy is measured, not
eyeballed. It is also the optimistic case — clean studio speech with no
background noise. Whatever accuracy we see here is a ceiling, not an expectation.

    python pipeline/check_gpu_speech.py
"""

from __future__ import annotations

import json
import statistics
import sys
import time
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent
DAY0 = ROOT / "out" / "day0"
PUNCT = set("，。！？、：；“”‘’…—《》（）,.!?;:\"' ")
N = 12


_t2s = None


def strip(s: str) -> str:
    """Drop punctuation and fold to Simplified.

    Whisper emits Traditional and Simplified inconsistently — sometimes within the same
    run — so a raw comparison scores 寶寶睡覺了 against 宝宝睡觉了 as 60% wrong when the
    recognition was perfect. Script choice is not something the speaker controls, so it
    must not count as an error.
    """
    global _t2s
    if _t2s is None:
        import opencc

        _t2s = opencc.OpenCC("t2s")
    return _t2s.convert("".join(c for c in s if c not in PUNCT))


def cer(ref: str, hyp: str) -> float:
    """Character error rate — Levenshtein over characters, normalised by reference length."""
    ref, hyp = strip(ref), strip(hyp)
    if not ref:
        return 0.0
    prev = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        cur = [i]
        for j, h in enumerate(hyp, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r != h)))
        prev = cur
    return prev[-1] / len(ref)


def main() -> int:
    manifest = json.loads((DAY0 / "sentences.json").read_text(encoding="utf-8"))
    approved = manifest["approved"]

    # Spread the sample across the whole corpus rather than taking the first N, which
    # are all short baby-related lines and would flatter the result. Full speed (+0%)
    # only — the -15% clips are easier and not what a person would say.
    step = max(1, len(approved) // N)
    clips = []
    for s in approved[::step][:N]:
        full = [c for c in s["clips"] if c["rate"] == "+0%"]
        if full:
            clips.append((DAY0 / full[len(clips) % len(full)]["file"], s["hanzi"]))
    if not clips:
        print("no clips matched sentences.json — check the naming convention")
        return 1

    print(f"testing {len(clips)} clips\n")

    from faster_whisper import WhisperModel

    # small first: if it is accurate enough, it is 10x cheaper to load and run, and
    # model size is the only real latency knob we have.
    trials = [(m, "cuda", "float16") for m in ("small", "large-v3")]
    trials.append(("small", "cpu", "int8"))  # fallback path if CUDA is unusable

    for name, device, compute in trials:
        print(f"--- {name} on {device} ({compute}) ---")
        t0 = time.perf_counter()
        try:
            model = WhisperModel(name, device=device, compute_type=compute)
        except Exception as e:  # noqa: BLE001 — the whole point is to see the failure
            print(f"  FAILED to load: {type(e).__name__}: {str(e)[:400]}\n")
            continue
        print(f"  model loaded in {time.perf_counter() - t0:.1f}s")

        times, errors = [], []
        for i, (path, ref) in enumerate(clips):
            t = time.perf_counter()
            segs, _ = model.transcribe(str(path), language="zh", beam_size=5)
            hyp = "".join(s.text for s in segs)
            dt = (time.perf_counter() - t) * 1000
            # The first call includes CUDA kernel autotuning — an order of magnitude
            # slower than steady state, and not what the learner would experience.
            if i > 0:
                times.append(dt)
            e = cer(ref, hyp)
            errors.append(e)
            flag = "   " if e == 0 else ("  ~" if e < 0.34 else "  X")
            print(f"{flag} {dt:6.0f}ms  cer {e:4.0%}  {ref}  ->  {strip(hyp)}")

        exact = sum(1 for e in errors if e == 0)
        warm = f"{statistics.median(times):.0f}ms" if times else "n/a"
        print(f"  exact {exact}/{len(errors)} · mean CER {statistics.mean(errors):.0%}"
              f" · median {warm} (warm)\n")
        del model

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
