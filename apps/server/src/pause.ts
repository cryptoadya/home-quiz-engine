import type { DatabaseSync } from 'node:sqlite';
import { getRoom, type Room } from './rooms.js';
import { completeQuestionInTransaction } from './reveal.js';

const pausableStates = ['ROUND_INTRO', 'QUESTION', 'ANSWERING', 'ANSWER_REVEAL', 'ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS'];
type Result = { room: Room } | { status: 404 | 409; error: string; changed?: boolean };

export function pauseGame(db: DatabaseSync, roomId: string, clock: () => number = Date.now): Result {
  db.exec('BEGIN IMMEDIATE');
  let committed = false;
  try {
    const room = getRoom(db, roomId);
    if (!room) return { status: 404, error: 'Room not found.' };
    if (room.closedAt || !pausableStates.includes(room.state)) return { status: 409, error: 'Room cannot be paused in this state.' };
    const row = db.prepare('SELECT answer_deadline_at FROM game_sessions WHERE id = ?').get(roomId)!;
    const now = clock();
    let remaining: number | null = null;
    if (room.state === 'ANSWERING') {
      // Same completion/scoring transaction as Submit and the deadline wakeup.
      if (completeQuestionInTransaction(db, roomId, now)) {
        db.exec('COMMIT'); committed = true;
        return { status: 409, error: 'Question has completed.', changed: true };
      }
      remaining = Math.max(0, Date.parse(String(row.answer_deadline_at)) - now);
      if (!(remaining > 0)) return { status: 409, error: 'Invalid answer deadline.' };
    }
    db.prepare(`UPDATE game_sessions SET state = 'PAUSED', paused_from_state = ?, paused_at = ?, paused_remaining_ms = ?,
      answer_started_at = CASE WHEN state = 'ANSWERING' THEN NULL ELSE answer_started_at END,
      answer_deadline_at = CASE WHEN state = 'ANSWERING' THEN NULL ELSE answer_deadline_at END WHERE id = ?`)
      .run(room.state, new Date(now).toISOString(), remaining, roomId);
    db.exec('COMMIT'); committed = true;
    return { room: getRoom(db, roomId)! };
  } finally { if (!committed) db.exec('ROLLBACK'); }
}

export function resumeGame(db: DatabaseSync, roomId: string, clock: () => number = Date.now): Result {
  db.exec('BEGIN IMMEDIATE');
  let committed = false;
  try {
    const room = getRoom(db, roomId);
    if (!room) return { status: 404, error: 'Room not found.' };
    if (room.closedAt || room.state !== 'PAUSED') return { status: 409, error: 'Room is not actively paused.' };
    const row = db.prepare('SELECT paused_from_state, paused_remaining_ms, answer_started_at, answer_deadline_at FROM game_sessions WHERE id = ?').get(roomId)!;
    const state = String(row.paused_from_state);
    if (!pausableStates.includes(state)) return { status: 409, error: 'Invalid paused state.' };
    let startedAt = row.answer_started_at;
    let deadlineAt = row.answer_deadline_at;
    if (state === 'ANSWERING') {
      const remaining = Number(row.paused_remaining_ms);
      if (!Number.isSafeInteger(remaining) || remaining <= 0) return { status: 409, error: 'Invalid frozen answer time.' };
      const now = clock();
      startedAt = new Date(now).toISOString();
      deadlineAt = new Date(now + remaining).toISOString();
    }
    db.prepare(`UPDATE game_sessions SET state = ?, answer_started_at = ?, answer_deadline_at = ?,
      paused_from_state = NULL, paused_at = NULL, paused_remaining_ms = NULL WHERE id = ?`)
      .run(state, startedAt, deadlineAt, roomId);
    db.exec('COMMIT'); committed = true;
    return { room: getRoom(db, roomId)! };
  } finally { if (!committed) db.exec('ROLLBACK'); }
}
