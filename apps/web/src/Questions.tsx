import { QuizPreview } from './QuizPreview';
import type { AuthoringTarget, Quiz } from './Admin';
import { useQuizMedia } from './Media';
import { MediaImage } from './MediaImage';
import { useEffect, useRef, useState } from 'react';
import { useEditorSave, useSaveBarrier } from './EditorSaves';
import { useQuestionAnswerData } from './useQuestionAnswerData';

export type Question = {
  id: string; roundId: string; type: 'single_choice' | 'yes_no' | 'multiple_choice' | 'matching'; textRu: string; textEn: string;
  points: number; answerTimeSeconds: number | null; showCorrectCount?: boolean;
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
type QuestionFields = Pick<Question, 'type' | 'textRu' | 'textEn' | 'points' | 'answerTimeSeconds' | 'showCorrectCount' | 'media' | 'explanationRu' | 'explanationEn'>;
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

export function Questions({ quizId, roundId, onPersistedChange, quiz, roundNumber = 1, mediaRevision = 0, targetQuestion }: { quiz?: Quiz; roundNumber?: number; quizId: string; roundId: string; onPersistedChange?: () => void; mediaRevision?: number; targetQuestion?: AuthoringTarget | null }) {
  const base = `/api/quizzes/${quizId}/rounds/${roundId}/questions`;
  const [questions, setQuestions] = useState<Question[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const { items: media, error: mediaError, retry: retryMedia } = useQuizMedia(quizId, mediaRevision, previewOpen);
  const [addType, setAddType] = useState<Question['type']>('single_choice');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const appliedTarget = useRef<typeof targetQuestion>(null);
  const editor = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const saves = useEditorSave();
  const barrier = useSaveBarrier();
  const questionOwner = (id: string) => `${roundId}/questions/${id}`;
  const { status } = saves;
  const [error, setError] = useState('');
  const selected = questions.find((item) => item.id === selectedId);
  const {
    options, setOptions, pairs, setPairs, childLoadFailed,
    loadAnswerData, commitChildChange, resetAnswerData, changeAnswerSelection,
    applyOptionEdit, applyPairEdit, applyQuestionTypeChange,
  } = useQuestionAnswerData({ base, selected, questionOwner, api, saves, barrier, setError });
  const visibleOptions = selected ? options.filter(item => item.questionId === selected.id) : [];
  const visiblePairs = selected ? pairs.filter(item => item.questionId === selected.id) : [];

  useEffect(() => {
    let active = true;
    api<Question[]>(base).then((items) => {
      if (active) { setQuestions(items); setSelectedId(items[0]?.id ?? null); }
    }).catch((cause: Error) => { if (active) setError(cause.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [base]);

  useEffect(() => resetAnswerData(selected), [base, selectedId]);

  useEffect(() => {
    if (!targetQuestion?.questionId || targetQuestion === appliedTarget.current || !questions.some(item => item.id === targetQuestion.questionId)) return;
    appliedTarget.current = targetQuestion;
    if (selectedId !== targetQuestion.questionId) void selectQuestion(targetQuestion.questionId);
  }, [targetQuestion, questions, selectedId]);

  useEffect(() => {
    if (!targetQuestion?.questionId || selectedId !== targetQuestion.questionId) return;
    setSettingsOpen(true);
    const child = [...(editor.current?.querySelectorAll<HTMLElement>('[data-authoring-item]') ?? [])]
      .find(item => item.dataset.authoringItem === (targetQuestion.optionId ?? targetQuestion.pairId));
    const target = child ?? editor.current;
    target?.scrollIntoView?.({ block: 'start' });
    target?.focus();
  }, [targetQuestion, selectedId, visibleOptions.length, visiblePairs.length]);

  async function selectQuestion(id: string) {
    try { await saves.flush(); changeAnswerSelection(() => setSelectedId(id)); setError(''); }
    catch (cause) { setError((cause as Error).message); }
  }
  function schedule(key: string, path: string, body: QuestionFields | OptionFields | PairFields, owner: string) {
    saves.schedule(key, async () => { await api(path, json('PUT', body)); onPersistedChange?.(); }, undefined, owner);
  }
  async function afterSaves(action: () => Promise<void>, discardOwner?: string, failureKey?: string): Promise<boolean> {
    setBusy(true);
    try {
      let release: (() => void) | undefined;
      if (discardOwner) {
        release = await (barrier ?? saves).flushExcept(discardOwner, failureKey);
      }
      try {
        await saves.perform(async () => {
          await action();
          if (discardOwner) (barrier ?? saves).discard(discardOwner);
          onPersistedChange?.();
        }, failureKey, Boolean(discardOwner), discardOwner); setError('');
        return true;
      } finally { release?.(); }
    }
    catch (cause) { setError((cause as Error).message); return false; }
    finally { setBusy(false); }
  }

  function editQuestion(question: Question, changes: QuestionFields) {
    setQuestions((items) => items.map((item) => item.id === question.id ? { ...item, ...changes } : item));
    schedule(question.id, `${base}/${question.id}`, changes, questionOwner(question.id));
  }
  function editOption(option: Option, changes: OptionFields) {
    applyOptionEdit(option, changes);
    schedule(option.id, `${base}/${option.questionId}/options/${option.id}`, changes, `${questionOwner(option.questionId)}/options/${option.id}`);
  }
  function editPair(pair: Pair, side: 'left' | 'right', value: Side) {
    const changes = { left: pair.left, right: pair.right, [side]: value };
    applyPairEdit(pair, changes);
    schedule(pair.id, `${base}/${pair.questionId}/pairs/${pair.id}`, changes, `${questionOwner(pair.questionId)}/pairs/${pair.id}`);
  }
  function movePair(index: number, direction: -1 | 1) {
    if (!selected) return;
    void afterSaves(async () => {
      const next = [...visiblePairs];
      [next[index], next[index + direction]] = [next[index + direction], next[index]];
      const ordered = await api<Pair[]>(`${base}/${selected.id}/pairs/order`, json('PUT', { ids: next.map(item => item.id) }));
      commitChildChange(selected, () => setPairs(ordered));
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
      const next = [...visibleOptions];
      [next[index], next[index + direction]] = [next[index + direction], next[index]];
      const ordered = await api<Option[]>(`${base}/${selected.id}/options/order`, json('PUT', { ids: next.map((item) => item.id) }));
      commitChildChange(selected, () => setOptions(ordered));
    });
  }
  const fields: QuestionFields | null = selected ? {
    explanationRu: selected.explanationRu ?? '', explanationEn: selected.explanationEn ?? '', type: selected.type, textRu: selected.textRu, textEn: selected.textEn, points: selected.points,
    answerTimeSeconds: selected.answerTimeSeconds, showCorrectCount: selected.showCorrectCount ?? true, media: selected.media ?? [],
  } : null;

  return <section className="questions">
    <div className="editor-heading"><h3>Questions</h3><span role="status" className="question-status" aria-live="polite">{status === 'Saving...' ? 'Saving…' : status}</span></div>
    {(saves.error || error) && <p role="alert" className="error">{saves.error || error}</p>}
    {loading ? <p>Loading questions...</p> : <>
      <div className="authoring-actions add-question"><label>New question type<select value={addType} disabled={busy} onChange={event => setAddType(event.target.value as Question['type'])}>
        <option value="single_choice">Single Choice</option><option value="yes_no">Yes / No</option><option value="multiple_choice">Multiple Choice</option><option value="matching">Matching</option>
      </select></label><button disabled={busy} onClick={() => void afterSaves(async () => {
        const question = await api<Question>(base, addType === 'single_choice' ? { method: 'POST' } : json('POST', { type: addType }));
        setQuestions(items => [...items, question]); setSelectedId(question.id);
      })}>Add question</button></div>
      <div className="question-workspace"><nav className="authoring-navigator" aria-label="Questions">
      {questions.length === 0 ? <p>No questions yet.</p> : <ol className="round-list">{questions.map((question, index) => <li key={question.id}>
        <button aria-current={selectedId === question.id ? 'true' : undefined} className={selectedId === question.id ? 'selected-round' : 'subtle'} disabled={busy}
          onClick={() => void selectQuestion(question.id)}>
          <span className="navigator-title">{index + 1}. {question.textEn || question.textRu || 'Untitled question'}</span>
        </button>
        <div className="round-order">
          <button className="subtle" aria-label={`Move question ${index + 1} up`} disabled={busy || index === 0} onClick={() => moveQuestion(index, -1)}>↑</button>
          <button className="subtle" aria-label={`Move question ${index + 1} down`} disabled={busy || index === questions.length - 1} onClick={() => moveQuestion(index, 1)}>↓</button>
        </div>
      </li>)}</ol>}
      </nav><div className="selected-question-content">
      <div id="question-preview" className="authoring-actions preview-entry">
        <div><h4>{selected ? `Question ${questions.indexOf(selected) + 1}` : 'Preview'}</h4><p>See how the selected question looks to Players, Screen, and Host.</p></div>
        <button disabled={!selected} onClick={() => setPreviewOpen(open => !open)} aria-expanded={previewOpen}>Preview question</button>
      </div>
      {selected && previewOpen && <QuizPreview key={selected.id} quizId={quizId} quiz={quiz} question={selected} options={visibleOptions} pairs={visiblePairs} media={media}
        roundNumber={roundNumber} questionNumber={questions.indexOf(selected) + 1} questionCount={questions.length} onClose={() => setPreviewOpen(false)} />}
      {selected && fields && <div className="question-editor fields" ref={editor} tabIndex={-1}>
        <h4>{selected.type === 'matching' ? 'Matching' : selected.type === 'yes_no' ? 'Yes / No' : selected.type === 'multiple_choice' ? 'Multiple Choice' : 'Single Choice'} question</h4>
        <details className="authoring-secondary"><summary>Change question type</summary><div className="fields"><label>Question type<select value={selected.type} disabled={busy} onChange={event => {
          const type = event.target.value as Question['type'];
          void (async () => {
            let confirmed: Question | undefined;
            const obsoleteOwner = selected.type === 'matching' && type !== 'matching' ? `${questionOwner(selected.id)}/pairs`
              : selected.type !== 'matching' && type === 'matching' ? `${questionOwner(selected.id)}/options` : undefined;
            const saved = await afterSaves(async () => {
              const question = await api<Question>(`${base}/${selected.id}`, json('PUT', { ...fields, type }));
              confirmed = question;
              applyQuestionTypeChange(selected, question, () => {
                setQuestions(items => items.map(item => item.id === question.id ? question : item));
              });
            }, obsoleteOwner);
            if (saved && confirmed) await loadAnswerData(confirmed);
          })();
        }}><option value="single_choice">Single Choice</option><option value="yes_no">Yes / No</option><option value="multiple_choice">Multiple Choice</option><option value="matching">Matching</option></select></label><p>Changing between Matching and other types clears the current answers. Matching starts with two blank pairs.</p></div></details>
        <label>Question text RU<textarea maxLength={5000} value={selected.textRu} disabled={busy} onChange={(event) => editQuestion(selected, { ...fields, textRu: event.target.value })} /></label>
        {childLoadFailed && <p>Could not load the answers. <button disabled={busy} onClick={() => void loadAnswerData(selected)}>Try loading answers again</button></p>}
        <label>Question text EN<textarea maxLength={5000} value={selected.textEn} disabled={busy} onChange={(event) => editQuestion(selected, { ...fields, textEn: event.target.value })} /></label>
        <details className="authoring-secondary" open={settingsOpen} onToggle={event => setSettingsOpen(event.currentTarget.open)}><summary>Timing, points & explanation</summary><div className="fields">
        <label>Explanation RU (after Reveal)<textarea maxLength={5000} value={selected.explanationRu ?? ''} disabled={busy} onChange={event => editQuestion(selected, { ...fields, explanationRu: event.target.value })} /></label>
        <label>Explanation EN (after Reveal)<textarea maxLength={5000} value={selected.explanationEn ?? ''} disabled={busy} onChange={event => editQuestion(selected, { ...fields, explanationEn: event.target.value })} /></label>
        {(selected.textRu.length > 1000 || selected.textEn.length > 1000 || visibleOptions.some(option => option.textRu.length > 200 || option.textEn.length > 200)) && <p role="status">Long text may be hard to read on phones or TV. Check Preview; text is not truncated.</p>}
        <label>Points<input type="number" min="1" step="1" value={selected.points} disabled={busy} onChange={(event) => editQuestion(selected, { ...fields, points: Number(event.target.value) })} /></label>
        <label>Answer time<select value={selected.answerTimeSeconds === null ? 'default' : 'custom'} disabled={busy}
          onChange={(event) => editQuestion(selected, { ...fields, answerTimeSeconds: event.target.value === 'default' ? null : 30 })}>
          <option value="default">Use quiz default</option><option value="custom">Custom</option>
        </select></label>
        {selected.answerTimeSeconds !== null && <label>Custom answer time (seconds)<input type="number" min="1" max="3600" step="1" value={selected.answerTimeSeconds} disabled={busy}
          onChange={(event) => editQuestion(selected, { ...fields, answerTimeSeconds: Number(event.target.value) })} /></label>}
        </div></details>
        {selected.type === 'matching' ? <>
          <h4>Matching pairs</h4>
          <p>At least 2 complete pairs. Each side uses bilingual text or an uploaded image.</p>
          {visiblePairs.map((pair, index) => <div className="option-editor" key={pair.id} data-authoring-item={pair.id} tabIndex={-1}>
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
                  {!media.some(item => item.id === (pair[side] as { mediaId: string }).mediaId) && <option value={pair[side].mediaId}>Image unavailable — choose another</option>}
                  {media.filter(item => item.kind === 'image').map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select></label>
                <MediaImage src={`/api/quizzes/${quizId}/media/${pair[side].mediaId}/content`} alt={`Pair ${index + 1} ${side} image`} className="editor-media-preview" />
              </> : (['textRu', 'textEn'] as const).map(language => <label key={language}>
                Pair {index + 1} {side} {language === 'textRu' ? 'RU' : 'EN'}
                <input maxLength={500} value={(pair[side] as TextSide)[language]} disabled={busy}
                  onChange={event => editPair(pair, side, { ...(pair[side] as TextSide), [language]: event.target.value })} />
              </label>)}
            </div>)}
            <div className="authoring-actions"><div className="round-order">
              <button className="subtle" aria-label={`Move pair ${index + 1} up`} disabled={busy || index === 0} onClick={() => movePair(index, -1)}>↑</button>
              <button className="subtle" aria-label={`Move pair ${index + 1} down`} disabled={busy || index === visiblePairs.length - 1} onClick={() => movePair(index, 1)}>↓</button>
            </div><div className="destructive-actions"><button className="subtle danger" aria-label={`Delete pair ${index + 1}`} disabled={busy} onClick={() => void afterSaves(async () => {
                await api<void>(`${base}/${selected.id}/pairs/${pair.id}`, { method: 'DELETE' });
                commitChildChange(selected, () => setPairs(items => items.filter(item => item.id !== pair.id)));
              }, `${questionOwner(selected.id)}/pairs/${pair.id}`, `delete:pair:${roundId}:${selected.id}:${pair.id}`)}>Delete</button></div>
            </div>
          </div>)}
          <button disabled={busy} onClick={() => void afterSaves(async () => {
            const pair = await api<Pair>(`${base}/${selected.id}/pairs`, { method: 'POST' });
            commitChildChange(selected, () => setPairs(items => [...items, pair]));
          })}>Add pair</button>
        </> : <>
        <h4>Answer options</h4>
        {selected.type === 'multiple_choice' && <>
          <p>Use 2–10 options and mark at least 2 correct.</p>
          <label className="checkbox"><input type="checkbox" checked={selected.showCorrectCount ?? true} disabled={busy}
            onChange={event => editQuestion(selected, { ...fields, showCorrectCount: event.target.checked })} /> Show correct-option count to Player</label>
        </>}
        {visibleOptions.map((option, index) => <div className="option-editor" key={option.id} data-authoring-item={option.id} tabIndex={-1}>
          <label className="checkbox"><input type={selected.type === 'multiple_choice' ? 'checkbox' : 'radio'} name={`correct-${selected.id}`} checked={option.isCorrect} disabled={busy}
            onChange={event => {
              if (selected.type === 'multiple_choice') { editOption(option, { textRu: option.textRu, textEn: option.textEn, isCorrect: event.target.checked }); return; }
              void afterSaves(async () => {
                const corrected = await api<Option[]>(`${base}/${selected.id}/options/${option.id}/correct`, { method: 'PUT' });
                commitChildChange(selected, () => setOptions(corrected));
              });
            }} /> Correct answer, option {index + 1}</label>
          <label>Option {index + 1} RU<input maxLength={500} value={option.textRu} disabled={busy}
            onChange={(event) => editOption(option, { textRu: event.target.value, textEn: option.textEn, isCorrect: option.isCorrect })} /></label>
          <label>Option {index + 1} EN<input maxLength={500} value={option.textEn} disabled={busy}
            onChange={(event) => editOption(option, { textRu: option.textRu, textEn: event.target.value, isCorrect: option.isCorrect })} /></label>
          {selected.type !== 'yes_no' && <div className="authoring-actions"><div className="round-order">
            <button className="subtle" aria-label={`Move option ${index + 1} up`} disabled={busy || index === 0} onClick={() => moveOption(index, -1)}>↑</button>
            <button className="subtle" aria-label={`Move option ${index + 1} down`} disabled={busy || index === visibleOptions.length - 1} onClick={() => moveOption(index, 1)}>↓</button>
            </div><div className="destructive-actions"><button className="subtle danger" aria-label={`Delete option ${index + 1}`} disabled={busy}
              onClick={() => void afterSaves(async () => {
                await api<void>(`${base}/${selected.id}/options/${option.id}`, { method: 'DELETE' });
                commitChildChange(selected, () => setOptions((items) => items.filter((item) => item.id !== option.id)));
              }, `${questionOwner(selected.id)}/options/${option.id}`, `delete:option:${roundId}:${selected.id}:${option.id}`)}>Delete</button></div>
          </div>}
        </div>)}
        {selected.type !== 'yes_no' && <button disabled={busy || visibleOptions.length >= 10} onClick={() => void afterSaves(async () => {
          const option = await api<Option>(`${base}/${selected.id}/options`, { method: 'POST' });
          commitChildChange(selected, () => setOptions((items) => [...items, option]));
        })}>Add option</button>}
        </>}
        <section className="question-media-editor" aria-label="Question media"><h4>Question media (Screen/TV)</h4>
        <p><a href="#quiz-media">Upload in the media library</a>, then attach a file here.</p>
        {mediaError && <p role="alert">{mediaError} <button className="subtle" disabled={busy} onClick={retryMedia}>Try loading media again</button></p>}
        <label>Attach question media<select value="" disabled={busy} onChange={event => {
          if (event.target.value) editQuestion(selected, { ...fields, media: [...(selected.media ?? []), { mediaId: event.target.value, playBeforeTimer: false }] });
        }}><option value="">Select uploaded media</option>{media.filter(item => !selected.media?.some(ref => ref.mediaId === item.id)).map(item => <option key={item.id} value={item.id}>{item.name} ({item.kind})</option>)}</select></label>
        <ol className="attachment-list">{(selected.media ?? []).map((ref, index, refs) => {
          const item = media.find(item => item.id === ref.mediaId);
          const update = (next: MediaRef[]) => editQuestion(selected, { ...fields, media: next });
          const move = (direction: -1 | 1) => { const next = [...refs]; [next[index], next[index + direction]] = [next[index + direction], next[index]]; update(next); };
          return <li key={ref.mediaId}><strong>{item ? `${item.name} (${item.kind})` : 'Attached file unavailable — remove it or choose another'}</strong>
            {item?.kind === 'image' && <MediaImage src={`/api/quizzes/${quizId}/media/${ref.mediaId}/content`} alt={item.name} className="editor-media-preview" />}
            {item && item.kind !== 'image' && <><label className="checkbox"><input type="checkbox" checked={ref.playBeforeTimer} disabled={busy} onChange={event => update(refs.map(value => value.mediaId === ref.mediaId ? { ...value, playBeforeTimer: event.target.checked } : value))} />Play before answer timer starts</label><p>The answer timer waits for this audio or video to finish.</p></>}
            <div className="authoring-actions media-actions"><div className="round-order">
              <button className="subtle" aria-label={`Move media ${index + 1} up`} disabled={busy || index === 0} onClick={() => move(-1)}>↑</button>
              <button className="subtle" aria-label={`Move media ${index + 1} down`} disabled={busy || index === refs.length - 1} onClick={() => move(1)}>↓</button>
            </div><div className="destructive-actions"><button className="subtle danger" aria-label={`Remove media ${index + 1}`} disabled={busy} onClick={() => update(refs.filter(value => value.mediaId !== ref.mediaId))}>Remove attachment</button></div></div>
          </li>;
        })}</ol></section>
        <div className="destructive-actions"><button className="subtle danger" disabled={busy} onClick={() => {
          if (!window.confirm('Delete this question? This cannot be undone.')) return;
          void afterSaves(async () => {
            await api<void>(`${base}/${selected.id}`, { method: 'DELETE' });
            const next = questions.filter((item) => item.id !== selected.id);
            setQuestions(next); setSelectedId(next[0]?.id ?? null);
          }, questionOwner(selected.id), `delete:question:${roundId}:${selected.id}`);
        }}>Delete question</button></div>
      </div>}
      </div></div>
    </>}
  </section>;
}
