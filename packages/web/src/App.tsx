import { useCallback, useEffect, useState } from 'react';
import { api } from './api.ts';
import { Drill } from './Drill.tsx';
import { ToneDrill } from './ToneDrill.tsx';
import { Capture } from './Capture.tsx';
import { Stats } from './Stats.tsx';

type View = 'drill' | 'tones' | 'capture' | 'stats';

const TABS: [View, string][] = [
  ['drill', 'Drill'],
  ['tones', 'Tones'],
  ['capture', 'Add Mandarin'],
  ['stats', 'Progress'],
];

export function App() {
  const [started, setStarted] = useState(false);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [view, setView] = useState<View>('drill');
  const [answered, setAnswered] = useState(0);

  const begin = useCallback(async () => {
    try {
      const { sessionId: id } = await api.startSession();
      setSessionId(id);
    } catch {
      // A session id is only used to group events; drilling without one is fine.
    }
    setStarted(true);
  }, []);

  // End the session on the way out so `ended_at` is meaningful.
  useEffect(() => {
    if (sessionId === null) return;
    const end = () => navigator.sendBeacon?.(`/api/session/${sessionId}/end`);
    window.addEventListener('pagehide', end);
    return () => window.removeEventListener('pagehide', end);
  }, [sessionId]);

  /**
   * Browsers block audio until a user gesture, so the first clip of the day would
   * silently fail without this. It doubles as a deliberate start to the session.
   */
  if (!started) {
    return (
      <main className="mx-auto grid min-h-dvh max-w-2xl place-items-center px-6">
        <div className="text-center">
          <h1 className="text-3xl">Mandarin</h1>
          <p className="mt-3 text-stone-500">
            Listening first. Headphones on — audio plays as soon as a card appears.
          </p>
          <button className="btn btn-primary mt-8 px-8 py-3 text-lg" onClick={() => void begin()}>
            Start
          </button>
          <p className="hint mt-6">
            <kbd>Space</kbd> replay · <kbd>1</kbd> missed · <kbd>2</kbd> got it · <kbd>Enter</kbd> next
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-8">
      <header className="mb-8 flex flex-wrap items-center gap-2">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            className="tab"
            aria-current={view === id}
            onClick={() => {
              setView(id);
              if (id === 'stats') setAnswered((n) => n + 1);
            }}
          >
            {label}
          </button>
        ))}
      </header>

      <div className="min-h-[26rem]">
        {view === 'drill' && (
          <Drill sessionId={sessionId} onAnswered={() => setAnswered((n) => n + 1)} />
        )}
        {view === 'tones' && <ToneDrill sessionId={sessionId} />}
        {view === 'capture' && <Capture />}
        {view === 'stats' && <Stats refreshKey={answered} />}
      </div>
    </main>
  );
}
