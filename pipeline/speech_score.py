"""Score a spoken attempt against a target sentence. Local, GPU, no API.

Two independent signals, because neither answers the other's question:

  words   faster-whisper transcribes the attempt. This catches wrong or missing
          words — but *only* those. Whisper decodes to the likeliest text, so a
          mispronounced tone comes back as the correct character (check_gpu_speech.py
          returned 它的 for 他的; both tā). It cannot judge pronunciation.

  tones   the raw pitch track, compared against a native clip of the same sentence.
          A tone is a relative movement, so contours are expressed in semitones
          relative to the speaker's own median — that is what lets a male learner be
          compared against a female reference (validated in check_gpu_pitch.py:
          0.59 semitones for the same sentence across a gender boundary, 1.13 for
          different sentences).

This module measures and does not grade. It returns distances and matches; @mt/core
turns those into an FSRS grade, so there is exactly one grading implementation and
the scale cannot drift between exercises (docs/design.md §2.9).

Self-test — uses one voice's clip as a stand-in learner against another's:

    python pipeline/speech_score.py --self-test
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import parselmouth

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent
TMP = Path(os.environ.get("MT_TMP", "D:/ml-cache/mt-speech"))


def _setup_windows_cuda() -> None:
    """Put the pip-installed CUDA libraries where CTranslate2 can find them.

    Since Python 3.8 Windows no longer searches PATH for extension DLLs, so
    ctranslate2 fails to load cuDNN/cuBLAS unless the directories are registered
    explicitly. Doing it here rather than in a launch script means `python
    speech_server.py` works from any shell instead of only from one with the right
    environment exported — a difference that otherwise shows up as a baffling
    "cannot load cudnn_ops64_9.dll" hours later.
    """
    if sys.platform != "win32":
        return
    site = Path(sys.prefix) / "Lib" / "site-packages" / "nvidia"
    for lib in ("cudnn", "cublas", "cuda_runtime", "cuda_nvrtc"):
        d = site / lib / "bin"
        if d.is_dir():
            os.add_dll_directory(str(d))


_setup_windows_cuda()

# Models are large — large-v3 alone is 3 GB — and the C: drive on this machine does
# not have room. Default the cache to D: unless the environment says otherwise.
os.environ.setdefault("HF_HOME", "D:/ml-cache/huggingface")
MODEL_NAME = os.environ.get("MT_WHISPER_MODEL", "large-v3")

# Praat needs a window of 3/floor seconds to estimate pitch, and produces nothing for
# the first half-window of a signal. A 60 Hz floor costs 25ms at each edge, which is a
# meaningful slice of a 150ms sentence-initial syllable. 75 Hz is the conventional
# speech floor and still sits well below a male speaking voice.
# Swept against measured coverage rather than chosen from convention:
#   floor 60, 3 frames → 84%   floor 75, 3 → 89%   floor 75, 2 → 92%   floor 100, 2 → 80%
# 75/2 wins without widening the distance distribution (p85 stays 1.25), so the extra
# coverage is real signal and not noise. 100 Hz is worse because it sits above part of
# a male speaking range and breaks tracking outright.
PITCH_FLOOR = float(os.environ.get("MT_PITCH_FLOOR", "75"))
MIN_FRAMES = int(os.environ.get("MT_MIN_FRAMES", "2"))

# Measured, not guessed — `--calibrate` over 209 syllables from 40 sentences read by
# both a female and a male native voice:
#
#   p50 0.66   p75 1.02   p85 1.25   p90 1.47   p95 1.83   p98 2.19
#
# That spread is the noise floor: two native speakers reading the same sentence
# genuinely differ. Thresholds sit at p85 and p98 of it, so a native reading trips
# "close" about 15% of the time and "off" about 2%. Erring tight would be the worse
# mistake — a learner told they are wrong when they are right stops trusting the
# green marks as well as the red ones. Re-run --calibrate if the voices change.
GOOD_SEMITONES = 1.3
BAD_SEMITONES = 2.2

_model = None
_t2s = None
_ref_cache: dict[str, dict] = {}


# ── text ────────────────────────────────────────────────────────────────────

def _han(c: str) -> bool:
    return "\u4e00" <= c <= "\u9fff" or "\u3400" <= c <= "\u4dbf"


def to_simplified(s: str) -> str:
    """Whisper emits Traditional and Simplified inconsistently, sometimes in one run.

    Script choice is not something the speaker controls, so folding both sides to
    Simplified before comparing keeps it from scoring as a pronunciation error.
    """
    global _t2s
    if _t2s is None:
        import opencc

        _t2s = opencc.OpenCC("t2s")
    return _t2s.convert(s)


TONE_VOWELS = {
    "\u0304": 1,  # macron   ā
    "\u0301": 2,  # acute    á
    "\u030c": 3,  # caron    ǎ
    "\u0300": 4,  # grave    à
}


def syllable_tones(pinyin: str) -> list[int]:
    """Tone number per syllable, from the diacritics. 0 = neutral."""
    out = []
    for syl in pinyin.replace("'", " ").split():
        tone = 0
        for ch in unicodedata.normalize("NFD", syl):
            if ch in TONE_VOWELS:
                tone = TONE_VOWELS[ch]
                break
        out.append(tone)
    return out


def align(target: str, hyp: str) -> list[tuple[str, str | None, int | None]]:
    """Levenshtein backtrace pairing each target character with what was said.

    Returns (target char, spoken char or None, index into hyp or None). The index
    matters: the backtrace skips inserted syllables without emitting a pair, so a
    caller that tracked position with its own counter would drift after the first
    insertion and attribute every later pitch contour to the wrong syllable.

    Alignment is needed at all because a learner who drops or adds one syllable would
    otherwise shift the whole rest of the sentence and read as entirely wrong.
    """
    n, m = len(target), len(hyp)
    d = np.zeros((n + 1, m + 1), dtype=int)
    d[:, 0] = np.arange(n + 1)
    d[0, :] = np.arange(m + 1)
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            d[i, j] = min(
                d[i - 1, j] + 1,
                d[i, j - 1] + 1,
                d[i - 1, j - 1] + (target[i - 1] != hyp[j - 1]),
            )
    pairs: list[tuple[str, str | None, int | None]] = []
    i, j = n, m
    while i > 0:
        if j > 0 and d[i, j] == d[i - 1, j - 1] + (target[i - 1] != hyp[j - 1]):
            pairs.append((target[i - 1], hyp[j - 1], j - 1))
            i, j = i - 1, j - 1
        elif d[i, j] == d[i - 1, j] + 1:
            pairs.append((target[i - 1], None, None))  # not said at all
            i -= 1
        else:
            j -= 1  # inserted syllable; no target to attach it to
    return pairs[::-1]


# ── audio ───────────────────────────────────────────────────────────────────

def to_wav(src: Path | bytes, stem: str = "attempt") -> Path:
    """Decode anything the browser records into 16 kHz mono WAV, leading silence removed.

    MediaRecorder produces webm/opus, which neither whisper nor praat reads directly.

    The silence trim is not cosmetic. Whisper anchors its first word at t=0 regardless
    of when speech actually starts, so with the ~200ms of lead-in every TTS clip has,
    the first syllable's span fell entirely inside the silence and contained no voiced
    frames — which is why 27 of 40 sentence-initial syllables were unmeasurable before
    this. Trimming first means whisper's zero and the pitch track's zero are the same
    instant. It matters even more for a learner, who takes longer than 200ms to start
    talking after clicking record.
    """
    TMP.mkdir(parents=True, exist_ok=True)
    out = TMP / f"{stem}.wav"
    if isinstance(src, bytes):
        raw = TMP / f"{stem}.bin"
        raw.write_bytes(src)
        src = raw
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
         # start_periods=1 trims only the lead-in; pauses inside the sentence are
         # part of the prosody and must survive.
         "-af", "silenceremove=start_periods=1:start_duration=0:start_threshold=-45dB",
         "-ac", "1", "-ar", "16000", str(out)],
        check=True,
    )
    return out


def loaded() -> bool:
    """Whether the model is resident. The server reports this so a slow first attempt
    is explainable rather than mysterious."""
    return _model is not None


def model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel

        _model = WhisperModel(MODEL_NAME, device="cuda", compute_type="float16")
    return _model


def transcribe(wav: Path) -> tuple[str, list[tuple[str, float, float]]]:
    """Transcript plus a (character, start, end) span for every character.

    Whisper's Chinese "words" are short multi-character chunks rather than syllables,
    so a chunk's duration is split evenly across its characters. Crude, but tones live
    on syllables and this is the granularity the feedback needs.
    """
    segs, _ = model().transcribe(str(wav), language="zh", beam_size=5, word_timestamps=True)
    text, spans = [], []
    for seg in segs:
        text.append(seg.text)
        for w in seg.words or []:
            chars = [c for c in to_simplified(w.word) if _han(c)]
            if not chars:
                continue
            step = (w.end - w.start) / len(chars)
            for k, ch in enumerate(chars):
                spans.append((ch, w.start + k * step, w.start + (k + 1) * step))
    return to_simplified("".join(text)), spans


def pitch_track(wav: Path) -> tuple[np.ndarray, np.ndarray]:
    """Times and pitch in semitones relative to this speaker's median.

    Median-centring removes the speaker's register and keeps the shape, which is what
    a tone actually is — without it a male learner scores as wrong on every syllable
    against a female reference.
    """
    snd = parselmouth.Sound(str(wav))
    pitch = snd.to_pitch(pitch_floor=PITCH_FLOOR, pitch_ceiling=500.0)
    f0 = pitch.selected_array["frequency"]
    times = pitch.xs()
    voiced = f0 > 0
    if voiced.sum() < 8:
        return np.array([]), np.array([])
    median = float(np.median(f0[voiced]))
    return times[voiced], 12.0 * np.log2(f0[voiced] / median)


def span_contour(times, semis, t0: float, t1: float, n: int = 24) -> np.ndarray | None:
    """Resample the pitch inside one syllable to a fixed-length shape."""
    if len(times) == 0:
        return None
    sel = (times >= t0) & (times <= t1)
    if sel.sum() < MIN_FRAMES:
        return None
    y = semis[sel]
    return np.interp(np.linspace(0, len(y) - 1, n), np.arange(len(y)), y)


def contour_distance(a: np.ndarray, b: np.ndarray) -> float:
    """Mean absolute semitone difference after DTW alignment.

    DTW absorbs the timing difference between a learner who dwells on a syllable and
    a reference that clips it, so the number reflects pitch shape and not speed.
    """
    n, m = len(a), len(b)
    cost = np.full((n + 1, m + 1), np.inf)
    cost[0, 0] = 0.0
    for i in range(1, n + 1):
        d = np.abs(a[i - 1] - b)
        for j in range(1, m + 1):
            cost[i, j] = d[j - 1] + min(cost[i - 1, j], cost[i, j - 1], cost[i - 1, j - 1])
    return float(cost[n, m] / (n + m))


# ── scoring ─────────────────────────────────────────────────────────────────

@dataclass
class Syllable:
    char: str
    said: str | None
    tone: int
    correct: bool
    distance: float | None = None
    verdict: str = "unscored"  # good | close | off | wrong | missing | unscored
    learner: list[float] = field(default_factory=list)
    reference: list[float] = field(default_factory=list)


def reference(path: Path, target: str) -> dict:
    """Per-character pitch contours for a native clip, cached.

    Cached because the same handful of clips are re-scored constantly and running
    whisper on the reference every attempt would double the latency for no new
    information. Keyed on filename; regenerate the corpus and the key changes.
    """
    key = path.name
    if key in _ref_cache:
        return _ref_cache[key]
    wav = to_wav(path, stem=f"ref_{path.stem}")
    _, spans = transcribe(wav)
    times, semis = pitch_track(wav)
    by_char: dict[int, np.ndarray] = {}
    hyp = "".join(c for c, _, _ in spans)
    # The reference is a native reading of the target, so its transcript should match;
    # align anyway, since whisper can still drop or merge a character.
    for i, (want, got, j) in enumerate(align(target, hyp)):
        if got is None or j is None or want != got:
            continue
        _, t0, t1 = spans[j]
        c = span_contour(times, semis, t0, t1)
        if c is not None:
            by_char[i] = c
    _ref_cache[key] = by_char
    return by_char


def score(attempt: Path | bytes, target_hanzi: str, target_pinyin: str,
          reference_clip: Path | None) -> dict:
    """Measure one spoken attempt. Returns measurements; grading happens in @mt/core."""
    target = to_simplified("".join(c for c in target_hanzi if _han(c)))
    tones = syllable_tones(target_pinyin)

    wav = to_wav(attempt)
    transcript, spans = transcribe(wav)
    times, semis = pitch_track(wav)
    ref = reference(reference_clip, target) if reference_clip else {}

    hyp = "".join(c for c, _, _ in spans) or "".join(c for c in transcript if _han(c))
    pairs = align(target, hyp)

    out: list[Syllable] = []
    for i, (want, got, j) in enumerate(pairs):
        tone = tones[i] if i < len(tones) else 0
        if got is None:
            out.append(Syllable(want, None, tone, False, verdict="missing"))
            continue
        correct = want == got
        s = Syllable(want, got, tone, correct, verdict="good" if correct else "wrong")

        if correct and j is not None:
            _, t0, t1 = spans[j]
            learner = span_contour(times, semis, t0, t1)
            if learner is not None and i in ref:
                d = contour_distance(learner, ref[i])
                s.distance = round(d, 2)
                s.verdict = "good" if d <= GOOD_SEMITONES else ("close" if d <= BAD_SEMITONES else "off")
                s.learner = [round(v, 2) for v in learner]
                s.reference = [round(v, 2) for v in ref[i]]
            else:
                # Unvoiced, too short to measure, or no reference contour for this
                # position. Say so rather than imply the syllable passed.
                s.verdict = "unscored"
        out.append(s)

    scored = [s for s in out if s.distance is not None]
    said_right = sum(1 for s in out if s.correct)
    return {
        "transcript": transcript,
        "target": target,
        "syllables": [vars(s) for s in out],
        "totalSyllables": len(out),
        "correctSyllables": said_right,
        # A syllable said correctly but with the wrong pitch shape. This is the number
        # whisper alone can never produce, and the reason the pitch track exists.
        "toneErrors": sum(1 for s in scored if s.verdict == "off"),
        "scoredSyllables": len(scored),
        "meanToneDistance": round(float(np.mean([s.distance for s in scored])), 2) if scored else None,
    }


# ── self-test ───────────────────────────────────────────────────────────────

def _pairs_for(day0: Path, n: int):
    approved = json.loads((day0 / "sentences.json").read_text(encoding="utf-8"))["approved"]

    def clip(s, voice):
        return next((day0 / c["file"] for c in s["clips"]
                     if c["voice"].startswith(voice) and c["rate"] == "+0%"), None)

    return [s for s in approved[:: max(1, len(approved) // n)][:n]
            if clip(s, "zh-TW-HsiaoChen") and clip(s, "zh-TW-YunJhe")], clip


def calibrate(n: int = 40) -> int:
    """Set the tone thresholds from measured native variation instead of guessing.

    Two native voices reading the same sentence still differ — different prosody,
    different emphasis — and that difference is the noise floor. Any threshold below
    it marks correct speech as wrong, which is the one failure that makes the whole
    feature untrustworthy: a learner who is told they are wrong when they are right
    stops believing the green marks too.

    So GOOD is set at the 85th percentile of native-vs-native distance and BAD at the
    98th. Roughly: a native speaker trips "close" 15% of the time and "off" 2%.
    """
    day0 = ROOT / "out" / "day0"
    picks, clip = _pairs_for(day0, n)
    print(f"calibrating on {len(picks)} native/native sentence pairs\n")

    d: list[float] = []
    total = first_total = first_unscored = 0
    for s in picks:
        r = score(clip(s, "zh-TW-YunJhe"), s["hanzi"], s["pinyin"], clip(s, "zh-TW-HsiaoChen"))
        d += [y["distance"] for y in r["syllables"] if y["distance"] is not None]
        total += r["totalSyllables"]
        if r["syllables"]:
            first_total += 1
            first_unscored += r["syllables"][0]["distance"] is None

    if not d:
        print("no scored syllables — alignment or pitch extraction is failing")
        return 1
    a = np.array(d)
    # A syllable we cannot measure is feedback the learner does not get, so coverage
    # is as much a quality number as accuracy is.
    print(f"  {len(a)}/{total} syllables measurable ({len(a) / total:.0%} coverage)")
    print(f"  sentence-initial unmeasured: {first_unscored}/{first_total}")
    for p in (50, 75, 85, 90, 95, 98):
        print(f"    p{p:<3} {np.percentile(a, p):5.2f} semitones")
    print(f"\n  suggested GOOD_SEMITONES = {np.percentile(a, 85):.1f}")
    print(f"  suggested BAD_SEMITONES  = {np.percentile(a, 98):.1f}")
    print(f"  current:  GOOD {GOOD_SEMITONES}  BAD {BAD_SEMITONES}")
    off = (a > BAD_SEMITONES).mean()
    print(f"  at current thresholds, native speech reads 'off' {off:.0%} of the time")
    return 0


def self_test() -> int:
    """Stand in a male voice for the learner and score it against a female reference.

    Two cases have to separate, or the scorer is not measuring speech:
      MATCH  the same sentence, different voice → high accuracy, low tone distance
      WRONG  a different sentence entirely      → low accuracy
    """
    day0 = ROOT / "out" / "day0"
    approved = json.loads((day0 / "sentences.json").read_text(encoding="utf-8"))["approved"]

    def clip(s, voice):
        return next((day0 / c["file"] for c in s["clips"]
                     if c["voice"].startswith(voice) and c["rate"] == "+0%"), None)

    picks = [s for s in approved[:: max(1, len(approved) // 8)][:8]
             if clip(s, "zh-TW-HsiaoChen") and clip(s, "zh-TW-YunJhe")]

    print(f"{MODEL_NAME} · {len(picks)} sentences · male attempt vs female reference\n")
    for i, s in enumerate(picks):
        r = score(clip(s, "zh-TW-YunJhe"), s["hanzi"], s["pinyin"], clip(s, "zh-TW-HsiaoChen"))
        marks = "".join(
            {"good": "+", "close": "~", "off": "!", "wrong": "x", "missing": "_"}.get(y["verdict"], "?")
            for y in r["syllables"]
        )
        print(f"  MATCH {r['correctSyllables']}/{r['totalSyllables']} said · "
              f"tone {r['meanToneDistance']} · {marks}  {s['hanzi']}")

        wrong = picks[(i + 1) % len(picks)]
        w = score(clip(wrong, "zh-TW-YunJhe"), s["hanzi"], s["pinyin"], clip(s, "zh-TW-HsiaoChen"))
        print(f"  WRONG {w['correctSyllables']}/{w['totalSyllables']} said · "
              f"heard \"{w['transcript'].strip()}\"\n")
    return 0


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        raise SystemExit(self_test())
    if "--calibrate" in sys.argv:
        raise SystemExit(calibrate())
    print(__doc__)
    raise SystemExit(1)
