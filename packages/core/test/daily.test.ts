import { describe, expect, it } from 'vitest';
import { computeStreak, dailyTarget, levelFor, repPoints } from '../src/index.ts';

describe('repPoints', () => {
  // Effort is paid first, success is a bonus. If failing paid nothing, the cheapest way
  // to score would be to avoid every word worth practising.
  it('pays for attempting something hard', () => {
    expect(repPoints({ modality: 'listen', isNew: false, grade: 'again' })).toBeGreaterThan(0);
  });

  it('pays more for success than failure', () => {
    const fail = repPoints({ modality: 'listen', isNew: false, grade: 'again' });
    const win = repPoints({ modality: 'listen', isNew: false, grade: 'good' });
    expect(win).toBeGreaterThan(fail);
  });

  it('pays more for producing than recognising', () => {
    expect(repPoints({ modality: 'speak', isNew: false, grade: 'good' })).toBeGreaterThan(
      repPoints({ modality: 'listen', isNew: false, grade: 'good' }),
    );
  });

  it('pays most for a first exposure', () => {
    expect(repPoints({ modality: 'listen', isNew: true, grade: 'good' })).toBeGreaterThan(
      repPoints({ modality: 'speak', isNew: false, grade: 'good' }),
    );
  });
});

describe('levelFor', () => {
  it('starts at level 1 with nothing earned', () => {
    expect(levelFor(0)).toEqual({ level: 1, into: 0, span: 150 });
  });

  it('advances and reports progress into the level', () => {
    const l = levelFor(200);
    expect(l.level).toBe(2);
    expect(l.into).toBe(50);
  });

  it('never reports progress beyond the span it is in', () => {
    for (const p of [0, 1, 149, 150, 999, 5000, 100_000]) {
      const l = levelFor(p);
      expect(l.into).toBeLessThan(l.span);
    }
  });
});

describe('computeStreak', () => {
  const days = (...d: string[]) => new Set(d);

  it('counts consecutive days', () => {
    const s = computeStreak({
      activeDays: days('2026-08-10', '2026-08-09', '2026-08-08'),
      today: '2026-08-10',
    });
    expect(s).toMatchObject({ days: 3, todayDone: true, graceUsed: 0 });
  });

  /** The day is not over. A streak shown as already lost at breakfast is a reason to
   *  not bother, which is the exact opposite of the point. */
  it('does not break the streak just because today is still empty', () => {
    const s = computeStreak({
      activeDays: days('2026-08-09', '2026-08-08'),
      today: '2026-08-10',
    });
    expect(s.days).toBe(2);
    expect(s.todayDone).toBe(false);
  });

  // A newborn is arriving. A counter that punishes one bad night gets abandoned in the
  // first week, and the loss itself then becomes the reason to stop.
  it('forgives a single missed day', () => {
    const s = computeStreak({
      activeDays: days('2026-08-10', '2026-08-09', '2026-08-07', '2026-08-06'),
      today: '2026-08-10',
    });
    expect(s.days).toBe(4);
    expect(s.graceUsed).toBe(1);
  });

  it('does not forgive two misses in the same week', () => {
    const s = computeStreak({
      activeDays: days('2026-08-10', '2026-08-08', '2026-08-06'),
      today: '2026-08-10',
    });
    expect(s.days).toBe(2); // today + the 8th, then the second gap inside a week stops it
  });

  it('forgives again once a week has passed', () => {
    const active = days(
      '2026-08-20', '2026-08-19', '2026-08-18', '2026-08-17', '2026-08-16',
      '2026-08-15', '2026-08-14', '2026-08-12', '2026-08-11', '2026-08-10',
    );
    // Gaps at the 13th and (later) the 9th are more than seven days apart.
    const s = computeStreak({ activeDays: active, today: '2026-08-20' });
    expect(s.days).toBe(10);
    expect(s.graceUsed).toBe(1);
  });

  it('reports zero when nothing has been done for days', () => {
    const s = computeStreak({ activeDays: days('2026-08-01'), today: '2026-08-10' });
    expect(s.days).toBe(0);
  });

  it('handles an empty history', () => {
    expect(computeStreak({ activeDays: new Set(), today: '2026-08-10' }).days).toBe(0);
  });
});

describe('dailyTarget', () => {
  it('takes the target from the schedule rather than a round number', () => {
    expect(dailyTarget(23, 0).reps).toBe(23);
  });

  // 122 done against a target of 19 reads as a broken bar; the day's work is both.
  it('counts the whole day, not just what is left', () => {
    const t = dailyTarget(19, 122);
    expect(t.reps).toBe(141);
    expect(t.done).toBe(122);
  });

  it('stays put as reps are done and the remainder shrinks', () => {
    expect(dailyTarget(19, 0).reps).toBe(19);
    expect(dailyTarget(9, 10).reps).toBe(19);
  });

  // Showing up on a caught-up day should still register as a day.
  it('falls back to the minimum when nothing is due', () => {
    const t = dailyTarget(0, 0);
    expect(t.reps).toBeGreaterThan(0);
    expect(t.met).toBe(false);
    expect(dailyTarget(0, 8).met).toBe(true);
  });

  /**
   * Clearing a forty-card backlog is not a fair condition for the day to count — on a
   * bad night it guarantees the streak breaks, which is how these counters get
   * abandoned. Keeping the day and finishing the plan are separate questions.
   */
  it('separates keeping the day from clearing the plan', () => {
    const t = dailyTarget(40, 8);
    expect(t.met).toBe(true);
    expect(t.planCleared).toBe(false);
    expect(dailyTarget(0, 8).planCleared).toBe(true);
  });
});
