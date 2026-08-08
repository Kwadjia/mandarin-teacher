"""Mainland vs Taiwan comparison. One-off decision aid, not part of the pipeline.

Jasmine's family is from Taiwan, which forks three things this project has so far
assumed were settled:

  1. Accent      — zh-CN voices vs zh-TW voices
  2. Word choice — 哪儿 vs 哪裡, 奶奶 vs 阿嬤, and friends
  3. Script      — Simplified vs Traditional characters

Renders the same sentences both ways so a native speaker can answer by ear rather
than by argument. Output: out/compare/compare.html

    python pipeline/compare_variety.py
"""

from __future__ import annotations

import asyncio
import html
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "out" / "compare"

CN_VOICES = [("zh-CN-XiaoxiaoNeural", "Mainland F"), ("zh-CN-YunxiNeural", "Mainland M")]
TW_VOICES = [("zh-TW-HsiaoChenNeural", "Taiwan F"), ("zh-TW-YunJheNeural", "Taiwan M")]

# (simplified, traditional, pinyin, gloss) — chosen to expose neutral-tone and
# retroflex differences, which is where the two varieties diverge most audibly.
ACCENT_SET = [
    ("宝宝睡觉了。", "寶寶睡覺了。", "bǎobao shuìjiào le", "The baby's asleep."),
    ("妈妈在家。", "媽媽在家。", "māma zài jiā", "Mom's home."),
    ("谢谢你。", "謝謝你。", "xièxie nǐ", "Thank you."),
    ("我朋友来了。", "我朋友來了。", "wǒ péngyou lái le", "My friend's here."),
    ("老婆，宝宝哭了。", "老婆，寶寶哭了。", "lǎopo, bǎobao kū le", "Honey, the baby's crying."),
    ("外婆晚上来。", "外婆晚上來。", "wàipó wǎnshang lái", "Grandma's coming this evening."),
    ("宝宝的尿布换了吗？", "寶寶的尿布換了嗎？", "bǎobao de niàobù huàn le ma?", "Has the baby been changed?"),
    ("我们的儿子很好。", "我們的兒子很好。", "wǒmen de érzi hěn hǎo", "Our son is doing well."),
    ("你怎么了？", "你怎麼了？", "nǐ zěnme le?", "What's wrong?"),
    ("我们一起吃吧。", "我們一起吃吧。", "wǒmen yìqǐ chī ba", "Let's eat together."),
]

# Word-choice forks. Both rendered in a Taiwan voice so only the wording differs.
WORD_CHOICE = [
    ("哪儿 vs 哪裡  (where)", "奶瓶在哪儿？", "奶瓶在哪裡？", "Where's the bottle?"),
    ("哪儿 vs 哪裡  (where)", "你去哪儿？", "你去哪裡？", "Where are you going?"),
    ("奶奶 vs 阿嬤  (grandma)", "奶奶抱宝宝。", "阿嬤抱寶寶。", "Grandma's holding the baby."),
    ("外婆 vs 阿嬤  (grandma)", "外婆来了。", "阿嬤來了。", "Grandma's here."),
    ("米饭 vs 白飯  (rice)", "我想吃米饭。", "我想吃白飯。", "I want rice."),
    ("土豆 vs 馬鈴薯 …  general", "我在做菜。", "我在做菜。", "I'm cooking. (identical — control)"),
]


async def render(jobs, concurrency: int = 6):
    import edge_tts

    sem = asyncio.Semaphore(concurrency)
    done = 0

    async def one(path: Path, text: str, voice: str):
        nonlocal done
        async with sem:
            await edge_tts.Communicate(text, voice).save(str(path))
            done += 1
            if done % 10 == 0 or done == len(jobs):
                print(f"   {done}/{len(jobs)}")

    await asyncio.gather(*(one(*j) for j in jobs))


CSS = """
:root { color-scheme: light dark; --bg:#faf9f7; --fg:#1a1a1a; --muted:#6b6b6b;
        --line:#e2e0dc; --card:#fff; --cn:#2f6f8f; --tw:#8a4b2a; }
@media (prefers-color-scheme: dark) { :root { --bg:#16150f; --fg:#ece9e2;
        --muted:#9a968c; --line:#302d26; --card:#1e1c16; --cn:#7fb8d4; --tw:#d99a6c; } }
*{box-sizing:border-box} body{margin:0;padding:2rem 1rem 4rem;background:var(--bg);
  color:var(--fg);font:16px/1.6 ui-serif,Georgia,serif}
main{max-width:48rem;margin:0 auto} h1{font-size:1.5rem;margin:0 0 .25rem}
h2{font-size:1.15rem;margin:2.5rem 0 .5rem;border-top:1px solid var(--line);padding-top:1.5rem}
.sub{color:var(--muted);font-size:.9rem;margin:0 0 1.5rem}
.item{background:var(--card);border:1px solid var(--line);border-radius:10px;
  padding:1rem 1.15rem;margin-bottom:.9rem}
.hz{font-size:1.45rem;font-family:ui-sans-serif,"Microsoft JhengHei","Microsoft YaHei",sans-serif;margin:0}
.py{color:var(--muted);font-size:.9rem;margin:.1rem 0 .1rem}
.en{color:var(--muted);font-size:.85rem;font-style:italic;margin:0 0 .7rem}
.row{display:flex;flex-wrap:wrap;gap:.9rem;align-items:flex-end}
.col{display:flex;flex-direction:column;gap:.2rem}
.col small{font-size:.72rem;font-weight:700;letter-spacing:.03em}
.cn small{color:var(--cn)} .tw small{color:var(--tw)}
audio{height:32px}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
@media (max-width:34rem){.pair{grid-template-columns:1fr}}
.label{font-size:.8rem;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;
  margin:0 0 .5rem}
"""


def build_page(accent_items, word_items) -> Path:
    parts = ["""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mainland vs Taiwan</title><style>""" + CSS + """</style></head><body><main>
<h1>Which one sounds like home?</h1>
<p class="sub">Jasmine &mdash; your family is from Taiwan, and everything built so far
assumed mainland Mandarin. Two questions, both answerable by ear.</p>

<h2>1. Accent &mdash; same words, different voice</h2>
<p class="sub">Identical sentence, four voices. Which pair sounds like the Mandarin you
grew up hearing? Listen for the <em>bao-bao</em> / <em>xie-xie</em> endings and the
sh/zh sounds &mdash; that's where the two varieties differ most.</p>"""]

    for it in accent_items:
        cn = "".join(
            f'<div class="col cn"><audio controls preload="none" src="{c["file"]}"></audio>'
            f'<small>{html.escape(c["label"])}</small></div>'
            for c in it["clips"] if c["region"] == "cn"
        )
        tw = "".join(
            f'<div class="col tw"><audio controls preload="none" src="{c["file"]}"></audio>'
            f'<small>{html.escape(c["label"])}</small></div>'
            for c in it["clips"] if c["region"] == "tw"
        )
        parts.append(f"""<div class="item">
<p class="hz">{html.escape(it['simp'])} &nbsp;<span style="color:var(--muted);font-size:1rem">/</span>&nbsp; {html.escape(it['trad'])}</p>
<p class="py">{html.escape(it['pinyin'])}</p><p class="en">{html.escape(it['gloss'])}</p>
<div class="row">{cn}{tw}</div></div>""")

    parts.append("""<h2>2. Word choice &mdash; same voice, different words</h2>
<p class="sub">Both read by the same Taiwan voice, so only the wording differs.
Which one would you actually say? If neither, say what you'd say instead.</p>""")

    for it in word_items:
        a, b = it["clips"]
        parts.append(f"""<div class="item">
<p class="label">{html.escape(it['topic'])}</p>
<div class="pair">
  <div><p class="hz">{html.escape(it['a_text'])}</p>
       <audio controls preload="none" src="{a['file']}"></audio></div>
  <div><p class="hz">{html.escape(it['b_text'])}</p>
       <audio controls preload="none" src="{b['file']}"></audio></div>
</div>
<p class="en" style="margin-top:.7rem">{html.escape(it['gloss'])}</p></div>""")

    parts.append("</main></body></html>")
    path = OUT / "compare.html"
    path.write_text("".join(parts), encoding="utf-8")
    return path


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    jobs: list[tuple[Path, str, str]] = []

    accent_items = []
    for i, (simp, trad, pinyin, gloss) in enumerate(ACCENT_SET):
        clips = []
        for voice, label in CN_VOICES:
            name = f"a{i:02d}_cn_{voice.split('-')[-1]}.mp3"
            jobs.append((OUT / name, simp, voice))
            clips.append({"file": name, "label": label, "region": "cn"})
        for voice, label in TW_VOICES:
            name = f"a{i:02d}_tw_{voice.split('-')[-1]}.mp3"
            jobs.append((OUT / name, trad, voice))  # TW voice reads Traditional
            clips.append({"file": name, "label": label, "region": "tw"})
        accent_items.append({"simp": simp, "trad": trad, "pinyin": pinyin,
                             "gloss": gloss, "clips": clips})

    tw_voice = TW_VOICES[0][0]
    word_items = []
    for i, (topic, a_text, b_text, gloss) in enumerate(WORD_CHOICE):
        clips = []
        for side, text in (("a", a_text), ("b", b_text)):
            name = f"w{i:02d}{side}.mp3"
            jobs.append((OUT / name, text, tw_voice))
            clips.append({"file": name})
        word_items.append({"topic": topic, "a_text": a_text, "b_text": b_text,
                           "gloss": gloss, "clips": clips})

    print(f"Rendering {len(jobs)} clips via edge-tts")
    asyncio.run(render(jobs))
    page = build_page(accent_items, word_items)
    print(f"\nDone. Open: {page}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
