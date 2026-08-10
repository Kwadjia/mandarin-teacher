"""Can a pitch contour tell a good tone from a bad one — across different speakers?

Whisper cannot judge tones. It decodes to the most probable text, so it silently
repairs a mispronounced tone into the right character (see check_gpu_speech.py,
where 他的 came back as 它的 — both tā). Tone feedback therefore has to come from
the raw pitch track, not the transcript.

The metric only works if it is speaker-invariant. A tone is a *relative* pitch
movement, and I am a man comparing myself to a female TTS voice roughly an octave
higher. Absolute Hz is meaningless here; the contour shape is the signal. So we
convert to semitones relative to each speaker's own median.

Two things have to hold, and either one failing kills the approach:

  SAME  the same sentence read by a female and a male voice must score as similar
  DIFF  two different sentences must score as dissimilar

If SAME does not clearly beat DIFF, the metric is measuring speaker or noise
rather than tone, and no amount of UI will rescue it.

    python pipeline/check_gpu_pitch.py
"""

from __future__ import annotations

import json
import statistics
import sys
from pathlib import Path

import numpy as np
import parselmouth

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent
DAY0 = ROOT / "out" / "day0"
FEMALE, MALE = "zh-TW-HsiaoChen", "zh-TW-YunJhe"


def contour(path: Path, n: int = 64) -> np.ndarray | None:
    """Pitch as semitones from the speaker's own median, resampled to n points.

    Median-centring is what makes this comparable across voices: it removes the
    speaker's register and keeps only the shape, which is what a tone actually is.
    Unvoiced frames are dropped rather than zero-filled — a zero would read as a
    huge pitch drop and invent a falling tone that was never spoken.
    """
    snd = parselmouth.Sound(str(path))
    f0 = snd.to_pitch(pitch_floor=60.0, pitch_ceiling=500.0).selected_array["frequency"]
    voiced = f0[f0 > 0]
    if len(voiced) < 8:
        return None
    semitones = 12.0 * np.log2(voiced / np.median(voiced))
    return np.interp(np.linspace(0, len(semitones) - 1, n), np.arange(len(semitones)), semitones)


def distance(a: np.ndarray, b: np.ndarray) -> float:
    """Mean absolute difference in semitones after DTW alignment.

    DTW absorbs the timing differences between two speakers — one dwells on a
    syllable, the other clips it — so the score reflects pitch shape rather than
    speaking rate. Roughly: how many semitones off is the contour, on average.
    """
    n, m = len(a), len(b)
    cost = np.full((n + 1, m + 1), np.inf)
    cost[0, 0] = 0.0
    for i in range(1, n + 1):
        d = np.abs(a[i - 1] - b)
        for j in range(1, m + 1):
            cost[i, j] = d[j - 1] + min(cost[i - 1, j], cost[i, j - 1], cost[i - 1, j - 1])
    return float(cost[n, m] / (n + m))


def main() -> int:
    approved = json.loads((DAY0 / "sentences.json").read_text(encoding="utf-8"))["approved"]

    def clip(s: dict, voice: str) -> Path | None:
        for c in s["clips"]:
            if c["voice"].startswith(voice) and c["rate"] == "+0%":
                return DAY0 / c["file"]
        return None

    pairs = []
    for s in approved[:: max(1, len(approved) // 20)][:20]:
        f, m = clip(s, FEMALE), clip(s, MALE)
        if f and m:
            pairs.append((s["hanzi"], f, m))
    if len(pairs) < 4:
        print("not enough female/male clip pairs to test")
        return 1

    print(f"{len(pairs)} sentences, each read by {FEMALE} (f) and {MALE} (m)\n")

    same, diff = [], []
    for i, (hanzi, f, m) in enumerate(pairs):
        cf, cm = contour(f), contour(m)
        if cf is None or cm is None:
            continue
        d_same = distance(cf, cm)
        same.append(d_same)

        # Same male voice, a different sentence. This isolates the sentence as the
        # only variable, which is the comparison that has to fail.
        other = pairs[(i + 1) % len(pairs)]
        co = contour(other[2])
        d_diff = distance(cf, co) if co is not None else None
        if d_diff is not None:
            diff.append(d_diff)

        mark = "ok " if d_diff is not None and d_same < d_diff else "BAD"
        print(f"  {mark} same {d_same:4.2f}   diff {d_diff:4.2f}   {hanzi}")

    wins = sum(1 for s, d in zip(same, diff) if s < d)
    print(f"\n  same-sentence mean {statistics.mean(same):.2f} semitones")
    print(f"  diff-sentence mean {statistics.mean(diff):.2f} semitones")
    print(f"  correctly ranked   {wins}/{len(diff)}")
    verdict = "USABLE" if wins >= 0.8 * len(diff) else "NOT USABLE — measures something else"
    print(f"  verdict: {verdict}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
