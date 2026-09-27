import type { DatabaseSync } from 'node:sqlite';
import { matchingContent } from './matching-game.js';
import { getAnswerCounts, type StoredAnswer } from './answers.js';
import { currentContent } from './snapshot.js';

// Caller owns BEGIN IMMEDIATE. Answers, scores and transition commit together.
export function completeQuestionInTransaction(db: DatabaseSync, roomId: string, now: number, expectedQuestionId?: string, resolveDisconnectPause = false): boolean {
  const session = db.prepare('SELECT state, closed_at, answer_deadline_at, pause_reason, paused_from_state FROM game_sessions WHERE id = ?').get(roomId);
  if (!session || session.closed_at) return false;
  const paused = resolveDisconnectPause && session.state === 'PAUSED' && session.pause_reason === 'player_disconnect' && session.paused_from_state === 'ANSWERING';
  if (session.state !== 'ANSWERING' && !paused) return false;
  const { round, questionIndex } = currentContent(db, roomId);
  const question = questionIndex === null ? undefined : round.questions[questionIndex];
  if (!question) throw new Error('Current question not found.');
  if (expectedQuestionId && question.id !== expectedQuestionId) return false;
  const players = db.prepare(`SELECT p.id, a.answer_json, e.player_id AS excluded FROM session_players p
    LEFT JOIN player_answers a ON a.session_id = p.session_id AND a.player_id = p.id AND a.question_id = ?
    LEFT JOIN question_exclusions e ON e.session_id = p.session_id AND e.player_id = p.id AND e.question_id = ?
    WHERE p.session_id = ? AND p.in_roster = 1`).all(question.id, question.id, roomId);
  const { answered, expected } = getAnswerCounts(db, roomId, question.id);
  if (answered !== expected && (paused || now < Date.parse(String(session.answer_deadline_at)))) return false;
  const correct = question.options.filter(option => option.isCorrect).map(option => option.id);
  const insert = db.prepare('INSERT INTO question_scores (session_id, question_id, player_id, result, awarded_points) VALUES (?, ?, ?, ?, ?)');
  for (const player of players) {
    const answer = player.answer_json === null ? null : JSON.parse(String(player.answer_json)) as StoredAnswer;
    const exact = answer?.kind === 'matching' && question.type === 'matching'
      ? answer.mapping.length === question.pairs!.length && matchingContent(roomId, question).correctMapping.every(pair => answer.mapping.some(entry => entry.leftId === pair.leftId && entry.rightId === pair.rightId))
      : answer?.kind === 'options' && question.type !== 'matching' && answer.optionIds.length === correct.length && correct.every(id => answer.optionIds.includes(id));
    const result = player.excluded !== null || answer === null ? 'unanswered' : exact ? 'correct' : 'wrong';
    insert.run(roomId, question.id, player.id, result, result === 'correct' ? question.points : 0);
  }
  // Retain navigation and original timer timestamps as completed-question context.
  db.prepare(`UPDATE game_sessions SET state = 'ANSWER_REVEAL',
    paused_from_state = NULL, paused_at = NULL, paused_remaining_ms = NULL, pause_reason = NULL, paused_player_id = NULL WHERE id = ?`).run(roomId);
  return true;
}

export function completeQuestion(db: DatabaseSync, roomId: string, clock: () => number = Date.now, expectedQuestionId?: string): boolean {
  db.exec('BEGIN IMMEDIATE');
  try {
    const changed = completeQuestionInTransaction(db, roomId, clock(), expectedQuestionId);
    db.exec('COMMIT');
    return changed;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function getRevealStats(db: DatabaseSync, roomId: string, questionId: string) {
  const rows = db.prepare('SELECT result, count(*) AS n FROM question_scores WHERE session_id = ? AND question_id = ? GROUP BY result').all(roomId, questionId);
  const stats = { correct: 0, wrong: 0, unanswered: 0 };
  for (const row of rows) stats[row.result as keyof typeof stats] = Number(row.n);
  return stats;
}

export function getPlayerResult(db: DatabaseSync, roomId: string, questionId: string, playerId: string) {
  const row = db.prepare('SELECT result, awarded_points FROM question_scores WHERE session_id = ? AND question_id = ? AND player_id = ?').get(roomId, questionId, playerId);
  if (!row) throw new Error('Missing durable Reveal result.');
  return { outcome: row.result as 'correct' | 'wrong' | 'unanswered', points: Number(row.awarded_points) };
}
