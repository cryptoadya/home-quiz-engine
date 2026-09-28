import { MatchingItemContent } from './MediaImage';
import { useState } from 'react';
import { CountdownDisplay, useRemainingSeconds } from './Countdown';
import type { PlayerQuestion, Submission, Mapping } from './lobby';

export function PlayerAnswer({ question, roomId, token, language }: {
  question: PlayerQuestion; roomId: string; token: string; language: 'ru' | 'en';
}) {
  const seconds = useRemainingSeconds(question.timer);
  async function submitAnswer(answer: AnswerDraft): Promise<Submission> {
    const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/answers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, questionId: question.questionId, ...answer }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.code === 'DEADLINE_REACHED' ? 'DEADLINE_REACHED' : 'Submission failed');
    return body;
  }
  return <PlayerAnswerContent question={question} language={language} seconds={seconds} onSubmit={submitAnswer} />;
}

export type AnswerDraft = { optionId: string } | { optionIds: string[] } | { mapping: Mapping };

// Presentation and draft interaction are independent of transport and clock ownership.
export function PlayerAnswerContent({ question, language, seconds, onSubmit }: {
  question: Omit<PlayerQuestion, 'timer'>; language: 'ru' | 'en'; seconds: number;
  onSubmit: (answer: AnswerDraft) => Promise<Submission>;
}) {
  const [mapping, setMapping] = useState<Mapping>([]);
  const [activeLeft, setActiveLeft] = useState<string | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const [accepted, setAccepted] = useState<Submission>({ submitted: false });
  const [busy, setBusy] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [error, setError] = useState(false);
  // Accepted state is monotonic for this keyed question, even if an older HTTP
  // reconnect response arrives after the submission acknowledgement.
  if (question.submission?.submitted && !accepted.submitted) setAccepted(question.submission);
  const submission = accepted.submitted ? accepted : question.submission;
  const locked = Boolean(submission?.submitted) || timedOut || seconds === 0 || busy;
  const multiple = question.type === 'multiple_choice';
  const matching = question.type === 'matching';
  const pairs = submission?.submitted && 'mapping' in submission ? submission.mapping : mapping;
  const complete = matching ? pairs.length === (question.leftItems?.length ?? 0) && pairs.length > 0 : selection.length > 0;
  const selected = submission?.submitted ? ('optionIds' in submission ? submission.optionIds : 'optionId' in submission ? [submission.optionId] : []) : selection;
  const ru = language === 'ru';

  async function submit() {
    if (locked || !complete) return;
    setBusy(true); setError(false);
    try {
      setAccepted(await onSubmit(matching ? { mapping: pairs } : multiple ? { optionIds: selected } : { optionId: selected[0] }));
    } catch (cause) {
      if (cause instanceof Error && cause.message === 'DEADLINE_REACHED') setTimedOut(true);
      else setError(true);
    }
    finally { setBusy(false); }
  }

  return <>
    <h2>{question.text}</h2>
    {multiple && question.requiredCorrectCount !== undefined && <p>{ru ? 'Количество верных вариантов' : 'Required correct options'}: {question.requiredCorrectCount}</p>}
    <CountdownDisplay seconds={timedOut ? 0 : seconds} language={language} />
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      {matching ? <fieldset disabled={locked}>
        <legend>{ru ? 'Нажмите слева, затем справа' : 'Tap a left item, then a right item'}</legend>
        <div className="matching-columns">
          <div>{question.leftItems?.map((item, index) => <button type="button" key={item.id} disabled={locked} aria-pressed={activeLeft === item.id}
            onClick={() => setActiveLeft(item.id)}>{index + 1}. <MatchingItemContent item={item} /></button>)}</div>
          <div>{question.rightItems?.map(item => { const pair = pairs.find(pair => pair.rightId === item.id); return <button type="button" key={item.id}
            disabled={locked || !activeLeft} onClick={() => { setMapping(current => [...current.filter(pair => pair.leftId !== activeLeft && pair.rightId !== item.id), { leftId: activeLeft!, rightId: item.id }]); setActiveLeft(null); }}>
            <MatchingItemContent item={item} />{pair ? ` (${question.leftItems!.findIndex(left => left.id === pair.leftId) + 1})` : ''}
          </button>; })}</div>
        </div>
        <ul>{pairs.map(pair => { const left = question.leftItems?.find(item => item.id === pair.leftId); const right = question.rightItems?.find(item => item.id === pair.rightId); return <li key={pair.leftId}><MatchingItemContent item={left} /> → <MatchingItemContent item={right} /></li>; })}</ul>
      </fieldset> : <fieldset disabled={locked} className="answer-choices">
        <legend>{multiple ? (ru ? 'Выберите несколько вариантов' : 'Choose multiple options') : (ru ? 'Выберите один вариант' : 'Choose one option')}</legend>
        {question.options.map(option => <label key={option.id}>
          <input type={multiple ? "checkbox" : "radio"} name="answer" value={option.id} checked={selected.includes(option.id)}
            disabled={locked} onChange={() => setSelection(current => multiple ? (current.includes(option.id) ? current.filter(id => id !== option.id) : [...current, option.id]) : [option.id])} />
          {option.text}
        </label>)}
      </fieldset>}
      {!submission?.submitted && <p>{ru ? 'Выбор можно изменить до отправки' : 'You can change your choice before Submit'}</p>}
      <button type="submit" disabled={locked || !complete}>{ru ? 'Отправить' : 'Submit'}</button>
    </form>
    {submission?.submitted && <p role="status">{ru ? 'Ответ принят' : 'Answer submitted'}</p>}
    {error && <p role="alert">{ru ? 'Не удалось подтвердить ответ. Попробуйте отправить снова или обновить страницу.' : 'Could not confirm your answer. Retry Submit or refresh the page.'}</p>}
  </>;
}
