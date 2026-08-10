"""Turn captured text into curriculum.

Two kinds of thing land in the capture inbox:

  English  — "how do I say 'time for a nap'". A request. Needs translating.
  Mandarin — something Jasmine or Nainai actually said. Needs pinyin and a gloss.

Both end up the same way: one utterance, any genuinely new words added as concepts
with source='emergent', audio rendered, capture marked processed.

This is a *pipeline* step, not an API endpoint, and deliberately so. Nothing in the
study loop ever calls a model (docs/design.md §2.10) — you run this occasionally,
it tells you what it will cost before spending anything, and the app stays free.

    python pipeline/resolve_captures.py            # process the queue
    python pipeline/resolve_captures.py --dry-run  # show what it would do
    python pipeline/resolve_captures.py --yes      # skip the cost prompt

Requires ANTHROPIC_API_KEY.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sqlite3
import sys
from pathlib import Path

import opencc
from pydantic import BaseModel

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
DB_PATH = REPO / "data" / "mandarin.db"
AUDIO_DIR = ROOT / "out" / "day0"

MODEL = "claude-opus-5"
PRICE_IN, PRICE_OUT = 5.00, 25.00  # USD per MTok

VOICES = [
    "zh-TW-HsiaoChenNeural",
    "zh-TW-YunJheNeural",
    "zh-CN-XiaoxiaoNeural",
    "zh-CN-YunxiNeural",
]
RATES = ["-15%", "+0%"]

CONVERT = opencc.OpenCC("s2twp").convert
HAN = set(range(0x4E00, 0xA000)) | set(range(0x3400, 0x4DC0))
PUNCT = set("，。！？、：；“”‘’…—《》（）()，.!?:;'\" \n\t\r0123456789")


class NewWord(BaseModel):
    headword: str
    pinyin: str
    gloss_en: str


class Resolved(BaseModel):
    hanzi: str
    pinyin: str
    gloss_en: str
    new_words: list[NewWord]
    note: str


PROMPT = """\
You are building a personal Mandarin curriculum for an adult learner.

About him, because the Mandarin should sound like his actual life: American software
engineer, married to Jasmine whose family is from Taiwan, new baby son, Jasmine's
mother (called 奶奶) is often at the house, they have a dog.

**Taiwan conventions are required.** Use 哪裡 not 哪儿, 白飯 not 米饭, and never erhua.
Grandma is always 奶奶. Write the Simplified form in `hanzi` — Traditional is derived
mechanically afterwards, so do not produce it yourself.

The input is one of two things:

  * English — he wants to know how to say it. Produce the natural Mandarin.
  * Mandarin — something said in his household. Keep it as-is unless it is clearly
    mistyped; supply pinyin and a natural English gloss.

INPUT ({kind}):
{text}

Rules:
- Prefer vocabulary he already knows, listed below, so the sentence is drillable.
  Introducing one or two new words is fine and expected; introducing eight is not.
- Say it the way a person would say it out loud, not the way a textbook would.
- `pinyin` uses tone marks and word spacing, e.g. "bǎobao gāi shuìjiào le".
- `new_words` lists every word in your sentence that is NOT in the known list, with
  its pinyin and a short English gloss. Be exhaustive — anything you miss here
  becomes a word he can never review.
- `note` is one short line for him: a usage caveat, or why you phrased it that way.

VOCABULARY HE ALREADY KNOWS
{vocab}
"""


def is_han(text: str) -> bool:
    return any(ord(c) in HAN for c in text)


def cover(text: str, vocab: set[str], max_len: int = 4) -> list[str]:
    """Greedy longest-match. Returns characters not covered by any known word."""
    missing, i = [], 0
    while i < len(text):
        if text[i] in PUNCT:
            i += 1
            continue
        for n in range(min(max_len, len(text) - i), 0, -1):
            if text[i : i + n] in vocab:
                i += n
                break
        else:
            missing.append(text[i])
            i += 1
    return missing


async def render(jobs, concurrency: int = 6):
    import edge_tts

    sem = asyncio.Semaphore(concurrency)

    async def one(path: Path, text: str, voice: str, rate: str):
        async with sem:
            await edge_tts.Communicate(text, voice, rate=rate).save(str(path))

    await asyncio.gather(*(one(*j) for j in jobs))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true", help="resolve but write nothing")
    ap.add_argument("--yes", action="store_true", help="skip the cost confirmation")
    ap.add_argument("--limit", type=int, default=25)
    args = ap.parse_args()

    if not DB_PATH.exists():
        print(f"No database at {DB_PATH}. Run: npm run seed")
        return 1
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("ANTHROPIC_API_KEY is not set — this step needs it to translate.")
        return 1

    import anthropic

    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")

    pending = db.execute(
        "SELECT id, raw_text, captured_by FROM capture "
        "WHERE status = 'new' AND raw_text IS NOT NULL ORDER BY ts LIMIT ?",
        (args.limit,),
    ).fetchall()

    if not pending:
        print("Nothing pending.")
        return 0

    known = {r["headword"]: r["id"] for r in db.execute("SELECT id, headword FROM concept")}
    vocab_block = "\n".join(
        f"{r['headword']}\t{r['pinyin']}\t{r['gloss_en']}"
        for r in db.execute("SELECT headword, pinyin, gloss_en FROM concept ORDER BY id")
    )

    print(f"{len(pending)} capture(s) pending")
    for c in pending:
        print(f"   #{c['id']} {c['raw_text']}  ({c['captured_by'] or 'unknown'})")

    est = len(pending) * (len(vocab_block) / 3 + 400) / 1e6 * PRICE_IN + len(pending) * 1200 / 1e6 * PRICE_OUT
    print(f"\nEstimated cost: up to ~${est:.3f}")
    if not args.yes and not args.dry_run:
        if input("Proceed? [y/N] ").strip().lower() not in ("y", "yes"):
            print("Aborted before any paid call.")
            return 1

    client = anthropic.Anthropic()
    spent = 0.0
    added_words = added_utterances = failed = 0
    tts_jobs: list[tuple[Path, str, str, str]] = []

    for cap in pending:
        text = cap["raw_text"].strip()
        kind = "Mandarin" if is_han(text) else "English"
        print(f"\n#{cap['id']} [{kind}] {text}")

        try:
            res = client.messages.parse(
                model=MODEL,
                max_tokens=8_000,
                output_config={"effort": "high"},
                output_format=Resolved,
                messages=[{"role": "user", "content": PROMPT.format(kind=kind, text=text, vocab=vocab_block)}],
            )
            spent += (
                res.usage.input_tokens / 1e6 * PRICE_IN + res.usage.output_tokens / 1e6 * PRICE_OUT
            )
            out = res.parsed_output
            if out is None:
                raise RuntimeError("no structured output")
        except Exception as exc:  # noqa: BLE001
            print(f"   FAILED: {exc}")
            failed += 1
            continue

        # The model is asked to list every new word. Verify rather than trust — a word
        # it forgets to declare becomes one that can never be reviewed.
        vocab_after = set(known) | {w.headword for w in out.new_words}
        missing = cover(out.hanzi, vocab_after)
        if missing:
            print(f"   REJECTED: {out.hanzi}")
            print(f"     undeclared characters: {' '.join(missing)}")
            failed += 1
            continue

        trad = CONVERT(out.hanzi)
        print(f"   → {trad}")
        print(f"     {out.pinyin}")
        print(f"     {out.gloss_en}")
        if out.new_words:
            print(f"     new: {', '.join(f'{w.headword} ({w.pinyin}) {w.gloss_en}' for w in out.new_words)}")
        if out.note:
            print(f"     note: {out.note}")

        if args.dry_run:
            continue

        now = int(__import__("time").time() * 1000)
        for w in out.new_words:
            if w.headword in known:
                continue
            cur = db.execute(
                """INSERT INTO concept (kind, headword, headword_trad, pinyin, sense, gloss_en,
                                        hsk_level, freq_rank, source, created_at)
                   VALUES ('word', ?, ?, ?, '', ?, NULL, NULL, 'emergent', ?)
                   ON CONFLICT (kind, headword, pinyin, sense) DO NOTHING
                   RETURNING id""",
                (w.headword, CONVERT(w.headword), w.pinyin, w.gloss_en, now),
            ).fetchone()
            if cur:
                known[w.headword] = cur[0]
                added_words += 1

        row = db.execute(
            """INSERT INTO utterance (hanzi, hanzi_trad, pinyin, gloss_en, source,
                                      source_detail, status, notes, created_at)
               VALUES (?, ?, ?, ?, 'family', ?, 'approved', ?, ?)
               ON CONFLICT (hanzi) DO UPDATE SET pinyin = excluded.pinyin
               RETURNING id""",
            (out.hanzi, trad, out.pinyin, out.gloss_en,
             f"capture #{cap['id']} from {cap['captured_by'] or 'unknown'}", out.note, now),
        ).fetchone()
        uid = row[0]
        added_utterances += 1

        db.execute("DELETE FROM utterance_concept WHERE utterance_id = ?", (uid,))
        pos, i = 0, 0
        while i < len(out.hanzi):
            if out.hanzi[i] in PUNCT:
                i += 1
                continue
            for n in range(min(4, len(out.hanzi) - i), 0, -1):
                tok = out.hanzi[i : i + n]
                if tok in known:
                    db.execute(
                        "INSERT INTO utterance_concept (utterance_id, concept_id, position) VALUES (?,?,?)",
                        (uid, known[tok], pos),
                    )
                    pos += 1
                    i += n
                    break
            else:
                i += 1

        for vi, voice in enumerate(VOICES):
            for rate in RATES:
                short = voice.replace("zh-CN-", "").replace("zh-TW-", "").replace("Neural", "")
                tidy = rate.replace("%", "").replace("+", "p").replace("-", "m")
                name = f"cap{cap['id']:04d}_{short}_{tidy}.mp3"
                path = AUDIO_DIR / name
                spoken = trad if voice.startswith("zh-TW") else out.hanzi
                if not path.exists():
                    tts_jobs.append((path, spoken, voice, rate))
                db.execute(
                    """INSERT INTO audio (utterance_id, storage_key, provider, voice, variety,
                                          rate, is_native, created_at)
                       VALUES (?, ?, 'edge', ?, ?, ?, 0, ?)
                       ON CONFLICT (storage_key) DO NOTHING""",
                    (uid, name, voice, "tw" if voice.startswith("zh-TW") else "cn", rate, now),
                )

        db.execute("UPDATE capture SET status = 'processed' WHERE id = ?", (cap["id"],))

    if args.dry_run:
        print(f"\nDry run. Spent ${spent:.4f} on resolution, wrote nothing.")
        db.close()
        return 0

    db.commit()

    if tts_jobs:
        print(f"\nRendering {len(tts_jobs)} clips…")
        AUDIO_DIR.mkdir(parents=True, exist_ok=True)
        asyncio.run(render(tts_jobs))

    print(f"\n{added_utterances} utterance(s), {added_words} new concept(s), {failed} failed")
    print(f"cost: ${spent:.4f}")
    print("\nRestart the app to pick these up.")
    db.close()
    return 2 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
