import { completeQuestionInTransaction } from './reveal.js';
import type { DatabaseSync } from 'node:sqlite';
import { currentContent } from './snapshot.js';
import { getRoom } from './rooms.js';
import { reconnectPlayer } from './players.js';

type Submission = { submitted: false } | { submitted: true; optionId: string };

export function getSubmission(db: DatabaseSync, roomId: string, questionId: string, playerId: string): Submission {
  const row = db.prepare('SELECT option_id FROM player_answers WHERE session_id = ? AND question_id = ? AND player_id = ?')
    .get(roomId, questionId, playerId);
  return row ? { submitted: true, optionId: String(row.option_id) } : { submitted: false };
}

export function isQuestionExcluded(db: DatabaseSync, roomId: string, questionId: string, playerId: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM question_exclusions WHERE session_id = ? AND question_id = ? AND player_id = ?').get(roomId, questionId, playerId));
}

export function getAnswerCounts(db: DatabaseSync, roomId: string, questionId: string) {
  const counts = db.prepare(`SELECT count(*) AS expected, count(a.player_id) AS answered FROM session_players p
    LEFT JOIN player_answers a ON a.session_id = p.session_id AND a.question_id = ? AND a.player_id = p.id
    WHERE p.session_id = ? AND p.in_roster = 1
    AND NOT EXISTS (SELECT 1 FROM question_exclusions e WHERE e.session_id = p.session_id AND e.question_id = ? AND e.player_id = p.id)`)
    .get(questionId, roomId, questionId)!;
  return { answered: Number(counts.answered), expected: Number(counts.expected) };
}

export function submitAnswer(db: DatabaseSync, roomId: string, body: unknown, clock: () => number = Date.now):
  { status: number; error: string; code?: string } | { submission: Submission; inserted: boolean } {
  const input = body as { token?: unknown; questionId?: unknown; optionId?: unknown } | null;
  if (!input || Array.isArray(input) || typeof input !== 'object'
    || typeof input.token !== 'string' || typeof input.questionId !== 'string' || !input.questionId
    || typeof input.optionId !== 'string' || !input.optionId) {
    return { status: 400, error: 'Expected token, questionId and optionId strings.' };
  }
  db.exec('BEGIN IMMEDIATE');
  let committed = false;
  try {
    const room = getRoom(db, roomId);
    if (!room) return { status: 404, error: 'Room not found.' };
    const identity = reconnectPlayer(db, roomId, input.token);
    if ('status' in identity) return identity;
    if (room.closedAt || (room.state !== 'ANSWERING' && room.state !== 'ANSWER_REVEAL')) return { status: 409, error: 'Room is not in active Answering.' };
    const roster = db.prepare('SELECT in_roster FROM session_players WHERE id = ? AND session_id = ?').get(identity.player.id, roomId);
    if (roster?.in_roster !== 1) return { status: 401, error: 'Player is not in the locked roster.' };
    const { round, questionIndex } = currentContent(db, roomId);
    const question = questionIndex === null ? undefined : round.questions[questionIndex];
    if (!question || question.id !== input.questionId) return { status: 409, error: 'Question is not current.' };
    if (isQuestionExcluded(db, roomId, question.id, identity.player.id)) return { status: 409, error: 'This question continued without you.' };
    if (!question.options.some(option => option.id === input.optionId)) return { status: 400, error: 'Option does not belong to current question.' };
    const accepted = getSubmission(db, roomId, question.id, identity.player.id);
    // Identity, current question and option are validated even for retries.
    // An accepted answer wins over the deadline and any different valid choice.
    if (accepted.submitted) return { submission: accepted, inserted: false };
    if (room.state === 'ANSWER_REVEAL') return { status: 409, error: 'Question is already revealed.' };
    const row = db.prepare('SELECT answer_deadline_at FROM game_sessions WHERE id = ?').get(roomId)!;
    const now = clock(); // Sample only after acquiring the write lock and validating.
    if (!(now < Date.parse(String(row.answer_deadline_at)))) {
      return { status: 409, code: 'DEADLINE_REACHED', error: 'Time is up.' };
    }
    db.prepare('INSERT INTO player_answers (session_id, player_id, question_id, option_id, submitted_at) VALUES (?, ?, ?, ?, ?)')
      .run(roomId, identity.player.id, question.id, input.optionId, new Date(now).toISOString());
    completeQuestionInTransaction(db, roomId, now);
    db.exec('COMMIT');
    committed = true;
    return { submission: { submitted: true as const, optionId: input.optionId }, inserted: true };
  } finally { if (!committed) db.exec('ROLLBACK'); }
}
