import { useEffect, useState } from 'react';
import { api, type Stats as StatsData } from './api.ts';

/**
 * Ability, not gamification (docs/design.md §2 / §4). No streaks, no points.
 *
 * The two numbers that matter are HSK coverage per modality and whether median
 * response latency is falling — for listening, speed of comprehension *is* the
 * skill, and it comes out of the event log for free.
 */
export function Stats({ refreshKey }: { refreshKey: number }) {
  const [s, setS] = useState<StatsData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void api
      .stats()
      .then(setS)
      .catch((e) => setErr((e as Error).message));
  }, [refreshKey]);

  if (err) return <p className="text-rose-700 dark:text-rose-400">{err}</p>;
  if (!s) return <p className="text-stone-500">Loading…</p>;

  return (
    <div className="space-y-8">
      <div>
        <p className="label">Listening</p>
        <p className="mt-1 text-5xl">HSK {s.hsk.estimate.toFixed(1)}</p>
        <p className="mt-1 text-sm text-stone-500">
          vocabulary coverage — not grammar, and not exam readiness
        </p>
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <div>
          <p className="label">Progress</p>
          <dl className="mt-2 space-y-1 text-sm">
            <Row k="Introduced" v={`${s.introduced} / ${s.total}`} />
            <Row k="Due now" v={String(s.due)} />
            <Row k="Shaky" v={String(s.hsk.shaky)} />
            <Row k="Reviews today" v={String(s.reviewsToday)} />
            <Row k="Reviews, 24h" v={String(s.reviews24h)} />
            <Row k="New words left" v={String(s.remainingNew)} />
            <Row
              k="Median response"
              v={s.medianLatencyMs === null ? '—' : `${(s.medianLatencyMs / 1000).toFixed(1)}s`}
            />
          </dl>
        </div>

        <div>
          <p className="label">Coverage by level</p>
          <div className="mt-2 space-y-2">
            {s.hsk.perLevel.map((l) => (
              <div key={l.level}>
                <div className="flex justify-between text-sm">
                  <span>HSK {l.level}</span>
                  <span className="text-stone-500">
                    {l.known}/{l.total}
                  </span>
                </div>
                <div className="mt-1 h-2 overflow-hidden rounded-full bg-stone-200 dark:bg-stone-800">
                  <div
                    className="h-full bg-amber-700 dark:bg-amber-500"
                    style={{ width: `${Math.round(l.coverage * 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {s.remainingNew < 40 && (
        <p className="rounded-lg border border-amber-700/40 bg-amber-700/5 p-3 text-sm">
          {s.remainingNew} new word{s.remainingNew === 1 ? '' : 's'} left in the corpus.
          At a dozen a day that is about {Math.max(1, Math.round(s.remainingNew / 12))} more
          day{Math.round(s.remainingNew / 12) === 1 ? '' : 's'} of new material — time to
          extend the vocabulary and generate more sentences.
        </p>
      )}

      {s.stranded.length > 0 && (
        <p className="rounded-lg border border-rose-300/60 bg-rose-50/60 p-3 text-sm text-rose-800 dark:bg-rose-950/30 dark:text-rose-300">
          {s.stranded.length} card(s) have no sentence to drill them with and can never come
          up. Concept ids: {s.stranded.join(', ')}
        </p>
      )}
    </div>
  );
}

const Row = ({ k, v }: { k: string; v: string }) => (
  <div className="flex justify-between border-b border-stone-100 pb-1 dark:border-stone-900">
    <dt className="text-stone-500">{k}</dt>
    <dd className="font-medium">{v}</dd>
  </div>
);
