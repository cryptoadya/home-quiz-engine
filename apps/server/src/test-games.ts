import type { DatabaseSync } from 'node:sqlite';
import { removeMediaDirectory } from './media.js';

// Age is measured from closure, never creation or gameplay phase.
export const testGameRetentionMs = 7 * 24 * 60 * 60 * 1000;

export function cleanupTestGames(db: DatabaseSync, now = Date.now()): number {
  const cutoff = new Date(now - testGameRetentionMs).toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const expired = db.prepare(`SELECT id FROM game_sessions
      WHERE is_test = 1 AND closed_at IS NOT NULL AND closed_at <= ? ORDER BY id`).all(cutoff);
    for (const { id } of expired) {
      // Delete files first: a filesystem failure retains the durable row for retry.
      // The write lock prevents the selection/deletion boundary from changing.
      removeMediaDirectory(db, String(id), true);
      db.prepare('DELETE FROM game_sessions WHERE id = ? AND is_test = 1 AND closed_at <= ?').run(id, cutoff);
    }
    db.exec('COMMIT');
    return expired.length;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
