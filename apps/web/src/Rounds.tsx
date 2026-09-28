import { useEffect, useRef, useState } from 'react';
import type { Quiz } from './Admin';
import { Questions } from './Questions';

export type Round = {
  id: string;
  quizId: string;
  titleRu: string;
  titleEn: string;
  descriptionRu: string;
  descriptionEn: string;
  showLeaderboardAfter: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
};

type RoundChanges = Pick<Round, 'titleRu' | 'titleEn' | 'descriptionRu' | 'descriptionEn' | 'showLeaderboardAfter'>;

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${response.status}).`);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export function Rounds({ quizId, targetRound, onPersistedChange, quiz }: { quiz?: Quiz; quizId: string; targetRound?: { id: string } | null; onPersistedChange?: () => void }) {
  const base = `/api/quizzes/${quizId}/rounds`;
  const [rounds, setRounds] = useState<Round[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Saved');
  const [error, setError] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ id: string; changes: RoundChanges } | null>(null);
  const revision = useRef(0);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const incomplete = useRef(false);
  const appliedTarget = useRef<typeof targetRound>(null);

  useEffect(() => {
    if (targetRound && targetRound !== appliedTarget.current && rounds.some((round) => round.id === targetRound.id)) {
      appliedTarget.current = targetRound;
      setSelectedId(targetRound.id);
    }
  }, [targetRound, rounds]);

  useEffect(() => {
    let active = true;
    api<Round[]>(base).then((items) => {
      if (active) {
        setRounds(items);
        setSelectedId(items[0]?.id ?? null);
      }
    }).catch((cause: Error) => { if (active) setError(cause.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [base]);

  function flush() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (!pending.current) return;
    const { id, changes } = pending.current;
    pending.current = null;
    const version = revision.current;
    saveChain.current = saveChain.current.then(async () => {
      try {
        await api<Round>(`${base}/${id}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes),
        });
        onPersistedChange?.();
        if (version === revision.current) { setStatus('Saved'); setError(''); }
      } catch (cause) {
        if (version === revision.current) { setStatus('Save failed'); setError((cause as Error).message); }
      }
    });
  }

  useEffect(() => () => { flush(); }, [quizId]);

  function change(round: Round, changes: RoundChanges) {
    setRounds((current) => current.map((item) => item.id === round.id ? { ...item, ...changes } : item));
    revision.current += 1;
    if (timer.current) clearTimeout(timer.current);
    pending.current = null;
    const valid = Boolean(changes.titleRu.trim() && changes.titleEn.trim()) &&
      Boolean(changes.descriptionRu.trim()) === Boolean(changes.descriptionEn.trim());
    incomplete.current = !valid;
    if (!valid) {
      setStatus('Complete both languages to save');
      setError('');
      return;
    }
    setStatus('Saving...');
    setError('');
    pending.current = { id: round.id, changes };
    timer.current = setTimeout(flush, 400);
  }

  async function add() {
    flush();
    await saveChain.current;
    setBusy(true);
    try {
      const round = await api<Round>(base, { method: 'POST' });
      onPersistedChange?.();
      setRounds((current) => [...current, round]);
      setSelectedId(round.id);
      setStatus('Saved');
      setError('');
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function move(index: number, direction: -1 | 1) {
    flush();
    await saveChain.current;
    const next = [...rounds];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    setBusy(true);
    try {
      const saved = await api<Round[]>(`${base}/order`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: next.map((round) => round.id) }),
      });
      onPersistedChange?.();
      setRounds(saved);
      setError('');
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function remove(round: Round) {
    if (!window.confirm(`Delete “${round.titleEn}”? This cannot be undone.`)) return;
    if (pending.current?.id === round.id) pending.current = null;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    await saveChain.current;
    setBusy(true);
    try {
      await api<void>(`${base}/${round.id}`, { method: 'DELETE' });
      onPersistedChange?.();
      const next = rounds.filter((item) => item.id !== round.id);
      setRounds(next);
      setSelectedId(next[0]?.id ?? null);
      incomplete.current = false;
      setStatus('Saved');
      setError('');
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  const selected = rounds.find((round) => round.id === selectedId);
  const fields: RoundChanges | null = selected ? {
    titleRu: selected.titleRu, titleEn: selected.titleEn,
    descriptionRu: selected.descriptionRu, descriptionEn: selected.descriptionEn,
    showLeaderboardAfter: selected.showLeaderboardAfter,
  } : null;

  return <section className="rounds">
    <div className="editor-heading"><h2>Rounds</h2><span className="round-status" role="status" aria-live="polite">{status}</span></div>
    {error && <p role="alert" className="error">{error}</p>}
    {loading ? <p>Loading rounds...</p> : <>
      <button onClick={() => void add()} disabled={busy || incomplete.current}>Add round</button>
      {rounds.length === 0 ? <p>No rounds yet.</p> : <ol className="round-list">{rounds.map((round, index) => <li key={round.id}>
        <button className={selectedId === round.id ? 'selected-round' : 'subtle'} onClick={() => { flush(); setSelectedId(round.id); }} disabled={busy || incomplete.current}>
          {round.titleEn} / {round.titleRu}
        </button>
        <div className="round-order">
          <button className="subtle" aria-label={`Move ${round.titleEn} up`} disabled={busy || incomplete.current || index === 0} onClick={() => void move(index, -1)}>↑</button>
          <button className="subtle" aria-label={`Move ${round.titleEn} down`} disabled={busy || incomplete.current || index === rounds.length - 1} onClick={() => void move(index, 1)}>↓</button>
        </div>
      </li>)}</ol>}
      {selected && fields && <div className="fields">
        <label>Round title RU<input value={selected.titleRu} maxLength={100} disabled={busy} onChange={(event) => change(selected, { ...fields, titleRu: event.target.value })} /></label>
        <label>Round title EN<input value={selected.titleEn} maxLength={100} disabled={busy} onChange={(event) => change(selected, { ...fields, titleEn: event.target.value })} /></label>
        <label>Round description RU<textarea value={selected.descriptionRu} disabled={busy} onChange={(event) => change(selected, { ...fields, descriptionRu: event.target.value })} /></label>
        <label>Round description EN<textarea value={selected.descriptionEn} disabled={busy} onChange={(event) => change(selected, { ...fields, descriptionEn: event.target.value })} /></label>
        <label className="checkbox"><input type="checkbox" checked={selected.showLeaderboardAfter} disabled={busy} onChange={(event) => change(selected, { ...fields, showLeaderboardAfter: event.target.checked })} /> Show leaderboard after this round</label>
        <button className="subtle danger" disabled={busy} onClick={() => void remove(selected)}>Delete round</button>
      </div>}
      {selected && <Questions quiz={quiz} roundNumber={rounds.indexOf(selected) + 1} key={selected.id} quizId={quizId} roundId={selected.id} onPersistedChange={onPersistedChange} />}
    </>}
  </section>;
}
