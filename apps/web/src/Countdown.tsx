import { useEffect, useMemo, useState } from 'react';
import type { AnswerTimer } from './lobby';

// Anchor server time to a monotonic local clock: device wall-clock skew is irrelevant.
// This is display only; server deadline checks decide whether time actually remains.
export function useRemainingSeconds(timer: AnswerTimer) {
  const anchor = useMemo(() => ({ receivedAt: performance.now(), remainingMs:
    timer.expired ? 0 : Math.max(0, Date.parse(timer.deadlineAt) - Date.parse(timer.serverNow)) }), [timer]);
  const [, refresh] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => refresh(value => value + 1), 250);
    return () => clearInterval(interval);
  }, [anchor]);
  const seconds = Math.ceil(Math.max(0, anchor.remainingMs - (performance.now() - anchor.receivedAt)) / 1000);
  return seconds;
}

export function Countdown({ timer, language }: { timer: AnswerTimer; language?: 'ru' | 'en' }) {
  return <CountdownDisplay seconds={useRemainingSeconds(timer)} durationSeconds={timer.durationSeconds} language={language} />;
}

export function CountdownDisplay({ seconds, language, durationSeconds }: { seconds: number; durationSeconds?: number; language?: 'ru' | 'en' }) {
  return <div className="countdown">
    <span>{language === 'ru' ? 'Осталось секунд' : language === 'en' ? 'Seconds remaining' : 'Осталось секунд / Seconds remaining'}</span>
    <strong role="timer" aria-label={language === 'ru' ? 'Осталось секунд' : 'Seconds remaining'}>{seconds}</strong>
    {durationSeconds !== undefined && <progress aria-label="Time remaining" max={durationSeconds} value={Math.min(seconds, durationSeconds)} />}
    {seconds === 0 && <p role="status">{language === 'ru' ? 'Время вышло' : language === 'en' ? 'Time is up' : 'Время вышло / Time is up'}</p>}
  </div>;
}
