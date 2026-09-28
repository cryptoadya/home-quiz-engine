import { freezeMedia, removeMediaDirectory } from './media.js';
import { randomInt, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { validateQuizReadiness, type QuizValidation } from './validation.js';
import { createGameSnapshot } from './snapshot.js';

export type Room = {
  id: string;
  code: string;
  quizId: string | null;
  quizTitle: string;
  themeId: string;
  isTest: boolean;
  state: 'LOBBY' | 'ROUND_INTRO' | 'QUESTION' | 'ANSWERING' | 'ANSWER_REVEAL' | 'ROUND_END' | 'LEADERBOARD' | 'FINAL_RESULTS' | 'WINNER_SCREEN' | 'PAUSED';
  createdAt: string;
  closedAt: string | null;
};

const roomQuery = `SELECT s.id, s.code, s.quiz_id AS quizId,
  CASE WHEN s.state = 'LOBBY' THEN q.title ELSE json_extract(s.snapshot_json, '$.title') END AS quizTitle,
  COALESCE(CASE WHEN s.state = 'LOBBY' THEN q.theme_id ELSE json_extract(s.snapshot_json, '$.themeId') END, 'default') AS themeId,
  s.is_test AS isTest, s.state, s.created_at AS createdAt, s.closed_at AS closedAt
  FROM game_sessions s LEFT JOIN quizzes q ON s.state = 'LOBBY' AND q.id = s.quiz_id`;

function publicRoom(row: Record<string, unknown> | undefined): Room | null {
  return row ? { ...row, isTest: row.isTest === 1 } as Room : null;
}

export function getRoom(db: DatabaseSync, id: string): Room | null {
  return publicRoom(db.prepare(`${roomQuery} WHERE s.id = ?`).get(id));
}

export function getRoomByCode(db: DatabaseSync, code: string): Room | null {
  return publicRoom(db.prepare(`${roomQuery} WHERE s.code = ? AND s.closed_at IS NULL`).get(code.trim().toUpperCase()));
}

function generateRoomCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 5 }, () => alphabet[randomInt(alphabet.length)]).join('');
}

type CreateResult = { room: Room } | { status: 404 | 409 | 503; error: string; validation?: QuizValidation };

export function createRoom(db: DatabaseSync, quizId: string, nextCode = generateRoomCode, isTest = false): CreateResult {
  // One local synchronous transaction keeps validation and allocation together.
  db.exec('BEGIN IMMEDIATE');
  let committed = false;
  try {
    const validation = validateQuizReadiness(db, quizId);
    if (!validation) return { status: 404, error: 'Quiz not found.' };
    if (!validation.ready) return { status: 409, error: 'Quiz is not ready. Review the validation problems.', validation };
    const insert = db.prepare(`INSERT INTO game_sessions (id, code, quiz_id, state, created_at, is_test)
      VALUES (?, ?, ?, 'LOBBY', ?, ?) ON CONFLICT(code) WHERE closed_at IS NULL DO NOTHING`);
    for (let attempt = 0; attempt < 100; attempt++) {
      const id = randomUUID();
      if (!insert.run(id, nextCode(), quizId, new Date().toISOString(), Number(isTest)).changes) continue;
      const room = getRoom(db, id)!;
      db.exec('COMMIT');
      committed = true;
      return { room };
    }
    return { status: 503, error: 'Could not allocate a room code. Please try again.' };
  } finally {
    if (!committed) db.exec('ROLLBACK');
  }
}

export function closeRoom(db: DatabaseSync, id: string): Room | null {
  db.prepare('UPDATE game_sessions SET closed_at = ? WHERE id = ? AND closed_at IS NULL').run(new Date().toISOString(), id);
  return getRoom(db, id);
}

export function startRoom(db: DatabaseSync, id: string): { room: Room } | { status: 404 | 409; error: string; validation?: QuizValidation } {
  db.exec('BEGIN IMMEDIATE');
  let committed = false;
  let freezing = false;
  try {
    const room = getRoom(db, id);
    if (!room) return { status: 404, error: 'Room not found.' };
    if (room.closedAt) return { status: 409, error: 'Room is closed.' };
    if (room.state !== 'LOBBY') return { status: 409, error: 'Game has already started.' };
    const validation = room.quizId === null ? null : validateQuizReadiness(db, room.quizId);
    if (!validation || !validation.ready) return {
      status: 409, error: 'Quiz is not ready. Review the validation problems.', validation: validation ?? undefined,
    };
    const count = db.prepare('SELECT count(*) AS n FROM session_players WHERE session_id = ? AND removed_at IS NULL').get(id)!;
    if (Number(count.n) === 0) return { status: 409, error: 'At least one active player is required.' };
    const snapshot = createGameSnapshot(db, room.quizId!);
    const mediaIds = snapshot.rounds.flatMap(round => round.questions.flatMap(question => [
      ...(question.media ?? []).map(ref => ref.mediaId),
      ...(question.pairs ?? []).flatMap(pair => [pair.left, pair.right].flatMap(side => side.kind === 'image' ? [side.mediaId] : [])),
    ]));
    freezing = mediaIds.length > 0;
    snapshot.media = freezeMedia(db, room.quizId!, id, mediaIds);
    db.prepare('UPDATE session_players SET in_roster = 1 WHERE session_id = ? AND removed_at IS NULL').run(id);
    db.prepare(`UPDATE game_sessions SET snapshot_json = ?, roster_locked_at = ?, state = 'ROUND_INTRO', current_round_index = 0, current_question_index = NULL WHERE id = ?`)
      .run(JSON.stringify(snapshot), new Date().toISOString(), id);
    const started = getRoom(db, id)!;
    db.exec('COMMIT');
    committed = true;
    return { room: started };
  } finally {
    if (!committed) { db.exec('ROLLBACK'); if (freezing) removeMediaDirectory(db, id, true); }
  }
}
