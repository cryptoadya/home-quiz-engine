import { QuizPreview } from './QuizPreview';
import type { Quiz } from './Admin';
import { MediaImage } from './MediaImage';
import { useEffect, useState } from 'react';
import { useEditorSave } from './EditorSaves';

export type Question = {
  id: string; roundId: string; type: 'single_choice' | 'yes_no' | 'multiple_choice' | 'matching'; textRu: string; textEn: string;
  points: number; answerTimeSeconds: number | null; showOptionsOnScreen: boolean; showCorrectCount?: boolean;
  explanationRu?: string; explanationEn?: string; media?: MediaRef[]; position: number; createdAt: string; updatedAt: string;
};
export type Option = {
  id: string; questionId: string; textRu: string; textEn: string; isCorrect: boolean;
  position: number; createdAt: string; updatedAt: string;
};
type MediaRef = { mediaId: string; playBeforeTimer: boolean };
export type Media = { id: string; name: string; kind: 'image' | 'audio' | 'video' };
type TextSide = { kind: 'text'; textRu: string; textEn: string };
export type Side = TextSide | { kind: 'image'; mediaId: string };
export type Pair = { id: string; questionId: string; left: Side; right: Side; position: number };
type PairFields = Pick<Pair, 'left' | 'right'>;
type QuestionFields = Pick<Question, 'type' | 'textRu' | 'textEn' | 'points' | 'answerTimeSeconds' | 'showOptionsOnScreen' | 'showCorrectCount' | 'media' | 'explanationRu' | 'explanationEn'>;
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

export function Questions({ quizId, roundId, onPersistedChange, quiz, roundNumber = 1 }: { quiz?: Quiz; roundNumber?: number; quizId: string; roundId: string; onPersistedChange?: () => void }) {
  const base = `/api/quizzes/${quizId}/rounds/${roundId}/questions`;
  const [questions, setQuestions] = useState<Question[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [media, setMedia] = useState<Media[]>([]);
  const [pairs, setPairs] = useState<Pair[]>([]);
  const [options, setOptions] = useState<Option[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const saves = useEditorSave(roundId);
  const { status } = saves;
  const [error, setError] = useState('');

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

  useEffect(() => {
    if (!previewOpen) return;
    let active = true;
    api<Media[]>(`/api/quizzes/${quizId}/media`).then(items => { if (active) setMedia(items); })
      .catch((cause: Error) => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [previewOpen, quizId]);

  async function selectQuestion(id: string) {
    try { await saves.flush(); setSelectedId(id); setError(''); }
    catch (cause) { setError((cause as Error).message); }
  }
  function schedule(key: string, path: string, body: QuestionFields | OptionFields | PairFields) {
    saves.schedule(key, async () => { await api(path, json('PUT', body)); onPersistedChange?.(); });
  }
  async function afterSaves(action: () => Promise<void>) {
    setBusy(true);
    try { await saves.perform(async () => { await action(); onPersistedChange?.(); }); setError(''); }
    catch (cause) { setError((cause as Error).message); }
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
  function editPair(pair: Pair, side: 'left' | 'right', value: Side) {
    const changes = { left: pair.left, right: pair.right, [side]: value };
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
    explanationRu: selected.explanationRu ?? '', explanationEn: selected.explanationEn ?? '', type: selected.type, textRu: selected.textRu, textEn: selected.textEn, points: selected.points,
    answerTimeSeconds: selected.answerTimeSeconds, showOptionsOnScreen: selected.showOptionsOnScreen, showCorrectCount: selected.showCorrectCount ?? true, media: selected.media ?? [],
  } : null;

  return <section className="questions">
    <div className="editor-heading"><h3>Questions</h3><span role="status" className="question-status" aria-live="polite">{status}</span></div>
    {(saves.error || error) && <p role="alert" className="error">{saves.error || error}</p>}
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
          onClick={() => void selectQuestion(question.id)}>
          {index + 1}. {question.textEn || question.textRu || 'Untitled question'}
        </button>
        <div className="round-order">
          <button className="subtle" aria-label={`Move question ${index + 1} up`} disabled={busy || index === 0} onClick={() => moveQuestion(index, -1)}>↑</button>
          <button className="subtle" aria-label={`Move question ${index + 1} down`} disabled={busy || index === questions.length - 1} onClick={() => moveQuestion(index, 1)}>↓</button>
        </div>
      </li>)}</ol>}
      {selected && <button onClick={() => setPreviewOpen(open => !open)} aria-expanded={previewOpen}>Preview question</button>}
      {selected && previewOpen && <QuizPreview key={selected.id} quizId={quizId} quiz={quiz} question={selected} options={options} pairs={pairs} media={media}
        roundNumber={roundNumber} questionNumber={questions.indexOf(selected) + 1} questionCount={questions.length} onClose={() => setPreviewOpen(false)} />}
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
        <label>Explanation RU (after Reveal)<textarea maxLength={5000} value={selected.explanationRu ?? ''} disabled={busy} onChange={event => editQuestion(selected, { ...fields, explanationRu: event.target.value })} /></label>
        <label>Explanation EN (after Reveal)<textarea maxLength={5000} value={selected.explanationEn ?? ''} disabled={busy} onChange={event => editQuestion(selected, { ...fields, explanationEn: event.target.value })} /></label>
        {(selected.textRu.length > 1000 || selected.textEn.length > 1000 || options.some(option => option.textRu.length > 200 || option.textEn.length > 200)) && <p role="status">Long text may be hard to read on phones or TV. Check Preview; text is not truncated.</p>}
        <label>Points<input type="number" min="1" step="1" value={selected.points} disabled={busy} onChange={(event) => editQuestion(selected, { ...fields, points: Number(event.target.value) })} /></label>
        <label>Answer time<select value={selected.answerTimeSeconds === null ? 'default' : 'custom'} disabled={busy}
          onChange={(event) => editQuestion(selected, { ...fields, answerTimeSeconds: event.target.value === 'default' ? null : 30 })}>
          <option value="default">Use quiz default</option><option value="custom">Custom</option>
        </select></label>
        {selected.answerTimeSeconds !== null && <label>Custom answer time (seconds)<input type="number" min="1" max="3600" step="1" value={selected.answerTimeSeconds} disabled={busy}
          onChange={(event) => editQuestion(selected, { ...fields, answerTimeSeconds: Number(event.target.value) })} /></label>}
        <label className="checkbox"><input type="checkbox" checked={selected.showOptionsOnScreen} disabled={busy}
          onChange={(event) => editQuestion(selected, { ...fields, showOptionsOnScreen: event.target.checked })} /> Show answer options on Screen</label>
        <h4>Question media (Screen/TV)</h4>
        <button disabled={busy} onClick={() => void afterSaves(async () => { setMedia(await api<Media[]>(`/api/quizzes/${quizId}/media`)); })}>Load / refresh uploaded media</button>
        <label>Attach question media<select value="" disabled={busy} onChange={event => {
          if (event.target.value) editQuestion(selected, { ...fields, media: [...(selected.media ?? []), { mediaId: event.target.value, playBeforeTimer: false }] });
        }}><option value="">Select uploaded media</option>{media.filter(item => !selected.media?.some(ref => ref.mediaId === item.id)).map(item => <option key={item.id} value={item.id}>{item.name} ({item.kind})</option>)}</select></label>
        <ol>{(selected.media ?? []).map((ref, index, refs) => {
          const item = media.find(item => item.id === ref.mediaId);
          const update = (next: MediaRef[]) => editQuestion(selected, { ...fields, media: next });
          const move = (direction: -1 | 1) => { const next = [...refs]; [next[index], next[index + direction]] = [next[index + direction], next[index]]; update(next); };
          return <li key={ref.mediaId}>{item?.name ?? `Media ${ref.mediaId}`}
            {item?.kind === 'image' && <MediaImage src={`/api/quizzes/${quizId}/media/${ref.mediaId}/content`} alt={item.name} className="editor-media-preview" />}
            {item && item.kind !== 'image' && <label><input type="checkbox" checked={ref.playBeforeTimer} disabled={busy} onChange={event => update(refs.map(value => value.mediaId === ref.mediaId ? { ...value, playBeforeTimer: event.target.checked } : value))} />Play before timer</label>}
            <button aria-label={`Move media ${index + 1} up`} disabled={busy || index === 0} onClick={() => move(-1)}>↑</button>
            <button aria-label={`Move media ${index + 1} down`} disabled={busy || index === refs.length - 1} onClick={() => move(1)}>↓</button>
            <button aria-label={`Remove media ${index + 1}`} disabled={busy} onClick={() => update(refs.filter(value => value.mediaId !== ref.mediaId))}>Remove reference</button>
          </li>;
        })}</ol>
        {selected.type === 'matching' ? <>
          <h4>Matching pairs</h4>
          <p>At least 2 complete pairs. Each side uses bilingual text or an uploaded image. Switching to an option type clears pairs; switching back creates blank pairs.</p>
          {pairs.map((pair, index) => <div className="option-editor" key={pair.id}>
            <h5>Pair {index + 1}</h5>
            {(['left', 'right'] as const).map(side => <div key={side}>
              <label>Pair {index + 1} {side} kind<select value={pair[side].kind} disabled={busy} onChange={event => {
                if (event.target.value === 'text') editPair(pair, side, { kind: 'text', textRu: '', textEn: '' });
                else {
                  const image = media.find(item => item.kind === 'image');
                  if (image) editPair(pair, side, { kind: 'image', mediaId: image.id });
                }
              }}><option value="text">Bilingual text</option><option value="image" disabled={!media.some(item => item.kind === 'image')}>Image</option></select></label>
              {pair[side].kind === 'image' ? <>
                <label>Pair {index + 1} {side} image<select value={pair[side].mediaId} disabled={busy} onChange={event => editPair(pair, side, { kind: 'image', mediaId: event.target.value })}>
                  {!media.some(item => item.id === (pair[side] as { mediaId: string }).mediaId) && <option value={pair[side].mediaId}>Current image (load media to inspect)</option>}
                  {media.filter(item => item.kind === 'image').map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select></label>
                <MediaImage src={`/api/quizzes/${quizId}/media/${pair[side].mediaId}/content`} alt={`Pair ${index + 1} ${side} image`} className="editor-media-preview" />
              </> : (['textRu', 'textEn'] as const).map(language => <label key={language}>
                Pair {index + 1} {side} {language === 'textRu' ? 'RU' : 'EN'}
                <input maxLength={500} value={(pair[side] as TextSide)[language]} disabled={busy}
                  onChange={event => editPair(pair, side, { ...(pair[side] as TextSide), [language]: event.target.value })} />
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
