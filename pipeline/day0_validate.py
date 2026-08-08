"""Phase-0 validation. Throwaway by design — do not build on this file.

Answers three questions in about two hours, before any app code exists:

  1. Does Azure zh-CN neural TTS sound like a person, or like a robot with
     wrong tones?  (If it's the latter, the audio-first premise needs rethinking.)
  2. Does Claude produce natural Mandarin when constrained to a small vocabulary?
  3. Does programmatic vocabulary verification actually catch out-of-vocab words?

Output is `out/day0/review.html` — open it, hand the laptop to a native speaker,
and have them grade every clip.

Usage:
    python pipeline/day0_validate.py
    python pipeline/day0_validate.py --count 30 --yes

Environment:
    ANTHROPIC_API_KEY       (or run `ant auth login`)
    AZURE_SPEECH_KEY
    AZURE_SPEECH_REGION     e.g. eastus
"""

from __future__ import annotations

import argparse
import asyncio
import html
import json
import math
import os
import struct
import sys
from dataclasses import dataclass, field
from pathlib import Path

import anthropic
import httpx
from pydantic import BaseModel

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent
SEED_PATH = ROOT / "data" / "seed_vocab.json"
OUT_DIR = ROOT / "out" / "day0"

MODEL = "claude-opus-5"

# Weighted toward Taiwan (the household variety) but deliberately mixed: training
# on one accent produces someone who understands one accent. Both varieties will be
# encountered for life, so both belong in the rotation.
# zh-TW voices are fed Traditional text, zh-CN voices Simplified — see script_for().
VOICES = [
    "zh-TW-HsiaoChenNeural",  # Taiwan, female
    "zh-TW-YunJheNeural",     # Taiwan, male
    "zh-CN-XiaoxiaoNeural",   # Mainland, female
    "zh-CN-YunxiNeural",      # Mainland, male
]


def script_for(voice: str, simp: str, trad: str | None) -> str:
    """Feed each voice its native script. Both render either correctly, but this
    keeps the input honest and surfaces conversion bugs early."""
    if voice.startswith("zh-TW") and trad:
        return trad
    return simp
# Native pace and a slightly slowed pace. Speed laddering is the core listening skill.
RATES = ["-15%", "+0%"]

# Punctuation and digits are always coverable; they carry no vocabulary load.
ALLOWED_NON_WORD = set("，。！？、：；“”‘’…—《》（）0123456789 \n\t")

# claude-opus-5 list price, USD per million tokens (see docs/design.md §5).
PRICE_IN_PER_MTOK = 5.00
PRICE_OUT_PER_MTOK = 25.00
# Azure neural TTS paid tier, USD per million characters. The F0 free tier
# currently covers 0.5M chars/month, so this is almost always $0 in practice.
AZURE_PRICE_PER_MCHAR = 15.00


# ── Vocabulary verification ───────────────────────────────────────────────────
# A greedy longest-match tokenizer over the allowed headwords. This is stricter
# and more honest than running a general segmenter: a sentence passes only if it
# can be fully covered by words I have actually chosen to teach.


@dataclass
class Coverage:
    tokens: list[str] = field(default_factory=list)
    oov: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.oov


def cover(text: str, allowed: set[str], max_len: int = 4) -> Coverage:
    result = Coverage()
    i = 0
    while i < len(text):
        ch = text[i]
        if ch in ALLOWED_NON_WORD:
            i += 1
            continue
        for length in range(min(max_len, len(text) - i), 0, -1):
            candidate = text[i : i + length]
            if candidate in allowed:
                result.tokens.append(candidate)
                i += length
                break
        else:
            result.oov.append(ch)
            i += 1
    return result


# ── Generation ────────────────────────────────────────────────────────────────


class Sentence(BaseModel):
    hanzi: str
    pinyin: str
    gloss_en: str
    hanzi_trad: str | None = None  # filled by normalize_corpus.py, not the model


class SentenceBatch(BaseModel):
    sentences: list[Sentence]


PROMPT = """\
You are writing listening-practice sentences for an adult learner of Mandarin.

His situation, which the sentences should reflect: he is an American software
engineer married to a native Mandarin speaker. Their first baby has just been born.
His mother-in-law is often at the house. They have a dog. He games and lifts.

Write {count} short Mandarin sentences that:

- use ONLY words from the allowed vocabulary list below, and nothing else;
- sound like things a real person would actually say out loud in that household —
  not textbook example sentences;
- vary in length between roughly 3 and 12 characters;
- vary in type: statements, questions, suggestions, things said to a baby;
- lean toward baby, parenting, food, and daily routine.

Hard constraint: every single character outside of punctuation must belong to a
word on the list. Do not use any word that is not listed, however common. If you
cannot express something naturally within the list, write a different sentence.

Return `pinyin` with tone marks and word spacing (e.g. "bǎobao shuìjiào le").
Return `gloss_en` as a natural English rendering, not a word-by-word gloss.

ALLOWED VOCABULARY
{vocab}
"""


def build_prompt(allowed_entries: list[dict], count: int) -> str:
    vocab = "\n".join(
        f"{e['headword']}\t{e['pinyin']}\t{e['gloss_en']}" for e in allowed_entries
    )
    return PROMPT.format(count=count, vocab=vocab)


def estimate(client, prompt: str) -> None:
    """Print a cost upper bound. Must run before asking for confirmation."""
    counted = client.messages.count_tokens(
        model=MODEL, messages=[{"role": "user", "content": prompt}]
    )
    est_in = counted.input_tokens
    est_out = 8_000  # generous: thinking is on by default on Opus 5
    est_cost = (est_in / 1e6) * PRICE_IN_PER_MTOK + (est_out / 1e6) * PRICE_OUT_PER_MTOK
    print(f"      input tokens : {est_in:,}")
    print(f"      est. cost    : up to ~${est_cost:.2f}")


def generate(client, prompt: str) -> list[Sentence]:
    messages = [{"role": "user", "content": prompt}]
    response = client.messages.parse(
        model=MODEL,
        max_tokens=16_000,
        output_config={"effort": "high"},
        output_format=SentenceBatch,
        messages=messages,
    )
    actual = (
        response.usage.input_tokens / 1e6 * PRICE_IN_PER_MTOK
        + response.usage.output_tokens / 1e6 * PRICE_OUT_PER_MTOK
    )
    print(f"      actual cost  : ${actual:.4f}")

    parsed = response.parsed_output
    if parsed is None:
        raise SystemExit("Model did not return parseable structured output.")
    return parsed.sentences


# ── Text to speech ────────────────────────────────────────────────────────────


def tone_wav(freq: float, ms: int = 350, sample_rate: int = 16_000) -> bytes:
    """A short sine tone as a WAV. Used only by --self-test, so the review page
    can be exercised end to end before any Azure key exists."""
    n = int(sample_rate * ms / 1000)
    frames = bytearray()
    for i in range(n):
        # brief fade in/out so it doesn't click
        env = min(1.0, i / 400, (n - i) / 400)
        frames += struct.pack(
            "<h", int(12_000 * env * math.sin(2 * math.pi * freq * i / sample_rate))
        )
    return (
        b"RIFF" + struct.pack("<I", 36 + len(frames)) + b"WAVEfmt "
        + struct.pack("<IHHIIHH", 16, 1, 1, sample_rate, sample_rate * 2, 2, 16)
        + b"data" + struct.pack("<I", len(frames)) + bytes(frames)
    )


def synthesize(text: str, voice: str, rate: str, key: str, region: str) -> bytes:
    ssml = (
        '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" '
        'xml:lang="zh-CN">'
        f'<voice name="{voice}"><prosody rate="{rate}">'
        f"{html.escape(text)}"
        "</prosody></voice></speak>"
    )
    response = httpx.post(
        f"https://{region}.tts.speech.microsoft.com/cognitiveservices/v1",
        headers={
            "Ocp-Apim-Subscription-Key": key,
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
            "User-Agent": "mandarin-teacher-day0",
        },
        content=ssml.encode("utf-8"),
        timeout=30.0,
    )
    response.raise_for_status()
    return response.content


def clip_name(index: int, voice: str, rate: str, ext: str = "mp3") -> str:
    short = voice.replace("zh-CN-", "").replace("Neural", "")
    tidy = rate.replace("%", "").replace("+", "p").replace("-", "m")
    return f"s{index:03d}_{short}_{tidy}.{ext}"


async def _edge_render_all(jobs: list[tuple[Path, str, str, str]], concurrency: int = 6):
    """edge-tts exposes the same zh-CN neural voices as Azure with no API key.

    It is an undocumented endpoint with no SLA — fine for validating the pattern
    and for personal use, not something to build production on. Switch to
    --tts azure once there's a key.
    """
    import edge_tts

    sem = asyncio.Semaphore(concurrency)
    done = 0
    failures: list[tuple[Path, Exception]] = []

    async def one(path: Path, text: str, voice: str, rate: str) -> None:
        nonlocal done
        async with sem:
            try:
                await edge_tts.Communicate(text, voice, rate=rate).save(str(path))
            except Exception as exc:  # noqa: BLE001 - report, don't abort the batch
                failures.append((path, exc))
            done += 1
            if done % 50 == 0 or done == len(jobs):
                print(f"      {done}/{len(jobs)} clips")

    await asyncio.gather(*(one(*job) for job in jobs))
    return failures


# ── Review page ───────────────────────────────────────────────────────────────

REVIEW_CSS = """
:root { color-scheme: light dark; --bg:#faf9f7; --fg:#1a1a1a; --muted:#6b6b6b;
        --line:#e2e0dc; --card:#ffffff; --accent:#8a4b2a; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#16150f; --fg:#ece9e2; --muted:#9a968c; --line:#302d26;
          --card:#1e1c16; --accent:#d99a6c; } }
* { box-sizing: border-box; }
body { margin:0; padding:2rem 1rem 6rem; background:var(--bg); color:var(--fg);
       font: 16px/1.6 ui-serif, Georgia, serif; }
main { max-width: 46rem; margin: 0 auto; }
h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
.sub { color: var(--muted); margin: 0 0 2rem; font-size: .9rem; }
.item { background: var(--card); border:1px solid var(--line); border-radius:10px;
        padding:1.1rem 1.25rem; margin-bottom:1rem; }
.hz { font-size:1.6rem; font-family: ui-sans-serif, "Microsoft JhengHei",
      "Microsoft YaHei", sans-serif; margin:0 0 .1rem; }
.hz-alt { font-size:1rem; color:var(--muted); font-family: ui-sans-serif,
      "Microsoft YaHei", sans-serif; margin:0 0 .2rem; }
.py { color: var(--muted); font-size:.95rem; margin:0; }
.tw small { color:#8a4b2a; } .cn small { color:#2f6f8f; }
@media (prefers-color-scheme: dark) { .tw small{color:#d99a6c} .cn small{color:#7fb8d4} }
.en { color: var(--muted); font-size:.9rem; font-style:italic; margin:.15rem 0 .8rem; }
.clips { display:flex; flex-wrap:wrap; gap:.5rem; margin-bottom:.9rem; }
.clip { display:flex; flex-direction:column; gap:.25rem; }
.clip small { color:var(--muted); font-size:.72rem; }
audio { height: 32px; }
.grade { display:flex; flex-wrap:wrap; gap:.4rem; align-items:center; }
button { font: inherit; font-size:.85rem; padding:.3rem .7rem; cursor:pointer;
         border:1px solid var(--line); border-radius:6px; background:transparent;
         color:var(--fg); }
button[aria-pressed="true"] { background:var(--accent); border-color:var(--accent);
                              color:#fff; }
input[type=text] { font: inherit; font-size:.85rem; padding:.3rem .5rem; flex:1;
                   min-width:12rem; border:1px solid var(--line); border-radius:6px;
                   background:transparent; color:var(--fg); }
.bar { position:fixed; bottom:0; left:0; right:0; background:var(--card);
       border-top:1px solid var(--line); padding:.75rem 1rem; display:flex;
       gap:1rem; align-items:center; justify-content:center; }
.warn { color:#b4472a; font-size:.8rem; }
"""

REVIEW_JS = """
const KEY = 'day0-review';
const state = JSON.parse(localStorage.getItem(KEY) || '{}');
function save(){ localStorage.setItem(KEY, JSON.stringify(state)); render(); }
function render(){
  document.querySelectorAll('[data-id]').forEach(el => {
    const id = el.dataset.id, s = state[id] || {};
    el.querySelectorAll('button[data-field]').forEach(b => {
      b.setAttribute('aria-pressed', String(s[b.dataset.field] === b.dataset.value));
    });
  });
  const done = Object.keys(state).filter(k => state[k].natural).length;
  document.getElementById('count').textContent =
    done + ' / ' + document.querySelectorAll('[data-id]').length + ' graded';
}
document.addEventListener('click', e => {
  const b = e.target.closest('button[data-field]'); if (!b) return;
  const id = b.closest('[data-id]').dataset.id;
  state[id] = state[id] || {};
  state[id][b.dataset.field] = state[id][b.dataset.field] === b.dataset.value
    ? null : b.dataset.value;
  save();
});
document.addEventListener('input', e => {
  if (!e.target.matches('input[data-note]')) return;
  const id = e.target.closest('[data-id]').dataset.id;
  state[id] = state[id] || {}; state[id].note = e.target.value; save();
});
document.getElementById('export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'day0-review.json'; a.click();
});
document.querySelectorAll('input[data-note]').forEach(i => {
  const id = i.closest('[data-id]').dataset.id;
  if (state[id] && state[id].note) i.value = state[id].note;
});
render();
"""


def write_review_page(items: list[dict], rejected: list[dict]) -> Path:
    parts: list[str] = []
    for item in items:
        clips = "".join(
            f'<div class="clip {"tw" if c["voice"].startswith("zh-TW") else "cn"}">'
            f'<audio controls preload="none" src="{c["file"]}"></audio>'
            f'<small>{"TW" if c["voice"].startswith("zh-TW") else "CN"} '
            f'{html.escape(c["voice"].split("-")[-1].replace("Neural", ""))}'
            f' &middot; {html.escape(c["rate"])}</small></div>'
            for c in item["clips"]
        )
        # Traditional is primary — that's the script Nainai writes.
        trad = item.get("hanzi_trad") or item["hanzi"]
        alt = (
            f'<p class="hz-alt">{html.escape(item["hanzi"])}</p>'
            if item.get("hanzi_trad") and item["hanzi_trad"] != item["hanzi"]
            else ""
        )
        parts.append(f"""
<div class="item" data-id="{item['id']}">
  <p class="hz">{html.escape(trad)}</p>
  {alt}
  <p class="py">{html.escape(item['pinyin'])}</p>
  <p class="en">{html.escape(item['gloss_en'])}</p>
  <div class="clips">{clips}</div>
  <div class="grade">
    <span class="py">Natural?</span>
    <button data-field="natural" data-value="yes">Yes</button>
    <button data-field="natural" data-value="odd">Odd but OK</button>
    <button data-field="natural" data-value="no">No one says this</button>
  </div>
  <div class="grade" style="margin-top:.4rem">
    <span class="py">Pronunciation?</span>
    <button data-field="pron" data-value="good">Correct</button>
    <button data-field="pron" data-value="tone">Tone error</button>
    <button data-field="pron" data-value="bad">Wrong / robotic</button>
    <input type="text" data-note placeholder="what was wrong, or a better phrasing">
  </div>
</div>""")

    rejected_html = ""
    if rejected:
        rows = "".join(
            f"<li><code>{html.escape(r['hanzi'])}</code> "
            f'&mdash; <span class="warn">out of vocabulary: '
            f"{html.escape(' '.join(r['oov']))}</span></li>"
            for r in rejected
        )
        rejected_html = f"""
<h2 style="font-size:1.05rem;margin-top:2.5rem">Rejected by the verifier ({len(rejected)})</h2>
<p class="sub">These never reached TTS. This is the vocabulary-constraint check doing
its job &mdash; a high count here means the generation prompt needs work.</p>
<ul class="py">{rows}</ul>"""

    page = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mandarin Teacher &mdash; Day 0 Review</title>
<style>{REVIEW_CSS}</style></head><body><main>
<h1>Day 0 &mdash; does this sound like a real person?</h1>
<p class="sub">Listen to each clip <em>before</em> reading the characters if you can.
For each sentence: would anyone actually say this, and is the pronunciation right?
Tone errors matter most. Grades save automatically in this browser.</p>
{''.join(parts)}
{rejected_html}
</main>
<div class="bar"><span class="py" id="count"></span>
<button id="export">Export grades as JSON</button></div>
<script>{REVIEW_JS}</script></body></html>"""

    path = OUT_DIR / "review.html"
    path.write_text(page, encoding="utf-8")
    return path


# ── Main ──────────────────────────────────────────────────────────────────────


# Fixtures for --self-test. Deliberately includes two sentences that must be
# rejected, so the verifier and the reject section of the page both get exercised.
SELF_TEST_FIXTURES = [
    ("宝宝睡觉了。", "bǎobao shuìjiào le", "The baby's asleep."),
    ("老婆，宝宝饿了吧？", "lǎopo, bǎobao è le ba?", "Honey, the baby's hungry, right?"),
    ("我们明天一起去买菜。", "wǒmen míngtiān yìqǐ qù mǎi cài", "Let's go grocery shopping together tomorrow."),
    ("奶奶抱宝宝，宝宝笑了。", "nǎinai bào bǎobao, bǎobao xiào le", "Grandma held the baby and he smiled."),
    ("我太累了，想喝咖啡。", "wǒ tài lèi le, xiǎng hē kāfēi", "I'm exhausted, I want coffee."),
    ("他在看电视。", "tā zài kàn diànshì", "He's watching TV."),
    ("宝宝的尿布该换了。", "bǎobao de niàobù gāi huàn le", "The baby's diaper needs changing."),
]


def confirm(question: str, auto_yes: bool) -> bool:
    if auto_yes:
        print(f"{question} [auto-confirmed]")
        return True
    return input(f"{question} [y/N] ").strip().lower() in ("y", "yes")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--count", type=int, default=20, help="sentences to request")
    ap.add_argument("--yes", action="store_true", help="skip cost confirmations")
    ap.add_argument(
        "--sentences",
        metavar="PATH",
        nargs="?",
        const=str(ROOT / "data" / "seed_sentences.json"),
        help="read sentences from a JSON file instead of calling the API. "
             "Bare flag uses data/seed_sentences.json.",
    )
    ap.add_argument(
        "--tts",
        choices=["edge", "azure", "none"],
        default="edge",
        help="edge = same zh-CN neural voices, no key (default); "
             "azure = official API, needs a key; none = skip audio",
    )
    ap.add_argument("--skip-tts", action="store_true", help="alias for --tts none")
    ap.add_argument("--force", action="store_true",
                    help="re-synthesize clips that already exist on disk")
    ap.add_argument(
        "--self-test",
        action="store_true",
        help="fixture sentences and tone placeholders — no network at all",
    )
    args = ap.parse_args()
    if args.skip_tts:
        args.tts = "none"
    if args.self_test:
        args.tts = "selftest"

    seed = json.loads(SEED_PATH.read_text(encoding="utf-8"))
    entries = seed["core"] + seed["personal"]
    allowed = {e["headword"] for e in entries}
    print(f"Seed vocabulary: {len(allowed)} words "
          f"({len(seed['core'])} core, {len(seed['personal'])} personal)\n")

    # 1 — obtain sentences
    if args.self_test:
        print("[1/3] SELF TEST — using fixture sentences, no API call")
        sentences = [
            Sentence(hanzi=h, pinyin=p, gloss_en=g) for h, p, g in SELF_TEST_FIXTURES
        ]
    elif args.sentences:
        path = Path(args.sentences)
        print(f"[1/3] Loading sentences from {path.name} — no API call")
        raw = json.loads(path.read_text(encoding="utf-8"))["sentences"]
        sentences = [
            Sentence(
                hanzi=r["hanzi"],
                pinyin=r["pinyin"],
                gloss_en=r["gloss_en"],
                hanzi_trad=r.get("hanzi_trad"),
            )
            for r in raw
            if "hanzi" in r  # skip inline _comment entries
        ]
    else:
        print("[1/3] Generating sentences with", MODEL)
        client = anthropic.Anthropic()
        prompt = build_prompt(entries, args.count)
        estimate(client, prompt)
        if not confirm("      Spend that on generation?", args.yes):
            print("Aborted before any paid call.")
            return 1
        sentences = generate(client, prompt)
    print(f"      got {len(sentences)} sentences\n")

    # 2 — verify
    print("[2/3] Verifying against the allowed vocabulary")
    approved, rejected = [], []
    for s in sentences:
        c = cover(s.hanzi, allowed)
        if c.ok:
            approved.append(s)
        else:
            rejected.append({"hanzi": s.hanzi, "oov": c.oov})
    rate = len(approved) / len(sentences) * 100 if sentences else 0
    print(f"      {len(approved)} passed, {len(rejected)} rejected ({rate:.0f}% pass)")
    for r in rejected:
        print(f"        reject: {r['hanzi']}  (out of vocab: {' '.join(r['oov'])})")
    if rate < 60:
        print("      NOTE: a low pass rate means the generation prompt needs work,")
        print("            not that the model is broken. Iterate on the prompt.")
    print()

    # 3 — synthesize
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    ext = "wav" if args.tts == "selftest" else "mp3"
    items: list[dict] = [
        {
            "id": f"s{i}",
            "hanzi": s.hanzi,
            "hanzi_trad": s.hanzi_trad,
            "pinyin": s.pinyin,
            "gloss_en": s.gloss_en,
            "clips": []
            if args.tts == "none"
            else [
                {"file": clip_name(i, v, r, ext), "voice": v, "rate": r}
                for v in VOICES
                for r in RATES
            ],
        }
        for i, s in enumerate(approved)
    ]
    total = sum(len(it["clips"]) for it in items)

    if args.tts == "none":
        print("[3/3] Skipping audio (--tts none)")

    elif args.tts == "selftest":
        print("[3/3] SELF TEST — tone placeholders, no network")
        for it in items:
            for n, c in enumerate(it["clips"]):
                (OUT_DIR / c["file"]).write_bytes(tone_wav(330 + n * 70))
        print(f"      {total} placeholder clips")

    elif args.tts == "edge":
        jobs = [
            (
                OUT_DIR / c["file"],
                script_for(c["voice"], it["hanzi"], it["hanzi_trad"]),
                c["voice"],
                c["rate"],
            )
            for it in items
            for c in it["clips"]
        ]
        # Incremental by default: an existing, non-trivial file is left alone. Adding
        # eight sentences should not re-synthesize sixteen hundred clips.
        if not args.force:
            fresh = [j for j in jobs if not (j[0].exists() and j[0].stat().st_size > 2000)]
            if len(fresh) < len(jobs):
                print(f"[3/3] {len(jobs) - len(fresh)} clips already on disk, "
                      f"{len(fresh)} to synthesize  (--force to redo all)")
            jobs = fresh
        if jobs:
            print(f"      via edge-tts ({len(VOICES)} voices x {len(RATES)} rates, free, no key)")
        failures = asyncio.run(_edge_render_all(jobs)) if jobs else []
        if failures:
            failed = {p.name for p, _ in failures}
            print(f"      {len(failures)} clips FAILED and were dropped from the page:")
            for path, exc in failures[:5]:
                print(f"        {path.name}: {type(exc).__name__}: {exc}")
            for it in items:
                it["clips"] = [c for c in it["clips"] if c["file"] not in failed]

    else:  # azure
        key = os.environ.get("AZURE_SPEECH_KEY")
        region = os.environ.get("AZURE_SPEECH_REGION")
        if not key or not region:
            print("AZURE_SPEECH_KEY / AZURE_SPEECH_REGION not set.")
            print("Use --tts edge (same voices, no key) or --tts none.")
            return 1

        chars = sum(len(it["hanzi"]) for it in items) * len(VOICES) * len(RATES)
        print(f"[3/3] Synthesizing {total} clips via Azure")
        print(f"      {chars:,} characters "
              f"~ ${chars / 1e6 * AZURE_PRICE_PER_MCHAR:.3f} on the paid tier "
              f"($0 within the F0 free tier)")
        if not confirm("      Proceed?", args.yes):
            print("Aborted before any TTS call.")
            return 1

        for n, it in enumerate(items):
            for c in it["clips"]:
                text = script_for(c["voice"], it["hanzi"], it["hanzi_trad"])
                (OUT_DIR / c["file"]).write_bytes(
                    synthesize(text, c["voice"], c["rate"], key, region)
                )
            print(f"      [{n + 1}/{len(items)}] {it['hanzi']}")

    (OUT_DIR / "sentences.json").write_text(
        json.dumps({"approved": items, "rejected": rejected},
                   ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    page = write_review_page(items, rejected)

    print(f"\nDone. Open: {page}")
    print("Hand it to a native speaker. If pronunciation is wrong or the sentences")
    print("read as textbook Mandarin, fix that before building anything else.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
