import { EditorSaves, useEditorSave, useSaveBarrier } from './EditorSaves';
import { ThemeSurface } from './themes/ThemeSurface';
import { resolveTheme, themes } from './themes';
import { MediaManager } from './Media';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Rounds } from './Rounds';

export type Quiz = {
  id: string;
  title: string;
  themeId: string;
  defaultAnswerTimeSeconds: number;
  shuffleAnswers: boolean;
  createdAt: string;
  updatedAt: string;
};

type QuizSettings = Pick<Quiz, 'title' | 'themeId' | 'defaultAnswerTimeSeconds' | 'shuffleAnswers'>;
export type AuthoringTarget = { id: string; questionId?: string; optionId?: string; pairId?: string; code?: string };
export type ValidationProblem = { code: string; message: string; roundId?: string; questionId?: string; optionId?: string; pairId?: string };
type QuizValidation = { ready: boolean; problems: ValidationProblem[] };

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${response.status}).`);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

async function downloadQuiz(id: string) {
  const response = await fetch(`/api/quizzes/${id}/export`);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Unable to export quiz.');
  }
  const url = URL.createObjectURL(await response.blob());
  try {
    const link = document.createElement('a');
    link.href = url; link.download = 'quiz.zip'; document.body.append(link); link.click(); link.remove();
  } finally { URL.revokeObjectURL(url); }
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}

export function QuizList() {
  const [quizzes, setQuizzes] = useState<Quiz[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [imported, setImported] = useState<Quiz | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let active = true;
    api<Quiz[]>('/api/quizzes').then((items) => {
      if (active) setQuizzes(items);
    }).catch((cause: Error) => {
      if (active) setError(cause.message);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);

  async function create() {
    setBusy(true);
    setError('');
    try {
      const quiz = await api<Quiz>('/api/quizzes', { method: 'POST' });
      navigate(`/admin/quizzes/${quiz.id}`);
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  }

  async function remove(quiz: Quiz) {
    if (!window.confirm(`Delete “${quiz.title}”? This cannot be undone.`)) return;
    setError(''); setBusy(true);
    try {
      await api<void>(`/api/quizzes/${quiz.id}`, { method: 'DELETE' });
      setQuizzes((current) => current.filter((item) => item.id !== quiz.id));
    } catch (cause) {
      setError((cause as Error).message);
    } finally { setBusy(false); }
  }

  async function duplicate(quiz: Quiz) {
    setBusy(true);
    setError('');
    try {
      const copy = await api<Quiz>(`/api/quizzes/${quiz.id}/duplicate`, { method: 'POST' });
      setQuizzes((current) => [copy, ...current]);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function importQuiz(file: File) {
    setBusy(true); setError(''); setNotice(''); setImported(null);
    try {
      const body = new FormData(); body.append('file', file);
      const copy = await api<Quiz>('/api/quizzes/import', { method: 'POST', body });
      setQuizzes(current => [copy, ...current]); setImported(copy);
      setNotice('Quiz imported as an editable Draft.');
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); if (importInput.current) importInput.current.value = ''; }
  }

  async function exportQuiz(quiz: Quiz) {
    setBusy(true); setError(''); setNotice('');
    try { await downloadQuiz(quiz.id); setNotice('Quiz ZIP downloaded.'); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function play(quiz: Quiz) {
    setBusy(true); setError('');
    try {
      const room = await api<{ code: string }>(`/api/quizzes/${quiz.id}/rooms`, { method: 'POST' });
      navigate(`/host/${room.code}`);
    } catch (cause) {
      setError(`Could not open the lobby for “${quiz.title}”. Open Edit to check readiness, then try again. ${(cause as Error).message}`);
      setBusy(false);
    }
  }

  return <ThemeSurface className="admin">
    <div className="app-masthead"><span className="wordmark">Home Quiz</span><span className="surface-label">Quiz studio</span></div>
    <header className="admin-header"><div><h1>My quizzes</h1><p>Edit a quiz, preview your questions, then open a lobby.</p></div><button onClick={create} disabled={busy}>Create quiz</button></header>
    <details className="authoring-secondary"><summary>Import & history</summary><div className="authoring-actions">
      <button className="subtle" disabled={busy} onClick={() => importInput.current?.click()}>Import Quiz</button>
      <Link to="/admin/history">History</Link>
    </div></details>
    <input ref={importInput} type="file" accept=".zip,application/zip" aria-label="Quiz ZIP" hidden onChange={event => { const file = event.target.files?.[0]; if (file) void importQuiz(file); }} />
    {notice && <p role="status">{notice} {imported && <Link to={`/admin/quizzes/${imported.id}`}>Open imported quiz</Link>}</p>}
    {imported && resolveTheme(imported.themeId).manifest.id !== imported.themeId && <p role="alert">This quiz’s theme is unavailable. Using Default; choose a theme in Edit.</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {loading ? <p>Loading quizzes...</p> : quizzes.length === 0 ? <p className="empty-state">No quizzes yet. Create one to get started.</p> :
      <ul className="quiz-list">{quizzes.map((quiz) => <li key={quiz.id}>
        <div><Link to={`/admin/quizzes/${quiz.id}`}>{quiz.title}</Link><p>{resolveTheme(quiz.themeId).manifest.name} · Modified {formatDate(quiz.updatedAt)}</p></div>
        <div className="quiz-actions">
          <Link className="authoring-button subtle" aria-label={`Edit ${quiz.title}`} to={`/admin/quizzes/${quiz.id}`}>Edit</Link>
          <button onClick={() => void play(quiz)} disabled={busy} aria-label={`Play ${quiz.title}`}>Play</button>
          <details className="authoring-secondary"><summary aria-label={`More actions for ${quiz.title}`}>More</summary><div className="authoring-actions">
          <button className="subtle" onClick={() => void exportQuiz(quiz)} disabled={busy} aria-label={`Export ${quiz.title}`}>Export</button>
          <button className="subtle" onClick={() => void duplicate(quiz)} disabled={busy} aria-label={`Duplicate ${quiz.title}`}>Duplicate</button>
          <div className="destructive-actions"><button className="subtle danger" onClick={() => void remove(quiz)} disabled={busy} aria-label={`Delete ${quiz.title}`}>Delete</button></div>
          </div></details>
        </div>
      </li>)}</ul>}
  </ThemeSurface>;
}

export function QuizEditor() {
  const { quizId } = useParams();
  return <EditorSaves key={quizId}><QuizEditorContent /></EditorSaves>;
}

function QuizEditorContent() {
  const navigate = useNavigate();
  const [exiting, setExiting] = useState(false);
  const exitPending = useRef(false);
  const [opening, setOpening] = useState(false);
  const [launchError, setLaunchError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState('');
  const { quizId } = useParams();
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [loading, setLoading] = useState(true);
  const saves = useEditorSave();
  const barrier = useSaveBarrier()!;
  const status = useSyncExternalStore(barrier.subscribe, barrier.snapshot);
  const [error, setError] = useState('');
  const [validation, setValidation] = useState<QuizValidation | null>(null);
  const [validationError, setValidationError] = useState('');
  const [targetRound, setTargetRound] = useState<AuthoringTarget | null>(null);
  const [mediaRevision, setMediaRevision] = useState(0);
  const validationRevision = useRef(0);

  function refreshValidation() {
    const version = ++validationRevision.current;
    void api<QuizValidation>(`/api/quizzes/${quizId}/validation`).then((result) => {
      if (version === validationRevision.current) { setValidation(result); setValidationError(''); }
    }).catch((cause: Error) => {
      if (version === validationRevision.current) setValidationError(cause.message);
    });
  }

  useEffect(() => {
    setValidation(null);
    refreshValidation();
    return () => { validationRevision.current += 1; };
  }, [quizId]);

  useEffect(() => {
    let active = true;
    api<Quiz>(`/api/quizzes/${quizId}`).then((item) => {
      if (active) setQuiz(item);
    }).catch((cause: Error) => {
      if (active) setError(cause.message);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [quizId]);

  async function exitEditor() {
    if (exitPending.current) return;
    exitPending.current = true;
    setExiting(true); setError('');
    try {
      await barrier.flush();
      navigate('/admin');
    } catch (cause) { setError((cause as Error).message); }
    finally { exitPending.current = false; setExiting(false); }
  }
  function change(settings: QuizSettings) {
    setQuiz(current => current ? { ...current, ...settings } : current);
    setError('');
    saves.schedule('settings', async () => {
      await api<Quiz>(`/api/quizzes/${quizId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings),
      });
      refreshValidation();
    });
  }

  async function openLobby(isTest = false) {
    setOpening(true);
    setLaunchError('');
    try {
      await barrier.flush();
      const room = await api<{ code: string }>(`/api/quizzes/${quizId}/${isTest ? 'test-games' : 'rooms'}`, { method: 'POST' });
      navigate(`/host/${room.code}`);
    } catch (cause) {
      setLaunchError((cause as Error).message);
      refreshValidation();
      setOpening(false);
    }
  }

  if (loading) return <ThemeSurface className="admin"><p>Loading quiz...</p></ThemeSurface>;
  if (!quiz) return <ThemeSurface className="admin"><Link to="/admin">← Quiz list</Link><p role="alert">{error}</p></ThemeSurface>;
  const settings: QuizSettings = {
    title: quiz.title,
    themeId: quiz.themeId,
    defaultAnswerTimeSeconds: quiz.defaultAnswerTimeSeconds,
    shuffleAnswers: quiz.shuffleAnswers,
  };

  return <ThemeSurface themeId={quiz.themeId} className="admin editor">
    <header className="editor-toolbar">
      <button className="subtle" disabled={exiting || opening || exporting} onClick={() => void exitEditor()}>← Quiz list</button>
      <div className="editor-heading"><h1>Edit quiz</h1><span className="editor-quiz-title">{quiz.title}</span><span role="status" aria-live="polite">{status === 'Saving...' ? 'Saving…' : status}</span><a className="authoring-button" href="#play-quiz">Play</a></div>
    </header>
    <nav className="authoring-steps" aria-label="Quiz authoring"><a href="#quiz-basics">1. Quiz basics</a><a href="#rounds-questions">2. Rounds & questions</a><a href="#question-preview">3. Preview</a><a href="#play-quiz">4. Play</a></nav>
    {(saves.error || error) && <p role="alert" className="error">{saves.error || error} Review the fields or your connection, then try again. Your edits are still here.</p>}
    {launchError && <p role="alert" className="error">{launchError} Check readiness and your connection, then try the action again.</p>}
    <section className="readiness" data-ready={validation?.ready} aria-label="Quiz readiness">
      <strong aria-live="polite">{validation ? validation.ready ? 'Ready to play' : `Problems to fix · ${validation.problems.length}` : 'Checking readiness…'}</strong>
      {validationError && <p role="alert" className="error">Could not check readiness. <button className="subtle" onClick={refreshValidation}>Try again</button> {validationError}</p>}
      {validation && validation.problems.length > 0 && <details>
        <summary>Show problems</summary>
        <ul>{validation.problems.map((problem, index) => <li key={`${problem.code}-${problem.roundId ?? ''}-${problem.questionId ?? ''}-${problem.optionId ?? ''}-${index}`}>
          <button type="button" className="problem-link" onClick={() => {
            if (problem.roundId) setTargetRound({ id: problem.roundId, questionId: problem.questionId, optionId: problem.optionId, pairId: problem.pairId, code: problem.code });
            else {
              const target = document.getElementById(problem.code === 'QUIZ_NO_ROUNDS' ? 'rounds-questions' : 'quiz-basics');
              target?.scrollIntoView?.({ block: 'start' });
              target?.querySelector<HTMLElement>('input, button')?.focus();
            }
          }}>{problem.message.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, 'attached file')}</button>
        </li>)}</ul>
      </details>}
    </section>
    <fieldset disabled={opening || exporting || exiting} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
    <section id="quiz-basics" className="authoring-panel" aria-label="Quiz basics"><h2>Quiz basics</h2><div className="fields">
      <label>Title<input value={quiz.title} maxLength={100} onChange={(event) => change({ ...settings, title: event.target.value })} /></label>
      <label>Theme<select value={quiz.themeId} onChange={(event) => change({ ...settings, themeId: event.target.value })}>
        {themes.map(theme => <option key={theme.manifest.id} value={theme.manifest.id}>{theme.manifest.name}</option>)}
        {!themes.some(theme => theme.manifest.id === quiz.themeId) && <option value={quiz.themeId}>Unavailable theme</option>}
      </select></label>
      {!themes.some(theme => theme.manifest.id === quiz.themeId) && <p>Theme unavailable. Using Default. Select Default to replace this unavailable theme.</p>}
      <details className="authoring-secondary"><summary>Answer settings</summary><div className="fields">
      <label>Default answer time (seconds)<input type="number" min="1" max="3600" step="1" value={quiz.defaultAnswerTimeSeconds} onChange={(event) => change({ ...settings, defaultAnswerTimeSeconds: Number(event.target.value) })} /></label>
      <label className="checkbox"><input type="checkbox" checked={quiz.shuffleAnswers} onChange={(event) => change({ ...settings, shuffleAnswers: event.target.checked })} /> Shuffle answers</label>
      </div></details>
    </div></section>
    <Rounds onMediaChange={() => { setMediaRevision(value => value + 1); refreshValidation(); }} quiz={quiz} quizId={quiz.id} mediaRevision={mediaRevision} targetRound={targetRound} problems={validation?.problems} onPersistedChange={refreshValidation} />
    <MediaManager revision={mediaRevision} key={quiz.id} quizId={quiz.id} disabled={opening || exporting || exiting} onPersistedChange={() => { setMediaRevision(value => value + 1); refreshValidation(); }} />
    </fieldset>
    <section id="play-quiz" className="authoring-panel" aria-label="Play quiz"><h2>Play</h2>
      <p>When your quiz is ready, open a lobby and invite your players.</p>
      <div className="authoring-actions"><button onClick={() => void openLobby()} disabled={opening || exporting || exiting || !validation?.ready || Boolean(validationError)}>Open lobby</button></div>
      <details className="authoring-secondary"><summary>Rehearse & export</summary>
        <p>Rehearse with real phones and Wi-Fi. The Host starts the game after players join. Rehearsals are excluded from normal history.</p>
        <div className="authoring-actions">
          <button className="subtle" onClick={() => void openLobby(true)} disabled={opening || exporting || exiting || !validation?.ready || Boolean(validationError)}>Rehearse with devices</button>
          <button className="subtle" disabled={exporting || opening || exiting} onClick={async () => {
            setExporting(true); setExportNotice(''); setLaunchError('');
            try { await barrier.flush(); await downloadQuiz(quiz.id); setExportNotice('Quiz ZIP downloaded.'); }
            catch (cause) { setLaunchError((cause as Error).message); }
            finally { setExporting(false); }
          }}>Export Quiz</button>
        </div>
      </details>
      {exportNotice && <p role="status">{exportNotice}</p>}
    </section>
  </ThemeSurface>;
}
