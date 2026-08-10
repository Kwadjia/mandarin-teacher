import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type DictationItem, type DictationResult } from './api.ts';
import { pickClip, useAudio, voiceLabel } from './useAudio.ts';

/**
 * Pinyin dictation: hear a sentence, type it back with tone numbers.
 *
 * The exercise the measurements have been asking for. Tone identification has sat at
 * 7/31 — chance for a four-way choice — since the first session, and nothing in the app
 * trained it: Listen & Commit lets "got it" cover the gist while the tones wash past,
 * and Shadow measures production rather than perception. `bao3 bao5 shui4 jiao4 le5`
 * cannot be typed without hearing every tone separately.
 *
 * No text is sent until the answer is submitted. That is not decoration — the reveal
 * gate (docs/design.md §2.9) only means anything if there is genuinely no path to the
 * answer, and for this exercise the hanzi *is* the answer.
 */

type Phase = 'typing' | 'checking' | 'result';

const VERDICT: Record<string, string> = {
  correct: 'text-emerald-700 dark:text-emerald-400',
  tone: 'text-amber-700 dark:text-amber-500',
  wrong: 'text-rose-700 dark:text-rose-400',
  missing: 'text-stone-400 dark:text-stone-600',
};

interface Props {
  sessionId: number | null;
  onAnswered?: () => void;
}

export function Dictation({ sessionId, onAnswered }: Props) {
  const [item, setItem] = useState<DictationItem | null>(null);
  const [answer, setAnswer] = useState('');
  const [phase, setPhase] = useState<Phase>('typing');
  const [result, setResult] = useState<DictationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reps, setReps] = useState(0);
  const clip = useRef(null as ReturnType<typeof pickClip>);
  const input = useRef<HTMLInputElement>(null);
  const audio = useAudio();

  const load = useCallback(async () => {
    setError(null);
    setResult(null);
    setAnswer('');
    setPhase('typing');
    audio.reset();
    try {
      const next = await api.dictation();
      setItem(next);
      if (next.type === 'item') {
        clip.current = pickClip(next.clips);
        if (clip.current) audio.play(clip.current.url);
        setTimeout(() => input.current?.focus(), 0);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [audio]);

  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    void loadRef.current();
  }, []);

  const replay = useCallback(() => {
    if (clip.current) audio.play(clip.current.url);
    input.current?.focus();
  }, [audio]);

  const submit = useCallback(async () => {
    if (!item || item.type !== 'item' || phase !== 'typing' || !answer.trim()) return;
    setPhase('checking');
    try {
      const res = await api.dictationAnswer({
        sessionId,
        utteranceId: item.utteranceId,
        answer,
        replays: audio.replays,
        latencyMs: audio.latencySince(),
      });
      setResult(res);
      setPhase('result');
      setReps((n) => n + 1);
      onAnswered?.();
    } catch (e) {
      setError((e as Error).message);
      setPhase('typing');
    }
  }, [item, phase, answer, sessionId, audio, onAnswered]);

  // ── keyboard ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Tab replays without leaving the field — the hands stay on the keyboard, which
      // is the whole ergonomic point of a typed exercise.
      if (e.key === 'Tab') {
        e.preventDefault();
        replay();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (phase === 'typing') void submit();
        else if (phase === 'result') void load();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, submit, load, replay]);

  if (error) {
    return (
      <div className="rounded-xl border border-rose-300/60 bg-rose-50/60 p-6 dark:bg-rose-950/30">
        <p className="font-medium text-rose-800 dark:text-rose-300">Something went wrong</p>
        <p className="mt-1 font-mono text-sm text-rose-700/80">{error}</p>
        <button className="btn mt-4" onClick={() => void load()}>
          Try again
        </button>
      </div>
    );
  }

  if (!item) return <p className="text-stone-500">Loading…</p>;

  if (item.type === 'idle') {
    return (
      <div className="py-16 text-center">
        <p className="text-2xl">Nothing to type yet.</p>
        <p className="mt-2 text-stone-500">{item.reason}</p>
        <button className="btn mt-6" onClick={() => void load()}>
          Check again
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <p className="label">Write what you hear</p>
        <p className="text-xs text-stone-500">
          {item.syllableCount} syllable{item.syllableCount === 1 ? '' : 's'}
          {reps > 0 && ` · ${reps} done`}
        </p>
      </div>

      <div className="mt-6 flex flex-col items-center">
        <button
          className="grid h-20 w-20 place-items-center rounded-full border-2 border-amber-700/70 text-3xl text-amber-800 transition hover:bg-amber-700/10 dark:border-amber-500/60 dark:text-amber-400"
          onClick={replay}
          aria-label="Replay"
        >
          ▶
        </button>
        <p className="mt-3 text-sm text-stone-500">
          {audio.replays === 0 ? 'listen' : `${audio.replays} replay${audio.replays > 1 ? 's' : ''}`}
        </p>
      </div>

      <div className="mt-8">
        <input
          ref={input}
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          disabled={phase !== 'typing'}
          placeholder="ni3 hao3"
          spellCheck={false}
          autoComplete="off"
          className="w-full rounded-lg border border-stone-300 bg-transparent px-4 py-3 text-2xl tracking-wide outline-none placeholder:text-stone-300 focus:border-amber-700 disabled:opacity-60 dark:border-stone-700 dark:placeholder:text-stone-700 dark:focus:border-amber-500"
        />
        <p className="hint mt-2">
          Tone numbers after each syllable · <kbd>Tab</kbd> replay · <kbd>Enter</kbd>{' '}
          {phase === 'result' ? 'next' : 'check'}
        </p>
      </div>

      {phase === 'typing' && (
        <div className="mt-6 flex items-center gap-3">
          <button className="btn btn-primary" disabled={!answer.trim()} onClick={() => void submit()}>
            Check
          </button>
          <span className="text-xs text-stone-400 dark:text-stone-600">
            Neutral tone is 5. Guess rather than skip — a wrong tone is worth more than a blank.
          </span>
        </div>
      )}

      {phase === 'result' && result && (
        <div className="mt-8 border-t border-stone-200 pt-6 dark:border-stone-800">
          <div className="flex items-baseline justify-between">
            <p className="label">
              {result.check.correctSyllables}/{result.check.totalSyllables} exact
              {result.check.toneErrors > 0 && (
                <> · {result.check.toneErrors} right sound, wrong tone</>
              )}
            </p>
            <p className="text-sm text-stone-500">
              graded <b className="text-stone-700 dark:text-stone-300">{result.grade}</b>
            </p>
          </div>

          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-3">
            {result.check.syllables.map((s, i) => (
              <div key={i} className={`text-center ${VERDICT[s.verdict]}`}>
                <p className="font-mono text-lg">{s.expected}</p>
                {s.verdict !== 'correct' && (
                  <p className="font-mono text-xs opacity-70">
                    {s.given ? `you: ${s.given}` : '—'}
                  </p>
                )}
              </div>
            ))}
          </div>

          <p className="hanzi mt-6">{result.hanziTrad}</p>
          <p className="pinyin">{result.pinyin}</p>
          <p className="mt-1 text-lg">{result.glossEn}</p>

          <div className="mt-6 flex items-center gap-3">
            <button className="btn" onClick={replay}>
              ▶ Again
            </button>
            <button className="btn btn-primary" onClick={() => void load()}>
              Next →
            </button>
            {clip.current && <span className="text-xs text-stone-500">{voiceLabel(clip.current)}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
