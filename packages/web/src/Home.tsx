import { useEffect, useState } from 'react';
import { api, type Modality, type Plan, type PlanBlock } from './api.ts';

/**
 * The first screen: what to work on, in what order, and for roughly how long.
 *
 * Built because the event log showed the opposite of the stated priorities — 53
 * speaking reps against 25 listening ones, with listening first. A row of tabs makes
 * every activity look equally worth opening. A plan does not, and the ordering is the
 * point (docs/design.md §1).
 *
 * No streaks, no points, no goal met. Ability, not gamification (§2). The numbers here
 * are the ones that change what to do next: what is due, what is left, how fast
 * comprehension is getting, and the two things the log says are going wrong.
 */

const mins = (ms: number | null) => (ms === null ? null : Math.max(1, Math.round(ms / 60000)));

const TITLE: Record<string, string> = {
  'listen:review': 'Review listening',
  'listen:new': 'Learn new words',
  'speak:review': 'Practise saying them',
  'speak:new': 'Say new words aloud',
  'read:review': 'Review reading',
  'read:new': 'New reading',
};

interface Props {
  onGo: (view: Modality) => void;
}

export function Home({ onGo }: Props) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .plan()
      .then(setPlan)
      .catch((e) => setError((e as Error).message));
  }, []);

  if (error) return <p className="text-rose-700 dark:text-rose-400">{error}</p>;
  if (!plan) return <p className="text-stone-500">Loading…</p>;

  const { blocks, standing, watch, streak, target, points, phrase } = plan;
  const total = mins(plan.totalMs);
  const toneRate = watch.tone.total ? watch.tone.correct / watch.tone.total : null;
  const pct = target.reps ? Math.min(100, Math.round((target.done / target.reps) * 100)) : 0;

  return (
    <div className="space-y-10">
      {/* The habit row. Days used is the binding constraint on this whole project —
          122 reps happened in a single sitting, on one day. */}
      <section className="flex flex-wrap items-center gap-x-8 gap-y-4">
        <div>
          <p className="text-4xl">
            {streak.days}
            <span className="ml-1 text-lg text-stone-500">day{streak.days === 1 ? '' : 's'}</span>
          </p>
          <p className="text-xs text-stone-500">
            {streak.todayDone
              ? 'today is in the bag'
              : streak.days > 0
                ? 'still safe — the day is not over'
                : 'start one today'}
          </p>
        </div>

        <div className="min-w-40 flex-1">
          <div className="flex items-baseline justify-between text-sm">
            {/* Keeping the day and clearing the plan are different things, and
                conflating them makes a heavy backlog feel like a failed day. */}
            <span>
              {target.planCleared ? 'Plan cleared' : target.met ? 'Day secured' : "Today's plan"}
            </span>
            <span className="text-stone-500">
              {target.done}/{target.reps}
            </span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-stone-200 dark:bg-stone-800">
            <div
              className={`h-full transition-all ${target.planCleared ? 'bg-emerald-600' : 'bg-amber-700 dark:bg-amber-500'}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>

        <div>
          <p className="text-sm">
            Level <b>{points.level}</b>
          </p>
          <div className="mt-1 h-1.5 w-24 overflow-hidden rounded-full bg-stone-200 dark:bg-stone-800">
            <div
              className="h-full bg-stone-400 dark:bg-stone-600"
              style={{ width: `${Math.round((points.into / points.span) * 100)}%` }}
            />
          </div>
        </div>
      </section>

      <section>
        <div className="flex items-baseline justify-between">
          <p className="label">Today</p>
          {total !== null && (
            <p className="text-sm text-stone-500">
              about {total} min · from your own pace
            </p>
          )}
        </div>

        {blocks.length === 0 ? (
          <div className="mt-3 rounded-xl border border-stone-200 p-6 dark:border-stone-800">
            <p className="text-xl">Nothing due, and today's new words are done.</p>
            <p className="mt-2 text-sm text-stone-500">
              Coming back tomorrow is worth more than pushing on — the schedule is built
              around the gap.
            </p>
            <button className="btn mt-4" onClick={() => onGo('listen')}>
              Drill anyway
            </button>
          </div>
        ) : (
          <ol className="mt-3 space-y-3">
            {blocks.map((b, i) => (
              <Step key={`${b.modality}:${b.kind}`} block={b} first={i === 0} onGo={onGo} />
            ))}
          </ol>
        )}
      </section>

      {/* The strongest asset in this project is not a counter, it is a fluent speaker
          in the same house. One phrase used on a real person beats a lot of drilling:
          retrieval under pressure, with a consequence, and someone waiting for it. */}
      {phrase && (
        <section className="rounded-xl border border-stone-200 p-5 dark:border-stone-800">
          <p className="label">Say this to Jasmine today</p>
          <p className="mt-2 text-3xl leading-snug">{phrase.hanziTrad}</p>
          <p className="pinyin">{phrase.pinyin}</p>
          <p className="mt-1 text-stone-500">{phrase.glossEn}</p>
          <p className="mt-3 text-xs text-stone-400 dark:text-stone-600">
            Every word in it is one you already know.
          </p>
        </section>
      )}

      <section>
        <p className="label">Where you stand</p>
        <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Figure
            label="Learning"
            value={`${standing.learning}`}
            note={`of ${standing.total} words in the corpus`}
          />
          {/* Zero here is expected early and says so, rather than sitting next to
              "Learning 12" looking like a contradiction or a bug. */}
          <Figure
            label="Solid"
            value={`${standing.solid}`}
            note={standing.solid === 0 ? 'needs ~2 weeks of reviews' : 'holding after a fortnight'}
          />
          <Figure
            label="Response time"
            value={standing.medianLatencyMs === null ? '—' : `${(standing.medianLatencyMs / 1000).toFixed(1)}s`}
            note="median — falling is the goal"
          />
          <Figure label="Reps today" value={`${standing.reviewsToday}`} note="all exercises" />
        </div>
      </section>

      {(toneRate !== null || watch.remainingNew < 40) && (
        <section>
          <p className="label">Worth knowing</p>
          <div className="mt-3 space-y-3 text-sm">
            {toneRate !== null && watch.tone.total >= 10 && toneRate <= 0.35 && (
              <p className="rounded-lg border border-amber-700/40 bg-amber-700/5 p-3">
                Tone identification is at{' '}
                <b>
                  {watch.tone.correct}/{watch.tone.total}
                </b>{' '}
                — at or below chance for a four-way choice. Worth knowing rather than
                worrying about: the drill measures tone perception but does not teach it,
                and the exercise designed to fix this is not built yet.
              </p>
            )}
            {watch.remainingNew < 40 && (
              <p className="rounded-lg border border-amber-700/40 bg-amber-700/5 p-3">
                {watch.remainingNew} new words left in the corpus — time to extend it
                before it runs dry.
              </p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function Step({ block, first, onGo }: { block: PlanBlock; first: boolean; onGo: (m: Modality) => void }) {
  const m = mins(block.estimateMs);
  return (
    <li
      className={`rounded-xl border p-4 ${
        first
          ? 'border-amber-700/50 bg-amber-700/5 dark:border-amber-500/40'
          : 'border-stone-200 dark:border-stone-800'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-lg">
            {TITLE[`${block.modality}:${block.kind}`] ?? block.modality}
            <span className="ml-2 text-stone-500">
              {block.reps} rep{block.reps === 1 ? '' : 's'}
              {m !== null && ` · ~${m} min`}
            </span>
          </p>
          <p className="mt-1 text-sm text-stone-500">{block.reason}</p>
        </div>
        <button
          className={first ? 'btn btn-primary' : 'btn'}
          onClick={() => onGo(block.modality)}
        >
          {first ? 'Start' : 'Go'}
        </button>
      </div>
    </li>
  );
}

const Figure = ({ label, value, note }: { label: string; value: string; note: string }) => (
  <div>
    <p className="text-xs uppercase tracking-wide text-stone-500">{label}</p>
    <p className="mt-1 text-2xl">{value}</p>
    <p className="text-xs text-stone-500">{note}</p>
  </div>
);
