"""Inspect saved attempts — the real ones, from the real learner.

Every threshold in speech_score.py was originally calibrated against TTS clips
standing in for a learner, because no recording of the learner existed. That was the
root cause of two rounds of wrong tuning: synthetic speech is clean, native, and
correctly pronounced, which is precisely what real attempts are not.

    python pipeline/review_attempts.py            # summary of everything kept
    python pipeline/review_attempts.py --rescore  # re-run scoring after a code change

`--rescore` is the point of keeping the audio: a threshold or algorithm change can be
evaluated against attempts that already happened, instead of asking someone to speak
into a microphone thirty more times to find out whether it helped.
"""

from __future__ import annotations

import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import speech_score as ss  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

MARK = {"good": "+", "close": "~", "tone": "!", "wrong": "x", "missing": "_", "unscored": "?"}

_by_target: dict[str, str] | None = None


def _infer_reference(target: str) -> str | None:
    """Find a native clip for this sentence when the attempt predates recording it.

    Attempts saved before the `reference` field existed have no clip name, and without
    one a rescore has nothing to compare contours against — every syllable comes back
    unscored, which makes the earliest and most interesting recordings unusable for
    evaluating changes. Matching on the target sentence recovers them.
    """
    global _by_target
    if _by_target is None:
        manifest = ss.AUDIO_DIR / "sentences.json"
        _by_target = {}
        if manifest.is_file():
            for s in json.loads(manifest.read_text(encoding="utf-8"))["approved"]:
                key = "".join(c for c in ss.to_simplified(s["hanzi"]) if ss._han(c))
                clip = next((c["file"] for c in s["clips"] if c["rate"] == "+0%"), None)
                if clip:
                    _by_target[key] = clip
    return _by_target.get(target)


def main() -> int:
    files = sorted(ss.ATTEMPTS.glob("*.json"))
    if not files:
        print(f"No attempts saved yet in {ss.ATTEMPTS}.")
        print("They accumulate as the Speak drill is used.")
        return 1

    rescore = "--rescore" in sys.argv
    print(f"{len(files)} attempts in {ss.ATTEMPTS}{'  (re-scoring)' if rescore else ''}\n")

    confs, rates, unusable = [], [], 0
    for f in files:
        m = json.loads(f.read_text(encoding="utf-8"))
        wav = f.with_suffix(".wav")

        if rescore and wav.exists():
            # Same native clip as the original attempt, or contours have nothing to
            # compare against and every syllable comes back unscored. keep=False, or
            # each rescore would re-save all of them and double the store.
            ref = m.get("reference") or _infer_reference(m["target"])
            ref_path = ss.AUDIO_DIR / ref if ref and (ss.AUDIO_DIR / ref).is_file() else None
            r = ss.score(wav, m["target"], m.get("targetPinyin", ""), ref_path, keep=False)
            m = {**m, "transcript": r["transcript"], "confidence": r.get("confidence"),
                 "unusable": r["unusable"], "reason": r.get("reason"),
                 "correct": r["correctSyllables"], "total": r["totalSyllables"],
                 "verdicts": [s["verdict"] for s in r["syllables"]],
                 "errorKinds": [s["errorKind"] for s in r["syllables"]],
                 "heard": [s["saidPinyin"] for s in r["syllables"]],
                 "want": [s["pinyin"] for s in r["syllables"]]}
            # Write the fresh analysis back, so the stored set reflects current code.
            f.write_text(json.dumps(m, ensure_ascii=False, indent=1), encoding="utf-8")

        conf = m.get("confidence")
        if conf is not None:
            confs.append(conf)

        if m.get("unusable"):
            unusable += 1
            print(f"  {f.stem}  conf {conf!s:>6}  NOT SCORED  {m['target']}")
            print(f"          heard {m.get('transcript', '')!r} — {m.get('reason', '')}")
            continue

        total = m.get("total") or 1
        rates.append(m.get("correct", 0) / total)
        marks = "".join(MARK.get(v, "?") for v in m.get("verdicts", []))
        print(f"  {f.stem}  conf {conf!s:>6}  {m.get('correct')}/{m.get('total')}  "
              f"{marks:<10}  {m['target']}")
        print(f"          heard {m.get('transcript', '')!r}")

    print(f"\n── {len(files)} attempts ──")
    print(f"  not scored: {unusable} ({unusable / len(files):.0%})")
    if rates:
        print(f"  right-sound rate: mean {statistics.mean(rates):.0%}, "
              f"median {statistics.median(rates):.0%}")
    if confs:
        confs.sort()
        q = lambda p: confs[min(len(confs) - 1, int(p * len(confs)))]  # noqa: E731
        print(f"  confidence: p10 {q(0.1):.2f}  p50 {q(0.5):.2f}  p90 {q(0.9):.2f}")
        print("\n  Compare against the synthetic baseline the thresholds came from:")
        print("    clean TTS -0.14 · degraded speech -0.18 · pink noise -0.64")
        print(f"    current cutoff MIN_CONFIDENCE = {ss.MIN_CONFIDENCE}")
        below = sum(1 for c in confs if c < -0.64)
        print(f"    real attempts quieter than pink noise: {below}/{len(confs)}"
              f" — which is why confidence cannot be the filter")

    # The part a teacher would notice and a single attempt cannot show: the same
    # sound going wrong the same way, session after session.
    confusions: dict[tuple[str, str, str], int] = {}
    for f in files:
        m = json.loads(f.read_text(encoding="utf-8"))
        for want, heard, kind in zip(m.get("want") or [], m.get("heard") or [],
                                     m.get("errorKinds") or []):
            if kind and want and heard:
                confusions[(kind, want, heard)] = confusions.get((kind, want, heard), 0) + 1
    if confusions:
        print("\n── recurring confusions ──")
        for kind in ("tone", "vowel", "consonant", "different"):
            rows = sorted(((k, n) for k, n in confusions.items() if k[0] == kind),
                          key=lambda kv: -kv[1])
            if not rows:
                continue
            print(f"  {kind}:")
            for (_, want, heard), n in rows[:8]:
                # Identical pinyin on both sides means whisper picked the right word
                # and the pitch contour caught the tone anyway — the two signals
                # covering for each other, which is the whole point of having both.
                detail = "pitch drifted" if want == heard else f"heard {heard}"
                print(f"    {n}x  want {want:<8} {detail}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
