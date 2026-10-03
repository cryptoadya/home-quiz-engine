import type { DatabaseSync } from 'node:sqlite';
import { getRoom, type Room } from './rooms.js';
import { currentContent, type GameSnapshot } from './snapshot.js';
import { getTiebreak, prepareTiebreakQuestion, reserveQuestions } from './tiebreak.js';

export type NavigationAction = 'next' | 'show-leaderboard' | 'next-round' | 'final-results' | 'show-winner' | 'start-tiebreak';

export function getLeaderboard(db: DatabaseSync, roomId: string) {
  const rows = db.prepare(`SELECT p.id, p.display_name AS name, COALESCE(SUM(s.awarded_points), 0) AS total
    FROM session_players p LEFT JOIN question_scores s ON s.session_id = p.session_id AND s.player_id = p.id
    WHERE p.session_id = ? AND p.in_roster = 1 AND p.removed_at IS NULL
    GROUP BY p.id ORDER BY total DESC, p.joined_at ASC, p.id ASC`).all(roomId);
  let rank = 0;
  let previous: number | undefined;
  return rows.map((row, index) => {
    const totalPoints = Number(row.total);
    if (totalPoints !== previous) rank = index + 1;
    previous = totalPoints;
    return { playerId: String(row.id), displayName: String(row.name), totalPoints, rank };
  });
}

export function navigationAction(state: Room['state'], snapshot: GameSnapshot, roundIndex: number, questionIndex: number | null): NavigationAction | null {
  const round = snapshot.rounds[roundIndex];
  if (!round) throw new Error('Current round not found.');
  if (state === 'ANSWER_REVEAL') return 'next';
  if (state === 'FINAL_RESULTS') return 'show-winner';
  if (state !== 'ROUND_END' && state !== 'LEADERBOARD') return null;
  if (questionIndex !== round.questions.length - 1) throw new Error('Round is not complete.');
  if (state === 'ROUND_END' && round.showLeaderboardAfter) return 'show-leaderboard';
  if (state === 'LEADERBOARD' && !round.showLeaderboardAfter) throw new Error('Leaderboard is disabled.');
  return snapshot.rounds.some((r, i) => i > roundIndex && !r.isTiebreak) ? 'next-round' : 'final-results';
}

export function navigate(db: DatabaseSync, roomId: string, action: NavigationAction): { room: Room } | { status: 404 | 409; error: string } {
  db.exec('BEGIN IMMEDIATE');
  let committed = false;
  try {
    const room = getRoom(db, roomId);
    if (!room) return { status: 404, error: 'Room not found.' };
    if (room.closedAt) return { status: 409, error: 'Room is closed.' };
    let content;
    const tie = getTiebreak(db, roomId);
    try {
      content = currentContent(db, roomId);
      if (action === 'start-tiebreak') {
        if (room.state !== 'FINAL_RESULTS' || tie || getLeaderboard(db, roomId).filter(p => p.rank === 1).length < 2 || !reserveQuestions(content.snapshot).length) throw new Error('Tiebreak is unavailable.');
      } else if (navigationAction(room.state, content.snapshot, content.roundIndex, content.questionIndex) !== action) throw new Error('Invalid action.');
      if (room.state === 'ANSWER_REVEAL' && (content.questionIndex === null || !content.round.questions[content.questionIndex])) throw new Error('Missing question.');
      const lastRegular = content.snapshot.rounds.reduce((last, r, i) => r.isTiebreak ? last : i, -1);
      if (room.state === 'FINAL_RESULTS' && !tie && (content.roundIndex !== lastRegular || content.questionIndex !== content.round.questions.length - 1)) throw new Error('Game is not complete.');
    } catch { return { status: 409, error: 'Invalid game state, frozen navigation or action.' }; }
    let { roundIndex, questionIndex } = content;
    let state: Room['state'];
    switch (action) {
      case 'start-tiebreak': {
        const ids = getLeaderboard(db, roomId).filter(p => p.rank === 1).map(p => p.playerId);
        const json = JSON.stringify(ids);
        db.prepare('INSERT INTO session_tiebreaks (session_id, initial_ids_json, contender_ids_json, question_ids_json) VALUES (?, ?, ?, ?)').run(roomId, json, json, json);
        const first = reserveQuestions(content.snapshot)[0];
        roundIndex = first.roundIndex; questionIndex = first.questionIndex; state = 'QUESTION';
        prepareTiebreakQuestion(db, roomId, first.questionId, ids);
        break;
      }
      case 'next':
        if (tie && !tie.completed) {
          const next = reserveQuestions(content.snapshot).find(q => q.roundIndex > roundIndex || (q.roundIndex === roundIndex && q.questionIndex > questionIndex!));
          if (tie.contenderIds.length <= 1 || !next) {
            state = 'FINAL_RESULTS';
            db.prepare('UPDATE session_tiebreaks SET completed = 1 WHERE session_id = ?').run(roomId);
          } else {
            state = 'QUESTION'; roundIndex = next.roundIndex; questionIndex = next.questionIndex;
            prepareTiebreakQuestion(db, roomId, next.questionId, tie.contenderIds);
          }
        } else if (questionIndex! + 1 < content.round.questions.length) { state = 'QUESTION'; questionIndex = questionIndex! + 1; }
        else state = 'ROUND_END';
        break;
      case 'show-leaderboard': state = 'LEADERBOARD'; break;
      case 'next-round': state = 'ROUND_INTRO'; roundIndex = content.snapshot.rounds.findIndex((r, i) => i > roundIndex && !r.isTiebreak); questionIndex = null; break;
      case 'final-results': state = 'FINAL_RESULTS'; break;
      case 'show-winner': state = 'WINNER_SCREEN'; break;
    }
    db.prepare(`UPDATE game_sessions SET state = ?, current_round_index = ?, current_question_index = ?,
      answer_started_at = NULL, answer_deadline_at = NULL WHERE id = ?`).run(state, roundIndex, questionIndex, roomId);
    if (state === 'FINAL_RESULTS') {
      const players = getLeaderboard(db, roomId).map(({ playerId, displayName, totalPoints }) => ({ playerId, displayName, totalPoints }));
      db.prepare(`UPDATE game_history SET completed_at = ?, players_json = ?
        WHERE session_id = ? AND completed_at IS NULL`).run(new Date().toISOString(), JSON.stringify(players), roomId);
    }
    db.exec('COMMIT');
    committed = true;
    return { room: getRoom(db, roomId)! };
  } finally { if (!committed) db.exec('ROLLBACK'); }
}
