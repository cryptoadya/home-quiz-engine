import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import request from 'supertest';
import { createApp } from './app.js';
import { initializeDatabase } from './db.js';

test('readiness follows persisted draft edits without restricting draft CRUD', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'home-quiz-validation-'));
  const db = initializeDatabase(join(directory, 'quiz.sqlite'));
  const app = request(createApp(db));
  try {
    const quizId = (await app.post('/api/quizzes')).body.id;
    const url = `/api/quizzes/${quizId}/validation`;
    const codes = async () => (await app.get(url)).body.problems.map((problem: { code: string }) => problem.code);
    assert.deepEqual(await codes(), ['QUIZ_NO_ROUNDS']);
    assert.equal((await app.get('/api/quizzes/missing/validation')).status, 404);
    const otherQuiz = (await app.post('/api/quizzes')).body.id;
    const roundId = (await app.post(`/api/quizzes/${quizId}/rounds`)).body.id;
    assert.deepEqual(await codes(), ['ROUND_NO_QUESTIONS']);
    const base = `/api/quizzes/${quizId}/rounds/${roundId}/questions`;
    const questionId = (await app.post(base)).body.id;
    assert.deepEqual(await codes(), [
      'QUESTION_TEXT_RU_MISSING', 'QUESTION_TEXT_EN_MISSING',
      'SINGLE_CHOICE_TOO_FEW_OPTIONS', 'SINGLE_CHOICE_CORRECT_COUNT',
    ]);
    assert.deepEqual((await app.get(`/api/quizzes/${otherQuiz}/validation`)).body.problems.map((problem: { code: string }) => problem.code), ['QUIZ_NO_ROUNDS']);
    const question = { type: 'single_choice', textRu: 'Вопрос', textEn: '', points: 1, answerTimeSeconds: null, showOptionsOnScreen: false };
    assert.equal((await app.put(`${base}/${questionId}`).send(question)).status, 200);
    assert.deepEqual(await codes(), ['QUESTION_TEXT_EN_MISSING', 'SINGLE_CHOICE_TOO_FEW_OPTIONS', 'SINGLE_CHOICE_CORRECT_COUNT']);
    question.textEn = 'Question';
    assert.equal((await app.put(`${base}/${questionId}`).send(question)).status, 200);
    const options = `${base}/${questionId}/options`;
    const first = (await app.post(options)).body.id;
    assert.deepEqual(await codes(), ['SINGLE_CHOICE_TOO_FEW_OPTIONS', 'SINGLE_CHOICE_CORRECT_COUNT', 'OPTION_TEXT_RU_MISSING', 'OPTION_TEXT_EN_MISSING']);
    const second = (await app.post(options)).body.id;
    assert.deepEqual(await codes(), ['SINGLE_CHOICE_CORRECT_COUNT', 'OPTION_TEXT_RU_MISSING', 'OPTION_TEXT_EN_MISSING', 'OPTION_TEXT_RU_MISSING', 'OPTION_TEXT_EN_MISSING']);
    await app.put(`${options}/${first}`).send({ textRu: 'Да', textEn: 'Yes', isCorrect: false });
    await app.put(`${options}/${second}`).send({ textRu: 'Нет', textEn: 'No', isCorrect: false });
    assert.deepEqual(await codes(), ['SINGLE_CHOICE_CORRECT_COUNT']);
    await app.put(`${options}/${first}/correct`);
    assert.deepEqual((await app.get(url)).body, { ready: true, problems: [] });
    db.prepare('UPDATE answer_options SET is_correct = 1 WHERE id = ?').run(second);
    assert.deepEqual(await codes(), ['SINGLE_CHOICE_CORRECT_COUNT']);
    db.prepare('UPDATE answer_options SET is_correct = 0, text_en = ? WHERE id = ?').run(' ', second);
    assert.deepEqual(await codes(), ['OPTION_TEXT_EN_MISSING']);
    db.prepare('UPDATE answer_options SET text_en = ?, text_ru = ? WHERE id = ?').run('No', ' ', second);
    assert.deepEqual(await codes(), ['OPTION_TEXT_RU_MISSING']);
    db.prepare('UPDATE answer_options SET text_ru = ? WHERE id = ?').run('Нет', second);
    db.prepare('UPDATE questions SET text_ru = ? WHERE id = ?').run(' ', questionId);
    assert.deepEqual(await codes(), ['QUESTION_TEXT_RU_MISSING']);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('readiness reports legacy field errors in round, question, and option order', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'home-quiz-validation-order-'));
  const db = initializeDatabase(join(directory, 'quiz.sqlite'));
  const app = request(createApp(db));
  try {
    const quizId = (await app.post('/api/quizzes')).body.id;
    const roundA = (await app.post(`/api/quizzes/${quizId}/rounds`)).body.id;
    const roundB = (await app.post(`/api/quizzes/${quizId}/rounds`)).body.id;
    const baseA = `/api/quizzes/${quizId}/rounds/${roundA}/questions`;
    const qA = (await app.post(baseA)).body.id;
    const qB = (await app.post(baseA)).body.id;
    const option = (await app.post(`${baseA}/${qA}/options`)).body.id;
    db.prepare('UPDATE quizzes SET title = ?, default_answer_time_seconds = 0 WHERE id = ?').run('x'.repeat(101), quizId);
    db.prepare('UPDATE rounds SET title_ru = ?, description_en = ? WHERE id = ?').run(' ', 'English only', roundA);
    db.prepare('UPDATE rounds SET title_en = ? WHERE id = ?').run('x'.repeat(101), roundB);
    db.exec('PRAGMA ignore_check_constraints = ON');
    db.prepare('UPDATE questions SET points = 0, answer_time_seconds = 3601, text_en = ? WHERE id = ?').run('x'.repeat(5001), qA);
    db.exec('PRAGMA ignore_check_constraints = OFF');
    db.prepare('UPDATE answer_options SET text_ru = ? WHERE id = ?').run('x'.repeat(501), option);
    const response = await app.get(`/api/quizzes/${quizId}/validation`);
    assert.equal(response.body.ready, false);
    assert.deepEqual(response.body.problems.map((problem: { code: string }) => problem.code), [
      'QUIZ_TITLE_INVALID', 'QUIZ_TIMER_INVALID',
      'ROUND_TITLE_RU_INVALID', 'ROUND_DESCRIPTION_INCOMPLETE',
      'QUESTION_TEXT_RU_MISSING', 'QUESTION_TEXT_EN_TOO_LONG', 'QUESTION_POINTS_INVALID', 'QUESTION_TIMER_INVALID',
      'SINGLE_CHOICE_TOO_FEW_OPTIONS', 'SINGLE_CHOICE_CORRECT_COUNT', 'OPTION_TEXT_RU_TOO_LONG', 'OPTION_TEXT_EN_MISSING',
      'QUESTION_TEXT_RU_MISSING', 'QUESTION_TEXT_EN_MISSING', 'SINGLE_CHOICE_TOO_FEW_OPTIONS', 'SINGLE_CHOICE_CORRECT_COUNT',
      'ROUND_TITLE_EN_INVALID', 'ROUND_NO_QUESTIONS',
    ]);
    assert.equal(response.body.problems[2].roundId, roundA);
    assert.equal(response.body.problems[4].questionId, qA);
    assert.equal(response.body.problems[10].optionId, option);
    assert.equal(response.body.problems[12].questionId, qB);
    assert.equal(response.body.problems.at(-1).roundId, roundB);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
