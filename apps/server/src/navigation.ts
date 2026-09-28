import type { DatabaseSync } from 'node:sqlite';
import { getRoom, type Room } from './rooms.js';
import { currentContent, type GameSnapshot } from './snapshot.js';

export type NavigationAction = 'next' | 'show-leaderboard' | 'next-round' | 'final-results' | 'show-winner';

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
  return roundIndex + 1 < snapshot.rounds.length ? 'next-round' : 'final-results';
}

export function navigate(db: DatabaseSync, roomId: string, action: NavigationAction): { room: Room } | { status: 404 | 409; error: string } {
  db.exec('BEGIN IMMEDIATE');
  let committed = false;
  try {
    const room = getRoom(db, roomId);
    if (!room) return { status: 404, error: 'Room not found.' };
    if (room.closedAt) return { status: 409, error: 'Room is closed.' };
    let content;
    try {
      content = currentContent(db, roomId);
      if (navigationAction(room.state, content.snapshot, content.roundIndex, content.questionIndex) !== action) throw new Error('Invalid action.');
      if (room.state === 'ANSWER_REVEAL' && (content.questionIndex === null || !content.round.questions[content.questionIndex])) throw new Error('Missing question.');
      if (room.state === 'FINAL_RESULTS' && (content.roundIndex !== content.snapshot.rounds.length - 1 || content.questionIndex !== content.round.questions.length - 1)) throw new Error('Game is not complete.');
    } catch { return { status: 409, error: 'Invalid game state, frozen navigation or action.' }; }
    let { roundIndex, questionIndex } = content;
    let state: Room['state'];
    switch (action) {
      case 'next':
        if (questionIndex! + 1 < content.round.questions.length) { state = 'QUESTION'; questionIndex = questionIndex! + 1; }
        else state = 'ROUND_END';
        break;
      case 'show-leaderboard': state = 'LEADERBOARD'; break;
      case 'next-round': state = 'ROUND_INTRO'; roundIndex++; questionIndex = null; break;
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
