"""Merge a vocabulary + sentence expansion into the seed corpus.

    python pipeline/merge_expansion.py data/expansion_hsk2.json

Every candidate sentence is segmented against the post-merge vocabulary before it is
accepted; anything containing a character no known word covers is rejected and
reported rather than silently added. That check is the whole reason hand-written and
model-written content can be treated the same way (docs/design.md §2.11).

Idempotent: re-running skips words and sentences already present.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent
VOCAB = ROOT / "data" / "seed_vocab.json"
SENTENCES = ROOT / "data" / "seed_sentences.json"
PUNCT = set("，。！？、：；“”‘’…—《》（）")


def cover(text: str, vocab: set[str], max_len: int = 4):
    tokens, i = [], 0
    while i < len(text):
        if text[i] in PUNCT or text[i].isspace():
            i += 1
            continue
        for n in range(min(max_len, len(text) - i), 0, -1):
            if text[i : i + n] in vocab:
                tokens.append(text[i : i + n])
                i += n
                break
        else:
            return None, text[i]
    return tokens, None


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    path = ROOT / sys.argv[1] if not Path(sys.argv[1]).is_absolute() else Path(sys.argv[1])
    data = json.loads(path.read_text(encoding="utf-8"))

    vocab = json.loads(VOCAB.read_text(encoding="utf-8"))
    have = {e["headword"] for e in vocab["core"] + vocab["personal"]}

    added_words = 0
    for w in data.get("words", []):
        if w["headword"] in have:
            continue
        bucket = "personal" if w.get("source") == "personal" else "core"
        vocab[bucket].append(
            {"headword": w["headword"], "pinyin": w["pinyin"], "gloss_en": w["gloss_en"]}
        )
        have.add(w["headword"])
        added_words += 1
    VOCAB.write_text(json.dumps(vocab, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    corpus = json.loads(SENTENCES.read_text(encoding="utf-8"))
    existing = {e["hanzi"] for e in corpus["sentences"] if "hanzi" in e}

    label = data.get("label", path.stem)
    corpus["sentences"].append({"_comment": f"Expansion: {label}"})

    ok, dup, skipped, rejected = 0, 0, 0, []
    for s in data.get("sentences", []):
        hanzi = s["hanzi"]
        # "SKIP" marks a draft I was not confident enough about to ship — usually a
        # phrasing I could not verify, or one needing vocabulary not yet introduced.
        if s["pinyin"] == "SKIP" or s["gloss_en"] == "SKIP":
            skipped += 1
            continue
        if hanzi in existing:
            dup += 1
            continue
        tokens, bad = cover(hanzi, have)
        if bad:
            rejected.append((hanzi, bad))
            continue
        corpus["sentences"].append(
            {"hanzi": hanzi, "pinyin": s["pinyin"], "gloss_en": s["gloss_en"]}
        )
        existing.add(hanzi)
        ok += 1

    SENTENCES.write_text(json.dumps(corpus, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    total_sentences = sum(1 for e in corpus["sentences"] if "hanzi" in e)
    print(f"{label}")
    print(f"  words     +{added_words:<4} → {len(have)} total")
    print(f"  sentences +{ok:<4} → {total_sentences} total"
          f"   ({dup} duplicate, {skipped} draft-skipped, {len(rejected)} rejected)")
    for h, b in rejected[:15]:
        print(f"     reject: {h}   (no word covers '{b}')")
    return 2 if rejected else 0


if __name__ == "__main__":
    raise SystemExit(main())
