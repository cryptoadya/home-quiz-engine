import type { DatabaseSync } from 'node:sqlite';
import { getRoom } from './rooms.js';
import { completeQuestionInTransaction } from './reveal.js';
import { createAnswerTimer, effectiveDuration } from './timer.js';
import { currentContent } from './snapshot.js';

type PlaybackRow = { playing: number; position_seconds: number; updated_at: number; revision: number };
const position = (row: PlaybackRow, now: number) => row.position_seconds + (row.playing ? Math.max(0, now - row.updated_at) / 1000 : 0);

export function projectMediaPlayback(db: DatabaseSync, roomId: string, questionId: string, mediaId: string, now: number) {
  const row = db.prepare('SELECT * FROM media_playback WHERE session_id = ? AND question_id = ? AND media_id = ?').get(roomId, questionId, mediaId) as PlaybackRow | undefined;
  return { playing: !!row?.playing, positionSeconds: row ? position(row, now) : 0, serverNow: now, revision: row?.revision ?? 0 };
}

export function preTimerMediaId(db: DatabaseSync, roomId: string): string | null {
  return db.prepare('SELECT pre_timer_media_id FROM game_sessions WHERE id = ?').get(roomId)?.pre_timer_media_id as string | null;
}

// Caller owns the lifecycle transaction.
export function freezeMediaPlayback(db: DatabaseSync, roomId: string, now: number) {
  // Game Pause suspends the required pre-timer attempt; Restart still replaces it.
  db.prepare(`UPDATE media_playback SET position_seconds = position_seconds + MAX(0, ? - updated_at) / 1000.0,
    updated_at = ?, playing = 0, resume_on_game_resume = 1,
    revision = revision + CASE WHEN media_id = (SELECT pre_timer_media_id FROM game_sessions WHERE id = session_id) THEN 0 ELSE 1 END
    WHERE session_id = ? AND playing = 1`).run(now, now, roomId);
}
export function resumeMediaPlayback(db: DatabaseSync, roomId: string, now: number) {
  db.prepare(`UPDATE media_playback SET playing = 1, updated_at = ?, resume_on_game_resume = 0,
    revision = revision + CASE WHEN media_id = (SELECT pre_timer_media_id FROM game_sessions WHERE id = session_id) THEN 0 ELSE 1 END
    WHERE session_id = ? AND resume_on_game_resume = 1`).run(now, roomId);
}
export function beginMedia(db: DatabaseSync, roomId: string, questionId: string, mediaId: string, now: number) {
  freezeMediaPlayback(db, roomId, now);
  db.prepare('UPDATE media_playback SET resume_on_game_resume = 0 WHERE session_id = ?').run(roomId);
  db.prepare(`INSERT INTO media_playback (session_id, question_id, media_id, playing, position_seconds, updated_at, revision)
    VALUES (?, ?, ?, 1, 0, ?, 1) ON CONFLICT(session_id, question_id, media_id) DO UPDATE SET
    playing = 1, position_seconds = 0, updated_at = excluded.updated_at, revision = media_playback.revision + 1`).run(roomId, questionId, mediaId, now);
}
export function beginAnswering(db: DatabaseSync, roomId: string, now: number) {
  const { snapshot, round, questionIndex } = currentContent(db, roomId);
  const question = round.questions[questionIndex!];
  const timer = createAnswerTimer(effectiveDuration(question.answerTimeSeconds, snapshot.defaultAnswerTimeSeconds), now);
  db.prepare("UPDATE game_sessions SET state = 'ANSWERING', pre_timer_media_id = NULL, answer_started_at = ?, answer_deadline_at = ? WHERE id = ?")
    .run(timer.startedAt, timer.deadlineAt, roomId);
  completeQuestionInTransaction(db, roomId, now);
}

// A Screen reports browser-local completion; identity/revision validation is atomic.
export function completeMedia(db: DatabaseSync, roomId: string, questionId: unknown, mediaId: unknown, revision: unknown, duration: unknown, now = Date.now()): boolean {
  db.exec('BEGIN IMMEDIATE');
  try {
    const room = getRoom(db, roomId);
    let changed = false;
    if (room && !room.closedAt && ['QUESTION', 'ANSWERING', 'ANSWER_REVEAL'].includes(room.state)) {
      // A concurrent overdue timer wins even if this completion is stale.
      changed = completeQuestionInTransaction(db, roomId, now);
      const { round, questionIndex } = currentContent(db, roomId);
      const question = round.questions[questionIndex!];
      if (question?.id === questionId && typeof mediaId === 'string' && Number.isSafeInteger(revision)
        && typeof duration === 'number' && Number.isFinite(duration) && duration > 0) {
        const row = db.prepare('SELECT * FROM media_playback WHERE session_id = ? AND question_id = ? AND media_id = ?').get(roomId, question.id, mediaId) as PlaybackRow | undefined;
        const current = preTimerMediaId(db, roomId);
        if (row?.playing && row.revision === revision && (!current || current === mediaId)) {
          db.prepare('UPDATE media_playback SET playing = 0, position_seconds = ?, updated_at = ?, revision = revision + 1 WHERE session_id = ? AND question_id = ? AND media_id = ?')
            .run(duration, now, roomId, question.id, mediaId);
          changed = true;
          if (room.state === 'QUESTION' && current === mediaId) {
            const ordered = question.media!.filter(ref => ref.playBeforeTimer);
            const next = ordered[ordered.findIndex(ref => ref.mediaId === mediaId) + 1];
            if (next) {
              db.prepare('UPDATE game_sessions SET pre_timer_media_id = ? WHERE id = ?').run(next.mediaId, roomId);
              beginMedia(db, roomId, question.id, next.mediaId, now);
            } else beginAnswering(db, roomId, now);
          }
        }
      }
    }
    db.exec('COMMIT'); return changed;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

// During Answering, only expiry may change lifecycle; controls never extend time.
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
    if (completeQuestionInTransaction(db, roomId, now)) {
      db.exec('COMMIT'); committed = true;
      return { room: getRoom(db, roomId)! };
    }
    const preTimer = preTimerMediaId(db, roomId);
    if (preTimer && preTimer !== mediaId) return { status: 409, error: 'Only current pre-timer media can be controlled.' };
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
