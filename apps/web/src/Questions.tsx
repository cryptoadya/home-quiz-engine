import { useEffect, useRef, useState } from 'react';

type Question = {
  id: string; roundId: string; type: 'single_choice' | 'yes_no' | 'multiple_choice' | 'matching'; textRu: string; textEn: string;
  points: number; answerTimeSeconds: number | null; showOptionsOnScreen: boolean; showCorrectCount?: boolean;
  position: number; createdAt: string; updatedAt: string;
};
type Option = {
  id: string; questionId: string; textRu: string; textEn: string; isCorrect: boolean;
  position: number; createdAt: string; updatedAt: string;
};
type TextSide = { kind: 'text'; textRu: string; textEn: string };
type Pair = { id: string; questionId: string; left: TextSide; right: TextSide; position: number };
type PairFields = Pick<Pair, 'left' | 'right'>;
type QuestionFields = Pick<Question, 'type' | 'textRu' | 'textEn' | 'points' | 'answerTimeSeconds' | 'showOptionsOnScreen' | 'showCorrectCount'>;
type OptionFields = Pick<Option, 'textRu' | 'textEn' | 'isCorrect'>;

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${response.status}).`);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export function Questions({ quizId, roundId, onPersistedChange }: { quizId: string; roundId: string; onPersistedChange?: () => void }) {
  const base = `/api/quizzes/${quizId}/rounds/${roundId}/questions`;
  const [questions, setQuestions] = useState<Question[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pairs, setPairs] = useState<Pair[]>([]);
  const [options, setOptions] = useState<Option[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Saved');
  const [error, setError] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<Map<string, { path: string; body: QuestionFields | OptionFields | PairFields }>>(new Map());
  const chain = useRef<Promise<void>>(Promise.resolve());
  const revision = useRef(0);

  useEffect(() => {
    let active = true;
    api<Question[]>(base).then((items) => {
      if (active) { setQuestions(items); setSelectedId(items[0]?.id ?? null); }
    }).catch((cause: Error) => { if (active) setError(cause.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [base]);

  useEffect(() => {
    if (!selectedId) { setOptions([]); setPairs([]); return; }
    let active = true;
    setOptions([]); setPairs([]);
    if (questions.find(question => question.id === selectedId)?.type === 'matching') {
      api<Pair[]>(`${base}/${selectedId}/pairs`).then(items => { if (active) setPairs(items); })
        .catch((cause: Error) => { if (active) setError(cause.message); });
      return () => { active = false; };
    }
    api<Option[]>(`${base}/${selectedId}/options`).then((items) => { if (active) setOptions(items); })
      .catch((cause: Error) => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [base, selectedId]);

  function flush() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (pending.current.size === 0) return;
    const saves = [...pending.current.values()];
    pending.current.clear();
    const version = revision.current;
    chain.current = chain.current.then(async () => {
      try {
        for (const save of saves) await api(save.path, json('PUT', save.body));
        onPersistedChange?.();
        if (version === revision.current) { setStatus('Saved'); setError(''); }
      } catch (cause) {
        if (version === revision.current) { setStatus('Save failed'); setError((cause as Error).message); }
      }
    });
  }
  useEffect(() => () => { flush(); }, [base]);

  function schedule(key: string, path: string, body: QuestionFields | OptionFields | PairFields) {
    revision.current += 1;
    pending.current.set(key, { path, body });
    setStatus('Saving...');
    setError('');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 400);
  }
  async function afterSaves(action: () => Promise<void>) {
    flush();
    await chain.current;
    setBusy(true);
    try { await action(); onPersistedChange?.(); setError(''); }
    catch (cause) { setStatus('Save failed'); setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  const selected = questions.find((item) => item.id === selectedId);
  function editQuestion(question: Question, changes: QuestionFields) {
    setQuestions((items) => items.map((item) => item.id === question.id ? { ...item, ...changes } : item));
    schedule(question.id, `${base}/${question.id}`, changes);
  }
  function editOption(option: Option, changes: OptionFields) {
    setOptions((items) => items.map((item) => item.id === option.id ? { ...item, ...changes } : item));
    schedule(option.id, `${base}/${option.questionId}/options/${option.id}`, changes);
  }
  function editPair(pair: Pair, side: 'left' | 'right', language: 'textRu' | 'textEn', value: string) {
    const changes = { left: pair.left, right: pair.right, [side]: { ...pair[side], [language]: value } };
    setPairs(items => items.map(item => item.id === pair.id ? { ...item, ...changes } : item));
    schedule(pair.id, `${base}/${pair.questionId}/pairs/${pair.id}`, changes);
  }
  function movePair(index: number, direction: -1 | 1) {
    if (!selected) return;
    void afterSaves(async () => {
      const next = [...pairs];
      [next[index], next[index + direction]] = [next[index + direction], next[index]];
      setPairs(await api<Pair[]>(`${base}/${selected.id}/pairs/order`, json('PUT', { ids: next.map(item => item.id) })));
    });
  }
  function moveQuestion(index: number, direction: -1 | 1) {
    void afterSaves(async () => {
      const next = [...questions];
      [next[index], next[index + direction]] = [next[index + direction], next[index]];
      setQuestions(await api<Question[]>(`${base}/order`, json('PUT', { ids: next.map((item) => item.id) })));
    });
  }
  function moveOption(index: number, direction: -1 | 1) {
    if (!selected) return;
    void afterSaves(async () => {
      const next = [...options];
      [next[index], next[index + direction]] = [next[index + direction], next[index]];
      setOptions(await api<Option[]>(`${base}/${selected.id}/options/order`, json('PUT', { ids: next.map((item) => item.id) })));
    });
  }
  const fields: QuestionFields | null = selected ? {
    type: selected.type, textRu: selected.textRu, textEn: selected.textEn, points: selected.points,
    answerTimeSeconds: selected.answerTimeSeconds, showOptionsOnScreen: selected.showOptionsOnScreen, showCorrectCount: selected.showCorrectCount ?? true,
  } : null;

  return <section className="questions">
    <div className="editor-heading"><h3>Questions</h3><span role="status" className="question-status" aria-live="polite">{status}</span></div>
    {error && <p role="alert" className="error">{error}</p>}
    {loading ? <p>Loading questions...</p> : <>
      <button disabled={busy} onClick={() => void afterSaves(async () => {
        const question = await api<Question>(base, { method: 'POST' });
        setQuestions((items) => [...items, question]); setSelectedId(question.id);
      })}>Add Single Choice question</button>
      <button disabled={busy} onClick={() => void afterSaves(async () => {
        const question = await api<Question>(base, json('POST', { type: 'yes_no' }));
        setQuestions(items => [...items, question]); setSelectedId(question.id);
      })}>Add Yes / No question</button>
      <button disabled={busy} onClick={() => void afterSaves(async () => {
        const question = await api<Question>(base, json('POST', { type: 'multiple_choice' }));
        setQuestions(items => [...items, question]); setSelectedId(question.id);
      })}>Add Multiple Choice question</button>
      <button disabled={busy} onClick={() => void afterSaves(async () => {
        const question = await api<Question>(base, json('POST', { type: 'matching' }));
        setQuestions(items => [...items, question]); setSelectedId(question.id);
      })}>Add Matching question</button>
      {questions.length === 0 ? <p>No questions yet.</p> : <ol className="round-list">{questions.map((question, index) => <li key={question.id}>
        <button className={selectedId === question.id ? 'selected-round' : 'subtle'} disabled={busy}
          onClick={() => { flush(); setSelectedId(question.id); }}>
          {index + 1}. {question.textEn || question.textRu || 'Untitled question'}
        </button>
        <div className="round-order">
          <button className="subtle" aria-label={`Move question ${index + 1} up`} disabled={busy || index === 0} onClick={() => moveQuestion(index, -1)}>↑</button>
          <button className="subtle" aria-label={`Move question ${index + 1} down`} disabled={busy || index === questions.length - 1} onClick={() => moveQuestion(index, 1)}>↓</button>
        </div>
      </li>)}</ol>}
      {selected && fields && <div className="question-editor fields">
        <h4>{selected.type === 'matching' ? 'Matching' : selected.type === 'yes_no' ? 'Yes / No' : selected.type === 'multiple_choice' ? 'Multiple Choice' : 'Single Choice'} question</h4>
        <label>Question type<select value={selected.type} disabled={busy} onChange={event => {
          const type = event.target.value as Question['type'];
          void afterSaves(async () => {
            const question = await api<Question>(`${base}/${selected.id}`, json('PUT', { ...fields, type }));
            const nextPairs = type === 'matching' ? await api<Pair[]>(`${base}/${selected.id}/pairs`) : [];
            const nextOptions = type !== 'matching' ? await api<Option[]>(`${base}/${selected.id}/options`) : [];
            setQuestions(items => items.map(item => item.id === question.id ? question : item));
            setOptions(nextOptions); setPairs(nextPairs);
          });
        }}><option value="single_choice">Single Choice</option><option value="yes_no">Yes / No</option><option value="multiple_choice">Multiple Choice</option><option value="matching">Matching</option></select></label>
        <label>Question text RU<textarea maxLength={5000} value={selected.textRu} disabled={busy} onChange={(event) => editQuestion(selected, { ...fields, textRu: event.target.value })} /></label>
        <label>Question text EN<textarea maxLength={5000} value={selected.textEn} disabled={busy} onChange={(event) => editQuestion(selected, { ...fields, textEn: event.target.value })} /></label>
        <label>Points<input type="number" min="1" step="1" value={selected.points} disabled={busy} onChange={(event) => editQuestion(selected, { ...fields, points: Number(event.target.value) })} /></label>
        <label>Answer time<select value={selected.answerTimeSeconds === null ? 'default' : 'custom'} disabled={busy}
          onChange={(event) => editQuestion(selected, { ...fields, answerTimeSeconds: event.target.value === 'default' ? null : 30 })}>
          <option value="default">Use quiz default</option><option value="custom">Custom</option>
        </select></label>
        {selected.answerTimeSeconds !== null && <label>Custom answer time (seconds)<input type="number" min="1" max="3600" step="1" value={selected.answerTimeSeconds} disabled={busy}
          onChange={(event) => editQuestion(selected, { ...fields, answerTimeSeconds: Number(event.target.value) })} /></label>}
        <label className="checkbox"><input type="checkbox" checked={selected.showOptionsOnScreen} disabled={busy}
          onChange={(event) => editQuestion(selected, { ...fields, showOptionsOnScreen: event.target.checked })} /> Show answer options on Screen</label>
        {selected.type === 'matching' ? <>
          <h4>Matching pairs</h4>
          <p>At least 2 complete pairs, with RU/EN text on both sides. Switching to an option type clears pairs; switching back creates blank pairs. Matching images are deferred to Phase 6.</p>
          {pairs.map((pair, index) => <div className="option-editor" key={pair.id}>
            <h5>Pair {index + 1}</h5>
            {(['left', 'right'] as const).map(side => <div key={side}>
              {(['textRu', 'textEn'] as const).map(language => <label key={language}>
                Pair {index + 1} {side} {language === 'textRu' ? 'RU' : 'EN'}
                <input maxLength={500} value={pair[side][language]} disabled={busy}
                  onChange={event => editPair(pair, side, language, event.target.value)} />
              </label>)}
            </div>)}
            <div className="round-order">
              <button aria-label={`Move pair ${index + 1} up`} disabled={busy || index === 0} onClick={() => movePair(index, -1)}>↑</button>
              <button aria-label={`Move pair ${index + 1} down`} disabled={busy || index === pairs.length - 1} onClick={() => movePair(index, 1)}>↓</button>
              <button aria-label={`Delete pair ${index + 1}`} disabled={busy} onClick={() => void afterSaves(async () => {
                await api<void>(`${base}/${selected.id}/pairs/${pair.id}`, { method: 'DELETE' });
                setPairs(items => items.filter(item => item.id !== pair.id));
              })}>Delete</button>
            </div>
          </div>)}
          <button disabled={busy} onClick={() => void afterSaves(async () => {
            const pair = await api<Pair>(`${base}/${selected.id}/pairs`, { method: 'POST' });
            setPairs(items => [...items, pair]);
          })}>Add pair</button>
        </> : <>
        <p>Switching to Matching clears answer options and creates two blank pairs.</p>
        <h4>Answer options</h4>
        {selected.type === 'multiple_choice' && <>
          <p>Use 2–10 options and mark at least 2 correct.</p>
          <label className="checkbox"><input type="checkbox" checked={selected.showCorrectCount ?? true} disabled={busy}
            onChange={event => editQuestion(selected, { ...fields, showCorrectCount: event.target.checked })} /> Show correct-option count to Player</label>
        </>}
        {options.map((option, index) => <div className="option-editor" key={option.id}>
          <label className="checkbox"><input type={selected.type === 'multiple_choice' ? 'checkbox' : 'radio'} name={`correct-${selected.id}`} checked={option.isCorrect} disabled={busy}
            onChange={event => {
              if (selected.type === 'multiple_choice') { editOption(option, { textRu: option.textRu, textEn: option.textEn, isCorrect: event.target.checked }); return; }
              void afterSaves(async () => {
                setOptions(await api<Option[]>(`${base}/${selected.id}/options/${option.id}/correct`, { method: 'PUT' }));
              });
            }} /> Correct answer, option {index + 1}</label>
          <label>Option {index + 1} RU<input maxLength={500} value={option.textRu} disabled={busy}
            onChange={(event) => editOption(option, { textRu: event.target.value, textEn: option.textEn, isCorrect: option.isCorrect })} /></label>
          <label>Option {index + 1} EN<input maxLength={500} value={option.textEn} disabled={busy}
            onChange={(event) => editOption(option, { textRu: option.textRu, textEn: event.target.value, isCorrect: option.isCorrect })} /></label>
          {selected.type !== 'yes_no' && <div className="round-order">
            <button className="subtle" aria-label={`Move option ${index + 1} up`} disabled={busy || index === 0} onClick={() => moveOption(index, -1)}>↑</button>
            <button className="subtle" aria-label={`Move option ${index + 1} down`} disabled={busy || index === options.length - 1} onClick={() => moveOption(index, 1)}>↓</button>
            <button className="subtle danger" aria-label={`Delete option ${index + 1}`} disabled={busy}
              onClick={() => void afterSaves(async () => {
                await api<void>(`${base}/${selected.id}/options/${option.id}`, { method: 'DELETE' });
                setOptions((items) => items.filter((item) => item.id !== option.id));
              })}>Delete</button>
          </div>}
        </div>)}
        {selected.type !== 'yes_no' && <button disabled={busy || options.length >= 10} onClick={() => void afterSaves(async () => {
          const option = await api<Option>(`${base}/${selected.id}/options`, { method: 'POST' });
          setOptions((items) => [...items, option]);
        })}>Add option</button>}
        </>}
        <button className="subtle danger" disabled={busy} onClick={() => {
          if (!window.confirm('Delete this question? This cannot be undone.')) return;
          void afterSaves(async () => {
            await api<void>(`${base}/${selected.id}`, { method: 'DELETE' });
            const next = questions.filter((item) => item.id !== selected.id);
            setQuestions(next); setSelectedId(next[0]?.id ?? null);
          });
        }}>Delete question</button>
      </div>}
    </>}
  </section>;
}
