import type { DatabaseSync } from 'node:sqlite';
import { currentContent } from './snapshot.js';
import { completeQuestion } from './reveal.js';

type Options = { clock?: () => number; schedule?: (callback: () => void, delay: number) => () => void };

// Timers are only wakeups. Persisted state and the transaction decide completion.
export function createDeadlineManager(db: DatabaseSync, changed: (roomId: string) => void, options: Options = {}) {
  const clock = options.clock ?? Date.now;
  const schedule = options.schedule ?? ((callback, delay) => {
    const timer = setTimeout(callback, delay);
    timer.unref();
    return () => clearTimeout(timer);
  });
  const pending = new Map<string, () => void>();
  let stopped = false;
  function sync(roomId: string) {
    pending.get(roomId)?.(); pending.delete(roomId);
    if (stopped) return;
    const session = db.prepare('SELECT state, closed_at, answer_deadline_at FROM game_sessions WHERE id = ?').get(roomId);
    if (!session || session.closed_at || session.state !== 'ANSWERING') return;
    const { round, questionIndex } = currentContent(db, roomId);
    const questionId = round.questions[questionIndex!].id;
    if (completeQuestion(db, roomId, clock, questionId)) { changed(roomId); return; }
    const delay = Math.max(0, Date.parse(String(session.answer_deadline_at)) - clock());
    const cancel = schedule(() => {
      if (stopped || pending.get(roomId) !== cancel) return;
      pending.delete(roomId);
      if (completeQuestion(db, roomId, clock, questionId)) changed(roomId);
      else sync(roomId); // Early wake or clock adjustment: re-read and re-arm.
    }, delay);
    pending.set(roomId, cancel);
  }
  return {
    sync,
    recover() {
      for (const row of db.prepare("SELECT id FROM game_sessions WHERE state = 'ANSWERING' AND closed_at IS NULL").all()) sync(String(row.id));
    },
    stop() { stopped = true; for (const cancel of pending.values()) cancel(); pending.clear(); },
  };
}
