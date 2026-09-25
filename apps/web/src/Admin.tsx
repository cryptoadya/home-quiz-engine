import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Rounds } from './Rounds';

export type Quiz = {
  id: string;
  title: string;
  themeId: 'default' | 'halloween';
  defaultAnswerTimeSeconds: number;
  shuffleAnswers: boolean;
  createdAt: string;
  updatedAt: string;
};

type QuizSettings = Pick<Quiz, 'title' | 'themeId' | 'defaultAnswerTimeSeconds' | 'shuffleAnswers'>;
type ValidationProblem = { code: string; message: string; roundId?: string; questionId?: string; optionId?: string };
type QuizValidation = { ready: boolean; problems: ValidationProblem[] };

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${response.status}).`);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}

export function QuizList() {
  const [quizzes, setQuizzes] = useState<Quiz[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
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
    setError('');
    try {
      await api<void>(`/api/quizzes/${quiz.id}`, { method: 'DELETE' });
      setQuizzes((current) => current.filter((item) => item.id !== quiz.id));
    } catch (cause) {
      setError((cause as Error).message);
    }
  }

  return <main className="admin">
    <header className="admin-header"><div><h1>Quizzes</h1><p>Your saved drafts</p></div><button onClick={create} disabled={busy}>Create quiz</button></header>
    {error && <p role="alert" className="error">{error}</p>}
    {loading ? <p>Loading quizzes...</p> : quizzes.length === 0 ? <p>No quizzes yet. Create one to get started.</p> :
      <ul className="quiz-list">{quizzes.map((quiz) => <li key={quiz.id}>
        <div><Link to={`/admin/quizzes/${quiz.id}`}>{quiz.title}</Link><p>{quiz.themeId === 'default' ? 'Default' : 'Halloween'} · Modified {formatDate(quiz.updatedAt)}</p></div>
        <button className="subtle danger" onClick={() => void remove(quiz)} aria-label={`Delete ${quiz.title}`}>Delete</button>
      </li>)}</ul>}
  </main>;
}

export function QuizEditor() {
  const { quizId } = useParams();
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('Saved');
  const [error, setError] = useState('');
  const [validation, setValidation] = useState<QuizValidation | null>(null);
  const [validationError, setValidationError] = useState('');
  const [targetRound, setTargetRound] = useState<{ id: string } | null>(null);
  const validationRevision = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<QuizSettings | null>(null);
  const revision = useRef(0);
  const saveChain = useRef<Promise<void>>(Promise.resolve());

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

  function save(settings: QuizSettings, version: number) {
    saveChain.current = saveChain.current.then(async () => {
      try {
        await api<Quiz>(`/api/quizzes/${quizId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(settings),
        });
        refreshValidation();
        if (version === revision.current) {
          setStatus('Saved');
          setError('');
        }
      } catch (cause) {
        if (version === revision.current) {
          setStatus('Save failed');
          setError((cause as Error).message);
        }
      }
    });
  }

  function flush() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (pending.current) {
      const settings = pending.current;
      pending.current = null;
      save(settings, revision.current);
    }
  }

  useEffect(() => () => { flush(); }, [quizId]);

  function change(settings: QuizSettings) {
    setQuiz((current) => current ? { ...current, ...settings } : current);
    setStatus('Saving...');
    setError('');
    revision.current += 1;
    pending.current = settings;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 400);
  }

  if (loading) return <main className="admin"><p>Loading quiz...</p></main>;
  if (!quiz) return <main className="admin"><Link to="/admin">← Quiz list</Link><p role="alert">{error}</p></main>;
  const settings: QuizSettings = {
    title: quiz.title,
    themeId: quiz.themeId,
    defaultAnswerTimeSeconds: quiz.defaultAnswerTimeSeconds,
    shuffleAnswers: quiz.shuffleAnswers,
  };

  return <main className="admin editor">
    <Link to="/admin" onClick={flush}>← Quiz list</Link>
    <div className="editor-heading"><h1>Edit quiz</h1><span role="status" aria-live="polite">{status}</span></div>
    {error && <p role="alert" className="error">{error}</p>}
    <section className="readiness" aria-label="Quiz readiness">
      <strong aria-live="polite">{validation ? validation.ready ? 'Ready to play' : `Draft · ${validation.problems.length} ${validation.problems.length === 1 ? 'problem' : 'problems'}` : 'Checking readiness...'}</strong>
      {validationError && <p role="alert" className="error">Could not refresh readiness: {validationError}</p>}
      {validation && validation.problems.length > 0 && <details>
        <summary>Show problems</summary>
        <ul>{validation.problems.map((problem, index) => <li key={`${problem.code}-${problem.roundId ?? ''}-${problem.questionId ?? ''}-${problem.optionId ?? ''}-${index}`}>
          {problem.roundId ? <button type="button" className="problem-link" onClick={() => setTargetRound({ id: problem.roundId! })}>{problem.message}</button> : problem.message}
        </li>)}</ul>
      </details>}
    </section>
    <div className="fields">
      <label>Title<input value={quiz.title} maxLength={100} onChange={(event) => change({ ...settings, title: event.target.value })} /></label>
      <label>Theme<select value={quiz.themeId} onChange={(event) => change({ ...settings, themeId: event.target.value as Quiz['themeId'] })}>
        <option value="default">Default</option><option value="halloween">Halloween</option>
      </select></label>
      <label>Default answer time (seconds)<input type="number" min="1" max="3600" step="1" value={quiz.defaultAnswerTimeSeconds} onChange={(event) => change({ ...settings, defaultAnswerTimeSeconds: Number(event.target.value) })} /></label>
      <label className="checkbox"><input type="checkbox" checked={quiz.shuffleAnswers} onChange={(event) => change({ ...settings, shuffleAnswers: event.target.checked })} /> Shuffle answers</label>
    </div>
    <Rounds quizId={quiz.id} targetRound={targetRound} onPersistedChange={refreshValidation} />
  </main>;
}
