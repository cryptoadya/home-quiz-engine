import type { DatabaseSync } from 'node:sqlite';

type HistoryPlayer = { playerId: string; displayName: string; totalPoints: number };

export function listHistory(db: DatabaseSync) {
  return db.prepare(`SELECT h.session_id, h.completed_at, h.quiz_id, h.quiz_title, h.players_json
    FROM game_history h JOIN game_sessions s ON s.id = h.session_id
    WHERE s.is_test = 0 AND h.completed_at IS NOT NULL
    ORDER BY h.completed_at DESC, h.session_id ASC LIMIT 100`).all().map(row => ({
      sessionId: String(row.session_id),
      completedAt: String(row.completed_at),
      quizId: row.quiz_id === null ? null : String(row.quiz_id),
      quizTitle: String(row.quiz_title),
      players: (JSON.parse(String(row.players_json)) as HistoryPlayer[]).map(({ playerId, displayName, totalPoints }) => ({ playerId, displayName, totalPoints })),
    }));
}
