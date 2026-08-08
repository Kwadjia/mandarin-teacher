"""Apply the Taiwan-variety decisions and regenerate Traditional characters.

Decisions from Jasmine's review (2026-08-08):
  - Grandma is always 奶奶. Drop 外婆 entirely; never use 阿嬤.
  - "Where" is 哪裡, not the mainland 哪儿.
  - Rice is 白飯, not 米饭.
  - Traditional is the primary reading script; Simplified is kept alongside.

Idempotent — safe to re-run. Rewrites data/seed_vocab.json and
data/seed_sentences.json in place, adding a `_trad` field to every entry.

    python pipeline/normalize_corpus.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import opencc

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent
VOCAB = ROOT / "data" / "seed_vocab.json"
SENTENCES = ROOT / "data" / "seed_sentences.json"

# s2twp = Simplified → Traditional, Taiwan standard, with Taiwanese phrasing.
# Plain s2t gives mainland-style Traditional and gets 哪里 → 哪里 rather than 哪裡.
CONVERT = opencc.OpenCC("s2twp").convert

# Ordered: longer keys first so no substitution eats another's prefix.
HANZI_SUBS = [("外婆", "奶奶"), ("米饭", "白饭"), ("哪儿", "哪里")]
PINYIN_SUBS = [("wàipó", "nǎinai"), ("mǐfàn", "báifàn"), ("nǎr", "nǎlǐ")]
GLOSS_SUBS = [("maternal grandmother", "grandmother"), ("cooked rice", "rice")]

DROP_HEADWORDS = {"外婆"}


def sub(text: str, table: list[tuple[str, str]]) -> str:
    for old, new in table:
        text = text.replace(old, new)
    return text


def main() -> int:
    changes = 0

    # ── vocabulary ────────────────────────────────────────────────────────────
    vocab = json.loads(VOCAB.read_text(encoding="utf-8"))
    for bucket in ("core", "personal"):
        kept = []
        for entry in vocab[bucket]:
            if entry["headword"] in DROP_HEADWORDS:
                print(f"  drop  {entry['headword']} ({entry['gloss_en']})")
                changes += 1
                continue
            before = entry["headword"]
            entry["headword"] = sub(entry["headword"], HANZI_SUBS)
            entry["pinyin"] = sub(entry["pinyin"], PINYIN_SUBS)
            entry["gloss_en"] = sub(entry["gloss_en"], GLOSS_SUBS)
            if entry["headword"] != before:
                print(f"  vocab {before} -> {entry['headword']} ({entry['pinyin']})")
                changes += 1
            entry["headword_trad"] = CONVERT(entry["headword"])
            kept.append(entry)
        vocab[bucket] = kept

    trad_differs = sum(
        1
        for b in ("core", "personal")
        for e in vocab[b]
        if e["headword_trad"] != e["headword"]
    )
    total = sum(len(vocab[b]) for b in ("core", "personal"))

    VOCAB.write_text(
        json.dumps(vocab, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    # ── sentences ─────────────────────────────────────────────────────────────
    data = json.loads(SENTENCES.read_text(encoding="utf-8"))
    edited = 0
    for entry in data["sentences"]:
        if "hanzi" not in entry:
            continue
        before = entry["hanzi"]
        entry["hanzi"] = sub(entry["hanzi"], HANZI_SUBS)
        entry["pinyin"] = sub(entry["pinyin"], PINYIN_SUBS)
        if entry["hanzi"] != before:
            print(f"  sent  {before} -> {entry['hanzi']}")
            edited += 1
        entry["hanzi_trad"] = CONVERT(entry["hanzi"])

    SENTENCES.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    n_sentences = sum(1 for e in data["sentences"] if "hanzi" in e)
    script_differs = sum(
        1 for e in data["sentences"] if "hanzi" in e and e["hanzi_trad"] != e["hanzi"]
    )

    print()
    print(f"vocabulary : {total} words, {changes} changed, "
          f"{trad_differs} differ in Traditional ({trad_differs / total:.0%})")
    print(f"sentences  : {n_sentences} total, {edited} rewritten, "
          f"{script_differs} differ in Traditional ({script_differs / n_sentences:.0%})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
