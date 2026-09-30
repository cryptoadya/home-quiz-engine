import { useEditorSave, useSaveBarrier } from './EditorSaves';
import { useEffect, useRef, useState } from 'react';
import type { Quiz } from './Admin';
import { MediaImage } from './MediaImage';
import { Questions } from './Questions';

export type Round = {
  id: string;
  quizId: string;
  titleRu: string;
  titleEn: string;
  descriptionRu: string;
  descriptionEn: string;
  artMediaId?: string | null; showLeaderboardAfter: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
};

type RoundChanges = Pick<Round, 'titleRu' | 'titleEn' | 'descriptionRu' | 'descriptionEn' | 'showLeaderboardAfter' | 'artMediaId'>;

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
  const [artMedia, setArtMedia] = useState<{ id: string; name: string; kind: string }[]>([]);
  const [rounds, setRounds] = useState<Round[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const saves = useEditorSave();
  const barrier = useSaveBarrier();
  const { status } = saves;
  const [error, setError] = useState('');
  const incomplete = useRef(false);
  const appliedTarget = useRef<typeof targetRound>(null);

  useEffect(() => {
    if (targetRound && targetRound !== appliedTarget.current && rounds.some((round) => round.id === targetRound.id)) {
      appliedTarget.current = targetRound;
      void selectRound(targetRound.id);
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

  async function selectRound(id: string) {
    try { await (barrier?.flush() ?? saves.flush()); setSelectedId(id); setError(''); }
    catch (cause) { setError((cause as Error).message); }
  }

  function change(round: Round, changes: RoundChanges) {
    setRounds(current => current.map(item => item.id === round.id ? { ...item, ...changes } : item));
    const valid = Boolean(changes.titleRu.trim() && changes.titleEn.trim()) &&
      Boolean(changes.descriptionRu.trim()) === Boolean(changes.descriptionEn.trim());
    incomplete.current = !valid;
    setError('');
    saves.schedule(round.id, async () => {
      await api<Round>(`${base}/${round.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes),
      });
      onPersistedChange?.();
    }, valid ? undefined : 'Complete both languages to save', round.id);
  }

  async function add() {
    setBusy(true);
    try {
      await (barrier?.flush() ?? saves.flush());
      await saves.perform(async () => {
        const round = await api<Round>(base, { method: 'POST' });
        onPersistedChange?.();
        setRounds((current) => [...current, round]);
        setSelectedId(round.id);
        setError('');
      });
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function move(index: number, direction: -1 | 1) {
    const next = [...rounds];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    setBusy(true);
    try {
      await (barrier?.flush() ?? saves.flush());
      await saves.perform(async () => {
        const saved = await api<Round[]>(`${base}/order`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: next.map((round) => round.id) }),
      });
      onPersistedChange?.();
      setRounds(saved);
      setError('');
      });
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function remove(round: Round) {
    if (!window.confirm(`Delete “${round.titleEn}”? This cannot be undone.`)) return;
    const failureKey = `delete:round:${round.id}`;
    setBusy(true);
    try {
      const release = await (barrier?.flushExcept(round.id, failureKey) ?? saves.flushExcept(round.id, failureKey));
      try {
        await saves.perform(async () => {
          await api<void>(`${base}/${round.id}`, { method: 'DELETE' });
          (barrier ?? saves).discard(round.id);
          onPersistedChange?.();
          const next = rounds.filter((item) => item.id !== round.id);
          setRounds(next);
          setSelectedId(next[0]?.id ?? null);
          incomplete.current = false;
          setError('');
        }, failureKey, true);
      } finally { release(); }
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  const selected = rounds.find((round) => round.id === selectedId);
  const fields: RoundChanges | null = selected ? {
    artMediaId: selected.artMediaId ?? null, titleRu: selected.titleRu, titleEn: selected.titleEn,
    descriptionRu: selected.descriptionRu, descriptionEn: selected.descriptionEn,
    showLeaderboardAfter: selected.showLeaderboardAfter,
  } : null;

  return <section className="rounds">
    <div className="editor-heading"><h2>Rounds</h2><span className="round-status" role="status" aria-live="polite">{status}</span></div>
    {(saves.error || error) && <p role="alert" className="error">{saves.error || error}</p>}
    {loading ? <p>Loading rounds...</p> : <>
      <button onClick={() => void add()} disabled={busy || incomplete.current}>Add round</button>
      {rounds.length === 0 ? <p>No rounds yet.</p> : <ol className="round-list">{rounds.map((round, index) => <li key={round.id}>
        <button className={selectedId === round.id ? 'selected-round' : 'subtle'} onClick={() => void selectRound(round.id)} disabled={busy || incomplete.current}>
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
        <button disabled={busy} onClick={() => void api<{ id: string; name: string; kind: string }[]>(`/api/quizzes/${quizId}/media`).then(setArtMedia).catch(cause => setError(cause.message))}>Load / refresh round art</button>
        <label>Round art<select disabled={busy} value={selected.artMediaId ?? ''} onChange={event => change(selected, { ...fields, artMediaId: event.target.value || null })}>
          <option value="">None</option>
          {selected.artMediaId && !artMedia.some(item => item.id === selected.artMediaId) && <option value={selected.artMediaId}>Current art (refresh to check)</option>}
          {artMedia.filter(item => item.kind === 'image').map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        {selected.artMediaId && <MediaImage src={`/api/quizzes/${quizId}/media/${selected.artMediaId}/content`} alt="Round art" className="editor-media-preview" />}
        <label className="checkbox"><input type="checkbox" checked={selected.showLeaderboardAfter} disabled={busy} onChange={(event) => change(selected, { ...fields, showLeaderboardAfter: event.target.checked })} /> Show leaderboard after this round</label>
        <button className="subtle danger" disabled={busy} onClick={() => void remove(selected)}>Delete round</button>
      </div>}
      {selected && <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <Questions quiz={quiz} roundNumber={rounds.indexOf(selected) + 1} key={selected.id} quizId={quizId} roundId={selected.id} onPersistedChange={onPersistedChange} />
      </fieldset>}
    </>}
  </section>;
}
