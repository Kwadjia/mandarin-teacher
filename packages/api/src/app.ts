/**
 * The HTTP surface. Deliberately thin: every decision it makes is delegated to
 * @mt/core, and every row it touches goes through queries.ts.
 *
 * Takes a `Db` rather than creating one, so the same app object runs on Node today
 * and on Cloudflare Workers later with only the adapter swapped (docs/design.md §5).
 *
 * Grading happens here rather than in the browser. The client reports *what
 * happened* — got it, how many replays, how long — and the server decides what that
 * is worth. One implementation, and a client cannot flatter itself.
 */

import { Hono } from 'hono';
import type { Db } from '@mt/schema';
import { segment } from '@mt/schema';
import {
  gradeAuto,
  gradeCommit,
  gradeDictation,
  hskCoverage,
  introductionQueue,
  medianLatency,
  newCard,
  nextAction,
  review,
  strandedCards,
  type Grade,
  type Modality,
} from '@mt/core';
import * as q from './queries.ts';

export interface ToneWord {
  hanzi: string;
  trad: string;
  tone: number;
  gloss: string;
  clips: { f: string; tw: number }[];
}
export interface ToneSet {
  syllable: string;
  words: ToneWord[];
}

export interface Deps {
  db: Db;
  /** Injectable so tests can control the clock. */
  now?: () => Date;
  /**
   * Tone minimal-pair drills. These live outside the concept table on purpose —
   * 妈 麻 马 骂 are not vocabulary being learned, they are a perception probe — so
   * their reps are logged as events with no card attached.
   */
  tones?: ToneSet[];
}

type Outcome =
  | {
      kind: 'commit';
      gotIt: boolean;
      replays?: number;
      latencyMs?: number | null;
      committedBeforeReveal?: boolean;
    }
  | { kind: 'auto'; correct: boolean; replays?: number; latencyMs?: number | null }
  | {
      kind: 'dictation';
      correctSyllables: number;
      toneErrors: number;
      totalSyllables: number;
      replays?: number;
    };

function toGrade(o: Outcome): Grade {
  switch (o.kind) {
    case 'commit':
      return gradeCommit({
        gotIt: o.gotIt,
        replays: o.replays ?? 0,
        latencyMs: o.latencyMs ?? null,
        committedBeforeReveal: o.committedBeforeReveal ?? true,
      });
    case 'auto':
      return gradeAuto({
        correct: o.correct,
        replays: o.replays ?? 0,
        latencyMs: o.latencyMs ?? null,
      });
    case 'dictation':
      return gradeDictation({
        correctSyllables: o.correctSyllables,
        toneErrors: o.toneErrors,
        totalSyllables: o.totalSyllables,
        replays: o.replays ?? 0,
      });
  }
}

/** Any CJK ideograph means the text is Mandarin rather than a translation request. */
const HAN = /[一-鿿㐀-䶿]/;

const startOfToday = (now: Date) =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

export function createApp({ db, now = () => new Date(), tones = [] }: Deps) {
  const app = new Hono();

  app.get('/api/health', (c) => c.json({ ok: true }));

  app.get('/api/tones', (c) => c.json({ sets: tones }));

  /**
   * Tone drills have no concept and therefore no card — they measure perception
   * rather than teach a word, so they are logged and reported but never scheduled.
   */
  app.post('/api/tone-answer', async (c) => {
    const body = (await c.req.json()) as {
      sessionId?: number | null;
      syllable: string;
      tone: number;
      answered: number;
      latencyMs?: number | null;
      exerciseType?: string;
      /** Extra detail merged into the event payload — shape varies by drill. */
      detail?: Record<string, unknown>;
    };
    if (!body.syllable || typeof body.tone !== 'number') {
      return c.json({ error: 'syllable and tone are required' }, 400);
    }
    const correct = body.answered === body.tone;
    await q.insertEvent(db, {
      ts: now().getTime(),
      sessionId: body.sessionId ?? null,
      kind: 'review',
      modality: 'listen',
      exerciseType: body.exerciseType ?? 'tone_id',
      result: correct ? 'good' : 'again',
      latencyMs: body.latencyMs ?? null,
      payload: {
        syllable: body.syllable,
        tone: body.tone,
        answered: body.answered,
        ...(body.detail ?? {}),
      },
    });
    return c.json({ correct });
  });

  /**
   * Tone accuracy, overall and per tone. Reported because self-report and measured
   * perception turned out to disagree sharply — an exercise can feel helpful while
   * accuracy sits at chance, and only the log knows which.
   */
  app.get('/api/tone-stats', async (c) => {
    const rows = await db.all<{ exercise_type: string; result: string; n: number }>(
      `SELECT exercise_type, result, count(*) AS n FROM event
       WHERE exercise_type IN ('tone_id', 'tone_same_diff') GROUP BY exercise_type, result`,
    );
    const tally = (ex: string) => {
      const good = rows.find((r) => r.exercise_type === ex && r.result === 'good')?.n ?? 0;
      const again = rows.find((r) => r.exercise_type === ex && r.result === 'again')?.n ?? 0;
      return { correct: good, wrong: again, total: good + again };
    };

    const perTone = await db.all<{ tone: number; ok: number; n: number }>(
      `SELECT json_extract(payload, '$.tone') AS tone,
              sum(CASE WHEN result = 'good' THEN 1 ELSE 0 END) AS ok,
              count(*) AS n
       FROM event WHERE exercise_type = 'tone_id'
       GROUP BY tone ORDER BY tone`,
    );

    const id = tally('tone_id');
    return c.json({ ...id, sameDiff: tally('tone_same_diff'), perTone });
  });

  app.post('/api/session', async (c) => {
    const id = await q.startSession(db);
    return c.json({ sessionId: id });
  });

  app.post('/api/session/:id/end', async (c) => {
    await q.endSession(db, Number(c.req.param('id')));
    return c.json({ ok: true });
  });

  /**
   * What to do next. Returns everything the client needs to render one rep, so a
   * drill is exactly one request in and one request out.
   */
  app.get('/api/next', async (c) => {
    const modality = (c.req.query('modality') ?? 'listen') as Modality;
    // The daily cap is a guard against bingeing, not a rule. An hour-long session
    // should never be stopped by it, so the client can raise it for the session.
    const maxNewPerDay = Number(c.req.query('maxNew') ?? 20);
    const at = now();

    const [concepts, cards, utterances, counts] = await Promise.all([
      q.loadConcepts(db),
      q.loadCards(db, modality),
      q.loadUtteranceRefs(db),
      q.utteranceCounts(db),
    ]);

    const introducedToday = await q.introducedSince(db, startOfToday(at), modality);

    const action = nextAction({
      concepts,
      cards,
      modality,
      utteranceCount: counts,
      utterances,
      now: at,
      introducedToday,
      maxNewPerDay,
    });

    const dueNow = cards.filter((k) => k.introducedAt !== null && k.dueAt <= at.getTime()).length;
    const queue = {
      due: dueNow,
      introducedToday,
      introduced: cards.filter((k) => k.introducedAt !== null).length,
      total: concepts.length,
    };

    if (action.type === 'idle') {
      // An idle screen with no way forward is where a study habit dies. Say *why*
      // it stopped and when the next card lands, so the UI can offer a way on.
      const introduced = cards.filter((k) => k.introducedAt !== null);
      const soonest = introduced.reduce<number | null>(
        (min, k) => (min === null || k.dueAt < min ? k.dueAt : min),
        null,
      );
      const remainingNew = introductionQueue(
        { concepts, cards, modality, utteranceCount: counts },
        1,
      ).length;
      return c.json({
        type: 'idle',
        reason: action.reason,
        // 'cap' means more material exists and only the daily limit is stopping you.
        cause: remainingNew > 0 && introducedToday >= maxNewPerDay ? 'cap' : 'nothing-due',
        nextDueAt: soonest,
        queue,
      });
    }

    const conceptId =
      action.type === 'review' ? action.card.conceptId : action.concept.id;
    const concept = concepts.find((x) => x.id === conceptId)!;
    const utterance = action.pick
      ? await q.loadUtteranceDetail(db, action.pick.utterance.id)
      : null;

    return c.json({
      type: action.type,
      concept,
      utterance,
      unknownCount: action.pick?.unknownCount ?? null,
      dueAt: action.type === 'review' ? action.card.dueAt : null,
      queue,
    });
  });

  /**
   * Record one rep. Grades it, advances the card, and writes the event log.
   */
  app.post('/api/answer', async (c) => {
    const body = (await c.req.json()) as {
      sessionId?: number | null;
      conceptId: number;
      utteranceId?: number | null;
      audioId?: number | null;
      modality?: Modality;
      exerciseType: string;
      outcome: Outcome;
    };

    if (typeof body.conceptId !== 'number' || !body.outcome?.kind) {
      return c.json({ error: 'conceptId and outcome are required' }, 400);
    }

    const modality: Modality = body.modality ?? 'listen';
    const at = now();
    const grade = toGrade(body.outcome);

    const existing = (await q.loadCards(db, modality)).find(
      (k) => k.conceptId === body.conceptId,
    );
    const before = existing ?? newCard(body.conceptId, modality, at);
    const result = review(before, grade, at);
    const cardId = await q.saveCard(db, result.card);

    const replays =
      'replays' in body.outcome ? (body.outcome.replays ?? 0) : 0;
    const latencyMs =
      'latencyMs' in body.outcome ? (body.outcome.latencyMs ?? null) : null;
    const committed =
      body.outcome.kind === 'commit' ? (body.outcome.committedBeforeReveal ?? true) : null;

    await q.insertEvent(db, {
      ts: at.getTime(),
      sessionId: body.sessionId ?? null,
      kind: 'review',
      conceptId: body.conceptId,
      cardId,
      utteranceId: body.utteranceId ?? null,
      audioId: body.audioId ?? null,
      modality,
      exerciseType: body.exerciseType,
      result: grade,
      latencyMs,
      replays,
      committedBeforeReveal: committed,
      payload: body.outcome.kind === 'dictation' ? body.outcome : undefined,
    });

    // Every other concept in the sentence was heard too. Logged as `exposure`, which
    // is counted and reported but deliberately does not drive FSRS — mixing
    // incidental exposure into a scheduler that assumes discrete scheduled reviews
    // is how these systems quietly break (docs/design.md §3).
    if (body.utteranceId) {
      const others = (await q.conceptIdsForUtterance(db, body.utteranceId)).filter(
        (id) => id !== body.conceptId,
      );
      for (const id of new Set(others)) {
        await q.insertEvent(db, {
          ts: at.getTime(),
          sessionId: body.sessionId ?? null,
          kind: 'exposure',
          conceptId: id,
          utteranceId: body.utteranceId,
          modality,
          exerciseType: body.exerciseType,
        });
      }
    }

    return c.json({
      grade,
      dueAt: result.card.dueAt,
      intervalDays: Math.round((result.intervalMs / 86_400_000) * 10) / 10,
      retentionAtDue: Math.round(result.retentionAtDue * 100) / 100,
    });
  });

  app.get('/api/stats', async (c) => {
    const modality = (c.req.query('modality') ?? 'listen') as Modality;
    const at = now();
    const [concepts, cards, utterances, latencies] = await Promise.all([
      q.loadConcepts(db),
      q.loadCards(db, modality),
      q.loadUtteranceRefs(db),
      q.recentLatencies(db),
    ]);

    const coverage = hskCoverage(concepts, cards, modality, at);
    const dayAgo = at.getTime() - 86_400_000;

    return c.json({
      modality,
      hsk: coverage,
      medianLatencyMs: medianLatency(latencies),
      due: cards.filter((k) => k.introducedAt !== null && k.dueAt <= at.getTime()).length,
      introduced: cards.filter((k) => k.introducedAt !== null).length,
      total: concepts.length,
      reviewsToday: await q.countEventsSince(db, startOfToday(at)),
      reviews24h: await q.countEventsSince(db, dayAgo),
      // How much new material is left. At a dozen or more words a day the corpus is
      // the real limiter, and it should be visible before it runs out rather than after.
      remainingNew: introductionQueue(
        { concepts, cards, modality, utteranceCount: await q.utteranceCounts(db) },
        10_000,
      ).length,
      // Should always be empty; surfaced because a corpus edit can create one.
      stranded: strandedCards(cards, modality, utterances).map((k) => k.conceptId),
    });
  });

  /**
   * Add Mandarin — the family-capture surface. Stores the raw text immediately and
   * returns a segmentation against known vocabulary, so nothing blocks the person
   * typing it in.
   */
  app.post('/api/capture', async (c) => {
    const body = (await c.req.json()) as { text?: string; capturedBy?: string };
    const text = (body.text ?? '').trim();
    if (!text) return c.json({ error: 'text is required' }, 400);

    const id = await q.addCapture(db, text, body.capturedBy ?? null);

    // Two different jobs share this box. Mandarin in is a capture — segment it
    // against what is known. English in is a *request* — "how do I say this" — and
    // segmenting it produces one bogus unknown word per Latin letter, which is
    // exactly what it did before this check existed.
    if (!HAN.test(text)) {
      await q.insertEvent(db, {
        ts: Date.now(),
        sessionId: null,
        kind: 'capture',
        payload: { captureId: id, language: 'en', pendingTranslation: true },
      });
      return c.json({
        captureId: id,
        text,
        language: 'en' as const,
        pendingTranslation: true,
        known: [],
        unknown: [],
        knownFraction: 0,
      });
    }

    const vocab = await q.knownHeadwords(db);
    const byHeadword = new Map(vocab.map((v) => [v.headword, v.id]));
    const { tokens, unknown } = segment(text, byHeadword.keys());

    await q.insertEvent(db, {
      ts: Date.now(),
      sessionId: null,
      kind: 'capture',
      payload: { captureId: id, language: 'zh', known: tokens.length, unknown: unknown.length },
    });

    return c.json({
      captureId: id,
      text,
      language: 'zh' as const,
      pendingTranslation: false,
      known: [...new Set(tokens)].map((t) => ({ headword: t, conceptId: byHeadword.get(t)! })),
      unknown: [...new Set(unknown)],
      knownFraction:
        tokens.length + unknown.length === 0
          ? 0
          : Math.round((tokens.length / (tokens.length + unknown.length)) * 100) / 100,
    });
  });

  app.get('/api/captures', async (c) => c.json(await q.listCaptures(db)));

  return app;
}

export type App = ReturnType<typeof createApp>;
