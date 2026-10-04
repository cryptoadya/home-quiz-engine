import { request as api } from './request';
import { useEditorSave, useSaveBarrier } from './EditorSaves';
import { useEffect, useRef, useState } from 'react';
import type { AuthoringTarget, Quiz, ValidationProblem } from './Admin';
import { useQuizMedia } from './Media';
import { MediaImage } from './MediaImage';
import { AuthoringField, textHint } from './AuthoringField';
import { Questions } from './Questions';
import { ROUND_DESCRIPTION_MAX_LENGTH } from '../../server/src/round-description';

export type Round = {
  id: string;
  quizId: string;
  titleRu: string;
  titleEn: string;
  descriptionRu: string;
  descriptionEn: string;
  artMediaId?: string | null; isTiebreak?: boolean; showLeaderboardAfter: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
};

type RoundChanges = Pick<Round, 'titleRu' | 'titleEn' | 'descriptionRu' | 'descriptionEn' | 'showLeaderboardAfter' | 'artMediaId' | 'isTiebreak'>;

export function Rounds({ quizId, targetRound, onPersistedChange, quiz, mediaRevision = 0, onMediaChange, problems = [] }: { quiz?: Quiz; quizId: string; targetRound?: AuthoringTarget | null; onPersistedChange?: () => void; mediaRevision?: number; onMediaChange?: () => void; problems?: ValidationProblem[] }) {
  const base = `/api/quizzes/${quizId}/rounds`;
  const { items: artMedia, error: mediaError, retry: retryMedia } = useQuizMedia(quizId, mediaRevision);
  const [roundSettingsOpen, setRoundSettingsOpen] = useState(false);
  const roundEditor = useRef<HTMLDivElement>(null);
  const [rounds, setRounds] = useState<Round[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [questionNavigation, setQuestionNavigation] = useState<HTMLDivElement | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
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
    if (!targetRound || selectedId !== targetRound.id || targetRound.questionId) return;
    setRoundSettingsOpen(true);
    roundEditor.current?.scrollIntoView?.({ block: 'start' });
    roundEditor.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, [targetRound, selectedId]);

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

  async function duplicate(round: Round) {
    setBusy(true);
    try {
      await (barrier?.flush() ?? saves.flush());
      await saves.perform(async () => {
        const copy = await api<Round>(`${base}/${round.id}/duplicate`, { method: 'POST' });
        setRounds(items => [...items, copy]); setSelectedId(copy.id);
        onPersistedChange?.(); setError('');
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
    isTiebreak: Boolean(selected.isTiebreak), showLeaderboardAfter: selected.showLeaderboardAfter,
  } : null;

  return <section id="rounds-questions" className="rounds" aria-label="Rounds & questions">
    <div className="editor-heading"><h2>Rounds & questions</h2><span className="round-status" role="status" aria-live="polite">{status === 'Saving...' ? 'Saving…' : status}</span></div>
    {(saves.error || error) && <p role="alert" className="error">{saves.error || error}</p>}
    {loading ? <p>Loading rounds...</p> : <>
      <div className="round-workspace">
      <nav className="authoring-navigator round-tree" aria-label="Rounds">
      <div className="authoring-actions"><button onClick={() => void add()} disabled={busy || incomplete.current}>Add round</button></div>
      {rounds.length === 0 ? <p>No rounds yet.</p> : <ol className="round-list">{rounds.map((round, index) => <li key={round.id}>
        <div className="round-tree-row"><button aria-current={selectedId === round.id ? 'true' : undefined} aria-expanded={selectedId === round.id} className={selectedId === round.id ? 'selected-round' : 'subtle'} onClick={() => void selectRound(round.id)} disabled={busy || incomplete.current}>
          <span className="navigator-title">{round.titleEn} / {round.titleRu}{round.isTiebreak && ' · Tiebreak'}</span>
        </button>
        {problems.some(problem => problem.roundId === round.id) && <span className="navigator-problem" aria-label="Round has problems" title={problems.filter(problem => problem.roundId === round.id).map(problem => problem.message).join('\n')}>!</span>}
        <div className="round-order">
          <button className="subtle" aria-label={`Move ${round.titleEn} up`} disabled={busy || incomplete.current || index === 0} onClick={() => void move(index, -1)}>↑</button>
          <button className="subtle" aria-label={`Move ${round.titleEn} down`} disabled={busy || incomplete.current || index === rounds.length - 1} onClick={() => void move(index, 1)}>↓</button>
        </div></div>
        {selectedId === round.id && <div className="round-questions"><fieldset disabled={busy} style={{ margin: 0 }}><div ref={setQuestionNavigation} /></fieldset></div>}
      </li>)}</ol>}
      </nav>
      <div className="round-content">
      {selected && fields && <div className="selected-round-editor" ref={roundEditor} tabIndex={-1}>
        <div className="authoring-actions"><h3>Round {rounds.indexOf(selected) + 1}: {selected.titleEn || selected.titleRu || 'Untitled round'}</h3>
        <button className="subtle" disabled={busy || incomplete.current} onClick={() => void duplicate(selected)}>Duplicate round</button></div>
        <div className="fields bilingual-fields">
        <AuthoringField label="Round title RU" error={textHint(selected.titleRu, 'RU', true, 100)}><input value={selected.titleRu} maxLength={100} disabled={busy} onChange={(event) => change(selected, { ...fields, titleRu: event.target.value })} /></AuthoringField>
        <AuthoringField label="Round title EN" error={textHint(selected.titleEn, 'EN', true, 100)}><input value={selected.titleEn} maxLength={100} disabled={busy} onChange={(event) => change(selected, { ...fields, titleEn: event.target.value })} /></AuthoringField>
        <details className="authoring-secondary" open={roundSettingsOpen} onToggle={event => setRoundSettingsOpen(event.currentTarget.open)}><summary>Round introduction & settings</summary><div className="fields bilingual-fields">
        <AuthoringField label="Round description RU" error={textHint(selected.descriptionRu, 'RU', Boolean(selected.descriptionRu.trim() || selected.descriptionEn.trim()), ROUND_DESCRIPTION_MAX_LENGTH)}><textarea value={selected.descriptionRu} maxLength={ROUND_DESCRIPTION_MAX_LENGTH} disabled={busy} onChange={(event) => change(selected, { ...fields, descriptionRu: event.target.value })} /></AuthoringField>
        <AuthoringField label="Round description EN" error={textHint(selected.descriptionEn, 'EN', Boolean(selected.descriptionRu.trim() || selected.descriptionEn.trim()), ROUND_DESCRIPTION_MAX_LENGTH)}><textarea value={selected.descriptionEn} maxLength={ROUND_DESCRIPTION_MAX_LENGTH} disabled={busy} onChange={(event) => change(selected, { ...fields, descriptionEn: event.target.value })} /></AuthoringField>
        {mediaError && <p role="alert">{mediaError} <button className="subtle" disabled={busy} onClick={retryMedia}>Try loading round art again</button></p>}
        <label className="full-width">Round art<select disabled={busy} value={selected.artMediaId ?? ''} onChange={event => change(selected, { ...fields, artMediaId: event.target.value || null })}>
          <option value="">None</option>
          {selected.artMediaId && !artMedia.some(item => item.id === selected.artMediaId) && <option value={selected.artMediaId}>Image unavailable — choose another</option>}
          {artMedia.filter(item => item.kind === 'image').map(item => <option key={item.id} value={item.id}>{item.name} (image)</option>)}
        </select></label>
        {selected.artMediaId && <MediaImage src={`/api/quizzes/${quizId}/media/${selected.artMediaId}/content`} alt="Round art" className="editor-media-preview" />}
        <label className="checkbox"><input type="checkbox" checked={Boolean(selected.isTiebreak)} disabled={busy} onChange={event => change(selected, { ...fields, isTiebreak: event.target.checked })} /> Reserve round for final tiebreak / Допвопросы при ничьей</label>
        {selected.isTiebreak && <p>Skipped in the main quiz. Only players sharing first place can answer after the final results; points are unchanged.</p>}
        <label className="checkbox"><input type="checkbox" checked={selected.showLeaderboardAfter} disabled={busy} onChange={(event) => change(selected, { ...fields, showLeaderboardAfter: event.target.checked })} /> Show leaderboard after this round</label>
        </div></details>
        </div><div className="destructive-actions"><button className="subtle danger" disabled={busy} onClick={() => void remove(selected)}>Delete round</button></div>
      </div>}
      {selected && <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <Questions quiz={quiz} roundNumber={rounds.indexOf(selected) + 1} key={selected.id} quizId={quizId} roundId={selected.id} mediaRevision={mediaRevision} onMediaChange={onMediaChange} targetQuestion={targetRound?.id === selected.id ? targetRound : null} onPersistedChange={onPersistedChange}
          navigationTarget={questionNavigation} previewOpen={previewOpen} onPreviewOpenChange={setPreviewOpen} problems={problems} />
      </fieldset>}
      </div></div>
    </>}
  </section>;
}
