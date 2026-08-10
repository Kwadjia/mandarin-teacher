import { useCallback, useEffect, useRef, useState } from 'react';
import type { Clip } from './api.ts';

/**
 * Audio playback for a drill.
 *
 * Two behaviours worth naming:
 *
 * 1. A random clip is drawn per rep — different voice, different speed, Taiwan or
 *    mainland. Voice variety is the default policy rather than an opt-in mode, so
 *    understanding one speaker and freezing at anyone else never becomes a habit.
 *
 * 2. `replays` is counted and reported. Needing the audio three times is not the
 *    same as knowing it, and the server discounts the grade accordingly — the
 *    learner does not have to be honest enough to admit it.
 */
export function useAudio() {
  const el = useRef<HTMLAudioElement | null>(null);
  const [replays, setReplays] = useState(0);
  const [playing, setPlaying] = useState(false);
  /** Set when playback finishes — the clock for comprehension latency starts here. */
  const endedAt = useRef<number | null>(null);
  /**
   * Whether this item has been heard at all yet. The *first* play is not a replay.
   * Callers must not decide this themselves: First Exposure does not autoplay, so
   * making the caller pass a flag meant its initial Play click was counted as a
   * replay and every single introduction was graded `hard` instead of `good`.
   */
  const heard = useRef(false);

  useEffect(() => {
    const audio = new Audio();
    audio.preload = 'auto';
    audio.addEventListener('play', () => setPlaying(true));
    audio.addEventListener('pause', () => setPlaying(false));
    audio.addEventListener('ended', () => {
      setPlaying(false);
      endedAt.current = performance.now();
    });
    el.current = audio;
    return () => {
      audio.pause();
      el.current = null;
    };
  }, []);

  const play = useCallback((url: string) => {
    const audio = el.current;
    if (!audio) return;
    audio.src = url;
    audio.currentTime = 0;
    endedAt.current = null;
    void audio.play().catch(() => {
      // Autoplay blocked until the first gesture; the Start screen handles that.
    });
    if (heard.current) setReplays((n) => n + 1);
    else heard.current = true;
  }, []);

  const reset = useCallback(() => {
    setReplays(0);
    heard.current = false;
    endedAt.current = null;
    el.current?.pause();
  }, []);

  /** Milliseconds from audio end to now. Null if the clip never finished. */
  const latencySince = useCallback(
    () => (endedAt.current === null ? null : Math.round(performance.now() - endedAt.current)),
    [],
  );

  return { play, reset, replays, playing, latencySince };
}

export const pickClip = (clips: Clip[]): Clip | null =>
  clips.length ? clips[Math.floor(Math.random() * clips.length)]! : null;

export const voiceLabel = (c: Clip) =>
  `${c.variety.toUpperCase()} ${c.voice.split('-').pop()?.replace('Neural', '') ?? ''} · ${c.rate}`;
