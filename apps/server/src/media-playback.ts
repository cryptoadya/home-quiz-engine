import type { DatabaseSync } from 'node:sqlite';
import { getRoom } from './rooms.js';
import { currentContent } from './snapshot.js';

type PlaybackRow = { playing: number; position_seconds: number; updated_at: number; revision: number };
const position = (row: PlaybackRow, now: number) => row.position_seconds + (row.playing ? Math.max(0, now - row.updated_at) / 1000 : 0);

export function projectMediaPlayback(db: DatabaseSync, roomId: string, questionId: string, mediaId: string, now: number) {
  const row = db.prepare('SELECT * FROM media_playback WHERE session_id = ? AND question_id = ? AND media_id = ?').get(roomId, questionId, mediaId) as PlaybackRow | undefined;
  return { playing: !!row?.playing, positionSeconds: row ? position(row, now) : 0, serverNow: now, revision: row?.revision ?? 0 };
}

// Playback commands never write lifecycle, answer or timer columns.
export function controlMedia(db: DatabaseSync, roomId: string, questionId: unknown, mediaId: string, action: string, now = Date.now()) {
  db.exec('BEGIN IMMEDIATE');
  let committed = false;
  try {
    const room = getRoom(db, roomId);
    if (!room) return { status: 404, error: 'Room not found.' };
    if (room.closedAt || !['QUESTION', 'ANSWERING', 'ANSWER_REVEAL'].includes(room.state)
      || !['play', 'pause', 'restart'].includes(action)) return { status: 409, error: 'Media control unavailable.' };
    const { snapshot, round, questionIndex } = currentContent(db, roomId);
    const question = questionIndex === null ? undefined : round.questions[questionIndex];
    const media = snapshot.media?.find(item => item.id === mediaId);
    if (!question || question.id !== questionId || !question.media?.some(ref => ref.mediaId === mediaId)
      || !media || media.kind === 'image') return { status: 409, error: 'Current playable media not found.' };
    const previous = db.prepare('SELECT * FROM media_playback WHERE session_id = ? AND question_id = ? AND media_id = ?').get(roomId, question.id, mediaId) as PlaybackRow | undefined;
    if (action !== 'pause') {
      const playing = db.prepare('SELECT * FROM media_playback WHERE session_id = ? AND playing = 1').all(roomId) as (PlaybackRow & { question_id: string; media_id: string })[];
      for (const row of playing) db.prepare('UPDATE media_playback SET playing = 0, position_seconds = ?, updated_at = ?, revision = revision + 1 WHERE session_id = ? AND question_id = ? AND media_id = ?')
        .run(position(row, now), now, roomId, row.question_id, row.media_id);
    }
    db.prepare(`INSERT INTO media_playback (session_id, question_id, media_id, playing, position_seconds, updated_at, revision)
      VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT(session_id, question_id, media_id) DO UPDATE SET
      playing = excluded.playing, position_seconds = excluded.position_seconds, updated_at = excluded.updated_at, revision = media_playback.revision + 1`)
      .run(roomId, question.id, mediaId, action === 'pause' ? 0 : 1, action === 'restart' ? 0 : previous ? position(previous, now) : 0, now);
    db.exec('COMMIT'); committed = true;
    return { room };
  } finally { if (!committed) db.exec('ROLLBACK'); }
}
