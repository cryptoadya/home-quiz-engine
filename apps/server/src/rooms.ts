import { randomInt, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { validateQuizReadiness, type QuizValidation } from './validation.js';

export type Room = {
  id: string;
  code: string;
  quizId: string;
  quizTitle: string;
  state: 'LOBBY';
  createdAt: string;
  closedAt: string | null;
};

const roomQuery = `SELECT s.id, s.code, s.quiz_id AS quizId, q.title AS quizTitle,
  s.state, s.created_at AS createdAt, s.closed_at AS closedAt
  FROM game_sessions s JOIN quizzes q ON q.id = s.quiz_id`;

export function getRoom(db: DatabaseSync, id: string): Room | null {
  return db.prepare(`${roomQuery} WHERE s.id = ?`).get(id) as Room | undefined ?? null;
}

export function getRoomByCode(db: DatabaseSync, code: string): Room | null {
  return db.prepare(`${roomQuery} WHERE s.code = ? AND s.closed_at IS NULL`).get(code.trim().toUpperCase()) as Room | undefined ?? null;
}

function generateRoomCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 5 }, () => alphabet[randomInt(alphabet.length)]).join('');
}

type CreateResult = { room: Room } | { status: 404 | 409 | 503; error: string; validation?: QuizValidation };

export function createRoom(db: DatabaseSync, quizId: string, nextCode = generateRoomCode): CreateResult {
  // One local synchronous transaction keeps validation and allocation together.
  db.exec('BEGIN IMMEDIATE');
  let committed = false;
  try {
    const validation = validateQuizReadiness(db, quizId);
    if (!validation) return { status: 404, error: 'Quiz not found.' };
    if (!validation.ready) return { status: 409, error: 'Quiz is not ready. Review the validation problems.', validation };
    const insert = db.prepare(`INSERT INTO game_sessions (id, code, quiz_id, state, created_at)
      VALUES (?, ?, ?, 'LOBBY', ?) ON CONFLICT(code) WHERE closed_at IS NULL DO NOTHING`);
    for (let attempt = 0; attempt < 100; attempt++) {
      const id = randomUUID();
      if (!insert.run(id, nextCode(), quizId, new Date().toISOString()).changes) continue;
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
