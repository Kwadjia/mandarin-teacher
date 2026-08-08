"""Build the exercise lab — playable prototypes of every drill type under consideration.

The point is to make design decisions by playing rather than by reading. Each mode is
a real, working exercise driven by the actual corpus and the actual audio, annotated
with what it trains and whether it can be auto-graded.

Every interaction also emits a row into a live event panel, in the shape of the real
`event` table, so the telemetry design is concrete rather than theoretical.

    python pipeline/build_lab.py
    # then, for the microphone exercises:
    cd pipeline/out && python -m http.server 8000
    # open http://localhost:8000/lab/

Output: out/lab/index.html  (audio is referenced from ../day0/)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from pypinyin import Style, lazy_pinyin

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent
SENTENCES = ROOT / "data" / "seed_sentences.json"
VOCAB = ROOT / "data" / "seed_vocab.json"
DAY0 = ROOT / "out" / "day0"
OUT = ROOT / "out" / "lab"

PUNCT = set("，。！？、：；“”‘’…—《》（）")


def syllables(hanzi: str) -> list[str]:
    return [
        s
        for s in lazy_pinyin(hanzi, style=Style.TONE3, neutral_tone_with_five=True)
        if s and s[0] not in PUNCT
    ]


def cover(text: str, allowed: set[str], max_len: int = 4) -> list[str]:
    out, i = [], 0
    while i < len(text):
        if text[i] in PUNCT:
            i += 1
            continue
        for n in range(min(max_len, len(text) - i), 0, -1):
            if text[i : i + n] in allowed:
                out.append(text[i : i + n])
                i += n
                break
        else:
            i += 1
    return out


# ── page ──────────────────────────────────────────────────────────────────────

CSS = """
:root{color-scheme:light dark;--bg:#faf9f7;--fg:#1a1a1a;--muted:#6b6b6b;--line:#e2e0dc;
 --card:#fff;--accent:#8a4b2a;--ok:#2f7d4f;--no:#b4472a;--tw:#8a4b2a;--cn:#2f6f8f;--code:#f2f0ec}
@media (prefers-color-scheme:dark){:root{--bg:#16150f;--fg:#ece9e2;--muted:#9a968c;
 --line:#302d26;--card:#1e1c16;--accent:#d99a6c;--ok:#7fc79b;--no:#e0876a;--tw:#d99a6c;
 --cn:#7fb8d4;--code:#12110c}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
 font:16px/1.6 ui-serif,Georgia,serif;padding:1.5rem 1rem 2rem}
.wrap{max-width:62rem;margin:0 auto;display:grid;grid-template-columns:1fr 20rem;gap:1.5rem}
@media(max-width:60rem){.wrap{grid-template-columns:1fr}}
h1{font-size:1.4rem;margin:0 0 .2rem}
.sub{color:var(--muted);font-size:.88rem;margin:0 0 1.2rem}
nav{display:flex;flex-wrap:wrap;gap:.9rem;margin-bottom:1.2rem;align-items:center}
.grp{display:flex;flex-wrap:wrap;gap:.3rem;align-items:center}
.glab{font-size:.65rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);
 margin-right:.15rem}
nav button{font:inherit;font-size:.8rem;padding:.32rem .7rem;border:1px solid var(--line);
 background:transparent;color:var(--fg);border-radius:99px;cursor:pointer}
nav button[aria-current=true]{background:var(--accent);border-color:var(--accent);color:#fff}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1.4rem}
.exhdr{border-bottom:1px solid var(--line);padding-bottom:.8rem;margin-bottom:1.2rem}
.exhdr h2{font-size:1.15rem;margin:0 0 .2rem}
.exhdr p{margin:0;font-size:.84rem;color:var(--muted)}
.tags{display:flex;gap:.35rem;flex-wrap:wrap;margin-top:.5rem}
.tag{font-size:.68rem;letter-spacing:.04em;text-transform:uppercase;padding:.15rem .5rem;
 border:1px solid var(--line);border-radius:99px;color:var(--muted)}
.tag.auto{color:var(--ok);border-color:var(--ok)}
.tag.self{color:var(--muted)}
.stage{min-height:15rem;display:flex;flex-direction:column;justify-content:center}
.hz{font-size:2.1rem;font-family:ui-sans-serif,"Microsoft JhengHei","Microsoft YaHei",sans-serif;
 margin:.2rem 0;line-height:1.35}
.hz.sm{font-size:1.35rem}
.alt{font-size:1rem;color:var(--muted);font-family:ui-sans-serif,"Microsoft YaHei",sans-serif;margin:0}
.py{color:var(--muted);font-size:.95rem;margin:.2rem 0}
.en{font-size:1rem;margin:.4rem 0 0}
.muted{color:var(--muted)}
.big{display:flex;gap:.6rem;flex-wrap:wrap;align-items:center;margin:1.1rem 0 .3rem}
button.b{font:inherit;padding:.5rem 1.1rem;border:1px solid var(--line);border-radius:8px;
 background:transparent;color:var(--fg);cursor:pointer;font-size:.92rem}
button.b:hover{border-color:var(--accent)}
button.b.p{background:var(--accent);border-color:var(--accent);color:#fff}
button.b.ok{border-color:var(--ok);color:var(--ok)}
button.b.no{border-color:var(--no);color:var(--no)}
button.b:disabled{opacity:.4;cursor:not-allowed}
button.play{font-size:1.5rem;width:4rem;height:4rem;border-radius:50%;display:grid;place-items:center}
.opts{display:grid;gap:.5rem;margin:1rem 0}
.opt{text-align:left;padding:.7rem .9rem;font-size:1rem}
.opt.right{border-color:var(--ok);background:color-mix(in srgb,var(--ok) 12%,transparent)}
.opt.wrong{border-color:var(--no);background:color-mix(in srgb,var(--no) 12%,transparent)}
input.t{font:inherit;font-size:1.05rem;padding:.55rem .7rem;width:100%;border:1px solid var(--line);
 border-radius:8px;background:transparent;color:var(--fg);font-family:ui-monospace,monospace}
.syl{display:inline-block;padding:.12rem .45rem;margin:.12rem;border-radius:5px;
 font-family:ui-monospace,monospace;font-size:.95rem;border:1px solid var(--line)}
.syl.ok{color:var(--ok);border-color:var(--ok)}
.syl.tone{color:#b8860b;border-color:#b8860b}
.syl.bad{color:var(--no);border-color:var(--no)}
.log{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1rem;
 position:sticky;top:1rem;max-height:85vh;overflow:auto}
.log h3{font-size:.82rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 .2rem}
.log p{font-size:.76rem;color:var(--muted);margin:0 0 .8rem}
.ev{font-family:ui-monospace,monospace;font-size:.68rem;background:var(--code);
 border-radius:6px;padding:.5rem .6rem;margin-bottom:.4rem;white-space:pre-wrap;word-break:break-all}
.rate{display:flex;gap:.3rem;flex-wrap:wrap}
.rate button{font-size:.8rem;padding:.3rem .6rem}
.rate button[aria-current=true]{background:var(--accent);border-color:var(--accent);color:#fff}
.vlab{font-size:.7rem;letter-spacing:.04em}
.vlab.tw{color:var(--tw)}.vlab.cn{color:var(--cn)}
.hint{font-size:.8rem;color:var(--muted);margin-top:.8rem}
.verdict{display:flex;gap:.35rem;align-items:center;flex-wrap:wrap;margin-top:.9rem;
 padding-top:.75rem;border-top:1px dashed var(--line)}
.vb{font:inherit;font-size:.75rem;padding:.22rem .6rem;border:1px solid var(--line);
 border-radius:99px;background:transparent;color:var(--muted);cursor:pointer}
.vb.on.keep{background:var(--ok);border-color:var(--ok);color:#fff}
.vb.on.maybe{background:var(--muted);border-color:var(--muted);color:#fff}
.vb.on.cut{background:var(--no);border-color:var(--no);color:#fff}
.vnote{flex:1;min-width:11rem;font:inherit;font-size:.78rem;padding:.22rem .5rem;
 border:1px solid var(--line);border-radius:6px;background:transparent;color:var(--fg)}
.warn{color:var(--no);font-size:.85rem}
.blank{border-bottom:2px solid var(--accent);padding:0 1.2rem;margin:0 .15rem}
.row{display:flex;gap:.8rem;align-items:center;flex-wrap:wrap}
progress{width:100%;height:6px}
"""

JS = r"""
const $ = (s,r=document)=>r.querySelector(s);
const rnd = a => a[Math.floor(Math.random()*a.length)];
const shuffle = a => a.map(v=>[Math.random(),v]).sort((x,y)=>x[0]-y[0]).map(v=>v[1]);
const sample = (a,n,not) => shuffle(a.filter(x=>x!==not)).slice(0,n);

const S = { item:null, t0:0, replays:0, audio:null, log:[], rate:1 };

// ── event log — mirrors the real `event` table shape (docs/design.md §3) ──
function emit(o){
  const ev = Object.assign({
    ts:new Date().toISOString().slice(11,23),
    kind:'review', modality:'listen', exercise_type:MODE,
    utterance_id:S.item? 'u'+S.item.i : null,
  }, o);
  S.log.unshift(ev);
  const box = $('#events');
  box.insertAdjacentHTML('afterbegin',
    '<div class="ev">'+JSON.stringify(ev,null,1).replace(/[{}"]/g,'')
      .split('\n').filter(l=>l.trim()).join('\n')+'</div>');
  while(box.children.length>14) box.lastChild.remove();
}

// ── audio ──
function clip(item,{tw=null,rate=null}={}){
  let c = item.clips;
  if(tw!==null) c = c.filter(x=>x.tw===tw);
  if(rate!==null) c = c.filter(x=>x.r===rate);
  return rnd(c.length?c:item.clips);
}
function play(file,speed=1){
  if(S.audio){S.audio.pause();}
  const a = new Audio('../day0/'+file);
  a.playbackRate = speed;
  S.audio = a; a.play(); return a;
}
function nextItem(){ S.item = rnd(DATA); S.replays = 0; S.t0 = performance.now(); return S.item; }
const elapsed = () => Math.round(performance.now()-S.t0);

function reveal(item){
  return `<p class="hz">${item.t}</p>`+
         (item.t!==item.s?`<p class="alt">${item.s}</p>`:'')+
         `<p class="py">${item.p}</p><p class="en">${item.g}</p>`;
}
function voiceLabel(c){
  return `<span class="vlab ${c.tw?'tw':'cn'}">${c.tw?'TW':'CN'} ${c.v}</span>`;
}

// ── pinyin comparison ──
function normSyl(x){
  x = x.trim().toLowerCase().replace(/[üǖǘǚǜ]/g,'v');
  if(!/[0-5]$/.test(x)) x += '5';
  return x;
}
function gradeSyllables(userStr, ref){
  const user = userStr.trim().split(/\s+/).filter(Boolean).map(normSyl);
  return ref.map((r,i)=>{
    const want = normSyl(r), got = user[i];
    if(!got) return {r, cls:'bad', got:'—'};
    if(got===want) return {r, cls:'ok', got};
    if(got.slice(0,-1)===want.slice(0,-1)) return {r, cls:'tone', got};
    return {r, cls:'bad', got};
  });
}

// ══ EXERCISES ══════════════════════════════════════════════════════════════
const EX = {};

EX['listen-commit'] = {
  name:'Listen & Commit', mod:'listen', auto:false,
  blurb:'The MVP baseline. Hear it, decide whether you understood it, and only then '+
        'may you reveal. The commitment is forced before the answer exists — that is what '+
        'keeps hindsight bias out of the data (design.md §2.9).',
  tags:['listening','self-graded','core loop'],
  run(el){
    const it = nextItem(), c = clip(it);
    el.innerHTML = `<div class="big"><button class="b p play" id="pl">▶</button>
      <span class="muted">${voiceLabel(c)} · replays <b id="rc">0</b>/2</span></div>
      <div class="big"><button class="b ok" id="got">Got it</button>
      <button class="b no" id="miss">Missed it</button></div>
      <p class="hint">No reveal button until you commit.</p><div id="out"></div>`;
    const a = play(c.f); S.t0 = performance.now();
    $('#pl').onclick = ()=>{ if(S.replays>=2) return; S.replays++; $('#rc').textContent=S.replays; play(c.f); };
    const done = ok => {
      const ms = elapsed();
      emit({result: ok?'good':'again', latency_ms:ms, replays:S.replays, committed_before_reveal:true});
      $('#out').innerHTML = reveal(it) +
        `<p class="hint">${ok?'Committed: understood':'Committed: missed'} · ${(ms/1000).toFixed(1)}s`+
        ` · ${S.replays} replay(s)</p>`+
        `<div class="big"><button class="b p" onclick="start('listen-commit')">Next →</button></div>`;
      $('#got').disabled = $('#miss').disabled = true;
    };
    $('#got').onclick = ()=>done(true); $('#miss').onclick = ()=>done(false);
  }
};

EX['meaning-match'] = {
  name:'Meaning Match', mod:'listen', auto:true,
  blurb:'Hear it, pick the English. Fully auto-graded, so it costs nothing per rep and '+
        'produces clean data. Easier than free recall — good for introducing a new word.',
  tags:['listening','auto-graded','recognition'],
  run(el){
    const it = nextItem(), c = clip(it);
    const opts = shuffle([it, ...sample(DATA,3,it)]);
    el.innerHTML = `<div class="big"><button class="b p play" id="pl">▶</button>
      <span class="muted">${voiceLabel(c)}</span></div><div class="opts" id="o"></div><div id="out"></div>`;
    play(c.f); S.t0 = performance.now();
    $('#pl').onclick = ()=>{S.replays++; play(c.f);};
    opts.forEach(o=>{
      const b = document.createElement('button');
      b.className='b opt'; b.textContent=o.g;
      b.onclick = ()=>{
        const ok = o===it, ms = elapsed();
        emit({result: ok?'good':'again', latency_ms:ms, replays:S.replays, committed_before_reveal:true});
        [...$('#o').children].forEach(x=>{
          x.disabled=true;
          if(x.textContent===it.g) x.classList.add('right');
          else if(x===b) x.classList.add('wrong');
        });
        $('#out').innerHTML = reveal(it)+
          `<div class="big"><button class="b p" onclick="start('meaning-match')">Next →</button></div>`;
      };
      $('#o').appendChild(b);
    });
  }
};

EX['dictation'] = {
  name:'Pinyin Dictation', mod:'listen', auto:true,
  blurb:'Hear it, type it in tone-numbered pinyin (bao3 bao3 shui4 jiao4 le5). This is the '+
        'only exercise that directly trains tone discrimination, it is deterministically '+
        'auto-gradable with zero AI, and it gives per-syllable feedback. Strongest candidate '+
        'for the phase-2 headline drill.',
  tags:['listening','tones','auto-graded'],
  run(el){
    const it = nextItem(), c = clip(it);
    el.innerHTML = `<div class="big"><button class="b p play" id="pl">▶</button>
      <span class="muted">${voiceLabel(c)} · ${it.n.length} syllables</span></div>
      <input class="t" id="in" autocomplete="off" spellcheck="false"
             placeholder="space-separated, tone numbers: bao3 bao3 shui4 jiao4 le5">
      <div class="big"><button class="b p" id="ck">Check</button></div>
      <p class="hint">Neutral tone = 5, or just omit the number. ü is typed v.</p>
      <div id="out"></div>`;
    play(c.f); S.t0 = performance.now(); $('#in').focus();
    $('#pl').onclick = ()=>{S.replays++; play(c.f);};
    const check = ()=>{
      const g = gradeSyllables($('#in').value, it.n);
      const right = g.filter(x=>x.cls==='ok').length;
      const toneOnly = g.filter(x=>x.cls==='tone').length;
      emit({result: right===it.n.length?'good':(right>=it.n.length*.6?'hard':'again'),
            latency_ms:elapsed(), replays:S.replays,
            payload:{correct:right, tone_errors:toneOnly, total:it.n.length}});
      $('#out').innerHTML =
        `<p>${g.map(x=>`<span class="syl ${x.cls}">${x.r}</span>`).join('')}</p>`+
        `<p class="hint">${right}/${it.n.length} exact`+
        (toneOnly?` · <b style="color:#b8860b">${toneOnly} right syllable, wrong tone</b>`:'')+
        `</p>`+reveal(it)+
        `<p class="hint">Note: neutral-tone conventions differ between Taiwan and the mainland `+
        `(bǎobǎo vs bǎobao), so a 3-vs-5 mismatch may be a variety difference, not an error.</p>`+
        `<div class="big"><button class="b p" onclick="start('dictation')">Next →</button></div>`;
    };
    $('#ck').onclick = check;
    $('#in').onkeydown = e=>{ if(e.key==='Enter') check(); };
  }
};

EX['which-one'] = {
  name:'Which One?', mod:'listen', auto:true,
  blurb:'Hear it, pick which written sentence it was. Distractors are length-matched, so '+
        'you cannot win on rhythm alone. Trains fine-grained discrimination rather than gist, '+
        'and doubles as reading practice.',
  tags:['listening','reading','auto-graded','discrimination'],
  run(el){
    const it = nextItem(), c = clip(it);
    const near = DATA.filter(x=>x!==it && Math.abs(x.s.length-it.s.length)<=1);
    const opts = shuffle([it, ...sample(near.length>=3?near:DATA,3,it)]);
    el.innerHTML = `<div class="big"><button class="b p play" id="pl">▶</button>
      <span class="muted">${voiceLabel(c)}</span></div><div class="opts" id="o"></div><div id="out"></div>`;
    play(c.f); S.t0 = performance.now();
    $('#pl').onclick = ()=>{S.replays++; play(c.f);};
    opts.forEach(o=>{
      const b=document.createElement('button');
      b.className='b opt'; b.innerHTML=`<span style="font-size:1.2rem">${o.t}</span>`;
      b.onclick=()=>{
        const ok=o===it;
        emit({result:ok?'good':'again', latency_ms:elapsed(), replays:S.replays});
        [...$('#o').children].forEach((x,i)=>{x.disabled=true;
          if(opts[i]===it)x.classList.add('right'); else if(x===b)x.classList.add('wrong');});
        $('#out').innerHTML=reveal(it)+
          `<div class="big"><button class="b p" onclick="start('which-one')">Next →</button></div>`;
      };
      $('#o').appendChild(b);
    });
  }
};

EX['cloze'] = {
  name:'Listening Cloze', mod:'listen', auto:true,
  blurb:'The sentence is shown with one word removed. Hear the full audio and identify '+
        'the missing word. Forces you to parse a specific word out of connected speech '+
        'rather than recognise the sentence as a whole — the closest drill to real listening.',
  tags:['listening','auto-graded','parsing'],
  run(el){
    let it, tries=0;
    do { it = nextItem(); tries++; } while(it.w.length<3 && tries<30);
    const wi = 1 + Math.floor(Math.random()*(it.w.length-1));
    const target = it.w[wi];
    const shown = it.w.map((w,i)=> i===wi ? '<span class="blank"></span>' : w).join('');
    const pool = [...new Set(VOCAB.filter(v=>v!==target))];
    const opts = shuffle([target, ...sample(pool,3,target)]);
    const c = clip(it);
    el.innerHTML = `<p class="hz sm">${shown}</p>
      <div class="big"><button class="b p play" id="pl">▶</button>
      <span class="muted">${voiceLabel(c)} · which word is missing?</span></div>
      <div class="opts" id="o"></div><div id="out"></div>`;
    play(c.f); S.t0=performance.now();
    $('#pl').onclick=()=>{S.replays++; play(c.f);};
    opts.forEach(o=>{
      const b=document.createElement('button');
      b.className='b opt'; b.innerHTML=`<span style="font-size:1.2rem">${o}</span>`;
      b.onclick=()=>{
        const ok=o===target;
        emit({result:ok?'good':'again', latency_ms:elapsed(), replays:S.replays,
              payload:{target}});
        [...$('#o').children].forEach((x,i)=>{x.disabled=true;
          if(opts[i]===target)x.classList.add('right'); else if(x===b)x.classList.add('wrong');});
        $('#out').innerHTML=reveal(it)+
          `<div class="big"><button class="b p" onclick="start('cloze')">Next →</button></div>`;
      };
      $('#o').appendChild(b);
    });
  }
};

EX['speed'] = {
  name:'Speed Ladder', mod:'listen', auto:false,
  blurb:'One sentence, progressively faster. Comprehension speed — not accuracy — is the '+
        'actual listening skill, and it is the thing a pass/fail grade never measures. '+
        'Find the speed where you fall off, and watch that number move over months.',
  tags:['listening','automaticity','self-graded'],
  run(el){
    const it = nextItem(), c = clip(it,{rate:0});
    const rates=[0.7,0.85,1.0,1.15,1.35];
    el.innerHTML = `<div class="rate" id="r"></div>
      <div class="big"><button class="b p play" id="pl">▶</button>
      <span class="muted">${voiceLabel(c)} · <b id="rl">1.0×</b></span></div>
      <div class="big"><button class="b no" id="lost">Lost it at this speed</button>
      <button class="b ok" id="fine">Still following</button></div><div id="out"></div>`;
    let cur=1.0;
    rates.forEach(r=>{
      const b=document.createElement('button'); b.className='b'; b.textContent=r+'×';
      b.setAttribute('aria-current', r===1.0);
      b.onclick=()=>{cur=r; $('#rl').textContent=r+'×';
        [...$('#r').children].forEach(x=>x.setAttribute('aria-current', x.textContent===r+'×'));
        play(c.f,r);};
      $('#r').appendChild(b);
    });
    play(c.f,1.0); S.t0=performance.now();
    $('#pl').onclick=()=>play(c.f,cur);
    const done = ok=>{
      emit({result:ok?'good':'again', latency_ms:elapsed(), exercise_type:'speed_ladder',
            payload:{playback_rate:cur}});
      $('#out').innerHTML=reveal(it)+
        `<p class="hint">Ceiling this rep: <b>${ok?cur+'× or higher':'below '+cur+'×'}</b></p>`+
        `<div class="big"><button class="b p" onclick="start('speed')">Next →</button></div>`;
    };
    $('#lost').onclick=()=>done(false); $('#fine').onclick=()=>done(true);
  }
};

EX['say-it'] = {
  name:'Say It', mod:'speak', auto:false,
  blurb:'English prompt, you say the Mandarin out loud, then compare against the native '+
        'audio. Production recall is much harder than recognition — expect to fail things '+
        'you "know". Later this gets scored by local faster-whisper at zero cost.',
  tags:['speaking','production','self-graded','mic optional'],
  run(el){
    const it = nextItem(), c = clip(it,{tw:1});
    el.innerHTML = `<p class="en" style="font-size:1.5rem">${it.g}</p>
      <p class="hint">Say it out loud in Mandarin. Then reveal.</p>
      <div class="big"><button class="b" id="rec">● Record (optional)</button>
        <button class="b p" id="rev">Reveal answer</button></div>
      <div id="mine"></div><div id="out"></div>`;
    S.t0=performance.now();
    wireRecorder($('#rec'), $('#mine'));
    $('#rev').onclick=()=>{
      play(c.f);
      $('#out').innerHTML=reveal(it)+
        `<div class="big"><button class="b" onclick="play('${c.f}')">▶ Native again</button></div>`+
        `<div class="big"><button class="b ok" id="y">Said it right</button>
         <button class="b no" id="n">Couldn't produce it</button></div>`;
      $('#y').onclick=()=>{emit({modality:'speak',result:'good',latency_ms:elapsed()});start('say-it');};
      $('#n').onclick=()=>{emit({modality:'speak',result:'again',latency_ms:elapsed()});start('say-it');};
    };
  }
};

EX['shadow'] = {
  name:'Shadow', mod:'speak', auto:false,
  blurb:'Hear the native line, immediately repeat it, then play both back to back. '+
        'The A/B is the whole point — you hear your own tone errors instantly in a way '+
        'you never do while speaking. Cheapest possible pronunciation feedback loop.',
  tags:['speaking','pronunciation','mic required'],
  run(el){
    const it = nextItem(), c = clip(it,{tw:1});
    el.innerHTML = reveal(it)+
      `<div class="big"><button class="b p" id="pl">▶ Native</button>
       <button class="b" id="rec">● Record</button></div>
      <div id="mine"></div>
      <div class="big"><button class="b" id="ab" disabled>▶ A/B compare</button>
       <button class="b p" onclick="start('shadow')">Next →</button></div>`;
    play(c.f);
    $('#pl').onclick=()=>play(c.f);
    wireRecorder($('#rec'), $('#mine'), url=>{
      const ab=$('#ab'); ab.disabled=false;
      ab.onclick=async()=>{
        play(c.f); await new Promise(r=>setTimeout(r,1800));
        const a=new Audio(url); a.play();
        emit({modality:'speak',exercise_type:'shadow',result:null,payload:{ab_compare:true}});
      };
    });
  }
};

EX['read-sprint'] = {
  name:'Reading Sprint', mod:'read', auto:true,
  blurb:'Traditional characters, no audio, timed. Reading is priority three, but this is '+
        'nearly free to build and it is how the Traditional/Simplified mapping gets absorbed '+
        'passively. Latency is the metric, not accuracy.',
  tags:['reading','traditional','auto-graded'],
  run(el){
    const it = nextItem();
    const opts = shuffle([it, ...sample(DATA,3,it)]);
    el.innerHTML = `<p class="hz">${it.t}</p><div class="opts" id="o"></div><div id="out"></div>`;
    S.t0=performance.now();
    opts.forEach(o=>{
      const b=document.createElement('button'); b.className='b opt'; b.textContent=o.g;
      b.onclick=()=>{
        const ok=o===it, ms=elapsed();
        emit({modality:'read', result:ok?'good':'again', latency_ms:ms});
        [...$('#o').children].forEach((x,i)=>{x.disabled=true;
          if(opts[i]===it)x.classList.add('right'); else if(x===b)x.classList.add('wrong');});
        $('#out').innerHTML=`<p class="alt">${it.s}</p><p class="py">${it.p}</p>`+
          `<p class="hint">${(ms/1000).toFixed(1)}s</p>`+
          `<div class="big"><button class="b p" onclick="start('read-sprint')">Next →</button></div>`;
      };
      $('#o').appendChild(b);
    });
  }
};

EX['immersion'] = {
  name:'Immersion', mod:'listen', auto:false,
  blurb:'Continuous audio, no interaction, no grading. For the second monitor while you '+
        'game. Real value depends on the content being comprehensible — 80–90% known — '+
        'which needs the learner model, so treat this as a shape preview, not the feature.',
  tags:['listening','passive','no grading'],
  run(el){
    el.innerHTML = `<div class="row"><button class="b p" id="go">▶ Start</button>
      <button class="b" id="stop" disabled>■ Stop</button>
      <label class="muted"><input type="checkbox" id="cap" checked> show captions</label>
      <label class="muted"><input type="checkbox" id="gap"> 2s gap (shadowing room)</label></div>
      <progress id="pg" value="0" max="20"></progress>
      <div id="now" style="margin-top:1rem"></div>`;
    let stop=false, n=0;
    const runLoop = async()=>{
      const list = shuffle(DATA).slice(0,20);
      for(const it of list){
        if(stop) break;
        const c = clip(it);
        $('#now').innerHTML = $('#cap').checked
          ? `<p class="hz sm">${it.t}</p><p class="en muted">${it.g}</p>`
          : `<p class="muted">listening…</p>`;
        const a = play(c.f);
        emit({kind:'exposure', result:null, exercise_type:'immersion', latency_ms:null});
        await new Promise(r=>{a.onended=r; setTimeout(r,6000);});
        if($('#gap').checked) await new Promise(r=>setTimeout(r,2000));
        $('#pg').value = ++n;
      }
      $('#go').disabled=false; $('#stop').disabled=true;
    };
    $('#go').onclick=()=>{stop=false;n=0;$('#go').disabled=true;$('#stop').disabled=false;runLoop();};
    $('#stop').onclick=()=>{stop=true; if(S.audio)S.audio.pause();};
  }
};

// ── microphone plumbing ──
function wireRecorder(btn, out, onDone){
  let rec=null, chunks=[];
  btn.onclick = async()=>{
    if(rec && rec.state==='recording'){ rec.stop(); return; }
    try{
      const stream = await navigator.mediaDevices.getUserMedia({audio:true});
      rec = new MediaRecorder(stream); chunks=[];
      rec.ondataavailable = e=>chunks.push(e.data);
      rec.onstop = ()=>{
        stream.getTracks().forEach(t=>t.stop());
        const url = URL.createObjectURL(new Blob(chunks,{type:'audio/webm'}));
        out.innerHTML = `<div class="row"><span class="muted vlab">YOU</span>
          <audio controls src="${url}"></audio></div>`;
        btn.textContent='● Record again';
        if(onDone) onDone(url);
      };
      rec.start(); btn.textContent='■ Stop recording';
    }catch(e){
      out.innerHTML = `<p class="warn">Microphone unavailable (${e.name}).<br>
        Browsers block getUserMedia on <code>file://</code>. To enable this exercise:<br>
        <code>cd pipeline/out &amp;&amp; python -m http.server 8000</code><br>
        then open <code>http://localhost:8000/lab/</code></p>`;
    }
  };
}

"""

JS2 = r"""
// ══ TONE ISOLATION ═════════════════════════════════════════════════════════
// Inside a sentence, context lets you infer a word without hearing its tone.
// These three remove that crutch.
const TONE_MARKS = {1:'ā',2:'á',3:'ǎ',4:'à'};
const toneClip = (w,tw=null) => rnd(tw===null? w.clips : w.clips.filter(c=>c.tw===tw));
function playTone(f){ if(S.audio)S.audio.pause(); const a=new Audio('../tones/'+f); S.audio=a; a.play(); return a; }

EX['tone-id'] = {
  name:'Tone ID', mod:'listen', auto:true,
  blurb:'One syllable, no context. Which tone was it? This is the most basic perception '+
        'skill and the one adult learners most reliably lack — you can know 2000 words and '+
        'still be at chance here. Cheap to drill, brutally honest as a measurement.',
  tags:['tones','perception','auto-graded'],
  run(el){
    const set = rnd(TONES), w = rnd(set.words), c = toneClip(w);
    S.item=null; S.t0=performance.now();
    el.innerHTML = `<div class="big"><button class="b p play" id="pl">▶</button>
      <span class="muted">syllable “${set.syllable}” · which tone?</span></div>
      <div class="row" id="o"></div><div id="out"></div>`;
    playTone(c.f);
    $('#pl').onclick=()=>playTone(c.f);
    [1,2,3,4].forEach(t=>{
      const b=document.createElement('button'); b.className='b';
      b.style.fontSize='1.5rem'; b.style.minWidth='4.5rem';
      b.innerHTML=`${set.syllable.replace(/[aeiou]/, m=>TONE_MARKS[t].replace('a',m==='a'?'a':m))}<br>
        <span style="font-size:.7rem" class="muted">tone ${t}</span>`;
      b.textContent = ''; b.innerHTML =
        `<div style="font-size:1.6rem;line-height:1.1">${TONE_MARKS[t]}</div>
         <div style="font-size:.68rem" class="muted">tone ${t}</div>`;
      b.onclick=()=>{
        const ok = t===w.tone;
        emit({exercise_type:'tone_id', result:ok?'good':'again', latency_ms:elapsed(),
              payload:{syllable:set.syllable, tone:w.tone, answered:t}});
        [...$('#o').children].forEach((x,i)=>{x.disabled=true;
          if(i+1===w.tone)x.classList.add('right'); else if(x===b)x.classList.add('wrong');});
        $('#out').innerHTML=`<p class="hz">${w.trad}</p><p class="py">${set.syllable}${w.tone} · ${w.gloss}</p>`+
          `<div class="big"><button class="b p" onclick="start('tone-id')">Next →</button></div>`;
      };
      $('#o').appendChild(b);
    });
  }
};

EX['minimal-pairs'] = {
  name:'Minimal Pairs', mod:'listen', auto:true,
  blurb:'Four real words, identical syllable, four different tones. 妈 麻 马 骂. If you '+
        'can do this you can hear tones; if you cannot, no amount of vocabulary will fix '+
        'the underlying problem. The hardest exercise here and the most diagnostic.',
  tags:['tones','perception','auto-graded','hard'],
  run(el){
    const set = rnd(TONES), w = rnd(set.words), c = toneClip(w);
    S.item=null; S.t0=performance.now();
    el.innerHTML = `<div class="big"><button class="b p play" id="pl">▶</button>
      <span class="muted">all four are “${set.syllable}” — which one?</span></div>
      <div class="opts" id="o"></div><div id="out"></div>`;
    playTone(c.f);
    $('#pl').onclick=()=>playTone(c.f);
    shuffle([...set.words]).forEach(x=>{
      const b=document.createElement('button'); b.className='b opt';
      b.innerHTML=`<span style="font-size:1.5rem">${x.trad}</span>
        <span class="muted" style="font-size:.85rem"> — ${x.gloss}</span>`;
      b.onclick=()=>{
        const ok = x===w;
        emit({exercise_type:'minimal_pair', result:ok?'good':'again', latency_ms:elapsed(),
              payload:{syllable:set.syllable, tone:w.tone, answered:x.tone}});
        [...$('#o').children].forEach(y=>{y.disabled=true;});
        [...$('#o').children].forEach(y=>{
          if(y.textContent.trim().startsWith(w.trad)) y.classList.add('right');
          else if(y===b) y.classList.add('wrong');
        });
        $('#out').innerHTML=`<p class="hint">Heard: <b>${set.syllable}${w.tone}</b> ${w.trad} (${w.gloss})</p>`+
          `<div class="row">`+set.words.map(v=>
            `<button class="b" onclick="playTone('${toneClip(v).f}')">${v.trad} ${v.tone}</button>`).join('')+`</div>`+
          `<div class="big"><button class="b p" onclick="start('minimal-pairs')">Next →</button></div>`;
      };
      $('#o').appendChild(b);
    });
  }
};

EX['same-diff'] = {
  name:'Same or Different?', mod:'listen', auto:true,
  blurb:'Two syllables back to back — same tone or different? Removes the naming step, so '+
        'it tests raw discrimination rather than whether you can label a tone. Usually the '+
        'right place to start if Minimal Pairs feels impossible.',
  tags:['tones','perception','auto-graded','entry level'],
  run(el){
    const same = Math.random()<0.5;
    const s1 = rnd(TONES); let s2 = rnd(TONES);
    const w1 = rnd(s1.words);
    let w2;
    if(same){ w2 = rnd(s2.words.filter(x=>x.tone===w1.tone)) || w1; }
    else { w2 = rnd(s2.words.filter(x=>x.tone!==w1.tone)); }
    S.item=null; S.t0=performance.now();
    el.innerHTML = `<div class="big"><button class="b p play" id="pl">▶</button>
      <span class="muted">two syllables — same tone?</span></div>
      <div class="big"><button class="b" id="y" style="min-width:8rem">Same</button>
      <button class="b" id="n" style="min-width:8rem">Different</button></div><div id="out"></div>`;
    const seq = async()=>{ playTone(toneClip(w1).f); await new Promise(r=>setTimeout(r,1100)); playTone(toneClip(w2).f); };
    seq(); $('#pl').onclick=seq;
    const ans = guess=>{
      const ok = guess===same;
      emit({exercise_type:'tone_same_diff', result:ok?'good':'again', latency_ms:elapsed(),
            payload:{t1:w1.tone, t2:w2.tone, same}});
      $('#out').innerHTML=`<p class="hint">${ok?'✓':'✗'} ${w1.trad} (tone ${w1.tone}) `+
        `then ${w2.trad} (tone ${w2.tone}) — <b>${same?'same':'different'}</b></p>`+
        `<div class="big"><button class="b p" onclick="start('same-diff')">Next →</button></div>`;
      $('#y').disabled=$('#n').disabled=true;
    };
    $('#y').onclick=()=>ans(true); $('#n').onclick=()=>ans(false);
  }
};

// ══ VARIETY & ENGAGEMENT ═══════════════════════════════════════════════════
EX['voice-roulette'] = {
  name:'Voice Roulette', mod:'listen', auto:false,
  blurb:'Same drill as Listen & Commit, but every single rep is a random voice at a random '+
        'speed, Taiwan or mainland. Guards against the failure mode where you understand '+
        'one speaker perfectly and freeze the moment anyone else opens their mouth.',
  tags:['listening','robustness','self-graded'],
  run(el){
    const it = nextItem(), c = rnd(it.clips);
    const speed = rnd([0.9,1.0,1.0,1.1]);
    el.innerHTML = `<div class="big"><button class="b p play" id="pl">▶</button>
      <span class="muted">? · ? — revealed after you commit</span></div>
      <div class="big"><button class="b ok" id="got">Got it</button>
      <button class="b no" id="miss">Missed it</button></div><div id="out"></div>`;
    play(c.f,speed); S.t0=performance.now();
    $('#pl').onclick=()=>{S.replays++;play(c.f,speed);};
    const done = ok=>{
      emit({exercise_type:'voice_roulette', result:ok?'good':'again', latency_ms:elapsed(),
            replays:S.replays, committed_before_reveal:true,
            payload:{voice:c.v, variety:c.tw?'tw':'cn', playback_rate:speed}});
      $('#out').innerHTML=reveal(it)+
        `<p class="hint">Was: ${voiceLabel(c)} at ${speed}×</p>`+
        `<div class="big"><button class="b p" onclick="start('voice-roulette')">Next →</button></div>`;
      $('#got').disabled=$('#miss').disabled=true;
    };
    $('#got').onclick=()=>done(true); $('#miss').onclick=()=>done(false);
  }
};

EX['story'] = {
  name:'Story Mode', mod:'listen', auto:true,
  blurb:'Three sentences in a row, then a question about what you heard. Real listening is '+
        'continuous — single sentences let you recover between reps in a way conversation '+
        'never does. This is the bridge from drill to comprehension.',
  tags:['listening','continuous','auto-graded'],
  run(el){
    const seq = sample(DATA,3);
    const distractor = rnd(DATA.filter(x=>!seq.includes(x)));
    const opts = shuffle([...seq, distractor]);
    S.item=seq[0]; S.t0=performance.now();
    el.innerHTML = `<div class="big"><button class="b p" id="pl">▶ Play all three</button>
      <span class="muted" id="pos"></span></div>
      <p class="hint">Then: which one did you <b>not</b> hear?</p>
      <div class="opts" id="o"></div><div id="out"></div>`;
    const playAll = async()=>{
      for(let i=0;i<seq.length;i++){
        $('#pos').textContent = `${i+1}/3`;
        const a = play(clip(seq[i]).f);
        await new Promise(r=>{a.onended=r; setTimeout(r,5000);});
        await new Promise(r=>setTimeout(r,400));
      }
      $('#pos').textContent='done';
    };
    playAll(); $('#pl').onclick=playAll;
    opts.forEach(o=>{
      const b=document.createElement('button'); b.className='b opt';
      b.innerHTML=`<span style="font-size:1.15rem">${o.t}</span>
        <span class="muted" style="font-size:.85rem"> — ${o.g}</span>`;
      b.onclick=()=>{
        const ok = o===distractor;
        emit({exercise_type:'story', result:ok?'good':'again', latency_ms:elapsed(),
              payload:{sentences:seq.length}});
        [...$('#o').children].forEach((x,i)=>{x.disabled=true;
          if(opts[i]===distractor)x.classList.add('right'); else if(x===b)x.classList.add('wrong');});
        $('#out').innerHTML=`<p class="hint">You heard:</p>`+
          seq.map(x=>`<p class="hz sm">${x.t} <span class="muted" style="font-size:.85rem">${x.g}</span></p>`).join('')+
          `<div class="big"><button class="b p" onclick="start('story')">Next →</button></div>`;
      };
      $('#o').appendChild(b);
    });
  }
};

EX['speed-round'] = {
  name:'Speed Round', mod:'listen', auto:true,
  blurb:'Sixty seconds, as many as you can. The only exercise here with a score, and the '+
        'closest thing to a game. Worth including because on a bad day a timer will get you '+
        'to open the app when a review queue will not.',
  tags:['listening','auto-graded','game'],
  run(el){
    let score=0, n=0, running=false, t0=0;
    el.innerHTML = `<div class="row"><button class="b p" id="go">Start 60s</button>
      <span class="muted">score <b id="sc">0</b> · <b id="tl">60</b>s</span></div>
      <progress id="pg" value="60" max="60"></progress><div id="q" style="margin-top:1rem"></div>`;
    const round = ()=>{
      if(!running) return;
      const it = rnd(DATA), c = clip(it);
      const opts = shuffle([it, ...sample(DATA,3,it)]);
      play(c.f);
      $('#q').innerHTML = `<div class="opts" id="o"></div>`;
      opts.forEach(o=>{
        const b=document.createElement('button'); b.className='b opt'; b.textContent=o.g;
        b.onclick=()=>{
          n++; if(o===it){score++; $('#sc').textContent=score;}
          emit({exercise_type:'speed_round', result:o===it?'good':'again', utterance_id:'u'+it.i});
          round();
        };
        $('#o').appendChild(b);
      });
    };
    $('#go').onclick=()=>{
      running=true; score=0; n=0; t0=Date.now(); $('#go').disabled=true;
      round();
      const tick=setInterval(()=>{
        const left = Math.max(0, 60-Math.round((Date.now()-t0)/1000));
        $('#tl').textContent=left; $('#pg').value=left;
        if(left<=0){
          clearInterval(tick); running=false; $('#go').disabled=false;
          if(S.audio)S.audio.pause();
          $('#q').innerHTML=`<p class="hz">${score} / ${n}</p>
            <p class="hint">${n?Math.round(score/n*100):0}% accuracy · ${(n/60*60).toFixed(0)} attempts/min</p>
            <div class="big"><button class="b p" onclick="start('speed-round')">Again</button></div>`;
          emit({exercise_type:'speed_round_summary', result:null,
                payload:{score, attempts:n, seconds:60}});
        }
      },200);
    };
  }
};

// ══ READING ════════════════════════════════════════════════════════════════
EX['flash'] = {
  name:'Flash Recognition', mod:'read', auto:true,
  blurb:'A word appears for 400ms, then it is gone. Forces whole-word recognition instead '+
        'of character-by-character decoding — the difference between reading Chinese and '+
        'solving Chinese. Shorten the flash as you improve.',
  tags:['reading','automaticity','auto-graded'],
  run(el){
    const w = rnd(VOCABF.filter(v=>v.gloss_en));
    const opts = shuffle([w, ...sample(VOCABF.filter(v=>v.gloss_en),3,w)]);
    let ms = 400;
    el.innerHTML = `<div class="row"><span class="muted">flash</span>
      <span class="rate" id="r"></span></div>
      <div id="flashbox" style="min-height:5rem;display:grid;place-items:center"></div>
      <div class="opts" id="o" style="display:none"></div><div id="out"></div>`;
    [250,400,700,1200].forEach(v=>{
      const b=document.createElement('button'); b.className='b'; b.textContent=v+'ms';
      b.setAttribute('aria-current', v===400);
      b.onclick=()=>{ms=v;[...$('#r').children].forEach(x=>x.setAttribute('aria-current',x.textContent===v+'ms'));};
      $('#r').appendChild(b);
    });
    setTimeout(()=>{
      $('#flashbox').innerHTML=`<span class="hz">${w.headword_trad||w.headword}</span>`;
      S.t0=performance.now();
      setTimeout(()=>{ $('#flashbox').innerHTML='<span class="muted">…</span>'; $('#o').style.display='grid'; }, ms);
    }, 600);
    opts.forEach(o=>{
      const b=document.createElement('button'); b.className='b opt'; b.textContent=o.gloss_en;
      b.onclick=()=>{
        const ok=o===w;
        emit({modality:'read', exercise_type:'flash', result:ok?'good':'again',
              latency_ms:elapsed(), payload:{flash_ms:ms}});
        [...$('#o').children].forEach((x,i)=>{x.disabled=true;
          if(opts[i]===w)x.classList.add('right'); else if(x===b)x.classList.add('wrong');});
        $('#out').innerHTML=`<p class="hz">${w.headword_trad||w.headword}</p>
          <p class="alt">${w.headword}</p><p class="py">${w.pinyin} — ${w.gloss_en}</p>
          <div class="big"><button class="b p" onclick="start('flash')">Next →</button></div>`;
      };
      $('#o').appendChild(b);
    });
  }
};

EX['trad-simp'] = {
  name:'Traditional ↔ Simplified', mod:'read', auto:true,
  blurb:'Match five pairs. Two-thirds of characters are identical between the scripts and '+
        'most of the rest follow systematic radical swaps — this drill makes that pattern '+
        'visible instead of forcing you to memorise both sets independently.',
  tags:['reading','script mapping','auto-graded'],
  run(el){
    const pool = VOCABF.filter(v=>v.headword_trad && v.headword_trad!==v.headword);
    const picks = sample(pool,5);
    let sel=null, done=0;
    S.t0=performance.now();
    el.innerHTML = `<div class="row" style="align-items:flex-start;gap:2rem">
      <div style="flex:1"><p class="muted vlab">TRADITIONAL</p><div id="L"></div></div>
      <div style="flex:1"><p class="muted vlab">SIMPLIFIED</p><div id="R"></div></div></div>
      <div id="out"></div>`;
    const mk=(txt,key,side)=>{
      const b=document.createElement('button'); b.className='b'; b.style.cssText=
        'display:block;width:100%;margin-bottom:.4rem;font-size:1.3rem';
      b.textContent=txt; b.dataset.k=key;
      b.onclick=()=>{
        if(b.disabled) return;
        if(!sel){ sel=b; b.classList.add('right'); return; }
        if(sel===b){ sel=null; b.classList.remove('right'); return; }
        const ok = sel.dataset.k===b.dataset.k;
        emit({modality:'read', exercise_type:'trad_simp', result:ok?'good':'again'});
        if(ok){ sel.disabled=b.disabled=true; sel.style.opacity=b.style.opacity=.45;
          sel.classList.remove('right'); sel=null; done++;
          if(done===picks.length){
            $('#out').innerHTML=`<p class="hint">All ${picks.length} matched in ${(elapsed()/1000).toFixed(1)}s</p>
              <div class="big"><button class="b p" onclick="start('trad-simp')">Again</button></div>`;
          }
        } else {
          b.classList.add('wrong'); const s=sel; sel=null;
          setTimeout(()=>{b.classList.remove('wrong'); s.classList.remove('right');},450);
        }
      };
      return b;
    };
    shuffle([...picks]).forEach(p=>$('#L').appendChild(mk(p.headword_trad,p.headword,'L')));
    shuffle([...picks]).forEach(p=>$('#R').appendChild(mk(p.headword,p.headword,'R')));
  }
};

EX['build-sentence'] = {
  name:'Build the Sentence', mod:'read', auto:true,
  blurb:'Hear it, then reconstruct it by tapping characters in order from a shuffled bank. '+
        'Bridges listening to written form without requiring an IME, and it is the natural '+
        'precursor to typing if that ever becomes a priority.',
  tags:['listening','reading','auto-graded','word order'],
  run(el){
    let it, tries=0;
    do{ it=nextItem(); tries++; }while(it.w.length<3 && tries<30);
    const target = it.w;
    const bank = shuffle([...target, ...sample(VOCAB,2)]);
    let built=[];
    const c = clip(it);
    el.innerHTML=`<div class="big"><button class="b p play" id="pl">▶</button>
      <span class="muted">${voiceLabel(c)} · tap in the order you heard</span></div>
      <div id="line" style="min-height:3rem;font-size:1.6rem;border-bottom:1px solid var(--line);
        padding:.5rem 0;margin-bottom:1rem"></div>
      <div class="row" id="bank"></div>
      <div class="big"><button class="b" id="undo">← Undo</button>
        <button class="b p" id="ck">Check</button></div><div id="out"></div>`;
    play(c.f); S.t0=performance.now();
    $('#pl').onclick=()=>{S.replays++;play(c.f);};
    const draw=()=>{ $('#line').textContent = built.join('') || ''; };
    bank.forEach(tok=>{
      const b=document.createElement('button'); b.className='b';
      b.style.fontSize='1.25rem'; b.textContent=tok;
      b.onclick=()=>{ built.push(tok); b.disabled=true; b.style.opacity=.35; draw(); };
      $('#bank').appendChild(b);
    });
    $('#undo').onclick=()=>{ const t=built.pop(); if(!t)return;
      [...$('#bank').children].find(x=>x.textContent===t&&x.disabled).disabled=false;
      [...$('#bank').children].forEach(x=>{if(x.textContent===t&&!x.disabled)x.style.opacity=1;});
      draw(); };
    $('#ck').onclick=()=>{
      const ok = built.join('')===target.join('');
      emit({exercise_type:'build_sentence', result:ok?'good':'again', latency_ms:elapsed(),
            replays:S.replays});
      $('#out').innerHTML=`<p class="hint">${ok?'✓ correct':'✗ you built: '+built.join('')}</p>`+
        reveal(it)+`<div class="big"><button class="b p" onclick="start('build-sentence')">Next →</button></div>`;
    };
  }
};

// ══ SESSION SHAPES ═════════════════════════════════════════════════════════
// This is the "education system" layer — a single exercise is a drill, an
// interleaved sequence with a summary is a study session.
const SESSION_MIX = [
  ['listen-commit', 3], ['meaning-match', 2], ['dictation', 2], ['which-one', 2],
  ['cloze', 2], ['tone-id', 1], ['minimal-pairs', 1], ['voice-roulette', 2],
  ['speed', 1], ['story', 1], ['read-sprint', 1], ['grammar-sense', 1],
  ['first-exposure', 1],
];
EX['mixed'] = {
  name:'▶ Mixed Session', mod:'session', auto:false,
  blurb:'The actual product, not a drill. Interleaves exercise types by weight for a fixed '+
        'number of reps, then reports what happened. Interleaving beats blocking for '+
        'retention — doing 20 of one type feels more productive and works worse.',
  tags:['session','interleaved','the real loop'],
  run(el){
    el.innerHTML = `<p class="muted">Pick a length. Reps are drawn from a weighted mix of
      every exercise above.</p><div class="big" id="pick"></div>
      <p class="hint">Weighting favours listening, with tone work and reading sprinkled in.
      A real scheduler would also weight by which concepts are due.</p>`;
    [[6,'Quick — 6 reps'],[15,'Standard — 15 reps'],[30,'Long — 30 reps']].forEach(([n,label])=>{
      const b=document.createElement('button'); b.className='b p'; b.textContent=label;
      b.onclick=()=>runSession(n); $('#pick').appendChild(b);
    });
  }
};
function runSession(total){
  const pool=[]; SESSION_MIX.forEach(([id,w])=>{for(let i=0;i<w;i++)pool.push(id);});
  const plan = Array.from({length:total},()=>rnd(pool));
  let idx=0; const results=[]; const t0=Date.now();
  const logLen = S.log.length;
  const step=()=>{
    if(idx>=total) return finish();
    const id=plan[idx];
    MODE=id;
    const ex=EX[id];
    $('#ex').innerHTML=`<div class="exhdr">
      <h2>${ex.name} <span class="muted" style="font-size:.85rem">· rep ${idx+1} of ${total}</span></h2>
      <progress value="${idx}" max="${total}"></progress></div>
      <div class="stage" id="stage"></div>`;
    ex.run($('#stage'));
    // advance when the exercise emits its result, or when the user clicks Next
    const before=S.log.length;
    const watch=setInterval(()=>{
      if(S.log.length>before){
        clearInterval(watch);
        results.push({id, r:S.log[0].result, ms:S.log[0].latency_ms});
        idx++;
        setTimeout(step, 1400);
      }
    },200);
  };
  const finish=()=>{
    const secs=Math.round((Date.now()-t0)/1000);
    const good=results.filter(r=>r.r==='good').length;
    const lat=results.filter(r=>r.ms).map(r=>r.ms).sort((a,b)=>a-b);
    const med=lat.length?lat[Math.floor(lat.length/2)]:0;
    const byType={}; results.forEach(r=>{byType[r.id]=byType[r.id]||{n:0,ok:0};
      byType[r.id].n++; if(r.r==='good')byType[r.id].ok++;});
    $('#ex').innerHTML=`<div class="exhdr"><h2>Session complete</h2>
      <p>${total} reps · ${Math.floor(secs/60)}m ${secs%60}s · ${S.log.length-logLen} events logged</p></div>
      <div class="stage" style="justify-content:flex-start">
      <p class="hz">${good}/${total}</p>
      <p class="hint">median response ${(med/1000).toFixed(1)}s</p>
      <table style="width:100%;border-collapse:collapse;margin-top:1rem;font-size:.9rem">
      ${Object.entries(byType).map(([k,v])=>
        `<tr><td style="padding:.3rem 0">${EX[k].name}</td>
         <td class="muted" style="text-align:right">${v.ok}/${v.n}</td></tr>`).join('')}
      </table>
      <p class="hint" style="margin-top:1rem">A real session would end by showing which
      concepts moved, what FSRS scheduled next, and which words are trending weak.</p>
      <div class="big"><button class="b p" onclick="start('mixed')">Another</button>
      <button class="b" onclick="start('dashboard')">See progress view →</button></div></div>`;
  };
  step();
}

// ══ PROGRESS VIEW (mock) ═══════════════════════════════════════════════════
EX['dashboard'] = {
  name:'◧ Progress', mod:'session', auto:false,
  blurb:'A mock of the stats view, on synthetic six-month data. Ability over gamification: '+
        'no streaks, no points, no badges. The two numbers that matter are HSK coverage per '+
        'modality and whether median response latency is falling.',
  tags:['analytics','mock data','no gamification'],
  run(el){
    const bar=(label,pct,note)=>`
      <div style="margin-bottom:.7rem"><div class="row" style="justify-content:space-between">
      <span>${label}</span><span class="muted" style="font-size:.85rem">${note}</span></div>
      <div style="background:var(--line);border-radius:99px;height:9px;overflow:hidden">
      <div style="width:${pct}%;height:100%;background:var(--accent)"></div></div></div>`;
    // synthetic latency trend, 24 weeks, declining with noise
    const pts=Array.from({length:24},(_,i)=>3.4-i*0.075+Math.sin(i)*0.12);
    const w=320,h=60,mx=Math.max(...pts),mn=Math.min(...pts);
    const path=pts.map((v,i)=>`${i?'L':'M'}${i/(pts.length-1)*w},${h-(v-mn)/(mx-mn)*h}`).join(' ');
    el.innerHTML=`
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.5rem">
      <div><h3 style="font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">Ability</h3>
        <p class="hz" style="margin:.2rem 0">HSK 2.4</p>
        <p class="muted" style="font-size:.85rem;margin:0">listening · vocabulary coverage</p>
        <div style="margin-top:1rem">
        ${bar('Listening',88,'HSK 2.4')}${bar('Reading',61,'HSK 1.7')}${bar('Speaking',40,'HSK 1.1')}
        </div></div>
      <div><h3 style="font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">Comprehension speed</h3>
        <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:70px;margin-top:.6rem">
          <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2"/></svg>
        <p class="muted" style="font-size:.85rem">median 3.4s → 1.8s over 24 weeks.
        The single best longitudinal signal — and it is free from the event log.</p></div>
    </div>
    <hr style="border:none;border-top:1px solid var(--line);margin:1.5rem 0">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.5rem">
      <div><h3 style="font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">Weakest concepts</h3>
        <table style="width:100%;font-size:.92rem;border-collapse:collapse;margin-top:.5rem">
        ${[['睡覺','shuìjiào',3,7],['尿布','niàobù',2,6],['怎麼','zěnme',4,9],['白飯','báifàn',1,5],['安靜','ānjìng',2,7]]
          .map(([h,p,ok,n])=>`<tr><td style="padding:.25rem 0;font-size:1.1rem">${h}</td>
          <td class="muted">${p}</td><td class="muted" style="text-align:right">${ok}/${n}</td></tr>`).join('')}
        </table></div>
      <div><h3 style="font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">This week</h3>
        <table style="width:100%;font-size:.92rem;border-collapse:collapse;margin-top:.5rem">
        ${[['Active study','2h 14m'],['Listening exposure','5h 02m'],['Reps','412'],
           ['New concepts','19'],['Due tomorrow','47'],['Family captures','6']]
          .map(([k,v])=>`<tr><td style="padding:.25rem 0">${k}</td>
          <td style="text-align:right"><b>${v}</b></td></tr>`).join('')}
        </table></div>
    </div>
    <p class="hint">All synthetic. The point is the shape: what would you actually want to
    look at once a week, and what would you never look at twice?</p>`;
  }
};

// ══ ACQUISITION & INPUT ════════════════════════════════════════════════════
EX['first-exposure'] = {
  name:'First Exposure', mod:'listen', auto:false,
  blurb:'Every other exercise assumes you already know the word. This is the one that '+
        'introduces it: meaning first, then the same word inside two different sentences, '+
        'then a check. Hearing a new word in one fixed frame is how you learn a phrase '+
        'instead of a word.',
  tags:['acquisition','introduction','listening'],
  run(el){
    const withWord = w => DATA.filter(d=>d.w.includes(w));
    let w, ex;
    for(let i=0;i<40;i++){ w = rnd(VOCABF); ex = withWord(w.headword); if(ex.length>=2) break; }
    if(!ex || ex.length<2){ el.innerHTML='<p class="muted">No word with two example sentences.</p>'; return; }
    const two = sample(ex,2);
    let step=0;
    S.item=two[0]; S.t0=performance.now();
    const render=()=>{
      if(step===0){
        el.innerHTML=`<p class="hz">${w.headword_trad||w.headword}</p>
          ${w.headword_trad!==w.headword?`<p class="alt">${w.headword}</p>`:''}
          <p class="py">${w.pinyin}</p><p class="en" style="font-size:1.2rem">${w.gloss_en}</p>
          <div class="big"><button class="b p" id="n">Hear it in context →</button></div>`;
        $('#n').onclick=()=>{step=1;render();};
      } else if(step<=2){
        const it=two[step-1], c=clip(it,{tw:1});
        el.innerHTML=`<p class="muted vlab">EXAMPLE ${step} OF 2 · ${w.headword_trad||w.headword}</p>
          <p class="hz sm">${it.t}</p><p class="py">${it.p}</p><p class="en">${it.g}</p>
          <div class="big"><button class="b" id="pl">▶ Replay</button>
          <button class="b p" id="n">${step===2?'Check yourself →':'Next example →'}</button></div>`;
        play(c.f);
        $('#pl').onclick=()=>play(c.f);
        $('#n').onclick=()=>{step++;render();};
      } else {
        const opts=shuffle([w, ...sample(VOCABF.filter(v=>v.gloss_en),3,w)]);
        el.innerHTML=`<p class="hz">${w.headword_trad||w.headword}</p>
          <p class="hint">Without scrolling back — what does it mean?</p>
          <div class="opts" id="o"></div><div id="out"></div>`;
        opts.forEach(o=>{
          const b=document.createElement('button'); b.className='b opt'; b.textContent=o.gloss_en;
          b.onclick=()=>{
            const ok=o===w;
            emit({kind:'review', exercise_type:'first_exposure', result:ok?'good':'again',
                  latency_ms:elapsed(), payload:{concept:w.headword, examples:2}});
            [...$('#o').children].forEach((x,i)=>{x.disabled=true;
              if(opts[i]===w)x.classList.add('right'); else if(x===b)x.classList.add('wrong');});
            $('#out').innerHTML=`<p class="py">${w.pinyin} — ${w.gloss_en}</p>
              <p class="hint">A real introduction would now create the (concept, listen) card
              and schedule its first review for ~10 minutes out.</p>
              <div class="big"><button class="b p" onclick="start('first-exposure')">New word →</button></div>`;
          };
          $('#o').appendChild(b);
        });
      }
    };
    render();
  }
};

EX['capture'] = {
  name:'Add Mandarin', mod:'input', auto:true,
  blurb:'The family-input surface. Paste or type anything Jasmine or Nainai says, and it '+
        'gets segmented against what you already know — known words in green, new ones '+
        'flagged for the personal curriculum. This is how the emergent curriculum actually '+
        'gets fed, and it has to be near-zero friction or it never gets used.',
  tags:['capture','emergent curriculum','auto-segmented'],
  run(el){
    el.innerHTML=`<p class="muted">Type or paste a Mandarin sentence. Try
      <code>宝宝该睡觉了</code> or <code>你吃饭了没有</code>.</p>
      <input class="t" id="in" placeholder="宝宝该睡觉了" style="font-size:1.3rem">
      <div class="big"><button class="b p" id="go">Analyse</button>
        <button class="b" id="ex1">Try an example</button></div>
      <div id="out"></div>`;
    const analyse=()=>{
      const text=$('#in').value.trim();
      if(!text) return;
      // Greedy longest-match against known vocabulary — same algorithm as the
      // pipeline verifier (design.md §2.11).
      const toks=[]; let i=0;
      while(i<text.length){
        if(/[，。！？、：；""''…—《》（）\s]/.test(text[i])){ i++; continue; }
        let hit=null;
        for(let n=Math.min(4,text.length-i); n>0; n--){
          if(VOCAB.includes(text.slice(i,i+n))){ hit=text.slice(i,i+n); break; }
        }
        if(hit){ toks.push({t:hit, known:true}); i+=hit.length; }
        else { toks.push({t:text[i], known:false}); i++; }
      }
      const unknown=[...new Set(toks.filter(t=>!t.known).map(t=>t.t))];
      const known=[...new Set(toks.filter(t=>t.known).map(t=>t.t))];
      const pct=Math.round(known.length/(known.length+unknown.length)*100)||0;
      emit({kind:'capture', modality:null, exercise_type:'capture', result:null,
            payload:{chars:text.length, known:known.length, new:unknown.length}});
      $('#out').innerHTML=`
        <p style="font-size:1.7rem;line-height:2;margin:1rem 0">${toks.map(t=>
          `<span class="syl ${t.known?'ok':'bad'}" style="font-size:1.5rem">${t.t}</span>`).join('')}</p>
        <p class="hint"><b>${pct}% known</b> · ${known.length} familiar, ${unknown.length} new</p>
        ${unknown.length?`
          <div class="card" style="margin-top:1rem;padding:1rem">
          <p class="muted vlab">WOULD ENTER THE PERSONAL CURRICULUM</p>
          ${unknown.map(u=>`<p style="margin:.3rem 0"><span style="font-size:1.3rem">${u}</span>
            <span class="muted" style="font-size:.85rem"> — needs pinyin + gloss, then a
            (concept, listen) card at source=<code>emergent</code></span></p>`).join('')}
          <div class="big"><button class="b p" onclick="alert('Prototype — this would write to the capture table, then the pipeline would resolve pinyin/gloss and generate example sentences containing only this word plus vocabulary you already have.')">Add ${unknown.length} concept(s)</button></div>
          </div>`:'<p class="hint">Nothing new — you already know every word in this sentence.</p>'}
        <p class="hint">Related sentences already in the corpus:
          ${DATA.filter(d=>known.some(k=>d.w.includes(k))).slice(0,3)
            .map(d=>`<span class="syl">${d.t}</span>`).join('') || 'none'}</p>`;
    };
    $('#go').onclick=analyse;
    $('#in').onkeydown=e=>{if(e.key==='Enter')analyse();};
    $('#ex1').onclick=()=>{
      $('#in').value=rnd(['宝宝该睡觉了','你吃饭了没有','我帮你换尿布','奶奶今天不舒服','这个太贵了']);
      analyse();
    };
  }
};

EX['grammar-sense'] = {
  name:'Grammar Sense', mod:'read', auto:true,
  blurb:'Two versions of a sentence — one correct, one containing a real error English '+
        'speakers make. Mandarin grammar is mostly word order, which vocabulary drilling '+
        'never touches. Each pair is hand-authored around a specific rule and shows the '+
        'rule after you answer, so it teaches rather than merely tests.',
  tags:['grammar','word order','auto-graded','authored'],
  run(el){
    const p = rnd(GRAMMAR);
    const opts = shuffle([{t:p.right, ok:true},{t:p.wrong, ok:false}]);
    S.item=null; S.t0=performance.now();
    el.innerHTML=`<p class="hint">One of these is wrong. Which is correct Mandarin?</p>
      <p class="en muted">“${p.gloss}”</p>
      <div class="opts" id="o"></div><div id="out"></div>`;
    opts.forEach(o=>{
      const b=document.createElement('button'); b.className='b opt';
      b.innerHTML=`<span style="font-size:1.35rem">${o.t}</span>`;
      b.onclick=()=>{
        emit({modality:'read', exercise_type:'grammar_sense',
              result:o.ok?'good':'again', latency_ms:elapsed(),
              payload:{rule:p.rule.slice(0,40)}});
        [...$('#o').children].forEach((x,i)=>{x.disabled=true;
          if(opts[i].ok)x.classList.add('right'); else x.classList.add('wrong');});
        $('#out').innerHTML=
          `<div class="card" style="padding:.9rem 1.1rem;margin-top:.6rem">
             <p class="muted vlab">THE RULE</p><p style="margin:.3rem 0 0">${p.rule}</p></div>
           <div class="big"><button class="b p" onclick="start('grammar-sense')">Next →</button></div>`;
      };
      $('#o').appendChild(b);
    });
  }
};

// ── shell ──
const GROUPS = [
  ['Listening', ['listen-commit','meaning-match','dictation','which-one','cloze','speed','voice-roulette','story']],
  ['Tones',     ['tone-id','minimal-pairs','same-diff']],
  ['Speaking',  ['say-it','shadow']],
  ['Reading',   ['read-sprint','flash','trad-simp','build-sentence','grammar-sense']],
  ['Acquire',   ['first-exposure','capture']],
  ['Sessions',  ['mixed','speed-round','immersion','dashboard']],
];
let MODE = 'listen-commit';

// ── verdicts: capture the reaction while it's fresh, not from memory afterwards ──
const RKEY='lab-verdicts';
const R = JSON.parse(localStorage.getItem(RKEY) || '{}');
function saveR(){ localStorage.setItem(RKEY, JSON.stringify(R)); renderSummary(); }
function verdictBar(id){
  const v = R[id] || {};
  const btn=(k,label)=>`<button class="vb ${v.verdict===k?'on '+k:''}" data-v="${k}">${label}</button>`;
  return `<div class="verdict">
    <span class="glab">worth building?</span>
    ${btn('keep','Keep')}${btn('maybe','Maybe')}${btn('cut','Cut')}
    <input class="vnote" placeholder="why — one line" value="${(v.note||'').replace(/"/g,'&quot;')}">
  </div>`;
}
function wireVerdict(id){
  const bar=$('.verdict'); if(!bar) return;
  bar.querySelectorAll('.vb').forEach(b=>{
    b.onclick=()=>{
      R[id]=R[id]||{}; R[id].verdict = R[id].verdict===b.dataset.v ? null : b.dataset.v;
      R[id].name=EX[id].name; saveR();
      bar.querySelectorAll('.vb').forEach(x=>{
        x.className='vb'+(R[id].verdict===x.dataset.v?' on '+x.dataset.v:'');
      });
    };
  });
  const n=bar.querySelector('.vnote');
  n.oninput=()=>{ R[id]=R[id]||{}; R[id].note=n.value; R[id].name=EX[id].name; saveR(); };
}
function renderSummary(){
  const box=$('#verdicts'); if(!box) return;
  const all=Object.keys(EX).length;
  const c={keep:0,maybe:0,cut:0};
  Object.values(R).forEach(v=>{ if(v.verdict) c[v.verdict]++; });
  const done=c.keep+c.maybe+c.cut;
  box.innerHTML=`<div class="row" style="gap:.5rem;font-size:.8rem">
      <span style="color:var(--ok)">${c.keep} keep</span>
      <span class="muted">${c.maybe} maybe</span>
      <span style="color:var(--no)">${c.cut} cut</span>
      <span class="muted">· ${done}/${all} judged</span></div>
    <div class="big" style="margin:.6rem 0 0"><button class="b" id="expv"
      style="font-size:.78rem;padding:.3rem .6rem">Export verdicts</button></div>`;
  $('#expv').onclick=()=>{
    const rows=Object.entries(EX).map(([id,ex])=>({
      id, name:ex.name, modality:ex.mod, auto_graded:!!ex.auto,
      verdict:(R[id]||{}).verdict||null, note:(R[id]||{}).note||''
    }));
    const blob=new Blob([JSON.stringify(rows,null,2)],{type:'application/json'});
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob); a.download='lab-verdicts.json'; a.click();
  };
}

function start(id){
  MODE = id;
  const ex = EX[id];
  document.querySelectorAll('nav button').forEach(b=>b.setAttribute('aria-current', b.dataset.id===id));
  $('#ex').innerHTML = `<div class="exhdr"><h2>${ex.name}</h2><p>${ex.blurb}</p>
    <div class="tags">${ex.tags.map(t=>`<span class="tag ${ex.auto?'auto':'self'}">${t}</span>`).join('')}</div>
    ${verdictBar(id)}</div><div class="stage" id="stage"></div>`;
  wireVerdict(id);
  ex.run($('#stage'));
}
window.start = start; window.play = play; window.playTone = playTone;
addEventListener('DOMContentLoaded', ()=>{
  const nav = $('nav');
  GROUPS.forEach(([label,ids])=>{
    const g=document.createElement('span'); g.className='grp';
    g.innerHTML=`<span class="glab">${label}</span>`;
    ids.forEach(id=>{
      if(!EX[id]) return;
      const b=document.createElement('button'); b.textContent=EX[id].name; b.dataset.id=id;
      b.onclick=()=>start(id); g.appendChild(b);
    });
    nav.appendChild(g);
  });
  renderSummary();
  start('listen-commit');
});
"""


def main() -> int:
    if not DAY0.exists():
        print("out/day0 missing — run day0_validate.py first.")
        return 1

    vocab = json.loads(VOCAB.read_text(encoding="utf-8"))
    allowed = {e["headword"] for e in vocab["core"] + vocab["personal"]}

    raw = json.loads(SENTENCES.read_text(encoding="utf-8"))["sentences"]
    rows = [r for r in raw if "hanzi" in r]

    manifest = json.loads((DAY0 / "sentences.json").read_text(encoding="utf-8"))
    by_hanzi = {it["hanzi"]: it for it in manifest["approved"]}

    tone_manifest = ROOT / "out" / "tones" / "manifest.json"
    if tone_manifest.exists():
        tones = json.loads(tone_manifest.read_text(encoding="utf-8"))["sets"]
    else:
        tones = []
        print("WARNING: out/tones missing — run build_tones.py; tone drills will be empty.")

    gp = ROOT / "data" / "grammar_pairs.json"
    grammar = json.loads(gp.read_text(encoding="utf-8"))["pairs"] if gp.exists() else []

    data, missing = [], 0
    for i, r in enumerate(rows):
        entry = by_hanzi.get(r["hanzi"])
        if not entry or not entry["clips"]:
            missing += 1
            continue
        data.append({
            "i": i,
            "s": r["hanzi"],
            "t": r.get("hanzi_trad") or r["hanzi"],
            "p": r["pinyin"],
            "g": r["gloss_en"],
            "n": syllables(r["hanzi"]),
            "w": cover(r["hanzi"], allowed),
            "clips": [
                {
                    "f": c["file"],
                    "v": c["voice"].split("-")[-1].replace("Neural", ""),
                    "tw": 1 if c["voice"].startswith("zh-TW") else 0,
                    "r": 0 if c["rate"] == "+0%" else 1,
                }
                for c in entry["clips"]
            ],
        })

    OUT.mkdir(parents=True, exist_ok=True)
    page = (
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
        "<title>Mandarin Teacher — Exercise Lab</title><style>" + CSS + "</style></head><body>"
        "<div class=\"wrap\"><div><h1>Exercise Lab</h1>"
        "<p class=\"sub\">Ten candidate drill types, all running on the real corpus and real "
        "audio. Play each one and judge it. Nothing here is committed to — the point is to "
        "find out which of these you would actually do every day.</p>"
        "<nav></nav><div class=\"card\" id=\"ex\"></div></div>"
        "<div class=\"log\"><h3>Event stream</h3>"
        "<p>Every interaction emits a row in the shape of the real <code>event</code> table. "
        "This is what the learner model would be built from.</p><div id=\"events\"></div></div>"
        "<h3 style=\"margin-top:1.2rem\">Your verdicts</h3>"
        "<p>Judge each exercise as you play it. Saved in this browser; export when done.</p>"
        "<div id=\"verdicts\"></div>"
        "</div><script>const DATA=" + json.dumps(data, ensure_ascii=False)
        + ";const VOCAB=" + json.dumps(sorted(allowed), ensure_ascii=False)
        + ";const VOCABF=" + json.dumps(vocab["core"] + vocab["personal"], ensure_ascii=False)
        + ";const TONES=" + json.dumps(tones, ensure_ascii=False)
        + ";const GRAMMAR=" + json.dumps(grammar, ensure_ascii=False) + ";"
        + JS + JS2 + "</script></body></html>"
    )
    path = OUT / "index.html"
    path.write_text(page, encoding="utf-8")

    print(f"{len(data)} sentences wired ({missing} skipped for missing audio)")
    print(f"{sum(len(d['clips']) for d in data)} clips referenced")
    print(f"{len([1 for d in data if len(d['w'])>=3])} sentences long enough for cloze")
    print(f"\nWrote {path}  ({path.stat().st_size/1024:.0f} KB)")
    print("\nOpen directly for 8 of 10 exercises:")
    print(f"  start {path}")
    print("For the two microphone exercises:")
    print("  cd pipeline/out && python -m http.server 8000   → http://localhost:8000/lab/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
