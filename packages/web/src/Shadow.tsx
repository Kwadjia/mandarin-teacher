import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type NextResponse, type ScoredSyllable, type SpeakResponse } from './api.ts';
import { pickClip, useAudio, voiceLabel } from './useAudio.ts';
import { useRecorder } from './useRecorder.ts';

/**
 * Shadowing: hear a native line, say it back, see how close you were.
 *
 * The text stays hidden until after the recording. That makes this shadowing rather
 * than reading aloud — the sentence has to be held in memory and reproduced, which is
 * the skill — and it keeps the reveal gate intact for a modality where the commitment
 * is the recording itself (docs/design.md §2.9). Replaying the native clip as often
 * as needed is the pressure valve, and every replay is counted.
 *
 * Feedback is per syllable, because "that was wrong" teaches nothing. Word errors
 * come from the recogniser and tone errors from the pitch track, and they are shown
 * as different kinds of mistake because they are: one is not knowing the word, the
 * other is the mouth not doing what it was told.
 */

type Phase = 'listen' | 'recording' | 'scoring' | 'feedback';

const TONE_NAME = ['neutral', 'high flat', 'rising', 'dipping', 'falling'];

/**
 * What each verdict means, said in words rather than implied by a colour.
 *
 * The first version labelled a mismatch "heard 鸟", which was accurate and useless —
 * it never said whether that meant the wrong word or the wrong tone, and those call
 * for completely different corrections.
 */
const VERDICT: Record<ScoredSyllable['verdict'], { cls: string; label: string }> = {
  good: { cls: 'text-emerald-700 dark:text-emerald-400', label: 'right' },
  close: { cls: 'text-amber-700 dark:text-amber-400', label: 'tone slightly off' },
  tone: { cls: 'text-amber-700 dark:text-amber-500', label: 'right sound, wrong tone' },
  wrong: { cls: 'text-rose-700 dark:text-rose-400', label: 'different word' },
  missing: { cls: 'text-stone-400 dark:text-stone-600', label: "didn't catch this one" },
  unscored: { cls: 'text-stone-500', label: 'said right; tone too short to measure' },
};

/**
 * The one-line correction under each syllable.
 *
 * Naming *what* to change, not just that something was wrong. Real attempts split
 * cleanly: bǎo→bào is a tone, gǒu→gāo is a vowel, chē→què is a consonant. "Sounded
 * like 高" gave none of that away, and those three need different practice.
 */
function caption(s: ScoredSyllable): string {
  switch (s.verdict) {
    case 'tone':
      return s.heardTone && s.heardTone !== s.tone
        ? `said ${TONE_NAME[s.heardTone]} · want ${TONE_NAME[s.tone]}`
        : `${TONE_NAME[s.tone]} — pitch drifted`;
    case 'wrong':
      switch (s.errorKind) {
        case 'vowel':
          return `vowel · said ${s.saidPinyin}`;
        case 'consonant':
          return `consonant · said ${s.saidPinyin}`;
        default:
          return `sounded like ${s.saidPinyin ?? s.said ?? '?'}`;
      }
    case 'missing':
      return 'not heard';
    case 'close':
      return `${TONE_NAME[s.tone]}, nearly`;
    default:
      return TONE_NAME[s.tone] ?? '';
  }
}

/**
 * One syllable's pitch, learner against native.
 *
 * Both are already in semitones relative to their own speaker's median, so a male
 * learner and a female voice land on the same axis and only the *shape* differs —
 * which is exactly what a tone is. Drawn on a shared scale so the two lines are
 * honestly comparable.
 */
function Contour({ learner, reference }: { learner: number[]; reference: number[] }) {
  if (!learner.length || !reference.length) return null;
  const all = [...learner, ...reference];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const span = Math.max(hi - lo, 2); // never magnify sub-semitone wobble into a mountain
  const path = (pts: number[]) =>
    pts
      .map((v, i) => {
        const x = (i / (pts.length - 1)) * 56;
        const y = 22 - ((v - lo) / span) * 20;
        return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');

  return (
    <svg viewBox="0 0 56 24" className="mt-1 h-6 w-14 overflow-visible" aria-hidden>
      <path d={path(reference)} fill="none" strokeWidth="2.5" className="stroke-stone-300 dark:stroke-stone-700" />
      <path d={path(learner)} fill="none" strokeWidth="2" strokeLinecap="round" className="stroke-current" />
    </svg>
  );
}

interface Props {
  sessionId: number | null;
  onAnswered?: () => void;
}

export function Shadow({ sessionId, onAnswered }: Props) {
  const [item, setItem] = useState<NextResponse | null>(null);
  const [phase, setPhase] = useState<Phase>('listen');
  const [result, setResult] = useState<SpeakResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [reps, setReps] = useState(0);
  const clip = useRef(null as ReturnType<typeof pickClip>);

  const audio = useAudio();
  const rec = useRecorder();

  useEffect(() => {
    void api
      .health()
      .then((h) => setAvailable(h.speech))
      .catch(() => setAvailable(false));
  }, []);

  const load = useCallback(async () => {
    setError(null);
    setResult(null);
    rec.reset();
    audio.reset();
    try {
      const next = await api.next('speak');
      setItem(next);
      setPhase('listen');
      clip.current = next.type === 'idle' ? null : next.utterance ? pickClip(next.utterance.clips) : null;
      if (clip.current) audio.play(clip.current.url);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [audio, rec]);

  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (available) void loadRef.current();
  }, [available]);

  const replay = useCallback(() => {
    if (clip.current) audio.play(clip.current.url);
  }, [audio]);

  const submit = useCallback(
    async (blob: Blob) => {
      if (!item || item.type === 'idle' || !item.utterance) return;
      setPhase('scoring');
      try {
        const res = await api.speak({
          sessionId,
          conceptId: item.concept.id,
          utteranceId: item.utterance.id,
          audioId: clip.current?.id ?? null,
          replays: audio.replays,
          audio: blob,
        });
        setResult(res);
        setPhase('feedback');
        // An unscorable recording is not a rep. It changed no card, so counting it
        // would overstate the session and trigger a pointless stats refresh.
        if (!res.unusable) {
          setReps((n) => n + 1);
          onAnswered?.();
        }
      } catch (e) {
        setError((e as Error).message);
        setPhase('listen');
      }
    },
    [item, sessionId, audio.replays, onAnswered],
  );

  // The recorder resolves asynchronously after stop(), so submission is driven by the
  // recording appearing rather than by the click that requested it.
  useEffect(() => {
    if (rec.recording && phase === 'recording') void submit(rec.recording.blob);
  }, [rec.recording, phase, submit]);

  const startRecording = useCallback(() => {
    setPhase('recording');
    void rec.start();
  }, [rec]);

  // ── keyboard ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === ' ') {
        e.preventDefault();
        if (phase === 'listen' || phase === 'feedback') replay();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (phase === 'listen') startRecording();
        else if (phase === 'recording') rec.stop();
        else if (phase === 'feedback') void load();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, replay, startRecording, rec, load]);

  // ── unavailable / error states ────────────────────────────────────────────
  if (available === null) return <p className="text-stone-500">Checking the microphone service…</p>;

  if (!available) {
    return (
      <div className="rounded-xl border border-amber-700/40 bg-amber-700/5 p-6">
        <p className="font-medium">Speaking needs the local scorer running.</p>
        <p className="mt-2 text-sm text-stone-500">
          It holds the speech model in memory on the GPU. Nothing is sent anywhere — your
          recordings never leave this machine.
        </p>
        <pre className="mt-4 rounded bg-stone-900 p-3 font-mono text-xs text-stone-100">npm run speech</pre>
        <button className="btn mt-4" onClick={() => location.reload()}>
          I started it — check again
        </button>
      </div>
    );
  }

  if (rec.state === 'denied' || rec.state === 'unsupported') {
    return (
      <div className="rounded-xl border border-rose-300/60 bg-rose-50/60 p-6 dark:bg-rose-950/30">
        <p className="font-medium text-rose-800 dark:text-rose-300">
          {rec.state === 'denied' ? 'Microphone access was refused.' : 'This browser cannot record audio.'}
        </p>
        {rec.error && <p className="mt-1 font-mono text-sm text-rose-700/80">{rec.error}</p>}
      </div>
    );
  }

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
        <p className="text-2xl">Nothing to say yet.</p>
        <p className="mt-2 text-stone-500">
          {item.queue.total === 0
            ? 'Speaking follows listening — drill some words first and they will show up here.'
            : item.reason}
        </p>
        <p className="mt-6 text-sm text-stone-500">
          {item.queue.introduced} of {item.queue.total} heard words practised aloud
          {reps > 0 && ` · ${reps} this session`}
        </p>
        <button className="btn mt-6" onClick={() => void load()}>
          Check again
        </button>
      </div>
    );
  }

  const { concept, utterance } = item;

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <p className="label">Say it back</p>
        <p className="text-xs text-stone-500">
          {item.queue.introduced}/{item.queue.total} spoken
        </p>
      </div>

      {/* Listen ─────────────────────────────────────────────────────────── */}
      <div className="mt-6 flex flex-col items-center">
        <button
          className="grid h-20 w-20 place-items-center rounded-full border-2 border-amber-700/70 text-3xl text-amber-800 transition hover:bg-amber-700/10 dark:border-amber-500/60 dark:text-amber-400"
          onClick={replay}
          aria-label="Play the native recording"
        >
          ▶
        </button>
        <p className="mt-3 text-sm text-stone-500">
          {audio.replays === 0 ? 'listen, then repeat it' : `${audio.replays} replay${audio.replays > 1 ? 's' : ''}`}
        </p>
      </div>

      {/* Record ─────────────────────────────────────────────────────────── */}
      {phase !== 'feedback' && (
        <div className="mt-8 flex flex-col items-center">
          {phase === 'scoring' ? (
            <p className="text-stone-500">Scoring…</p>
          ) : phase === 'recording' ? (
            <>
              <button
                className="flex items-center gap-3 rounded-full bg-rose-600 px-8 py-3 text-lg text-white transition hover:bg-rose-700"
                onClick={rec.stop}
              >
                <span className="h-3 w-3 animate-pulse rounded-full bg-white" />
                Stop
              </button>
              <p className="mt-3 text-sm text-stone-500">recording — say the sentence</p>
            </>
          ) : (
            <>
              <button className="btn btn-primary px-8 py-3 text-lg" onClick={startRecording}>
                ● Speak
              </button>
              <p className="hint mt-3">
                <kbd>Space</kbd> replay · <kbd>Enter</kbd> record and stop
              </p>
            </>
          )}
          <p className="mt-8 text-center text-xs text-stone-400 dark:text-stone-600">
            The text is hidden on purpose — repeat what you heard, not what you read.
          </p>
        </div>
      )}

      {/* Feedback ───────────────────────────────────────────────────────── */}
      {phase === 'feedback' && result && utterance && (
        <div className="mt-8 border-t border-stone-200 pt-6 dark:border-stone-800">
          {result.unusable ? (
            // Not graded, and the card is untouched. A microphone problem is not a
            // failure to speak Mandarin and must not be recorded as one.
            <div className="rounded-lg border border-amber-700/40 bg-amber-700/5 p-4">
              <p className="font-medium">Couldn't make that out — not counted.</p>
              <p className="mt-1 text-sm text-stone-500">
                {result.reason}. Nothing was graded and the word is unchanged; just try again.
              </p>
            </div>
          ) : (
            <div className="flex items-baseline justify-between">
              <p className="label">
                {result.score.correctSyllables}/{result.score.totalSyllables} sounds right
                {result.score.toneErrors > 0 && (
                  <> · {result.score.toneErrors} tone{result.score.toneErrors === 1 ? '' : 's'} off</>
                )}
              </p>
              <p className="text-sm text-stone-500">
                graded <b className="text-stone-700 dark:text-stone-300">{result.grade}</b> · back in{' '}
                {result.intervalDays < 1
                  ? `${Math.round(result.intervalDays * 24 * 60)} min`
                  : `${result.intervalDays} d`}
              </p>
            </div>
          )}

          {!result.unusable && (
            <>
              <div className="mt-5 flex flex-wrap gap-x-5 gap-y-4">
                {result.score.syllables.map((s, i) => {
                  const v = VERDICT[s.verdict];
                  return (
                    <div key={i} className={`flex flex-col items-center ${v.cls}`} title={v.label}>
                      <span className="text-3xl leading-none">{s.char}</span>
                      <span className="text-[0.7rem] opacity-70">{s.pinyin}</span>
                      <Contour learner={s.learner} reference={s.reference} />
                      <span className="mt-0.5 max-w-[7rem] text-center text-[0.65rem] leading-tight">
                        {caption(s)}
                      </span>
                    </div>
                  );
                })}
              </div>

              <p className="mt-5 text-sm text-stone-500">
                the recogniser heard{' '}
                <b className="text-stone-700 dark:text-stone-300">{result.score.transcript.trim()}</b>
              </p>
            </>
          )}

          <p className="hanzi mt-4">{utterance.hanziTrad}</p>
          <p className="pinyin">{utterance.pinyin}</p>
          <p className="mt-1 text-lg">{utterance.glossEn}</p>
          <p className="mt-3 text-sm text-stone-500">
            target word <b className="text-stone-700 dark:text-stone-300">{concept.headwordTrad}</b>{' '}
            {concept.pinyin} — {concept.glossEn}
          </p>

          {/* Hearing the two back to back is where the correction actually lands. */}
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button className="btn" onClick={replay}>
              ▶ Native
            </button>
            {rec.recording && (
              <button className="btn" onClick={() => new Audio(rec.recording!.url).play()}>
                ▶ You
              </button>
            )}
            <button className="btn btn-primary" onClick={() => void load()}>
              Next →
            </button>
            {clip.current && <span className="text-xs text-stone-500">{voiceLabel(clip.current)}</span>}
          </div>
          <p className="hint mt-3">
            <kbd>Space</kbd> native · <kbd>Enter</kbd> next
          </p>
        </div>
      )}
    </div>
  );
}
