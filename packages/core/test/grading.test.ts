import { describe, expect, it } from 'vitest';
import { FLUENT_MS, LABOURED_MS, gradeAuto, gradeCommit, gradeDictation } from '../src/index.ts';

describe('gradeCommit', () => {
  const base = { gotIt: true, replays: 0, latencyMs: 3000, committedBeforeReveal: true };

  it('fails a miss regardless of anything else', () => {
    expect(gradeCommit({ ...base, gotIt: false, latencyMs: 100 })).toBe('again');
  });

  it('rewards instant recognition with easy', () => {
    expect(gradeCommit({ ...base, latencyMs: FLUENT_MS - 1 })).toBe('easy');
  });

  it('treats slow-but-correct as hard', () => {
    expect(gradeCommit({ ...base, latencyMs: LABOURED_MS + 1 })).toBe('hard');
  });

  it('gives good for an unremarkable correct answer', () => {
    expect(gradeCommit({ ...base, latencyMs: 4000 })).toBe('good');
  });

  // The point of counting replays: "I got it (on the third listen)" is not a `good`,
  // and the learner should not have to be honest enough to say so.
  it('discounts the self-report when the audio was replayed', () => {
    expect(gradeCommit({ ...base, replays: 1, latencyMs: 500 })).toBe('hard');
    expect(gradeCommit({ ...base, replays: 2, latencyMs: 500 })).toBe('hard');
  });

  it('treats one replay plus a laboured answer as a failure', () => {
    expect(gradeCommit({ ...base, replays: 1, latencyMs: LABOURED_MS + 1 })).toBe('again');
  });

  it('falls back to good when latency was not measurable', () => {
    expect(gradeCommit({ ...base, latencyMs: null })).toBe('good');
  });
});

describe('gradeAuto', () => {
  it('fails an incorrect answer however fast it was', () => {
    expect(gradeAuto({ correct: false, replays: 0, latencyMs: 100 })).toBe('again');
  });

  it('awards easy only for a fast, first-listen answer', () => {
    expect(gradeAuto({ correct: true, replays: 0, latencyMs: 1000 })).toBe('easy');
    expect(gradeAuto({ correct: true, replays: 1, latencyMs: 1000 })).toBe('hard');
  });

  it('gives good for correct but unhurried', () => {
    expect(gradeAuto({ correct: true, replays: 0, latencyMs: 9000 })).toBe('good');
  });
});

describe('gradeDictation', () => {
  const d = (correct: number, tone: number, total: number, replays = 0) =>
    gradeDictation({ correctSyllables: correct, toneErrors: tone, totalSyllables: total, replays });

  it('gives easy for a flawless first-listen transcription', () => {
    expect(d(5, 0, 5)).toBe('easy');
  });

  it('downgrades a flawless transcription that needed replays', () => {
    expect(d(5, 0, 5, 2)).toBe('good');
  });

  // The distinction that makes this exercise worth building: right syllables with
  // wrong tones is a specific, actionable failure, not the same as knowing nothing.
  it('separates tone errors from not knowing the word', () => {
    expect(d(1, 4, 5)).toBe('hard');
    expect(d(1, 0, 5)).toBe('again');
  });

  it('accepts near-perfect as good', () => {
    expect(d(4, 0, 5)).toBe('good');
  });

  it('handles an empty target without dividing by zero', () => {
    expect(d(0, 0, 0)).toBe('again');
  });
});
