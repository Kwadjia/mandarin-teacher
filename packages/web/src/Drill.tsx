import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type NextResponse, type AnswerResponse } from './api.ts';
import { pickClip, useAudio, voiceLabel } from './useAudio.ts';

/**
 * The core loop: Listen & Commit, plus First Exposure when the scheduler offers a
 * word for the first time.
 *
 * The reveal gate is the important part (docs/design.md §2.9). There is no button
 * to show the answer until a commitment has been made, and no keyboard path to one
 * either — hindsight bias would otherwise poison every grade in the log.
 */

type Phase = 'listening' | 'revealed' | 'introducing';

interface Props {
  sessionId: number | null;
  onAnswered?: () => void;
}

export function Drill({ sessionId, onAnswered }: Props) {
  const [item, setItem] = useState<NextResponse | null>(null);
  const [phase, setPhase] = useState<Phase>('listening');
  const [result, setResult] = useState<AnswerResponse | null>(null);
  const [gotIt, setGotIt] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clip = useRef(
    null as ReturnType<typeof pickClip>,
  );
  const audio = useAudio();

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.next();
      setItem(next);
      setResult(null);
      setGotIt(null);
      audio.reset();
      if (next.type === 'idle') {
        clip.current = null;
        return;
      }
      clip.current = next.utterance ? pickClip(next.utterance.clips) : null;
      setPhase(next.type === 'introduce' ? 'introducing' : 'listening');
      // First Exposure shows the word before playing; a review plays immediately.
      if (next.type === 'review' && clip.current) audio.play(clip.current.url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [audio]);

  useEffect(() => {
    void load();
    // Intentionally once: subsequent items are loaded by `next()`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const replay = useCallback(() => {
    if (clip.current) audio.play(clip.current.url, true);
  }, [audio]);

  const commit = useCallback(
    async (understood: boolean) => {
      if (!item || item.type === 'idle' || busy) return;
      setBusy(true);
      setGotIt(understood);
      try {
        const res = await api.answer({
          sessionId,
          conceptId: item.concept.id,
          utteranceId: item.utterance?.id ?? null,
          audioId: clip.current?.id ?? null,
          exerciseType: 'listen-commit',
          outcome: {
            kind: 'commit',
            gotIt: understood,
            replays: audio.replays,
            latencyMs: audio.latencySince(),
            committedBeforeReveal: true,
          },
        });
        setResult(res);
        setPhase('revealed');
        onAnswered?.();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [item, busy, sessionId, audio, onAnswered],
  );

  /**
   * Accepting a newly introduced word. Sent with no latency so the server grades it
   * `good` rather than `easy` — a word seen once should come back in minutes, not
   * a fortnight.
   */
  const acceptIntroduction = useCallback(async () => {
    if (!item || item.type === 'idle' || busy) return;
    setBusy(true);
    try {
      await api.answer({
        sessionId,
        conceptId: item.concept.id,
        utteranceId: item.utterance?.id ?? null,
        audioId: clip.current?.id ?? null,
        exerciseType: 'first-exposure',
        outcome: {
          kind: 'commit',
          gotIt: true,
          replays: audio.replays,
          latencyMs: null,
          committedBeforeReveal: true,
        },
      });
      onAnswered?.();
      await load();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }, [item, busy, sessionId, audio, onAnswered, load]);

  // ── keyboard ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === ' ') {
        e.preventDefault();
        replay();
        return;
      }
      if (phase === 'listening') {
        if (e.key === '1') void commit(false);
        if (e.key === '2') void commit(true);
      } else if (phase === 'introducing') {
        if (e.key === 'Enter') void acceptIntroduction();
      } else if (phase === 'revealed') {
        if (e.key === 'Enter') void load();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, replay, commit, acceptIntroduction, load]);

  if (error) {
    return (
      <div className="rounded-xl border border-rose-300/60 bg-rose-50/60 p-6 dark:bg-rose-950/30">
        <p className="font-medium text-rose-800 dark:text-rose-300">Something went wrong</p>
        <p className="mt-1 font-mono text-sm text-rose-700/80 dark:text-rose-400/80">{error}</p>
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
        <p className="text-2xl">Nothing due.</p>
        <p className="mt-2 text-stone-500">{item.reason}</p>
        <p className="mt-6 text-sm text-stone-500">
          {item.queue.introduced} of {item.queue.total} concepts introduced.
        </p>
        <button className="btn mt-6" onClick={() => void load()}>
          Check again
        </button>
      </div>
    );
  }

  const { concept, utterance } = item;

  // ── First Exposure ────────────────────────────────────────────────────────
  if (phase === 'introducing') {
    return (
      <div>
        <p className="label">New word · {concept.source}</p>
        <p className="hanzi mt-2">{concept.headwordTrad}</p>
        {concept.headwordTrad !== concept.headword && (
          <p className="hanzi-alt">{concept.headword}</p>
        )}
        <p className="pinyin">{concept.pinyin}</p>
        <p className="mt-2 text-xl">{concept.glossEn}</p>

        {utterance && (
          <div className="mt-8 border-t border-stone-200 pt-6 dark:border-stone-800">
            <p className="label">Heard in</p>
            <p className="mt-1 text-2xl leading-relaxed">{utterance.hanziTrad}</p>
            <p className="pinyin">{utterance.pinyin}</p>
            <p className="text-stone-500">{utterance.glossEn}</p>
            <div className="mt-4 flex items-center gap-3">
              <button className="btn" onClick={replay}>
                ▶ Play
              </button>
              {clip.current && (
                <span className="text-xs text-stone-500">{voiceLabel(clip.current)}</span>
              )}
            </div>
          </div>
        )}

        <div className="mt-8">
          <button className="btn btn-primary" disabled={busy} onClick={() => void acceptIntroduction()}>
            Got it — add to rotation
          </button>
          <p className="hint mt-3">
            <kbd>Space</kbd> play · <kbd>Enter</kbd> continue
          </p>
        </div>
      </div>
    );
  }

  // ── Listen & Commit ───────────────────────────────────────────────────────
  return (
    <div>
      {phase === 'listening' ? (
        <>
          <div className="flex flex-col items-center py-10">
            <button
              className="grid h-28 w-28 place-items-center rounded-full border-2 border-amber-700/70 text-4xl text-amber-800 transition hover:bg-amber-700/10 dark:border-amber-500/60 dark:text-amber-400"
              onClick={replay}
              aria-label="Replay"
            >
              ▶
            </button>
            <p className="mt-4 text-sm text-stone-500">
              {audio.replays === 0 ? 'listen' : `${audio.replays} replay${audio.replays > 1 ? 's' : ''}`}
            </p>
          </div>

          <div className="flex justify-center gap-3">
            <button className="btn btn-miss" disabled={busy} onClick={() => void commit(false)}>
              Missed it
            </button>
            <button className="btn btn-got" disabled={busy} onClick={() => void commit(true)}>
              Got it
            </button>
          </div>
          <p className="hint mt-6 text-center">
            <kbd>Space</kbd> replay · <kbd>1</kbd> missed · <kbd>2</kbd> got it
          </p>
          <p className="mt-8 text-center text-xs text-stone-400 dark:text-stone-600">
            Commit before you see the answer — that is what keeps the data honest.
          </p>
        </>
      ) : (
        <div>
          <div className="flex items-baseline justify-between">
            <p className="label">{gotIt ? 'You said: got it' : 'You said: missed it'}</p>
            {result && (
              <p className="text-sm text-stone-500">
                graded <b className="text-stone-700 dark:text-stone-300">{result.grade}</b> · back in{' '}
                {result.intervalDays < 1
                  ? `${Math.round(result.intervalDays * 24 * 60)} min`
                  : `${result.intervalDays} d`}
              </p>
            )}
          </div>

          {utterance && (
            <>
              <p className="hanzi mt-3">{utterance.hanziTrad}</p>
              {utterance.hanziTrad !== utterance.hanzi && (
                <p className="hanzi-alt">{utterance.hanzi}</p>
              )}
              <p className="pinyin">{utterance.pinyin}</p>
              <p className="mt-2 text-xl">{utterance.glossEn}</p>
            </>
          )}

          <p className="mt-6 text-sm text-stone-500">
            target word{' '}
            <b className="text-stone-700 dark:text-stone-300">{concept.headwordTrad}</b>{' '}
            {concept.pinyin} — {concept.glossEn}
          </p>

          <div className="mt-6 flex items-center gap-3">
            <button className="btn" onClick={replay}>
              ▶ Again
            </button>
            <button className="btn btn-primary" onClick={() => void load()}>
              Next →
            </button>
            {clip.current && (
              <span className="text-xs text-stone-500">{voiceLabel(clip.current)}</span>
            )}
          </div>
          <p className="hint mt-3">
            <kbd>Enter</kbd> next · <kbd>Space</kbd> replay
          </p>
        </div>
      )}
    </div>
  );
}
