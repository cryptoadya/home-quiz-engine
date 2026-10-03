import type { DatabaseSync } from 'node:sqlite';
import { getRoom, type Room } from './rooms.js';
import { completeQuestionInTransaction } from './reveal.js';
import { absentPlayerPresence, resolveDisconnectPauseInTransaction, type PlayerPresenceChecker } from './pause.js';

export function kickPlayer(db: DatabaseSync, roomId: string, playerId: string, confirmed: unknown, clock: () => number = Date.now, presence: PlayerPresenceChecker = absentPlayerPresence): { room: Room } | { status: number; error: string } {
  if (confirmed !== true) return { status: 400, error: 'Confirm permanent player removal.' };
  db.exec('BEGIN IMMEDIATE');
  let committed = false;
  try {
    const room = getRoom(db, roomId);
    if (!room) return { status: 404, error: 'Room not found.' };
    const session = db.prepare('SELECT paused_from_state, paused_player_id FROM game_sessions WHERE id = ?').get(roomId)!;
    if (room.closedAt || room.tiebreak || ['FINAL_RESULTS', 'WINNER_SCREEN'].includes(room.state) || session.paused_from_state === 'FINAL_RESULTS') {
      return { status: 409, error: 'Players cannot be removed after game completion or closure.' };
    }
    const removed = db.prepare(`UPDATE session_players SET removed_at = ? WHERE session_id = ? AND id = ? AND removed_at IS NULL
      AND ((SELECT roster_locked_at FROM game_sessions WHERE id = session_id) IS NULL OR in_roster = 1)`)
      .run(new Date(clock()).toISOString(), roomId, playerId);
    if (!removed.changes) return { status: 404, error: 'Active player not found.' };
    // Keep frozen membership and accepted answer records; removed_at is the single
    // permanent removal boundary, distinct from temporary question exclusions.
    if (room.state === 'PAUSED' && session.paused_player_id === playerId) {
      const result = resolveDisconnectPauseInTransaction(db, roomId, true, presence, clock, true);
      if ('status' in result) return result;
    } else completeQuestionInTransaction(db, roomId, clock());
    db.exec('COMMIT'); committed = true;
    return { room: getRoom(db, roomId)! };
  } finally { if (!committed) db.exec('ROLLBACK'); }
}
