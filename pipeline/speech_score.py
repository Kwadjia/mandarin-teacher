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
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

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


def syllables(chars: str) -> list[tuple[str, int]]:
    """(base syllable, tone) per character — 尿 → ('niao', 4), 鸟 → ('niao', 3).

    Derived per character rather than parsed out of the corpus pinyin string, because
    that string is written in words: "bǎobao shuìjiào le" is three space-separated
    tokens for five characters, so splitting it on spaces misaligned the tone of every
    multi-syllable word.

    Splitting base from tone is what lets a tone error be told apart from a wrong word.
    Comparing characters cannot: 尿 heard as 鸟 is the right sound with the wrong tone,
    but it scored as a wrong word and drew no tone feedback at all — on exactly the
    syllable where tone feedback was the entire point.
    """
    from pypinyin import Style, lazy_pinyin

    out: list[tuple[str, int]] = []
    for ch in chars:
        p = lazy_pinyin(ch, style=Style.TONE3, errors=lambda x: [x])[0]
        if p and p[-1].isdigit():
            out.append((p[:-1], int(p[-1])))
        else:
            out.append((p, 0))  # a neutral tone carries no digit
    return out


def align(target: Sequence, hyp: Sequence) -> list[tuple[Any, Any | None, int | None]]:
    """Levenshtein backtrace pairing each target element with what was said.

    Runs over base syllables rather than characters. For learner speech that matters:
    a tone slip turns 尿 into 鸟, which as characters is a substitution but as syllables
    is a match, so the alignment stays anchored instead of cascading into spurious
    errors down the rest of the sentence.

    Returns (target element, spoken element or None, index into hyp or None). The index
    matters: the backtrace skips insertions without emitting a pair, so a caller that
    tracked position with its own counter would drift after the first inserted syllable
    and attribute every later pitch contour to the wrong one.
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


def transcribe(wav: Path) -> tuple[str, list[tuple[str, float, float]], float]:
    """Transcript, a (character, start, end) span per character, and mean confidence.

    Whisper's Chinese "words" are short multi-character chunks rather than syllables,
    so a chunk's duration is split evenly across its characters. Crude, but tones live
    on syllables and this is the granularity the feedback needs.

    Confidence is returned because learner speech makes whisper hallucinate outright —
    real attempts here came back as "99888" and "宝宝SOLA". Those are recogniser
    failures, and grading them as if the learner had said nothing poisons the log with
    failures that were never theirs.
    """
    segs, _ = model().transcribe(
        str(wav),
        language="zh",
        beam_size=5,
        word_timestamps=True,
        # Each attempt is one short utterance; carrying context between them invites
        # whisper to invent continuations of the previous sentence.
        condition_on_previous_text=False,
    )
    text, spans, logprobs = [], [], []
    for seg in segs:
        text.append(seg.text)
        logprobs.append(seg.avg_logprob)
        for w in seg.words or []:
            chars = [c for c in to_simplified(w.word) if _han(c)]
            if not chars:
                continue
            step = (w.end - w.start) / len(chars)
            for k, ch in enumerate(chars):
                spans.append((ch, w.start + k * step, w.start + (k + 1) * step))
    confidence = float(np.mean(logprobs)) if logprobs else -99.0
    return to_simplified("".join(text)), spans, confidence


def pitch_track(wav: Path) -> tuple[np.ndarray, np.ndarray]:
    """Times and pitch in semitones relative to this speaker's median.

    Median-centring removes the speaker's register and keeps the shape, which is what
    a tone actually is — without it a male learner scores as wrong on every syllable
    against a female reference.
    """
    # Trimming leading silence from a recording of nothing leaves a zero-sample file,
    # and Praat raises rather than returning an empty track. Clicking Speak and saying
    # nothing is an ordinary thing to do, not a server error.
    if wav.stat().st_size < 1024:
        return np.array([]), np.array([])
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
    """What the recogniser heard in this position, as a character."""
    said: str | None
    """Expected pinyin, e.g. 'niào'. Shown so a tone error can be read, not guessed."""
    pinyin: str
    """Pinyin of what was actually heard, when it differs."""
    saidPinyin: str | None
    tone: int
    heardTone: int | None
    """Right base syllable — the sound landed, whatever happened to the tone."""
    correct: bool
    distance: float | None = None
    verdict: str = "unscored"  # good | close | tone | wrong | missing | unscored
    learner: list[float] = field(default_factory=list)
    reference: list[float] = field(default_factory=list)


TONE_MARK = {0: "", 1: "ˉ", 2: "ˊ", 3: "ˇ", 4: "ˋ"}


def _pretty(base: str, tone: int) -> str:
    return f"{base}{TONE_MARK.get(tone, '')}"


def reference(path: Path, target: str) -> dict:
    """Per-position pitch contours for a native clip, cached.

    Cached because the same handful of clips are re-scored constantly and running
    whisper on the reference every attempt would double the latency for no new
    information.

    Keyed on filename *and* target, because the contours are indexed by position in the
    target rather than by anything intrinsic to the clip. Keying on the filename alone
    meant one request that paired a clip with the wrong sentence cached a nearly empty
    result and silently starved every later attempt on that clip of tone feedback.
    """
    key = f"{path.name}|{target}"
    if key in _ref_cache:
        return _ref_cache[key]
    wav = to_wav(path, stem=f"ref_{path.stem}")
    _, spans, _ = transcribe(wav)
    times, semis = pitch_track(wav)
    by_pos: dict[int, np.ndarray] = {}
    hyp = "".join(c for c, _, _ in spans)
    # The reference is a native reading of the target, so its transcript should match;
    # align on syllables anyway, since whisper can still drop or merge a character.
    want_syl = [b for b, _ in syllables(target)]
    got_syl = [b for b, _ in syllables(hyp)]
    for i, (want, got, j) in enumerate(align(want_syl, got_syl)):
        if got is None or j is None or want != got:
            continue
        _, t0, t1 = spans[j]
        c = span_contour(times, semis, t0, t1)
        if c is not None:
            by_pos[i] = c
    _ref_cache[key] = by_pos
    return by_pos


def _voiced_frames(wav: Path) -> int:
    """How many frames carry pitch. A cheap "was that actually speech" check."""
    times, _ = pitch_track(wav)
    return len(times)


# Whether the recording contains speech at all, decided by counting frames that carry
# pitch. Measured across audio quality:
#
#   clean TTS       59 voiced frames, confidence -0.14
#   degraded speech 45 voiced frames, confidence -0.18   (quiet, noisy, band-limited)
#   pink noise       0 voiced frames, confidence -0.64   → whisper wrote "谢谢大家"
#
# Voiced frames separate cleanly; confidence does not. -0.64 against -0.18 leaves no
# room for a threshold that rejects noise without also rejecting a real attempt
# recorded across a room, and rejecting real attempts is much the worse failure.
# Confidence is kept only as a loose backstop.
MIN_VOICED_FRAMES = 10
MIN_CONFIDENCE = -1.5


KEEP_ATTEMPTS = int(os.environ.get("MT_KEEP_ATTEMPTS", "300"))
ATTEMPTS = Path(os.environ.get("MT_ATTEMPTS", "D:/ml-cache/mt-attempts"))


def _keep(wav: Path, meta: dict) -> None:
    """Retain the recording and what we made of it, for later diagnosis.

    Every threshold in this file was calibrated against TTS clips standing in for a
    learner, because no recording of the actual learner existed. That was the root
    cause of two rounds of wrong tuning: synthetic speech is clean, native, and
    correctly pronounced, which is exactly what real attempts are not.

    Kept locally, never uploaded, and capped — this is the same machine that already
    holds the recordings, so it adds no exposure, and the diagnostic value is the
    difference between measuring and guessing.
    """
    try:
        ATTEMPTS.mkdir(parents=True, exist_ok=True)
        existing = sorted(ATTEMPTS.glob("*.wav"))
        for old in existing[: max(0, len(existing) - KEEP_ATTEMPTS + 1)]:
            old.unlink(missing_ok=True)
            old.with_suffix(".json").unlink(missing_ok=True)
        # Monotonic and collision-free without needing a clock the caller controls.
        n = 1 + max((int(p.stem) for p in existing if p.stem.isdigit()), default=0)
        dest = ATTEMPTS / f"{n:05d}.wav"
        dest.write_bytes(wav.read_bytes())
        dest.with_suffix(".json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8"
        )
    except OSError:
        pass  # diagnostics must never break scoring


def score(attempt: Path | bytes, target_hanzi: str, target_pinyin: str,
          reference_clip: Path | None) -> dict:
    """Measure one spoken attempt. Returns measurements; grading happens in @mt/core.

    Matching is done on base syllables, not characters. A learner who says the right
    sound with the wrong tone produces a different character — 尿 becomes 鸟 — and
    calling that a wrong word is both wrong and useless, since it withholds tone
    feedback exactly where it is needed. Comparing 'niao' to 'niao' identifies the
    sound as correct and hands the tone to a separate judgement.

    Tone is judged from two independent sources, and either can convict:
      - the tone whisper implicitly heard, from the character it chose (4 vs 3 above).
        Precise when it fires, but silent whenever the language model snaps back to the
        expected word.
      - the pitch contour against a native reading. Always available, noisier.
    """
    target = to_simplified("".join(c for c in target_hanzi if _han(c)))
    wav = to_wav(attempt)

    def unusable(reason: str, transcript: str = "", confidence: float | None = None) -> dict:
        """A recogniser failure is not a learner failure.

        Returning this rather than a score lets the caller decline to grade. Whisper
        hallucinates fluently on unclear input — real attempts came back as "99888",
        "宝宝SOLA" and "欢迎订阅我的频道" (a caption phrase memorised from YouTube, and its
        signature output when it cannot decode) — and logging those as 0/5 buries cards
        for mistakes that were never made.
        """
        _keep(wav, {"target": target, "targetPinyin": target_pinyin, "transcript": transcript,
                    "confidence": confidence, "unusable": True, "reason": reason})
        return {
            "unusable": True, "reason": reason, "transcript": transcript, "target": target,
            "confidence": confidence, "syllables": [], "totalSyllables": 0,
            "correctSyllables": 0, "toneErrors": 0, "scoredSyllables": 0,
            "meanToneDistance": None,
        }

    # Checked before transcription, not after: this avoids the hallucination rather than
    # filtering it, and skips the GPU work entirely when there is nothing to recognise.
    times, semis = pitch_track(wav)
    if len(times) < MIN_VOICED_FRAMES:
        return unusable("no speech in the recording — check the microphone")

    transcript, spans, confidence = transcribe(wav)
    hyp = "".join(c for c, _, _ in spans) or "".join(c for c in transcript if _han(c))
    if not hyp:
        return unusable("nothing recognisable as Mandarin", transcript, round(confidence, 2))
    if confidence < MIN_CONFIDENCE:
        return unusable("the recording was too unclear to score", transcript, round(confidence, 2))

    want_syl = syllables(target)
    got_syl = syllables(hyp)
    pairs = align([b for b, _ in want_syl], [b for b, _ in got_syl])

    # Not one syllable in common. Someone attempting a sentence they just heard does not
    # miss every single sound — but a recogniser that has given up produces exactly this,
    # fluently and with no other outward sign:
    #
    #   换尿布吧      → "欢迎订阅我的频道"
    #   车在房子后面  → "这是番萨荷米"
    #   奶奶抱宝宝    → "来呢 吧 吧 吧"
    #
    # Declining to grade costs a rep. Grading it writes `again` against words that were
    # probably said correctly, and that is a lie the log keeps forever.
    matched = sum(1 for i, (w, g, j) in enumerate(pairs)
                  if g is not None and want_syl[i][0] == got_syl[j][0])
    if matched == 0 and len(want_syl) >= 3:
        return unusable(
            "couldn't match that to the sentence — the recogniser struggles with "
            "learner speech, so this was not counted",
            transcript,
            round(confidence, 2),
        )

    ref = reference(reference_clip, target) if reference_clip else {}

    out: list[Syllable] = []
    for i, (want, got, j) in enumerate(pairs):
        base, tone = want_syl[i] if i < len(want_syl) else (str(want), 0)
        char = target[i] if i < len(target) else str(want)

        if got is None or j is None:
            out.append(Syllable(char, None, _pretty(base, tone), None, tone, None, False,
                                verdict="missing"))
            continue

        heard_base, heard_tone = got_syl[j]
        heard_char = hyp[j] if j < len(hyp) else ""
        right_sound = base == heard_base

        s = Syllable(
            char=char,
            said=heard_char,
            pinyin=_pretty(base, tone),
            saidPinyin=_pretty(heard_base, heard_tone),
            tone=tone,
            heardTone=heard_tone,
            correct=right_sound,
            verdict="good" if right_sound else "wrong",
        )

        if right_sound:
            _, t0, t1 = spans[j]
            learner = span_contour(times, semis, t0, t1)
            if learner is not None and i in ref:
                d = contour_distance(learner, ref[i])
                s.distance = round(d, 2)
                s.learner = [round(v, 2) for v in learner]
                s.reference = [round(v, 2) for v in ref[i]]

            # Whisper picking a different-toned word is strong, specific evidence and
            # outranks the contour. A neutral tone is excluded: it has no target shape,
            # and whisper's neutral-vs-full choice is unreliable.
            if tone and heard_tone and tone != heard_tone:
                s.verdict = "tone"
            elif s.distance is None:
                s.verdict = "unscored"
            elif s.distance > BAD_SEMITONES:
                s.verdict = "tone"
            elif s.distance > GOOD_SEMITONES:
                s.verdict = "close"

        out.append(s)

    scored = [s for s in out if s.distance is not None or s.verdict == "tone"]
    _keep(wav, {
        "target": target, "targetPinyin": target_pinyin, "transcript": transcript,
        "confidence": round(confidence, 2), "unusable": False,
        "correct": sum(1 for s in out if s.correct), "total": len(out),
        "verdicts": [s.verdict for s in out],
        "heard": [s.saidPinyin for s in out],
        "want": [s.pinyin for s in out],
    })
    return {
        "unusable": False,
        "reason": None,
        "transcript": transcript,
        "target": target,
        "confidence": round(confidence, 2),
        "syllables": [vars(s) for s in out],
        "totalSyllables": len(out),
        "correctSyllables": sum(1 for s in out if s.correct),
        # Right sound, wrong tone. The number transcription alone cannot produce, and
        # the reason both signals exist.
        "toneErrors": sum(1 for s in out if s.verdict == "tone"),
        "scoredSyllables": len(scored),
        "meanToneDistance": (
            round(float(np.mean([s.distance for s in scored if s.distance is not None])), 2)
            if any(s.distance is not None for s in scored)
            else None
        ),
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
            {"good": "+", "close": "~", "tone": "!", "wrong": "x", "missing": "_"}.get(y["verdict"], "?")
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
