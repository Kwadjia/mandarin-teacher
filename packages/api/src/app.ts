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
  gradeSpeak,
  hskCoverage,
  introductionQueue,
  measurePace,
  medianLatency,
  newCard,
  nextAction,
  planDuration,
  planSession,
  review,
  strandedCards,
  type Grade,
  type Modality,
  type ModalityState,
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

/** One syllable of a spoken attempt, as measured by pipeline/speech_score.py. */
export interface ScoredSyllable {
  char: string;
  /** The character the recogniser heard here; null if the syllable was not said. */
  said: string | null;
  /** Expected pinyin with diacritics, e.g. 'niào'. */
  pinyin: string;
  /** Pinyin of what was heard — 'niǎo' against 'niào' is a tone error, not a word error. */
  saidPinyin: string | null;
  tone: number;
  heardTone: number | null;
  /** Right base syllable: the sound landed, whatever happened to the tone. */
  correct: boolean;
  /** What to change: tone, vowel, consonant, or a different word entirely. */
  errorKind: 'tone' | 'vowel' | 'consonant' | 'different' | null;
  distance: number | null;
  verdict: 'good' | 'close' | 'tone' | 'wrong' | 'missing' | 'unscored';
  learner: number[];
  reference: number[];
}

export interface SpeechScore {
  /** True when the recording could not be scored at all — see §2.12. */
  unusable: boolean;
  reason: string | null;
  transcript: string;
  target: string;
  confidence?: number | null;
  syllables: ScoredSyllable[];
  totalSyllables: number;
  correctSyllables: number;
  toneErrors: number;
  scoredSyllables: number;
  meanToneDistance: number | null;
  elapsedMs?: number;
  referenceUsed?: string | null;
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
  /**
   * Sends a recording to the local scoring service (pipeline/speech_server.py).
   *
   * Injected rather than imported so the API keeps no opinion about how scoring
   * happens, and so tests can exercise the speaking route without a GPU. Absent
   * means speaking is unavailable, which the route reports plainly instead of
   * failing in a way that looks like a bug.
   */
  scoreSpeech?: (input: {
    audio: ArrayBuffer;
    mimeType: string;
    hanzi: string;
    pinyin: string;
    reference: string | null;
  }) => Promise<SpeechScore>;
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

export function createApp({ db, now = () => new Date(), tones = [], scoreSpeech }: Deps) {
  const app = new Hono();

  app.get('/api/health', (c) => c.json({ ok: true, speech: Boolean(scoreSpeech) }));

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

    // Listening comes first, and that ordering is enforced here rather than left to
    // habit: a word is only eligible to be spoken once its listening card exists.
    // Otherwise the speak queue would introduce brand-new vocabulary on its own and
    // ask for production of a word that has never been heard — backwards for this
    // learner, and the fastest route to drilling a mispronunciation into place.
    let candidates = concepts;
    if (modality === 'speak') {
      const heard = await q.loadCards(db, 'listen');
      const ready = new Set(
        heard.filter((k) => k.introducedAt !== null).map((k) => k.conceptId),
      );
      candidates = concepts.filter((x) => ready.has(x.id));
    }

    const action = nextAction({
      concepts: candidates,
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
      // Eligible concepts, not all of them — for speaking that is what has been heard.
      total: candidates.length,
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
        { concepts: candidates, cards, modality, utteranceCount: counts },
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

  /**
   * Score one spoken attempt, grade it, and log it.
   *
   * The browser uploads a recording and the target; it never sees a grade it could
   * have influenced. Two measurements come back from the scorer and both are kept:
   * which words were recognised, and how far each syllable's pitch contour sat from
   * a native reading. The second is the whole reason this exists — whisper decodes to
   * the likeliest text and will hand back the right character for a mispronounced
   * tone, so transcription alone would quietly certify bad pronunciation as correct.
   *
   * Failures here are reported as 503 rather than 500: the scoring service being
   * down is an operational state with an obvious remedy, not a bug in the app.
   */
  app.post('/api/speak', async (c) => {
    if (!scoreSpeech) {
      return c.json(
        { error: 'Speech scoring is not running. Start it with: npm run speech' },
        503,
      );
    }

    const form = await c.req.formData();
    const audio = form.get('audio');
    const conceptId = Number(form.get('conceptId'));
    const utteranceId = form.get('utteranceId') ? Number(form.get('utteranceId')) : null;

    if (!(audio instanceof File) || !Number.isFinite(conceptId) || !utteranceId) {
      return c.json({ error: 'audio, conceptId and utteranceId are required' }, 400);
    }

    const utterance = await q.loadUtteranceDetail(db, utteranceId);
    if (!utterance) return c.json({ error: 'unknown utterance' }, 404);

    // Score against the clip actually heard when there is one, so prosody and speed
    // match what was being imitated. Otherwise any native reading of the sentence.
    const audioId = form.get('audioId') ? Number(form.get('audioId')) : null;
    const heard = utterance.clips.find((x) => x.id === audioId) ?? utterance.clips[0];

    let score: SpeechScore;
    try {
      score = await scoreSpeech({
        audio: await audio.arrayBuffer(),
        mimeType: audio.type || 'audio/webm',
        hanzi: utterance.hanzi,
        pinyin: utterance.pinyin,
        reference: heard ? heard.url.replace(/^\/audio\//, '') : null,
      });
    } catch (e) {
      return c.json({ error: `Scoring failed: ${(e as Error).message}` }, 503);
    }

    const replays = Number(form.get('replays') ?? 0);
    const sessionId = form.get('sessionId') ? Number(form.get('sessionId')) : null;

    /**
     * Nothing recognisable in the recording. Do not grade it and do not touch the card.
     *
     * Whisper hallucinates fluently on unclear input — real attempts came back as
     * "99888" and "宝宝SOLA" — and grading those produced `again` on words that were
     * very likely said correctly. A microphone problem must not be recorded as a
     * failure to speak Mandarin: it corrupts the learner model with mistakes that were
     * never made, and no amount of later practice explains the dip away.
     *
     * Logged as a `note` so the log still shows it happened, while every review query
     * — counts, latencies, accuracy — filters on `kind = 'review'` and ignores it.
     */
    if (score.unusable) {
      await q.insertEvent(db, {
        ts: now().getTime(),
        sessionId,
        kind: 'note',
        conceptId,
        utteranceId,
        modality: 'speak',
        exerciseType: 'shadow',
        payload: { unusable: true, reason: score.reason, transcript: score.transcript },
      });
      return c.json({ unusable: true, reason: score.reason, score });
    }

    const measured = gradeSpeak({
      correctSyllables: score.correctSyllables,
      totalSyllables: score.totalSyllables,
      toneErrors: score.toneErrors,
      scoredSyllables: score.scoredSyllables,
      replays,
    });

    const existing = (await q.loadCards(db, 'speak')).find((k) => k.conceptId === conceptId);

    // A first attempt is never worth `easy`. Saying a word correctly once, immediately
    // after hearing it, is imitation rather than production — FSRS reads `easy` on a
    // new card as a fortnight, and a mouth that has done something once does not
    // remember how in two weeks. Same reasoning as First Exposure on the listening side.
    const grade: Grade = !existing && measured === 'easy' ? 'good' : measured;
    const before = existing ?? newCard(conceptId, 'speak', now());
    const result = review(before, grade, now());
    const cardId = await q.saveCard(db, result.card);

    await q.insertEvent(db, {
      ts: now().getTime(),
      sessionId,
      kind: 'review',
      conceptId,
      cardId,
      utteranceId,
      audioId: heard?.id ?? null,
      modality: 'speak',
      exerciseType: 'shadow',
      result: grade,
      replays,
      // The contours are dropped before logging — they are hundreds of floats per
      // attempt, useful for drawing the feedback once and worthless afterwards. The
      // verdicts are what a later analysis would want.
      payload: {
        transcript: score.transcript,
        // Kept because the first two rounds of threshold tuning were done without it,
        // against synthetic audio, and both were wrong.
        confidence: score.confidence ?? null,
        correctSyllables: score.correctSyllables,
        totalSyllables: score.totalSyllables,
        toneErrors: score.toneErrors,
        scoredSyllables: score.scoredSyllables,
        meanToneDistance: score.meanToneDistance,
        verdicts: score.syllables.map((s) => s.verdict),
        heard: score.syllables.map((s) => s.saidPinyin),
      },
    });

    return c.json({
      unusable: false,
      grade,
      dueAt: result.card.dueAt,
      intervalDays: Math.round((result.intervalMs / 86_400_000) * 10) / 10,
      retentionAtDue: Math.round(result.retentionAtDue * 100) / 100,
      score,
    });
  });

  /**
   * The home screen: what to do next, why, and how long it should take.
   *
   * Everything here is derived from the log rather than configured. The session
   * estimate uses measured gaps between the learner's own reps, and the "watch" items
   * are the two things the data says are actually going wrong — tone perception sitting
   * at chance, and the corpus running out.
   */
  app.get('/api/plan', async (c) => {
    const at = now();
    const maxNewPerDay = Number(c.req.query('maxNew') ?? 15);
    const today = startOfToday(at);

    const [concepts, counts, gaps] = await Promise.all([
      q.loadConcepts(db),
      q.utteranceCounts(db),
      q.repGaps(db),
    ]);

    const heard = await q.loadCards(db, 'listen');
    const speakable = new Set(
      heard.filter((k) => k.introducedAt !== null).map((k) => k.conceptId),
    );

    const states: ModalityState[] = [];
    for (const modality of ['listen', 'speak'] as Modality[]) {
      const cards = await q.loadCards(db, modality);
      // Speaking draws only on words already heard — the same gate /api/next applies.
      const eligible = modality === 'speak' ? concepts.filter((x) => speakable.has(x.id)) : concepts;
      states.push({
        modality,
        due: cards.filter((k) => k.introducedAt !== null && k.dueAt <= at.getTime()).length,
        newAvailable: introductionQueue(
          { concepts: eligible, cards, modality, utteranceCount: counts },
          10_000,
        ).length,
        introducedToday: await q.introducedSince(db, today, modality),
        dailyCap: maxNewPerDay,
      });
    }

    const paceMs = new Map<string, number>();
    for (const key of ['listen:review', 'listen:new', 'speak:review', 'speak:new']) {
      const [m, k] = key.split(':');
      const p = measurePace(
        gaps.filter((g) => g.modality === m && g.kind === k).map((g) => g.gap),
      );
      if (p !== null) paceMs.set(key, p);
    }

    const blocks = planSession({ states, paceMs });

    const listenCards = heard;
    const coverage = hskCoverage(concepts, listenCards, 'listen', at);
    const toneRow = await db.first<{ ok: number; n: number }>(
      `SELECT sum(CASE WHEN result = 'good' THEN 1 ELSE 0 END) AS ok, count(*) AS n
       FROM event WHERE exercise_type = 'tone_id'`,
    );

    return c.json({
      blocks,
      totalMs: planDuration(blocks),
      states,
      standing: {
        // Three counts that mean different things and were being conflated. `solid`
        // uses the retention test — predicted 85% recall at a fortnight — so it is
        // legitimately zero for the first couple of weeks, and the UI has to say that
        // rather than present a bare 0 next to a 12 and let them contradict each other.
        solid: coverage.perLevel.reduce((n, l) => n + l.known, 0),
        learning: listenCards.filter((k) => k.introducedAt !== null).length,
        total: concepts.length,
        medianLatencyMs: medianLatency(await q.recentLatencies(db)),
        reviewsToday: await q.countEventsSince(db, today),
      },
      // Surfaced because the log disagrees with how these feel. Tone ID has sat below
      // chance for a four-way choice since the first session.
      watch: {
        tone: { correct: toneRow?.ok ?? 0, total: toneRow?.n ?? 0 },
        remainingNew: states.find((s) => s.modality === 'listen')?.newAvailable ?? 0,
      },
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
