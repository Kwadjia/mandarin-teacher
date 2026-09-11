import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Microphone capture for the speaking drill.
 *
 * The stream is opened once and held for the session rather than per attempt. Asking
 * getUserMedia on every rep costs a few hundred milliseconds and, in some browsers,
 * re-triggers the permission chrome — both of which land squarely between hearing a
 * sentence and repeating it, which is the one moment that has to feel immediate.
 */

export type RecorderState = 'idle' | 'ready' | 'recording' | 'denied' | 'unsupported';

export interface Recording {
  blob: Blob;
  url: string;
  durationMs: number;
}

export function useRecorder() {
  const [state, setState] = useState<RecorderState>('idle');
  const [recording, setRecording] = useState<Recording | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const startedAt = useRef(0);
  /** Revoked on replacement — object URLs are not garbage collected on their own. */
  const lastUrl = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      stream.current?.getTracks().forEach((t) => t.stop());
      if (lastUrl.current) URL.revokeObjectURL(lastUrl.current);
    };
  }, []);

  const arm = useCallback(async () => {
    if (stream.current) {
      // Holding the stream for the session is a desktop luxury. Phone browsers
      // reclaim the microphone between takes — the track flips to 'ended' with no
      // event the UI reacts to — and recording from a dead track produces a few
      // bytes of container tail that the scorer can do nothing with. One take
      // worked, every take after it "failed", and the mic looked on the whole time.
      if (stream.current.getAudioTracks().some((t) => t.readyState === 'ended')) {
        stream.current.getTracks().forEach((t) => t.stop());
        stream.current = null;
      } else {
        return true;
      }
    }
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setState('unsupported');
      return false;
    }
    try {
      // Browser DSP is left on deliberately. It is tuned for speech, the scorer only
      // reads pitch and phonemes, and a learner's room is not a recording booth.
      stream.current = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      setState('ready');
      return true;
    } catch (e) {
      setError((e as Error).message);
      setState('denied');
      return false;
    }
  }, []);

  const start = useCallback(async () => {
    if (!(await arm())) return;
    if (recorder.current?.state === 'recording') return;

    // Each recorder owns its chunks. A shared buffer had a race: starting the next
    // take before the previous recorder's onstop fired would wipe or cross-wire the
    // two recordings.
    const chunks: Blob[] = [];
    const mr = new MediaRecorder(stream.current!, {
      mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : '',
    });
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mr.onstop = () => {
      const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
      if (lastUrl.current) URL.revokeObjectURL(lastUrl.current);
      lastUrl.current = URL.createObjectURL(blob);
      setRecording({ blob, url: lastUrl.current, durationMs: Date.now() - startedAt.current });
      setState('ready');
    };
    recorder.current = mr;
    startedAt.current = Date.now();
    mr.start();
    setState('recording');
  }, [arm]);

  const stop = useCallback(() => {
    if (recorder.current?.state === 'recording') recorder.current.stop();
  }, []);

  const reset = useCallback(() => {
    setRecording(null);
    setError(null);
  }, []);

  return { state, recording, error, arm, start, stop, reset };
}
