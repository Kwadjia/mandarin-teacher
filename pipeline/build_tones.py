"""Render tone minimal-pair audio for the isolation drills.

Inside a sentence, context lets you infer a word without ever hearing its tone.
Isolated minimal pairs remove that crutch — they are the only drill that measures
tone perception directly. 15 sets x 4 tones x 2 voices (one Taiwan, one mainland).

    python pipeline/build_tones.py

Output: out/tones/*.mp3 + manifest.json
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent
PAIRS = ROOT / "data" / "minimal_pairs.json"
OUT = ROOT / "out" / "tones"

VOICES = [("zh-TW-HsiaoChenNeural", "tw"), ("zh-CN-XiaoxiaoNeural", "cn")]


async def render(jobs, concurrency: int = 6):
    import edge_tts

    sem = asyncio.Semaphore(concurrency)
    done = 0
    failures = []

    async def one(path: Path, text: str, voice: str):
        nonlocal done
        async with sem:
            try:
                await edge_tts.Communicate(text, voice).save(str(path))
            except Exception as exc:  # noqa: BLE001
                failures.append((path.name, exc))
            done += 1
            if done % 30 == 0 or done == len(jobs):
                print(f"   {done}/{len(jobs)}")

    await asyncio.gather(*(one(*j) for j in jobs))
    return failures


def main() -> int:
    data = json.loads(PAIRS.read_text(encoding="utf-8"))
    OUT.mkdir(parents=True, exist_ok=True)

    jobs, manifest = [], []
    for s in data["sets"]:
        syl = s["syllable"]
        entry = {"syllable": syl, "words": []}
        for w in s["words"]:
            clips = []
            for voice, tag in VOICES:
                name = f"{syl}{w['tone']}_{tag}.mp3"
                # Taiwan voice reads Traditional, mainland reads Simplified.
                text = w["trad"] if tag == "tw" else w["hanzi"]
                jobs.append((OUT / name, text, voice))
                clips.append({"f": name, "tw": 1 if tag == "tw" else 0})
            entry["words"].append({
                "hanzi": w["hanzi"], "trad": w["trad"], "tone": w["tone"],
                "gloss": w["gloss"], "clips": clips,
            })
        manifest.append(entry)

    print(f"Rendering {len(jobs)} tone clips ({len(data['sets'])} sets x 4 tones x {len(VOICES)} voices)")
    failures = asyncio.run(render(jobs))
    if failures:
        print(f"   {len(failures)} FAILED:")
        for name, exc in failures[:5]:
            print(f"     {name}: {exc}")

    (OUT / "manifest.json").write_text(
        json.dumps({"sets": manifest}, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"\nWrote {OUT / 'manifest.json'}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
