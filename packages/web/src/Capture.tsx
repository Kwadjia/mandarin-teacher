import { useEffect, useState } from 'react';
import { api, type CaptureResponse } from './api.ts';

/**
 * Add Mandarin — the family-capture surface.
 *
 * The raw text is stored the moment it is submitted, before any analysis. Nothing
 * blocks the person typing it in, because the whole value of this surface is that
 * it costs nothing to use when Jasmine says something worth keeping.
 */
export function Capture() {
  const [text, setText] = useState('');
  const [who, setWho] = useState('jasmine');
  const [result, setResult] = useState<CaptureResponse | null>(null);
  const [recent, setRecent] = useState<{ id: number; raw_text: string | null; captured_by: string | null }[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = () => void api.captures().then(setRecent).catch(() => {});
  useEffect(refresh, []);

  const submit = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      setResult(await api.capture(t, who));
      setText('');
      refresh();
    } catch {
      /* keep the text so nothing is lost */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="label">Heard something worth keeping?</p>
      <p className="mt-1 text-sm text-stone-500">
        Type or paste it. It is saved immediately and segmented against what you already know.
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <input
          className="input flex-1 text-xl"
          value={text}
          placeholder="宝宝该睡觉了"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
        />
        <select className="input" value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="jasmine">Jasmine</option>
          <option value="nainai">Nainai</option>
          <option value="arthur">Me</option>
          <option value="media">Media</option>
        </select>
        <button className="btn btn-primary" disabled={busy || !text.trim()} onClick={() => void submit()}>
          Add
        </button>
      </div>

      {result && (
        <div className="mt-6 rounded-xl border border-stone-200 p-4 dark:border-stone-800">
          <p className="text-2xl">
            {result.known.length + result.unknown.length === 0 ? (
              <span className="text-stone-400">nothing recognisable</span>
            ) : (
              <>
                {result.known.map((k) => (
                  <span key={k.conceptId} className="tok known">
                    {k.headword}
                  </span>
                ))}
                {result.unknown.map((u) => (
                  <span key={u} className="tok unknown">
                    {u}
                  </span>
                ))}
              </>
            )}
          </p>
          <p className="mt-3 text-sm text-stone-500">
            <b className="text-stone-700 dark:text-stone-300">
              {Math.round(result.knownFraction * 100)}% known
            </b>{' '}
            · {result.known.length} familiar, {result.unknown.length} new
          </p>
          {result.unknown.length > 0 && (
            <p className="mt-2 text-sm text-stone-500">
              New words are queued for the pipeline to resolve — pinyin, gloss, and example
              sentences built only from vocabulary you already have.
            </p>
          )}
        </div>
      )}

      {recent.length > 0 && (
        <div className="mt-10">
          <p className="label">Recent captures</p>
          <ul className="mt-2 space-y-1">
            {recent.slice(0, 12).map((r) => (
              <li key={r.id} className="flex items-baseline gap-3 text-lg">
                <span>{r.raw_text}</span>
                <span className="text-xs text-stone-400">{r.captured_by}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
