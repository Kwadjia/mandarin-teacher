"""Assign HSK levels to the vocabulary, and refuse to do it badly.

    python pipeline/tag_hsk.py           # report only
    python pipeline/tag_hsk.py --write   # write `hsk` into seed_vocab.json

Every core word was previously tagged HSK 1 by a hardcoded literal in seed.ts, which
made the level breakdown meaningless: 284 of 308 concepts in "level 1", and a coverage
figure that could only ever describe the whole corpus.

The list in data/hsk_levels.json is hand-assigned, so the checks here matter more than
usual. A word claimed at two levels, or a stray non-Chinese entry, silently corrupts the
coverage denominator and the ordering the scheduler introduces words in — and neither
failure is visible from the app.

Words absent from the list stay untagged. That is the honest outcome for family
vocabulary (尿布, 奶瓶) and Taiwan usages (白饭) that are genuinely outside HSK; giving
them a level to avoid a blank would be inventing data.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent
LEVELS = ROOT / "data" / "hsk_levels.json"
VOCAB = ROOT / "data" / "seed_vocab.json"


def han(s: str) -> bool:
    return all("一" <= c <= "鿿" or "㐀" <= c <= "䶿" for c in s) and bool(s)


def main() -> int:
    data = json.loads(LEVELS.read_text(encoding="utf-8"))
    levels = {k: v for k, v in data.items() if k.isdigit()}

    problems: list[str] = []
    seen: dict[str, str] = {}
    for level, words in sorted(levels.items()):
        for w in words:
            if not han(w):
                problems.append(f"level {level}: {w!r} is not Chinese")
            elif w in seen:
                problems.append(f"{w} claimed at both level {seen[w]} and level {level}")
            else:
                seen[w] = level

    # More words claimed at a level than the level contains is arithmetically impossible
    # and means the assignments are wrong. It would show up in the app as a coverage
    # figure above 100%, long after the mistake was made and with nothing pointing back
    # to it — so it fails here instead.
    sizes = data["sizes"]
    for level, words in sorted(levels.items()):
        cap = sizes.get(level)
        if cap and len(words) > cap:
            problems.append(
                f"level {level}: {len(words)} words assigned but HSK{level} has only {cap}"
            )

    if problems:
        print(f"{len(problems)} problem(s) in hsk_levels.json — nothing written:\n")
        for p in problems:
            print(f"  {p}")
        return 1

    vocab = json.loads(VOCAB.read_text(encoding="utf-8"))
    tagged = {"1": 0, "2": 0, "3": 0}
    untagged_core: list[str] = []

    for entry in vocab["core"]:
        level = seen.get(entry["headword"])
        if level:
            entry["hsk"] = int(level)
            tagged[level] = tagged.get(level, 0) + 1
        else:
            entry.pop("hsk", None)
            untagged_core.append(entry["headword"])
    for entry in vocab["personal"]:
        # Personal vocabulary sits outside HSK by definition. Tag it only if it happens
        # to be a real HSK word too — 狗 and 车 are, 尿布 is not.
        level = seen.get(entry["headword"])
        if level:
            entry["hsk"] = int(level)
        else:
            entry.pop("hsk", None)

    total = len(vocab["core"]) + len(vocab["personal"])
    print(f"{total} words · tagged " + " · ".join(f"HSK{k} {v}" for k, v in sorted(tagged.items())))
    print(f"  untagged core words: {len(untagged_core)}")
    if untagged_core:
        print("    " + " ".join(untagged_core))

    print("\n  coverage denominators (official level sizes):")
    for lvl in sorted(sizes):
        have = sum(1 for w in seen if seen[w] == lvl and w in
                   {e["headword"] for e in vocab["core"] + vocab["personal"]})
        print(f"    HSK{lvl}: corpus has {have} of {sizes[lvl]}")

    if "--write" in sys.argv:
        VOCAB.write_text(json.dumps(vocab, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"\nwrote {VOCAB.name}")
    else:
        print("\nreport only — pass --write to apply")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
