import { useState } from 'react';
import { CountdownDisplay, useRemainingSeconds } from './Countdown';
import type { PlayerQuestion, Submission } from './lobby';

export function PlayerAnswer({ question, roomId, token, language }: {
  question: PlayerQuestion; roomId: string; token: string; language: 'ru' | 'en';
}) {
  const [selection, setSelection] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<Submission>({ submitted: false });
  const [busy, setBusy] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [error, setError] = useState(false);
  // Accepted state is monotonic for this keyed question, even if an older HTTP
  // reconnect response arrives after the submission acknowledgement.
  if (question.submission?.submitted && !accepted.submitted) setAccepted(question.submission);
  const submission = accepted.submitted ? accepted : question.submission;
  const seconds = useRemainingSeconds(question.timer);
  const locked = Boolean(submission?.submitted) || timedOut || seconds === 0 || busy;
  const selected = submission?.submitted ? submission.optionId : selection;
  const ru = language === 'ru';

  async function submit() {
    if (locked || !selected) return;
    setBusy(true); setError(false);
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/answers`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, questionId: question.questionId, optionId: selected }),
      });
      const body = await response.json();
      if (!response.ok) {
        if (body.code === 'DEADLINE_REACHED') { setTimedOut(true); return; }
        throw new Error('Submission failed');
      }
      setAccepted(body);
    } catch { setError(true); }
    finally { setBusy(false); }
  }

  return <>
    <h2>{question.text}</h2>
    <CountdownDisplay seconds={timedOut ? 0 : seconds} language={language} />
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <fieldset disabled={locked} className="answer-choices">
        <legend>{ru ? 'Выберите один вариант' : 'Choose one option'}</legend>
        {question.options.map(option => <label key={option.id}>
          <input type="radio" name="answer" value={option.id} checked={selected === option.id}
            disabled={locked} onChange={() => setSelection(option.id)} />
          {option.text}
        </label>)}
      </fieldset>
      {!submission?.submitted && <p>{ru ? 'Выбор можно изменить до отправки' : 'You can change your choice before Submit'}</p>}
      <button type="submit" disabled={locked || !selected}>{ru ? 'Отправить' : 'Submit'}</button>
    </form>
    {submission?.submitted && <p role="status">{ru ? 'Ответ принят' : 'Answer submitted'}</p>}
    {error && <p role="alert">{ru ? 'Не удалось подтвердить ответ. Попробуйте отправить снова или обновить страницу.' : 'Could not confirm your answer. Retry Submit or refresh the page.'}</p>}
  </>;
}
