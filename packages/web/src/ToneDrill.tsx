import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ToneSet, type ToneWord } from './api.ts';

/**
 * Tone perception. Two drills, and which one you should be doing depends on data
 * rather than preference.
 *
 *   Tone ID          — hear one syllable, name the tone. Requires you to both
 *                      perceive the contour and attach a label to it.
 *   Same or Different — hear two, say whether the tones match. No naming step, so
 *                      it isolates raw discrimination.
 *
 * Same/Different is the entry ramp. If Tone ID is sitting at chance, naming is not
 * the bottleneck and drilling it harder will not help.
 */

const MARKS = ['ā', 'á', 'ǎ', 'à'];
type Mode = 'id' | 'samediff';

interface Props {
  sessionId: number | null;
}

interface Stats {
  correct: number;
  total: number;
  perTone: { tone: number; ok: number; n: number }[];
  sameDiff: { correct: number; total: number };
}

export function ToneDrill({ sessionId }: Props) {
  const [mode, setMode] = useState<Mode>(
    () => (localStorage.getItem('tone-mode') as Mode) ?? 'samediff',
  );
  const [sets, setSets] = useState<ToneSet[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

  // Tone ID state
  const [item, setItem] = useState<{ set: ToneSet; word: ToneWord; src: string } | null>(null);
  const [answered, setAnswered] = useState<number | null>(null);

  // Same/Different state
  const [pair, setPair] = useState<{ a: ToneWord; b: ToneWord; same: boolean; srcA: string; srcB: string } | null>(null);
  const [guess, setGuess] = useState<boolean | null>(null);

  const started = useRef(0);

  const refreshStats = useCallback(() => {
    void api
      .toneStats()
      .then((s) => setStats(s as unknown as Stats))
      .catch(() => {});
  }, []);

  useEffect(() => {
    audio.current = new Audio();
    void api.tones().then((r) => setSets(r.sets));
    refreshStats();
    return () => audio.current?.pause();
  }, [refreshStats]);

  const playSrc = useCallback((src: string) => {
    if (!audio.current) return;
    audio.current.src = src;
    audio.current.currentTime = 0;
    void audio.current.play().catch(() => {});
  }, []);

  const clipOf = (w: ToneWord) => `/tones/${w.clips[Math.floor(Math.random() * w.clips.length)]!.f}`;

  // ── next item ─────────────────────────────────────────────────────────────
  const nextId = useCallback(() => {
    if (!sets?.length) return;
    const set = sets[Math.floor(Math.random() * sets.length)]!;
    const word = set.words[Math.floor(Math.random() * set.words.length)]!;
    const src = clipOf(word);
    setItem({ set, word, src });
    setAnswered(null);
    started.current = performance.now();
    setTimeout(() => playSrc(src), 0);
  }, [sets, playSrc]);

  const nextPair = useCallback(() => {
    if (!sets?.length) return;
    const same = Math.random() < 0.5;
    const setA = sets[Math.floor(Math.random() * sets.length)]!;
    const a = setA.words[Math.floor(Math.random() * setA.words.length)]!;
    const setB = sets[Math.floor(Math.random() * sets.length)]!;
    const candidates = setB.words.filter((w) => (same ? w.tone === a.tone : w.tone !== a.tone));
    const b = candidates[Math.floor(Math.random() * candidates.length)] ?? a;
    const srcA = clipOf(a);
    const srcB = clipOf(b);
    setPair({ a, b, same: a.tone === b.tone, srcA, srcB });
    setGuess(null);
    started.current = performance.now();
    setTimeout(() => {
      playSrc(srcA);
      setTimeout(() => playSrc(srcB), 1100);
    }, 0);
  }, [sets, playSrc]);

  const replay = useCallback(() => {
    if (mode === 'id' && item) playSrc(item.src);
    if (mode === 'samediff' && pair) {
      playSrc(pair.srcA);
      setTimeout(() => playSrc(pair.srcB), 1100);
    }
  }, [mode, item, pair, playSrc]);

  const next = useCallback(() => (mode === 'id' ? nextId() : nextPair()), [mode, nextId, nextPair]);

  useEffect(() => {
    if (!sets?.length) return;
    next();
    // Restart the drill when the mode changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sets, mode]);

  // ── answering ─────────────────────────────────────────────────────────────
  const answerId = useCallback(
    async (tone: number) => {
      if (!item || answered !== null) return;
      setAnswered(tone);
      try {
        await api.toneAnswer({
          sessionId,
          syllable: item.set.syllable,
          tone: item.word.tone,
          answered: tone,
          latencyMs: Math.round(performance.now() - started.current),
        });
        refreshStats();
      } catch {
        /* a dropped tone rep is not worth interrupting the drill for */
      }
    },
    [item, answered, sessionId, refreshStats],
  );

  const answerPair = useCallback(
    async (said: boolean) => {
      if (!pair || guess !== null) return;
      setGuess(said);
      try {
        await api.toneAnswer({
          sessionId,
          syllable: `${pair.a.hanzi}${pair.a.tone}/${pair.b.hanzi}${pair.b.tone}`,
          tone: pair.same ? 1 : 0,
          answered: said ? 1 : 0,
          latencyMs: Math.round(performance.now() - started.current),
          exerciseType: 'tone_same_diff',
          detail: { toneA: pair.a.tone, toneB: pair.b.tone },
        });
        refreshStats();
      } catch {
        /* ignore */
      }
    },
    [pair, guess, sessionId, refreshStats],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === ' ') {
        e.preventDefault();
        replay();
        return;
      }
      if (mode === 'id') {
        if (['1', '2', '3', '4'].includes(e.key)) void answerId(Number(e.key));
        if (e.key === 'Enter' && answered !== null) next();
      } else {
        if (e.key === '1') void answerPair(true);
        if (e.key === '2') void answerPair(false);
        if (e.key === 'Enter' && guess !== null) next();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, replay, answerId, answerPair, answered, guess, next]);

  if (!sets) return <p className="text-stone-500">Loading…</p>;
  if (!sets.length) {
    return (
      <p className="text-stone-500">
        No tone drills yet. Run <code>python pipeline/build_tones.py</code>.
      </p>
    );
  }

  const pct = (c: number, t: number) => (t ? Math.round((c / t) * 100) : null);

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1">
          {(
            [
              ['samediff', 'Same or Different'],
              ['id', 'Tone ID'],
            ] as [Mode, string][]
          ).map(([m, label]) => (
            <button
              key={m}
              className="tab"
              aria-current={mode === m}
              onClick={() => {
                setMode(m);
                localStorage.setItem('tone-mode', m);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {stats && (
          <p className="text-sm text-stone-500">
            {mode === 'id'
              ? `${stats.correct}/${stats.total}${stats.total >= 8 ? ` · ${pct(stats.correct, stats.total)}%` : ''}`
              : `${stats.sameDiff.correct}/${stats.sameDiff.total}${stats.sameDiff.total >= 8 ? ` · ${pct(stats.sameDiff.correct, stats.sameDiff.total)}%` : ''}`}
          </p>
        )}
      </div>

      <div className="flex flex-col items-center py-6">
        <button
          className="grid h-24 w-24 place-items-center rounded-full border-2 border-amber-700/70 text-3xl text-amber-800 transition hover:bg-amber-700/10 dark:border-amber-500/60 dark:text-amber-400"
          onClick={replay}
          aria-label="Replay"
        >
          ▶
        </button>
      </div>

      {mode === 'id' && item && (
        <>
          <p className="mb-4 text-center text-sm text-stone-500">
            syllable “{item.set.syllable}” — which tone?
          </p>
          <div className="flex justify-center gap-2">
            {[1, 2, 3, 4].map((t) => {
              const state =
                answered === null ? '' : t === item.word.tone ? 'right' : t === answered ? 'wrong' : '';
              return (
                <button
                  key={t}
                  className={`tone-btn ${state}`}
                  onClick={() => void answerId(t)}
                  disabled={answered !== null}
                >
                  <span className="text-3xl leading-none">{MARKS[t - 1]}</span>
                  <span className="mt-1 text-[0.65rem] text-stone-500">tone {t}</span>
                </button>
              );
            })}
          </div>
          {answered !== null && (
            <div className="mt-8 text-center">
              <p className={answered === item.word.tone ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'}>
                {answered === item.word.tone ? '✓' : '✗'} {item.set.syllable}
                {item.word.tone} — {item.word.trad} ({item.word.gloss})
              </p>
              <div className="mt-4 flex justify-center gap-2">
                {item.set.words.map((w) => (
                  <button key={w.tone} className="btn text-sm" onClick={() => playSrc(clipOf(w))}>
                    {w.trad} {w.tone}
                  </button>
                ))}
              </div>
              <button className="btn btn-primary mt-6" onClick={next}>
                Next →
              </button>
            </div>
          )}
          <p className="hint mt-8 text-center">
            <kbd>Space</kbd> replay · <kbd>1</kbd>–<kbd>4</kbd> tone · <kbd>Enter</kbd> next
          </p>
        </>
      )}

      {mode === 'samediff' && pair && (
        <>
          <p className="mb-4 text-center text-sm text-stone-500">
            two syllables — same tone, or different?
          </p>
          <div className="flex justify-center gap-3">
            <button
              className={`btn px-8 ${guess === null ? '' : pair.same ? 'btn-got' : guess === true ? 'btn-miss' : ''}`}
              onClick={() => void answerPair(true)}
              disabled={guess !== null}
            >
              Same
            </button>
            <button
              className={`btn px-8 ${guess === null ? '' : !pair.same ? 'btn-got' : guess === false ? 'btn-miss' : ''}`}
              onClick={() => void answerPair(false)}
              disabled={guess !== null}
            >
              Different
            </button>
          </div>
          {guess !== null && (
            <div className="mt-8 text-center">
              <p className={guess === pair.same ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'}>
                {guess === pair.same ? '✓' : '✗'} {pair.a.trad} (tone {pair.a.tone}) then {pair.b.trad} (tone{' '}
                {pair.b.tone}) — <b>{pair.same ? 'same' : 'different'}</b>
              </p>
              <button className="btn btn-primary mt-6" onClick={next}>
                Next →
              </button>
            </div>
          )}
          <p className="hint mt-8 text-center">
            <kbd>Space</kbd> replay · <kbd>1</kbd> same · <kbd>2</kbd> different · <kbd>Enter</kbd> next
          </p>
        </>
      )}

      {stats && stats.total >= 10 && (
        <div className="mt-10 border-t border-stone-200 pt-4 dark:border-stone-800">
          <p className="label">Tone ID accuracy so far</p>
          <div className="mt-2 flex gap-4 text-sm">
            {[1, 2, 3, 4].map((t) => {
              const row = stats.perTone.find((r) => r.tone === t);
              const p = row && row.n ? Math.round((row.ok / row.n) * 100) : null;
              return (
                <span key={t} className={p !== null && p < 30 ? 'text-rose-700 dark:text-rose-400' : ''}>
                  {MARKS[t - 1]} {p === null ? '—' : `${p}%`}
                  <span className="text-stone-400"> ({row?.ok ?? 0}/{row?.n ?? 0})</span>
                </span>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-stone-500">
            25% is chance on a four-way choice. Anything near that means naming is not the
            bottleneck — work Same or Different until discrimination is solid.
          </p>
        </div>
      )}
    </div>
  );
}
