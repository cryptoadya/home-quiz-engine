import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { getRound } from './rounds.js';
import { getQuestion, listQuestions } from './questions.js';

// Copies stay inside one quiz, so references reuse its existing media library.
function copyQuestion(db: DatabaseSync, sourceId: string, roundId: string, now: string): string {
  const id = randomUUID();
  db.prepare(`INSERT INTO questions (id, round_id, type, text_ru, text_en, points, answer_time_seconds,
    show_options_on_screen, show_correct_count, explanation_ru, explanation_en, media_json, position, created_at, updated_at)
    SELECT ?, ?, type, text_ru, text_en, points, answer_time_seconds, show_options_on_screen, show_correct_count,
      explanation_ru, explanation_en, media_json,
      (SELECT COALESCE(MAX(position), -1) + 1 FROM questions WHERE round_id = ?), ?, ? FROM questions WHERE id = ?`)
    .run(id, roundId, roundId, now, now, sourceId);
  for (const option of db.prepare('SELECT id FROM answer_options WHERE question_id = ? ORDER BY position, id').all(sourceId)) {
    db.prepare(`INSERT INTO answer_options (id, question_id, text_ru, text_en, is_correct, position, created_at, updated_at)
      SELECT ?, ?, text_ru, text_en, is_correct, position, ?, ? FROM answer_options WHERE id = ?`)
      .run(randomUUID(), id, now, now, option.id);
  }
  for (const pair of db.prepare('SELECT id FROM matching_pairs WHERE question_id = ? ORDER BY position, id').all(sourceId)) {
    db.prepare(`INSERT INTO matching_pairs (id, question_id, left_json, right_json, position, created_at, updated_at)
      SELECT ?, ?, left_json, right_json, position, ?, ? FROM matching_pairs WHERE id = ?`)
      .run(randomUUID(), id, now, now, pair.id);
  }
  return id;
}

export function duplicateQuestion(db: DatabaseSync, quizId: string, roundId: string, sourceId: string) {
  if (!getQuestion(db, quizId, roundId, sourceId)) return null;
  db.exec('BEGIN');
  try {
    const id = copyQuestion(db, sourceId, roundId, new Date().toISOString());
    db.exec('COMMIT');
    return getQuestion(db, quizId, roundId, id)!;
  } catch (cause) { db.exec('ROLLBACK'); throw cause; }
}

export function duplicateRound(db: DatabaseSync, quizId: string, sourceId: string) {
  const source = getRound(db, quizId, sourceId);
  if (!source) return null;
  const id = randomUUID(), now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    db.prepare(`INSERT INTO rounds (id, quiz_id, title_ru, title_en, description_ru, description_en,
      art_media_id, is_tiebreak, show_leaderboard_after, position, created_at, updated_at)
      SELECT ?, quiz_id, ?, ?, description_ru, description_en, art_media_id, is_tiebreak, show_leaderboard_after,
        (SELECT COALESCE(MAX(position), -1) + 1 FROM rounds WHERE quiz_id = ?), ?, ? FROM rounds WHERE id = ?`)
      .run(id, `${source.titleRu.slice(0, 92)} (Копия)`, `${source.titleEn.slice(0, 93)} (Copy)`, quizId, now, now, sourceId);
    for (const question of listQuestions(db, sourceId)) copyQuestion(db, question.id, id, now);
    db.exec('COMMIT');
    return getRound(db, quizId, id)!;
  } catch (cause) { db.exec('ROLLBACK'); throw cause; }
}
