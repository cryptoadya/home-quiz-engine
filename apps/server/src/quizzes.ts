import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export type Quiz = {
  id: string;
  title: string;
  themeId: 'default' | 'halloween';
  defaultAnswerTimeSeconds: number;
  shuffleAnswers: boolean;
  createdAt: string;
  updatedAt: string;
};

type QuizRow = {
  id: string;
  title: string;
  theme_id: Quiz['themeId'];
  default_answer_time_seconds: number;
  shuffle_answers: number;
  created_at: string;
  updated_at: string;
};

function toQuiz(row: QuizRow): Quiz {
  return {
    id: row.id,
    title: row.title,
    themeId: row.theme_id,
    defaultAnswerTimeSeconds: row.default_answer_time_seconds,
    shuffleAnswers: Boolean(row.shuffle_answers),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listQuizzes(db: DatabaseSync): Quiz[] {
  return (db.prepare('SELECT * FROM quizzes ORDER BY updated_at DESC, id DESC').all() as QuizRow[]).map(toQuiz);
}

export function getQuiz(db: DatabaseSync, id: string): Quiz | null {
  const row = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(id) as QuizRow | undefined;
  return row ? toQuiz(row) : null;
}

export function createQuiz(db: DatabaseSync): Quiz {
  const quiz: Quiz = {
    id: randomUUID(),
    title: 'New Quiz',
    themeId: 'default',
    defaultAnswerTimeSeconds: 30,
    shuffleAnswers: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  db.prepare(`INSERT INTO quizzes
    (id, title, theme_id, default_answer_time_seconds, shuffle_answers, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    quiz.id, quiz.title, quiz.themeId, quiz.defaultAnswerTimeSeconds,
    Number(quiz.shuffleAnswers), quiz.createdAt, quiz.updatedAt,
  );
  return quiz;
}

export type QuizChanges = Pick<Quiz, 'title' | 'themeId' | 'defaultAnswerTimeSeconds' | 'shuffleAnswers'>;

export function validateQuizChanges(value: unknown): { changes: QuizChanges } | { error: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { error: 'Quiz settings must be a JSON object.' };
  }
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length !== 4 || keys.some((key) => !['title', 'themeId', 'defaultAnswerTimeSeconds', 'shuffleAnswers'].includes(key))) {
    return { error: 'Provide title, themeId, defaultAnswerTimeSeconds, and shuffleAnswers.' };
  }
  if (typeof input.title !== 'string' || input.title.trim().length === 0 || input.title.trim().length > 100) {
    return { error: 'Title must be 1–100 characters.' };
  }
  if (input.themeId !== 'default' && input.themeId !== 'halloween') {
    return { error: 'Theme must be default or halloween.' };
  }
  if (!Number.isInteger(input.defaultAnswerTimeSeconds) || (input.defaultAnswerTimeSeconds as number) < 1 || (input.defaultAnswerTimeSeconds as number) > 3600) {
    return { error: 'Answer time must be an integer from 1 to 3600 seconds.' };
  }
  if (typeof input.shuffleAnswers !== 'boolean') {
    return { error: 'Shuffle answers must be a boolean.' };
  }
  return { changes: {
    title: input.title.trim(),
    themeId: input.themeId,
    defaultAnswerTimeSeconds: input.defaultAnswerTimeSeconds as number,
    shuffleAnswers: input.shuffleAnswers,
  } };
}

export function updateQuiz(db: DatabaseSync, id: string, changes: QuizChanges): Quiz | null {
  const updatedAt = new Date().toISOString();
  const result = db.prepare(`UPDATE quizzes SET title = ?, theme_id = ?, default_answer_time_seconds = ?,
    shuffle_answers = ?, updated_at = ? WHERE id = ?`).run(
    changes.title, changes.themeId, changes.defaultAnswerTimeSeconds,
    Number(changes.shuffleAnswers), updatedAt, id,
  );
  return result.changes ? getQuiz(db, id) : null;
}

export function deleteQuiz(db: DatabaseSync, id: string): boolean {
  return db.prepare('DELETE FROM quizzes WHERE id = ?').run(id).changes > 0;
}
