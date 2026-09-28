import { copyQuizMedia, removeMediaDirectory } from './media.js';
import { listPairs } from './matching.js';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { listRounds } from './rounds.js';
import { listOptions, listQuestions } from './questions.js';

export type Quiz = {
  id: string;
  title: string;
  themeId: string;
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

export function duplicateQuiz(db: DatabaseSync, sourceId: string): Quiz | null {
  const source = getQuiz(db, sourceId);
  if (!source) return null;
  const id = randomUUID();
  const now = new Date().toISOString();
  const title = `${source.title.slice(0, 93)} (Copy)`;
  db.exec('BEGIN');
  try {
    db.prepare(`INSERT INTO quizzes (id, title, theme_id, default_answer_time_seconds, shuffle_answers, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, title, source.themeId, source.defaultAnswerTimeSeconds, Number(source.shuffleAnswers), now, now);
    const mediaIds = copyQuizMedia(db, sourceId, id);
    const remapSide = (side: import('./matching.js').MatchingSide) => side.kind === 'image' ? { ...side, mediaId: mediaIds.get(side.mediaId) ?? side.mediaId } : side;
    const insertRound = db.prepare(`INSERT INTO rounds (id, quiz_id, title_ru, title_en, description_ru, description_en,
      show_leaderboard_after, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertQuestion = db.prepare(`INSERT INTO questions (id, round_id, type, text_ru, text_en, points, answer_time_seconds,
      show_options_on_screen, show_correct_count, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertOption = db.prepare(`INSERT INTO answer_options (id, question_id, text_ru, text_en, is_correct, position, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const round of listRounds(db, sourceId)) {
      const roundId = randomUUID();
      insertRound.run(roundId, id, round.titleRu, round.titleEn, round.descriptionRu, round.descriptionEn,
        Number(round.showLeaderboardAfter), round.position, now, now);
      db.prepare('UPDATE rounds SET art_media_id = ? WHERE id = ?').run(round.artMediaId ? mediaIds.get(round.artMediaId) ?? round.artMediaId : null, roundId);
      for (const question of listQuestions(db, round.id)) {
        const questionId = randomUUID();
        insertQuestion.run(questionId, roundId, question.type, question.textRu, question.textEn, question.points,
          question.answerTimeSeconds, Number(question.showOptionsOnScreen), Number(question.showCorrectCount), question.position, now, now);
        db.prepare('UPDATE questions SET explanation_ru = ?, explanation_en = ? WHERE id = ?').run(question.explanationRu, question.explanationEn, questionId);
        db.prepare('UPDATE questions SET media_json = ? WHERE id = ?').run(JSON.stringify(question.media.map(ref => ({ ...ref, mediaId: mediaIds.get(ref.mediaId) ?? ref.mediaId }))), questionId);
        for (const pair of listPairs(db, question.id)) {
          db.prepare('INSERT INTO matching_pairs (id, question_id, left_json, right_json, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(randomUUID(), questionId, JSON.stringify(remapSide(pair.left)), JSON.stringify(remapSide(pair.right)), pair.position, now, now);
        }
        for (const option of listOptions(db, question.id)) {
          insertOption.run(randomUUID(), questionId, option.textRu, option.textEn, Number(option.isCorrect), option.position, now, now);
        }
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    removeMediaDirectory(db, id);
    throw error;
  }
  return getQuiz(db, id)!;
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
  if (typeof input.themeId !== 'string' || input.themeId.trim().length === 0 || input.themeId.length > 100) {
    return { error: 'Theme ID must be 1–100 characters.' };
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
  if (!getQuiz(db, id)) return false;
  removeMediaDirectory(db, id);
  return db.prepare('DELETE FROM quizzes WHERE id = ?').run(id).changes > 0;
}
