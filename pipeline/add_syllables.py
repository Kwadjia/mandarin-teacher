"""Add per-syllable, tone-numbered pinyin to every sentence, from the pinyin we wrote.

    python pipeline/add_syllables.py [--write]

Dictation grades syllable by syllable, but `seed_sentences.json` stores pinyin in words
— "bǎobao shuìjiào le", three tokens for five syllables — because that is how a person
reads it. Splitting that back apart is not safe by inspection: 西安 is xī'ān while 先 is
xiān, and the apostrophe is often omitted.

Neither is pypinyin safe on its own. Per character it loses word context (睡觉 → shui4
jue2, 银行 → yin2 xing2). On the whole string it fixes those and even applies tone
sandhi, but invents others: 我们都会 comes back as du1 rather than dou1.

So pypinyin is used only to propose *where the syllable boundaries fall*, and the tones
come from the hand-written, human-checked pinyin already in the corpus. If the proposed
split does not reconstruct that pinyin letter for letter, the sentence is reported and
left untagged rather than given a wrong answer key — a dictation exercise that marks a
correct answer wrong is worse than no exercise.
"""

from __future__ import annotations

import json
import sys
import unicodedata
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent
SENTENCES = ROOT / "data" / "seed_sentences.json"

TONE_MARKS = {"̄": 1, "́": 2, "̌": 3, "̀": 4}
DIAERESIS = "̈"

# Readings where the corpus and pypinyin legitimately disagree. Only the boundary
# matters here — the tone comes from the written pinyin either way — so accepting the
# alternate is safe, and refusing it would drop good sentences.
#
#   shui/shei   谁 — both standard; shéi is the everyday and Taiwan-leaning reading
#   zhang/chang 长 — genuinely two words, and pypinyin picks the wrong one in 很长
ALTERNATES = {
    "shui": ["shei"],
    "shei": ["shui"],
    "zhang": ["chang"],
    "chang": ["zhang"],
    "jue": ["jiao"],
    "jiao": ["jue"],
    "le": ["yue"],
    "yue": ["le"],
    "xing": ["hang"],
    "hang": ["xing"],
    "dou": ["du"],
    "du": ["dou"],
    "de": ["dei", "di"],
    "he": ["huo", "han", "hu"],
    "huo": ["he"],  # 和 — pypinyin reads it as huo2 in 鸡蛋和面包
}


def han(c: str) -> bool:
    return "一" <= c <= "鿿" or "㐀" <= c <= "䶿"


def normalise(letters: str) -> str:
    """Fold the spellings that differ only by convention: ü/v/u:, and case."""
    return letters.lower().replace("ü", "v").replace("u:", "v")


def parse_written(pinyin: str) -> tuple[str, list[int]]:
    """The hand-written pinyin as (bare letters, tone per letter position).

    Tones are kept per letter rather than per syllable because the syllable boundaries
    are not known yet — that is what the split is for.
    """
    letters: list[str] = []
    tones: list[int] = []
    for ch in unicodedata.normalize("NFD", pinyin):
        if ch in TONE_MARKS:
            if tones:
                tones[-1] = TONE_MARKS[ch]  # the mark follows its vowel
        elif ch == DIAERESIS:
            # ǚ decomposes to u + diaeresis + caron. Dropping the diaeresis as "not a
            # letter" turned nǚ into nu, which then failed to match pypinyin's nv and
            # cost every sentence containing 女, 绿 or 旅.
            if letters and letters[-1] == "u":
                letters[-1] = "v"
        elif ch.isalpha() or ch == "ü":
            letters.append(ch)
            tones.append(0)
    return normalise("".join(letters)), tones


def split_for(hanzi: str, written: str) -> list[str] | None:
    """Tone-numbered syllables, split by pypinyin and voiced by the written pinyin."""
    from pypinyin import Style, lazy_pinyin

    chars = [c for c in hanzi if han(c)]
    if not chars:
        return None

    proposed = lazy_pinyin("".join(chars), style=Style.TONE3, errors=lambda x: [x])
    if len(proposed) != len(chars):
        return None
    bases = [normalise(p[:-1] if p and p[-1].isdigit() else p) for p in proposed]

    letters, tones = parse_written(written)

    # Walk the written pinyin, consuming one proposed syllable at a time. Matching
    # incrementally rather than comparing whole concatenations makes it possible to
    # accept a documented alternate reading for one syllable without discarding the
    # sentence — and still refuse when nothing lines up, which is the case that matters.
    out, i = [], 0
    for base in bases:
        match = next(
            (c for c in [base, *ALTERNATES.get(base, [])] if letters.startswith(c, i)),
            None,
        )
        if match is None:
            return None
        span = tones[i : i + len(match)]
        tone = next((t for t in span if t), 5)  # no mark in the syllable = neutral
        out.append(f"{match}{tone}")
        i += len(match)

    # Every letter accounted for, or the boundaries drifted somewhere.
    return out if i == len(letters) else None


def main() -> int:
    corpus = json.loads(SENTENCES.read_text(encoding="utf-8"))
    done = 0
    failed: list[tuple[str, str]] = []

    for s in corpus["sentences"]:
        if "hanzi" not in s:
            continue
        syl = split_for(s["hanzi"], s.get("pinyin", ""))
        if syl is None:
            s.pop("pinyin_syllables", None)
            failed.append((s["hanzi"], s.get("pinyin", "")))
            continue
        s["pinyin_syllables"] = " ".join(syl)
        done += 1

    total = done + len(failed)
    print(f"{done}/{total} sentences tagged ({done / total:.0%})")
    for s in corpus["sentences"]:
        if s.get("pinyin_syllables"):
            print(f"  {s['hanzi']}  →  {s['pinyin_syllables']}")
            break

    if failed:
        print(f"\n  {len(failed)} could not be split — left untagged, not guessed:")
        for h, p in failed[:25]:
            print(f"    {h:<16} {p}")
        if len(failed) > 25:
            print(f"    … and {len(failed) - 25} more")

    if "--write" in sys.argv:
        SENTENCES.write_text(
            json.dumps(corpus, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print(f"\nwrote {SENTENCES.name}")
    else:
        print("\nreport only — pass --write to apply")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
