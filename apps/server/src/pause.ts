import type { DatabaseSync } from 'node:sqlite';
import { getRoom, type Room } from './rooms.js';
import { currentContent } from './snapshot.js';
import { getSubmission, isQuestionExcluded } from './answers.js';
import { completeQuestionInTransaction } from './reveal.js';

const pausableStates = ['ROUND_INTRO', 'QUESTION', 'ANSWERING', 'ANSWER_REVEAL', 'ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS'];
type Result = { room: Room } | { status: 404 | 409; error: string; changed?: boolean };

export function pauseGame(db: DatabaseSync, roomId: string, clock: () => number = Date.now): Result {
  return pause(db, roomId, clock);
}

export function autoPauseForDisconnectedPlayer(db: DatabaseSync, roomId: string, playerId: string, clock: () => number = Date.now): boolean {
  const result = pause(db, roomId, clock, playerId);
  return 'room' in result || result.changed === true;
}

function pause(db: DatabaseSync, roomId: string, clock: () => number, playerId?: string): Result {
  db.exec('BEGIN IMMEDIATE');
  let committed = false;
  try {
    const room = getRoom(db, roomId);
    if (!room) return { status: 404, error: 'Room not found.' };
    if (room.closedAt || !pausableStates.includes(room.state)) return { status: 409, error: 'Room cannot be paused in this state.' };
    if (playerId !== undefined) {
      if (room.state !== 'ANSWERING' || !db.prepare('SELECT 1 FROM session_players WHERE session_id = ? AND id = ? AND in_roster = 1').get(roomId, playerId)) {
        return { status: 409, error: 'Disconnected player is not answering in the fixed roster.' };
      }
    }
    const row = db.prepare('SELECT answer_deadline_at FROM game_sessions WHERE id = ?').get(roomId)!;
    const now = clock();
    let remaining: number | null = null;
    if (room.state === 'ANSWERING') {
      // Same completion/scoring transaction as Submit and the deadline wakeup.
      if (completeQuestionInTransaction(db, roomId, now)) {
        db.exec('COMMIT'); committed = true;
        return { status: 409, error: 'Question has completed.', changed: true };
      }
      if (playerId !== undefined) {
        const { round, questionIndex } = currentContent(db, roomId);
        if (isQuestionExcluded(db, roomId, round.questions[questionIndex!].id, playerId)) return { status: 409, error: 'Disconnected player is excluded from this question.' };
        if (getSubmission(db, roomId, round.questions[questionIndex!].id, playerId).submitted) {
          return { status: 409, error: 'Disconnected player already submitted.' };
        }
      }
      remaining = Math.max(0, Date.parse(String(row.answer_deadline_at)) - now);
      if (!(remaining > 0)) return { status: 409, error: 'Invalid answer deadline.' };
    }
    db.prepare(`UPDATE game_sessions SET state = 'PAUSED', paused_from_state = ?, paused_at = ?, paused_remaining_ms = ?,
      pause_reason = ?, paused_player_id = ?,
      answer_started_at = CASE WHEN state = 'ANSWERING' THEN NULL ELSE answer_started_at END,
      answer_deadline_at = CASE WHEN state = 'ANSWERING' THEN NULL ELSE answer_deadline_at END WHERE id = ?`)
      .run(room.state, new Date(now).toISOString(), remaining, playerId === undefined ? 'manual' : 'player_disconnect', playerId ?? null, roomId);
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
    const row = db.prepare('SELECT paused_from_state, paused_remaining_ms, answer_started_at, answer_deadline_at, pause_reason FROM game_sessions WHERE id = ?').get(roomId)!;
    if (row.pause_reason !== 'manual') return { status: 409, error: 'Use Wait for Player or Continue Without Player to resolve this pause.' };
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
      paused_from_state = NULL, paused_at = NULL, paused_remaining_ms = NULL, pause_reason = NULL, paused_player_id = NULL WHERE id = ?`)
      .run(state, startedAt, deadlineAt, roomId);
    db.exec('COMMIT'); committed = true;
    return { room: getRoom(db, roomId)! };
  } finally { if (!committed) db.exec('ROLLBACK'); }
}

export type PlayerPresenceChecker = (roomId: string, playerId: string) => boolean;
export const absentPlayerPresence: PlayerPresenceChecker = () => false;

export function waitForPlayer(db: DatabaseSync, roomId: string, presence: PlayerPresenceChecker = absentPlayerPresence, clock: () => number = Date.now): Result {
  return resolveDisconnectPause(db, roomId, false, presence, clock);
}

export function continueWithoutPlayer(db: DatabaseSync, roomId: string, clock: () => number = Date.now): Result {
  return resolveDisconnectPause(db, roomId, true, absentPlayerPresence, clock);
}

function resolveDisconnectPause(db: DatabaseSync, roomId: string, exclude: boolean, presence: PlayerPresenceChecker, clock: () => number): Result {
  db.exec('BEGIN IMMEDIATE');
  let committed = false;
  try {
    const room = getRoom(db, roomId);
    if (!room) return { status: 404, error: 'Room not found.' };
    const row = db.prepare('SELECT pause_reason, paused_from_state, paused_player_id, paused_remaining_ms FROM game_sessions WHERE id = ?').get(roomId)!;
    if (room.closedAt || room.state !== 'PAUSED' || row.pause_reason !== 'player_disconnect' || row.paused_from_state !== 'ANSWERING') {
      return { status: 409, error: 'Room is not paused for a disconnected player.' };
    }
    const playerId = String(row.paused_player_id);
    if (!db.prepare('SELECT 1 FROM session_players WHERE session_id = ? AND id = ? AND in_roster = 1').get(roomId, playerId)) {
      return { status: 409, error: 'Paused player is not in the fixed roster.' };
    }
    let questionId: string;
    try {
      const { round, questionIndex } = currentContent(db, roomId);
      const question = questionIndex === null ? undefined : round.questions[questionIndex];
      if (!question) throw new Error('Missing question.');
      questionId = question.id;
    } catch { return { status: 409, error: 'Invalid current frozen question.' }; }
    const remaining = Number(row.paused_remaining_ms);
    if (!Number.isSafeInteger(remaining) || remaining <= 0) return { status: 409, error: 'Invalid frozen answer time.' };
    if (getSubmission(db, roomId, questionId, playerId).submitted || isQuestionExcluded(db, roomId, questionId, playerId)) {
      return { status: 409, error: 'Paused player has already submitted or is excluded.' };
    }
    if (!exclude && !presence(roomId, playerId)) return { status: 409, error: 'Player has not reconnected yet.' };
    if (exclude) db.prepare('INSERT INTO question_exclusions (session_id, question_id, player_id) VALUES (?, ?, ?)').run(roomId, questionId, playerId);
    const now = clock();
    // Score directly from PAUSED when exclusion completes the question. No timer
    // is created and no intermediate state can escape this transaction.
    if (!exclude || !completeQuestionInTransaction(db, roomId, now, questionId, true)) {
      db.prepare(`UPDATE game_sessions SET state = 'ANSWERING', answer_started_at = ?, answer_deadline_at = ?,
        paused_from_state = NULL, paused_at = NULL, paused_remaining_ms = NULL, pause_reason = NULL, paused_player_id = NULL WHERE id = ?`)
        .run(new Date(now).toISOString(), new Date(now + remaining).toISOString(), roomId);
    }
    db.exec('COMMIT'); committed = true;
    return { room: getRoom(db, roomId)! };
  } finally { if (!committed) db.exec('ROLLBACK'); }
}
