import type { DatabaseSync } from 'node:sqlite';
import type { GameSnapshot } from './snapshot.js';

export type Tiebreak = { initialIds: string[]; contenderIds: string[]; questionPlayerIds: string[]; completed: boolean };

export function getTiebreak(db: DatabaseSync, roomId: string): Tiebreak | null {
  const row = db.prepare('SELECT * FROM session_tiebreaks WHERE session_id = ?').get(roomId);
  return row ? { initialIds: JSON.parse(String(row.initial_ids_json)), contenderIds: JSON.parse(String(row.contender_ids_json)),
    questionPlayerIds: JSON.parse(String(row.question_ids_json)), completed: row.completed === 1 } : null;
}

export function reserveQuestions(snapshot: GameSnapshot) {
  return snapshot.rounds.flatMap((round, roundIndex) => round.isTiebreak
    ? round.questions.map((question, questionIndex) => ({ roundIndex, questionIndex, questionId: question.id })) : []);
}

// Called inside the navigation transaction; exclusions reuse the authoritative
// submission, deadline, disconnect and completion rules without changing membership.
export function prepareTiebreakQuestion(db: DatabaseSync, roomId: string, questionId: string, playerIds: string[]) {
  db.prepare('UPDATE session_tiebreaks SET question_ids_json = ? WHERE session_id = ?').run(JSON.stringify(playerIds), roomId);
  const players = db.prepare('SELECT id FROM session_players WHERE session_id = ? AND in_roster = 1 AND removed_at IS NULL').all(roomId);
  const exclude = db.prepare('INSERT INTO question_exclusions (session_id, question_id, player_id) VALUES (?, ?, ?)');
  for (const player of players) if (!playerIds.includes(String(player.id))) exclude.run(roomId, questionId, player.id);
}

export function resolveTiebreakQuestion(db: DatabaseSync, roomId: string, questionId: string) {
  const tie = getTiebreak(db, roomId);
  if (!tie || tie.completed) return;
  const correct = db.prepare("SELECT player_id FROM question_scores WHERE session_id = ? AND question_id = ? AND result = 'correct'").all(roomId, questionId).map(row => String(row.player_id));
  // Everyone wrong or unanswered is another tie, never an empty final roster.
  const survivors = correct.length ? tie.questionPlayerIds.filter(id => correct.includes(id)) : tie.questionPlayerIds;
  db.prepare('UPDATE session_tiebreaks SET contender_ids_json = ? WHERE session_id = ?').run(JSON.stringify(survivors), roomId);
}
