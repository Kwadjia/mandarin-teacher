/**
 * Typed client for the API. Mirrors packages/api/src/app.ts.
 *
 * Note what is *not* here: any grading logic. The client reports what happened and
 * the server decides what it was worth (docs/design.md §2.9).
 */

export type Modality = 'listen' | 'speak' | 'read';
export type Grade = 'again' | 'hard' | 'good' | 'easy';

export interface Concept {
  id: number;
  headword: string;
  headwordTrad: string;
  pinyin: string;
  glossEn: string;
  source: 'core' | 'personal' | 'emergent';
  hskLevel: number | null;
}

export interface Clip {
  id: number;
  url: string;
  voice: string;
  variety: 'tw' | 'cn';
  rate: string;
}

export interface Utterance {
  id: number;
  hanzi: string;
  hanziTrad: string;
  pinyin: string;
  glossEn: string;
  clips: Clip[];
}

export interface Queue {
  due: number;
  introducedToday: number;
  introduced: number;
  total: number;
}

export type NextResponse =
  | { type: 'review' | 'introduce'; concept: Concept; utterance: Utterance | null; unknownCount: number | null; dueAt: number | null; queue: Queue }
  | {
      type: 'idle';
      reason: string;
      /** 'cap' = more material exists, only the daily limit is stopping you. */
      cause: 'cap' | 'nothing-due';
      nextDueAt: number | null;
      queue: Queue;
    };

export interface AnswerResponse {
  grade: Grade;
  dueAt: number;
  intervalDays: number;
  retentionAtDue: number;
}

export interface Stats {
  modality: Modality;
  hsk: { estimate: number; perLevel: { level: number; total: number; known: number; coverage: number }[]; shaky: number };
  medianLatencyMs: number | null;
  due: number;
  introduced: number;
  total: number;
  reviewsToday: number;
  reviews24h: number;
  remainingNew: number;
  stranded: number[];
}

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

/** One syllable of a spoken attempt, measured by the local scorer. */
export interface ScoredSyllable {
  char: string;
  /** The character heard here, or null if the syllable was not said at all. */
  said: string | null;
  /** Expected pinyin with diacritics, e.g. 'niào'. */
  pinyin: string;
  /** Pinyin of what was heard. Same base with a different mark means a tone slip. */
  saidPinyin: string | null;
  /** Expected tone; 0 = neutral. */
  tone: number;
  heardTone: number | null;
  /** Right base syllable — the sound was right, whatever the tone did. */
  correct: boolean;
  /** What to change: tone, vowel, consonant, or a different word entirely. */
  errorKind: 'tone' | 'vowel' | 'consonant' | 'different' | null;
  /** Semitones from the native contour. Null when it could not be measured. */
  distance: number | null;
  verdict: 'good' | 'close' | 'tone' | 'wrong' | 'missing' | 'unscored';
  /** Pitch shapes for drawing, in semitones relative to each speaker's median. */
  learner: number[];
  reference: number[];
}

export interface SpeechScore {
  unusable: boolean;
  reason: string | null;
  transcript: string;
  target: string;
  syllables: ScoredSyllable[];
  totalSyllables: number;
  correctSyllables: number;
  toneErrors: number;
  scoredSyllables: number;
  meanToneDistance: number | null;
  elapsedMs?: number;
}

/** A recording that could not be scored is not graded at all — no card change. */
export type SpeakResponse =
  | ({ unusable: false; score: SpeechScore } & AnswerResponse)
  | { unusable: true; reason: string | null; score: SpeechScore };

export interface PlanBlock {
  kind: 'review' | 'new';
  modality: Modality;
  reps: number;
  reason: string;
  /** Null when there is no measured pace yet — shown as unknown, never guessed. */
  estimateMs: number | null;
}

export interface Plan {
  blocks: PlanBlock[];
  totalMs: number | null;
  /** Consecutive active days. Forgives one miss a week — a newborn is arriving. */
  streak: { days: number; todayDone: boolean; graceUsed: number };
  /** Taken from the schedule, not a round number. */
  target: { reps: number; done: number; met: boolean; planCleared: boolean };
  points: { total: number; level: number; into: number; span: number };
  /** A sentence to say to an actual person today, from words already known. */
  phrase: { hanzi: string; hanziTrad: string; pinyin: string; glossEn: string } | null;
  states: {
    modality: Modality;
    due: number;
    newAvailable: number;
    introducedToday: number;
    dailyCap: number;
  }[];
  standing: {
    /** Passing the retention test — legitimately 0 for the first couple of weeks. */
    solid: number;
    /** Introduced and in rotation. */
    learning: number;
    total: number;
    medianLatencyMs: number | null;
    reviewsToday: number;
  };
  watch: {
    tone: { correct: number; total: number };
    remainingNew: number;
  };
}

export interface CaptureResponse {
  captureId: number;
  text: string;
  /** 'en' means it is a translation request rather than a capture. */
  language: 'zh' | 'en';
  pendingTranslation: boolean;
  known: { headword: string; conceptId: number }[];
  unknown: string[];
  knownFraction: number;
}

export type ChoiceKind = 'meaning-match' | 'which-one' | 'cloze';

/** Options arrive shuffled and unmarked; only the server knows which is right. */
export interface ChoiceOption {
  conceptId: number;
  label: string;
  sub: string | null;
}

export type ChoiceItem =
  | {
      type: 'item';
      kind: ChoiceKind;
      conceptId: number;
      utteranceId: number;
      clips: Clip[];
      options: ChoiceOption[];
      /** Cloze only: the sentence with the target blanked out. */
      prompt: string | null;
    }
  | { type: 'idle'; reason: string };

export interface ChoiceResult {
  correct: boolean;
  grade: Grade;
  intervalDays: number;
  /** False when a correct early answer deliberately left the schedule alone. */
  rescheduled: boolean;
  concept: Concept | null;
  utterance: { hanzi: string; hanziTrad: string; pinyin: string; glossEn: string } | null;
}

/** One dictation item — audio only. The text would be the answer key. */
export type DictationItem =
  | { type: 'item'; utteranceId: number; syllableCount: number; clips: Clip[]; dueNow: number }
  | { type: 'idle'; reason: string };

export interface DictationSyllable {
  expected: string;
  given: string | null;
  correct: boolean;
  verdict: 'correct' | 'tone' | 'wrong' | 'missing';
}

export interface DictationResult {
  grade: Grade;
  check: {
    syllables: DictationSyllable[];
    totalSyllables: number;
    correctSyllables: number;
    toneErrors: number;
    extra: number;
  };
  hanzi: string;
  hanziTrad: string;
  pinyin: string;
  glossEn: string;
}

export interface ToneReport {
  perTone: { tone: number; correct: number; total: number; heardAs: Record<number, number> }[];
  attempts: number;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status} ${detail}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  startSession: () => json<{ sessionId: number }>('/api/session', { method: 'POST' }),
  endSession: (id: number) => json<{ ok: true }>(`/api/session/${id}/end`, { method: 'POST' }),

  next: (modality: Modality = 'listen', maxNew?: number) =>
    json<NextResponse>(
      `/api/next?modality=${modality}` + (maxNew ? `&maxNew=${maxNew}` : ''),
    ),

  answer: (body: {
    sessionId: number | null;
    conceptId: number;
    utteranceId: number | null;
    audioId: number | null;
    exerciseType: string;
    /** Extra drilling beyond what is due; a correct answer will not move the card. */
    practice?: boolean;
    outcome:
      | { kind: 'commit'; gotIt: boolean; replays: number; latencyMs: number | null; committedBeforeReveal: boolean }
      | { kind: 'auto'; correct: boolean; replays: number; latencyMs: number | null };
  }) => json<AnswerResponse>('/api/answer', { method: 'POST', body: JSON.stringify(body) }),

  stats: (modality: Modality = 'listen') => json<Stats>(`/api/stats?modality=${modality}`),

  health: () => json<{ ok: boolean; speech: boolean }>('/api/health'),

  plan: (maxNew?: number) => json<Plan>('/api/plan' + (maxNew ? `?maxNew=${maxNew}` : '')),

  /**
   * Drill what is already known, ignoring due dates and introducing nothing new.
   *
   * `seen` is the concepts already served this run, so the queue cycles through the
   * whole set rather than handing back the weakest word forever.
   */
  practice: (modality: Modality = 'listen', seen: number[] = []) =>
    json<NextResponse>(
      `/api/next?modality=${modality}&mode=practice` +
        (seen.length ? `&seen=${seen.join(',')}` : ''),
    ),

  /** A multiple-choice listening item. Options come shuffled and unmarked. */
  choice: (kind: ChoiceKind) => json<ChoiceItem>(`/api/choice?kind=${kind}`),
  choiceAnswer: (body: {
    sessionId: number | null;
    conceptId: number;
    utteranceId: number;
    audioId: number | null;
    chosenConceptId: number;
    kind: ChoiceKind;
    replays: number;
    latencyMs: number | null;
    practice?: boolean;
  }) => json<ChoiceResult>('/api/choice', { method: 'POST', body: JSON.stringify(body) }),

  /** Audio only — the sentence text is withheld until the answer is submitted. */
  dictation: () => json<DictationItem>('/api/dictation'),
  dictationAnswer: (body: {
    sessionId: number | null;
    utteranceId: number;
    answer: string;
    replays: number;
    latencyMs: number | null;
  }) => json<DictationResult>('/api/dictation', { method: 'POST', body: JSON.stringify(body) }),
  toneReport: () => json<ToneReport>('/api/tone-report'),

  /**
   * Upload one spoken attempt. Multipart rather than JSON so the recording goes up as
   * bytes instead of base64, and the server returns the grade — the browser measures
   * nothing and grades nothing (docs/design.md §2.9).
   */
  speak: (body: {
    sessionId: number | null;
    conceptId: number;
    utteranceId: number;
    audioId: number | null;
    replays: number;
    audio: Blob;
  }) => {
    const form = new FormData();
    form.set('audio', body.audio, 'attempt.webm');
    form.set('conceptId', String(body.conceptId));
    form.set('utteranceId', String(body.utteranceId));
    form.set('replays', String(body.replays));
    if (body.audioId !== null) form.set('audioId', String(body.audioId));
    if (body.sessionId !== null) form.set('sessionId', String(body.sessionId));
    // No content-type header: the browser must set the multipart boundary itself.
    return fetch('/api/speak', { method: 'POST', body: form }).then(async (res) => {
      if (!res.ok) throw new Error((await res.text().catch(() => '')) || `HTTP ${res.status}`);
      return res.json() as Promise<SpeakResponse>;
    });
  },

  tones: () => json<{ sets: ToneSet[] }>('/api/tones'),
  toneAnswer: (body: {
    sessionId: number | null;
    syllable: string;
    tone: number;
    answered: number;
    latencyMs: number | null;
    exerciseType?: string;
    detail?: Record<string, unknown>;
  }) => json<{ correct: boolean }>('/api/tone-answer', { method: 'POST', body: JSON.stringify(body) }),
  toneStats: () =>
    json<{
      correct: number;
      wrong: number;
      total: number;
      sameDiff: { correct: number; wrong: number; total: number };
      perTone: { tone: number; ok: number; n: number }[];
    }>('/api/tone-stats'),

  capture: (text: string, capturedBy?: string) =>
    json<CaptureResponse>('/api/capture', {
      method: 'POST',
      body: JSON.stringify({ text, capturedBy }),
    }),
  captures: () =>
    json<{ id: number; ts: number; raw_text: string | null; captured_by: string | null }[]>(
      '/api/captures',
    ),
};


