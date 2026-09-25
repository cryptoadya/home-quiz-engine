import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { getRound } from './rounds.js';

export type Question = {
  id: string; roundId: string; type: 'single_choice'; textRu: string; textEn: string;
  points: number; answerTimeSeconds: number | null; showOptionsOnScreen: boolean;
  position: number; createdAt: string; updatedAt: string;
};
export type AnswerOption = {
  id: string; questionId: string; textRu: string; textEn: string; isCorrect: boolean;
  position: number; createdAt: string; updatedAt: string;
};
type QuestionRow = {
  id: string; round_id: string; type: 'single_choice'; text_ru: string; text_en: string;
  points: number; answer_time_seconds: number | null; show_options_on_screen: number;
  position: number; created_at: string; updated_at: string;
};
type OptionRow = {
  id: string; question_id: string; text_ru: string; text_en: string; is_correct: number;
  position: number; created_at: string; updated_at: string;
};
const toQuestion = (row: QuestionRow): Question => ({
  id: row.id, roundId: row.round_id, type: row.type, textRu: row.text_ru, textEn: row.text_en,
  points: row.points, answerTimeSeconds: row.answer_time_seconds,
  showOptionsOnScreen: Boolean(row.show_options_on_screen), position: row.position,
  createdAt: row.created_at, updatedAt: row.updated_at,
});
const toOption = (row: OptionRow): AnswerOption => ({
  id: row.id, questionId: row.question_id, textRu: row.text_ru, textEn: row.text_en,
  isCorrect: Boolean(row.is_correct), position: row.position,
  createdAt: row.created_at, updatedAt: row.updated_at,
});

export function getQuestion(db: DatabaseSync, quizId: string, roundId: string, id: string): Question | null {
  if (!getRound(db, quizId, roundId)) return null;
  const row = db.prepare('SELECT * FROM questions WHERE round_id = ? AND id = ?').get(roundId, id) as QuestionRow | undefined;
  return row ? toQuestion(row) : null;
}
export function listQuestions(db: DatabaseSync, roundId: string): Question[] {
  return (db.prepare('SELECT * FROM questions WHERE round_id = ? ORDER BY position, id').all(roundId) as QuestionRow[]).map(toQuestion);
}
export function createQuestion(db: DatabaseSync, roundId: string): Question {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO questions (id, round_id, type, text_ru, text_en, points, answer_time_seconds,
    show_options_on_screen, position, created_at, updated_at) VALUES (?, ?, 'single_choice', '', '', 1, NULL, 0,
    (SELECT COALESCE(MAX(position), -1) + 1 FROM questions WHERE round_id = ?), ?, ?)`).run(id, roundId, roundId, now, now);
  return toQuestion(db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as QuestionRow);
}
export type QuestionChanges = Pick<Question, 'type' | 'textRu' | 'textEn' | 'points' | 'answerTimeSeconds' | 'showOptionsOnScreen'>;
export function validateQuestionChanges(value: unknown): { changes: QuestionChanges } | { error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'Question fields must be an object.' };
  const input = value as Record<string, unknown>;
  const keys = ['type', 'textRu', 'textEn', 'points', 'answerTimeSeconds', 'showOptionsOnScreen'];
  if (Object.keys(input).length !== keys.length || Object.keys(input).some((key) => !keys.includes(key))) return { error: 'Provide all question fields.' };
  if (input.type !== 'single_choice') return { error: 'Only single_choice is supported.' };
  if (typeof input.textRu !== 'string' || typeof input.textEn !== 'string' || input.textRu.length > 5000 || input.textEn.length > 5000) return { error: 'Question text must be strings of at most 5000 characters.' };
  if (!Number.isSafeInteger(input.points) || (input.points as number) < 1) return { error: 'Points must be a positive integer.' };
  if (input.answerTimeSeconds !== null && (!Number.isInteger(input.answerTimeSeconds) || (input.answerTimeSeconds as number) < 1 || (input.answerTimeSeconds as number) > 3600)) return { error: 'Answer time must be null or 1–3600 seconds.' };
  if (typeof input.showOptionsOnScreen !== 'boolean') return { error: 'showOptionsOnScreen must be a boolean.' };
  return { changes: input as QuestionChanges };
}
export function updateQuestion(db: DatabaseSync, roundId: string, id: string, changes: QuestionChanges): Question {
  db.prepare(`UPDATE questions SET type = ?, text_ru = ?, text_en = ?, points = ?, answer_time_seconds = ?,
    show_options_on_screen = ?, updated_at = ? WHERE round_id = ? AND id = ?`).run(
    changes.type, changes.textRu, changes.textEn, changes.points, changes.answerTimeSeconds,
    Number(changes.showOptionsOnScreen), new Date().toISOString(), roundId, id,
  );
  return toQuestion(db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as QuestionRow);
}
export function deleteQuestion(db: DatabaseSync, roundId: string, id: string): void {
  db.prepare('DELETE FROM questions WHERE round_id = ? AND id = ?').run(roundId, id);
}

function reorder<T extends { id: string }>(db: DatabaseSync, table: 'questions' | 'answer_options', parentColumn: 'round_id' | 'question_id', parentId: string, existing: T[], ids: unknown): boolean {
  if (!Array.isArray(ids) || ids.length !== existing.length || ids.some((id) => typeof id !== 'string') ||
      new Set(ids).size !== ids.length || ids.some((id) => !existing.some((item) => item.id === id))) return false;
  db.exec('BEGIN');
  try {
    const update = db.prepare(`UPDATE ${table} SET position = ?, updated_at = ? WHERE ${parentColumn} = ? AND id = ?`);
    const now = new Date().toISOString();
    ids.forEach((id, position) => update.run(position, now, parentId, id));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return true;
}
export function reorderQuestions(db: DatabaseSync, roundId: string, ids: unknown): Question[] | null {
  return reorder(db, 'questions', 'round_id', roundId, listQuestions(db, roundId), ids) ? listQuestions(db, roundId) : null;
}

export function listOptions(db: DatabaseSync, questionId: string): AnswerOption[] {
  return (db.prepare('SELECT * FROM answer_options WHERE question_id = ? ORDER BY position, id').all(questionId) as OptionRow[]).map(toOption);
}
export function getOption(db: DatabaseSync, questionId: string, id: string): AnswerOption | null {
  const row = db.prepare('SELECT * FROM answer_options WHERE question_id = ? AND id = ?').get(questionId, id) as OptionRow | undefined;
  return row ? toOption(row) : null;
}
export function createOption(db: DatabaseSync, questionId: string): AnswerOption {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO answer_options (id, question_id, text_ru, text_en, is_correct, position, created_at, updated_at)
    VALUES (?, ?, '', '', 0, (SELECT COALESCE(MAX(position), -1) + 1 FROM answer_options WHERE question_id = ?), ?, ?)`)
    .run(id, questionId, questionId, now, now);
  return getOption(db, questionId, id)!;
}
export type OptionChanges = Pick<AnswerOption, 'textRu' | 'textEn' | 'isCorrect'>;
export function validateOptionChanges(value: unknown): { changes: OptionChanges } | { error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'Option fields must be an object.' };
  const input = value as Record<string, unknown>;
  const keys = ['textRu', 'textEn', 'isCorrect'];
  if (Object.keys(input).length !== keys.length || Object.keys(input).some((key) => !keys.includes(key))) return { error: 'Provide all option fields.' };
  if (typeof input.textRu !== 'string' || typeof input.textEn !== 'string' || input.textRu.length > 500 || input.textEn.length > 500) return { error: 'Option text must be strings of at most 500 characters.' };
  if (typeof input.isCorrect !== 'boolean') return { error: 'isCorrect must be a boolean.' };
  return { changes: input as OptionChanges };
}
export function updateOption(db: DatabaseSync, questionId: string, id: string, changes: OptionChanges): AnswerOption {
  db.prepare(`UPDATE answer_options SET text_ru = ?, text_en = ?, is_correct = ?, updated_at = ? WHERE question_id = ? AND id = ?`)
    .run(changes.textRu, changes.textEn, Number(changes.isCorrect), new Date().toISOString(), questionId, id);
  return getOption(db, questionId, id)!;
}
export function selectCorrectOption(db: DatabaseSync, questionId: string, id: string): AnswerOption[] {
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE answer_options SET is_correct = (id = ?), updated_at = ? WHERE question_id = ?')
      .run(id, new Date().toISOString(), questionId);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return listOptions(db, questionId);
}
export function deleteOption(db: DatabaseSync, questionId: string, id: string): void {
  db.prepare('DELETE FROM answer_options WHERE question_id = ? AND id = ?').run(questionId, id);
}
export function reorderOptions(db: DatabaseSync, questionId: string, ids: unknown): AnswerOption[] | null {
  return reorder(db, 'answer_options', 'question_id', questionId, listOptions(db, questionId), ids) ? listOptions(db, questionId) : null;
}
