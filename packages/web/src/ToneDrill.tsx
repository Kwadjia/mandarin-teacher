import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ToneSet, type ToneWord } from './api.ts';

/**
 * Tone ID — one syllable, no context, which tone was it?
 *
 * Inside a sentence, context lets you infer a word without ever hearing its tone.
 * This removes that crutch, which makes it the only honest measurement of tone
 * perception in the app.
 */

const MARKS = ['ā', 'á', 'ǎ', 'à'];

interface Props {
  sessionId: number | null;
}

export function ToneDrill({ sessionId }: Props) {
  const [sets, setSets] = useState<ToneSet[] | null>(null);
  const [set, setSet] = useState<ToneSet | null>(null);
  const [word, setWord] = useState<ToneWord | null>(null);
  const [answered, setAnswered] = useState<number | null>(null);
  const [score, setScore] = useState({ correct: 0, total: 0 });
  const audio = useRef<HTMLAudioElement | null>(null);
  const started = useRef<number>(0);
  const src = useRef<string>('');

  useEffect(() => {
    audio.current = new Audio();
    void api.tones().then((r) => {
      setSets(r.sets);
    });
    void api.toneStats().then((s) => setScore({ correct: s.correct, total: s.total }));
    return () => audio.current?.pause();
  }, []);

  const play = useCallback(() => {
    if (!audio.current || !src.current) return;
    audio.current.src = src.current;
    audio.current.currentTime = 0;
    void audio.current.play().catch(() => {});
  }, []);

  const nextItem = useCallback(() => {
    if (!sets?.length) return;
    const s = sets[Math.floor(Math.random() * sets.length)]!;
    const w = s.words[Math.floor(Math.random() * s.words.length)]!;
    const clip = w.clips[Math.floor(Math.random() * w.clips.length)]!;
    src.current = `/tones/${clip.f}`;
    setSet(s);
    setWord(w);
    setAnswered(null);
    started.current = performance.now();
    // Let state settle before playing so the src ref is current.
    setTimeout(play, 0);
  }, [sets, play]);

  useEffect(() => {
    if (sets?.length && !word) nextItem();
  }, [sets, word, nextItem]);

  const answer = useCallback(
    async (tone: number) => {
      if (!set || !word || answered !== null) return;
      setAnswered(tone);
      setScore((s) => ({ correct: s.correct + (tone === word.tone ? 1 : 0), total: s.total + 1 }));
      try {
        await api.toneAnswer({
          sessionId,
          syllable: set.syllable,
          tone: word.tone,
          answered: tone,
          latencyMs: Math.round(performance.now() - started.current),
        });
      } catch {
        // A dropped tone rep is not worth interrupting the drill for.
      }
    },
    [set, word, answered, sessionId],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === ' ') {
        e.preventDefault();
        play();
      } else if (['1', '2', '3', '4'].includes(e.key)) {
        void answer(Number(e.key));
      } else if (e.key === 'Enter' && answered !== null) {
        nextItem();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [play, answer, answered, nextItem]);

  if (!sets) return <p className="text-stone-500">Loading…</p>;
  if (!sets.length) {
    return (
      <p className="text-stone-500">
        No tone drills yet. Run <code>python pipeline/build_tones.py</code>.
      </p>
    );
  }
  if (!set || !word) return <p className="text-stone-500">…</p>;

  const correct = answered !== null && answered === word.tone;

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <p className="label">
          syllable “{set.syllable}” — which tone?
        </p>
        <p className="text-sm text-stone-500">
          {score.correct}/{score.total}
          {score.total >= 5 && ` · ${Math.round((score.correct / score.total) * 100)}%`}
        </p>
      </div>

      <div className="flex flex-col items-center py-8">
        <button
          className="grid h-24 w-24 place-items-center rounded-full border-2 border-amber-700/70 text-3xl text-amber-800 transition hover:bg-amber-700/10 dark:border-amber-500/60 dark:text-amber-400"
          onClick={play}
          aria-label="Replay"
        >
          ▶
        </button>
      </div>

      <div className="flex justify-center gap-2">
        {[1, 2, 3, 4].map((t) => {
          const state =
            answered === null ? '' : t === word.tone ? 'right' : t === answered ? 'wrong' : '';
          return (
            <button
              key={t}
              className={`tone-btn ${state}`}
              onClick={() => void answer(t)}
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
          <p className={correct ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'}>
            {correct ? '✓' : '✗'} {set.syllable}
            {word.tone} — {word.trad} ({word.gloss})
          </p>
          <div className="mt-4 flex justify-center gap-2">
            {set.words.map((w) => (
              <button
                key={w.tone}
                className="btn text-sm"
                onClick={() => {
                  const c = w.clips[0];
                  if (!c || !audio.current) return;
                  audio.current.src = `/tones/${c.f}`;
                  void audio.current.play().catch(() => {});
                }}
              >
                {w.trad} {w.tone}
              </button>
            ))}
          </div>
          <button className="btn btn-primary mt-6" onClick={nextItem}>
            Next →
          </button>
        </div>
      )}

      <p className="hint mt-8 text-center">
        <kbd>Space</kbd> replay · <kbd>1</kbd>–<kbd>4</kbd> tone · <kbd>Enter</kbd> next
      </p>
    </div>
  );
}
