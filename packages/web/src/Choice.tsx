import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ChoiceItem, type ChoiceResult, type ChoiceKind } from './api.ts';
import { pickClip, useAudio, voiceLabel } from './useAudio.ts';

/**
 * Multiple-choice listening: Meaning Match, Which One, and Cloze.
 *
 * Listen & Commit asks whether you got it and believes the answer. There is no way to
 * be wrong, hindsight makes every revealed answer feel familiar, and the grade has to
 * be reconstructed from replay counts. These ask a question that has a wrong answer.
 *
 * The three differ only in what the options say, which is why they share a component:
 *
 *   Meaning Match  four English meanings — fastest, closest to "did you understand"
 *   Which One      four Chinese words — no translation to lean on
 *   Cloze          the sentence with the word blanked, four words to fill it
 */

const KINDS: { id: ChoiceKind; label: string; hint: string }[] = [
  { id: 'meaning-match', label: 'Meaning', hint: 'pick what it means' },
  { id: 'which-one', label: 'Which word', hint: 'pick what you heard' },
  { id: 'cloze', label: 'Fill the gap', hint: 'pick the missing word' },
];

interface Props {
  sessionId: number | null;
  onAnswered?: () => void;
}

export function Choice({ sessionId, onAnswered }: Props) {
  const [kind, setKind] = useState<ChoiceKind>('meaning-match');
  const [item, setItem] = useState<ChoiceItem | null>(null);
  const [result, setResult] = useState<ChoiceResult | null>(null);
  const [chosen, setChosen] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reps, setReps] = useState(0);
  const [score, setScore] = useState({ right: 0, total: 0 });
  const clip = useRef(null as ReturnType<typeof pickClip>);
  const audio = useAudio();

  const load = useCallback(async () => {
    setError(null);
    setResult(null);
    setChosen(null);
    audio.reset();
    try {
      const next = await api.choice(kind);
      setItem(next);
      if (next.type === 'item') {
        clip.current = pickClip(next.clips);
        if (clip.current) audio.play(clip.current.url);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [audio, kind]);

  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    void loadRef.current();
  }, [kind]);

  const replay = useCallback(() => {
    if (clip.current) audio.play(clip.current.url);
  }, [audio]);

  const answer = useCallback(
    async (conceptId: number) => {
      if (!item || item.type !== 'item' || result) return;
      setChosen(conceptId);
      try {
        const res = await api.choiceAnswer({
          sessionId,
          conceptId: item.conceptId,
          utteranceId: item.utteranceId,
          audioId: clip.current?.id ?? null,
          chosenConceptId: conceptId,
          kind: item.kind,
          replays: audio.replays,
          latencyMs: audio.latencySince(),
        });
        setResult(res);
        setReps((n) => n + 1);
        setScore((s) => ({ right: s.right + (res.correct ? 1 : 0), total: s.total + 1 }));
        onAnswered?.();
      } catch (e) {
        setError((e as Error).message);
        setChosen(null);
      }
    },
    [item, result, sessionId, audio, onAnswered],
  );

  // ── keyboard ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === ' ') {
        e.preventDefault();
        replay();
        return;
      }
      if (e.key === 'Enter' && result) {
        e.preventDefault();
        void load();
        return;
      }
      // 1–4 pick an option without reaching for the mouse.
      if (!result && item?.type === 'item' && /^[1-4]$/.test(e.key)) {
        const opt = item.options[Number(e.key) - 1];
        if (opt) void answer(opt.conceptId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [item, result, answer, load, replay]);

  const picker = (
    <div className="mb-6 flex flex-wrap items-center gap-2">
      {KINDS.map((k) => (
        <button
          key={k.id}
          className="tab"
          aria-current={kind === k.id}
          onClick={() => setKind(k.id)}
        >
          {k.label}
        </button>
      ))}
      <span className="ml-auto text-xs text-stone-500">
        {score.total > 0 && `${score.right}/${score.total} this session`}
      </span>
    </div>
  );

  if (error) {
    return (
      <div>
        {picker}
        <div className="rounded-xl border border-rose-300/60 bg-rose-50/60 p-6 dark:bg-rose-950/30">
          <p className="font-medium text-rose-800 dark:text-rose-300">Something went wrong</p>
          <p className="mt-1 font-mono text-sm text-rose-700/80">{error}</p>
          <button className="btn mt-4" onClick={() => void load()}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (!item) return <p className="text-stone-500">Loading…</p>;

  if (item.type === 'idle') {
    return (
      <div>
        {picker}
        <div className="py-16 text-center">
          <p className="text-2xl">Not enough to choose between yet.</p>
          <p className="mt-2 text-stone-500">{item.reason}</p>
          <button className="btn mt-6" onClick={() => void load()}>
            Check again
          </button>
        </div>
      </div>
    );
  }

  const active = KINDS.find((k) => k.id === kind)!;

  return (
    <div>
      {picker}

      <div className="flex flex-col items-center">
        <button
          className="grid h-20 w-20 place-items-center rounded-full border-2 border-amber-700/70 text-3xl text-amber-800 transition hover:bg-amber-700/10 dark:border-amber-500/60 dark:text-amber-400"
          onClick={replay}
          aria-label="Replay"
        >
          ▶
        </button>
        <p className="mt-3 text-sm text-stone-500">
          {audio.replays === 0 ? active.hint : `${audio.replays} replay${audio.replays > 1 ? 's' : ''}`}
        </p>
      </div>

      {/* Cloze shows the sentence with the word removed; the gap is the question. */}
      {item.prompt && <p className="mt-6 text-center text-3xl leading-relaxed">{item.prompt}</p>}

      <div className="mt-8 grid gap-3 sm:grid-cols-2">
        {item.options.map((o, i) => {
          const isChosen = chosen === o.conceptId;
          const isAnswer = result && o.conceptId === item.conceptId;
          const tone = !result
            ? 'border-stone-200 hover:border-amber-700/60 dark:border-stone-800'
            : isAnswer
              ? 'border-emerald-600 bg-emerald-600/5'
              : isChosen
                ? 'border-rose-500 bg-rose-500/5'
                : 'border-stone-200 opacity-50 dark:border-stone-800';
          return (
            <button
              key={o.conceptId}
              disabled={Boolean(result)}
              onClick={() => void answer(o.conceptId)}
              className={`flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition ${tone}`}
            >
              <span className="text-xs text-stone-400 dark:text-stone-600">{i + 1}</span>
              <span>
                <span className={o.sub ? 'text-2xl' : 'text-lg'}>{o.label}</span>
                {o.sub && <span className="ml-2 text-sm text-stone-500">{o.sub}</span>}
              </span>
            </button>
          );
        })}
      </div>

      {!result && (
        <p className="hint mt-6 text-center">
          <kbd>1</kbd>–<kbd>4</kbd> choose · <kbd>Space</kbd> replay
        </p>
      )}

      {result && (
        <div className="mt-8 border-t border-stone-200 pt-6 dark:border-stone-800">
          <div className="flex items-baseline justify-between">
            <p className="label">{result.correct ? 'Right' : 'Not that one'}</p>
            <p className="text-sm text-stone-500">
              graded <b className="text-stone-700 dark:text-stone-300">{result.grade}</b>
              {!result.rescheduled && ' · practice, schedule untouched'}
            </p>
          </div>

          {result.utterance && (
            <>
              <p className="hanzi mt-3">{result.utterance.hanziTrad}</p>
              <p className="pinyin">{result.utterance.pinyin}</p>
              <p className="mt-1 text-lg">{result.utterance.glossEn}</p>
            </>
          )}
          {result.concept && (
            <p className="mt-4 text-sm text-stone-500">
              target word{' '}
              <b className="text-stone-700 dark:text-stone-300">{result.concept.headwordTrad}</b>{' '}
              {result.concept.pinyin} — {result.concept.glossEn}
            </p>
          )}

          <div className="mt-6 flex items-center gap-3">
            <button className="btn" onClick={replay}>
              ▶ Again
            </button>
            <button className="btn btn-primary" onClick={() => void load()}>
              Next →
            </button>
            {clip.current && <span className="text-xs text-stone-500">{voiceLabel(clip.current)}</span>}
            <span className="ml-auto text-xs text-stone-500">{reps} this session</span>
          </div>
          <p className="hint mt-3">
            <kbd>Enter</kbd> next · <kbd>Space</kbd> replay
          </p>
        </div>
      )}
    </div>
  );
}
