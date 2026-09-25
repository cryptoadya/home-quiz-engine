import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import request from 'supertest';
import { createApp } from './app.js';
import { initializeDatabase } from './db.js';
import { duplicateQuiz } from './quizzes.js';

test('duplicates empty drafts with a bounded title and fresh quiz ID', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'home-quiz-duplicate-empty-'));
  const db = initializeDatabase(join(directory, 'quiz.sqlite'));
  const app = request(createApp(db));
  try {
    assert.equal((await app.post('/api/quizzes/missing/duplicate')).status, 404);
    const source = (await app.post('/api/quizzes')).body;
    const title = 'A'.repeat(100);
    await app.put(`/api/quizzes/${source.id}`).send({ title, themeId: 'halloween', defaultAnswerTimeSeconds: 47, shuffleAnswers: true });
    const result = await app.post(`/api/quizzes/${source.id}/duplicate`);
    assert.equal(result.status, 201);
    assert.notEqual(result.body.id, source.id);
    assert.equal(result.body.title, `${'A'.repeat(93)} (Copy)`);
    assert.deepEqual([result.body.themeId, result.body.defaultAnswerTimeSeconds, result.body.shuffleAnswers], ['halloween', 47, true]);
    assert.deepEqual((await app.get(`/api/quizzes/${result.body.id}/rounds`)).body, []);
    assert.deepEqual((await app.get(`/api/quizzes/${result.body.id}/validation`)).body.problems.map((problem: { code: string }) => problem.code), ['QUIZ_NO_ROUNDS']);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('duplicates the ordered quiz tree with independent entities and matching readiness', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'home-quiz-duplicate-full-'));
  const db = initializeDatabase(join(directory, 'quiz.sqlite'));
  const app = request(createApp(db));
  try {
    const sourceId = (await app.post('/api/quizzes')).body.id;
    const settings = { title: 'Party', themeId: 'halloween', defaultAnswerTimeSeconds: 48, shuffleAnswers: true };
    await app.put(`/api/quizzes/${sourceId}`).send(settings);
    const roundBase = `/api/quizzes/${sourceId}/rounds`;
    const sourceRounds = [(await app.post(roundBase)).body, (await app.post(roundBase)).body];
    for (const [index, round] of sourceRounds.entries()) {
      await app.put(`${roundBase}/${round.id}`).send({
        titleRu: `Раунд ${index + 1}`, titleEn: `Round ${index + 1}`,
        descriptionRu: `Описание ${index + 1}`, descriptionEn: `Description ${index + 1}`,
        showLeaderboardAfter: index === 0,
      });
    }
    await app.put(`${roundBase}/order`).send({ ids: sourceRounds.map((round) => round.id).reverse() });
    const sourceTree = [];
    for (const round of (await app.get(roundBase)).body) {
      const questionsBase = `${roundBase}/${round.id}/questions`;
      const created = [(await app.post(questionsBase)).body, (await app.post(questionsBase)).body];
      for (const [index, question] of created.entries()) {
        await app.put(`${questionsBase}/${question.id}`).send({
          type: 'single_choice', textRu: `Вопрос ${index + 1}`, textEn: `Question ${index + 1}`,
          points: index + 2, answerTimeSeconds: index ? null : 50, showOptionsOnScreen: index === 0,
        });
      }
      await app.put(`${questionsBase}/order`).send({ ids: created.map((question) => question.id).reverse() });
      const questions = (await app.get(questionsBase)).body;
      const optionsByQuestion = [];
      for (const question of questions) {
        const optionsBase = `${questionsBase}/${question.id}/options`;
        const options = [(await app.post(optionsBase)).body, (await app.post(optionsBase)).body];
        for (const [index, option] of options.entries()) {
          await app.put(`${optionsBase}/${option.id}`).send({ textRu: `Ответ ${index + 1}`, textEn: `Answer ${index + 1}`, isCorrect: false });
        }
        await app.put(`${optionsBase}/${options[1].id}/correct`);
        await app.put(`${optionsBase}/order`).send({ ids: options.map((option) => option.id).reverse() });
        optionsByQuestion.push((await app.get(optionsBase)).body);
      }
      sourceTree.push({ round, questions, optionsByQuestion });
    }
    const copied = (await app.post(`/api/quizzes/${sourceId}/duplicate`)).body;
    assert.equal(copied.title, 'Party (Copy)');
    assert.notEqual(copied.id, sourceId);
    assert.deepEqual([copied.themeId, copied.defaultAnswerTimeSeconds, copied.shuffleAnswers], ['halloween', 48, true]);
    assert.deepEqual((await app.get(`/api/quizzes/${copied.id}/validation`)).body, { ready: true, problems: [] });
    assert.deepEqual((await app.get(`/api/quizzes/${sourceId}/validation`)).body, { ready: true, problems: [] });
    const copiedRounds = (await app.get(`/api/quizzes/${copied.id}/rounds`)).body;
    const sourceIds = new Set([sourceId, ...sourceTree.flatMap(({ round, questions, optionsByQuestion }) => [
      round.id, ...questions.map((question: { id: string }) => question.id),
      ...optionsByQuestion.flatMap((options: { id: string }[]) => options.map((option) => option.id)),
    ])]);
    const copiedIds = new Set([copied.id]);
    assert.equal(copiedRounds.length, 2);
    for (const [roundIndex, copiedRound] of copiedRounds.entries()) {
      const original = sourceTree[roundIndex];
      assert.notEqual(copiedRound.id, original.round.id);
      copiedIds.add(copiedRound.id);
      assert.equal(copiedRound.quizId, copied.id);
      assert.deepEqual([copiedRound.position, copiedRound.titleRu, copiedRound.titleEn, copiedRound.descriptionRu, copiedRound.descriptionEn, copiedRound.showLeaderboardAfter],
        [original.round.position, original.round.titleRu, original.round.titleEn, original.round.descriptionRu, original.round.descriptionEn, original.round.showLeaderboardAfter]);
      const copiedQuestions = (await app.get(`/api/quizzes/${copied.id}/rounds/${copiedRound.id}/questions`)).body;
      assert.equal(copiedQuestions.length, 2);
      for (const [questionIndex, copiedQuestion] of copiedQuestions.entries()) {
        const sourceQuestion = original.questions[questionIndex];
        assert.notEqual(copiedQuestion.id, sourceQuestion.id);
        copiedIds.add(copiedQuestion.id);
        assert.equal(copiedQuestion.roundId, copiedRound.id);
        assert.deepEqual([copiedQuestion.position, copiedQuestion.type, copiedQuestion.textRu, copiedQuestion.textEn, copiedQuestion.points, copiedQuestion.answerTimeSeconds, copiedQuestion.showOptionsOnScreen],
          [sourceQuestion.position, sourceQuestion.type, sourceQuestion.textRu, sourceQuestion.textEn, sourceQuestion.points, sourceQuestion.answerTimeSeconds, sourceQuestion.showOptionsOnScreen]);
        const copiedOptions = (await app.get(`/api/quizzes/${copied.id}/rounds/${copiedRound.id}/questions/${copiedQuestion.id}/options`)).body;
        assert.equal(copiedOptions.length, 2);
        for (const [optionIndex, copiedOption] of copiedOptions.entries()) {
          const sourceOption = original.optionsByQuestion[questionIndex][optionIndex];
          assert.notEqual(copiedOption.id, sourceOption.id);
          copiedIds.add(copiedOption.id);
          assert.equal(copiedOption.questionId, copiedQuestion.id);
          assert.deepEqual([copiedOption.position, copiedOption.textRu, copiedOption.textEn, copiedOption.isCorrect],
            [sourceOption.position, sourceOption.textRu, sourceOption.textEn, sourceOption.isCorrect]);
        }
      }
    }
    assert.equal(copiedIds.size, sourceIds.size);
    assert.ok([...copiedIds].every((id) => !sourceIds.has(id)));
    await app.delete(`/api/quizzes/${copied.id}/rounds/${copiedRounds[0].id}`);
    await app.put(`/api/quizzes/${copied.id}`).send({ ...settings, title: 'Changed copy' });
    assert.equal((await app.get(`/api/quizzes/${sourceId}`)).body.title, 'Party');
    assert.equal((await app.get(`${roundBase}`)).body.length, 2);
    assert.deepEqual((await app.get(`/api/quizzes/${sourceId}/validation`)).body, { ready: true, problems: [] });
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('duplicate transaction rolls back if copying a child fails', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'home-quiz-duplicate-rollback-'));
  const db = initializeDatabase(join(directory, 'quiz.sqlite'));
  const app = request(createApp(db));
  try {
    const sourceId = (await app.post('/api/quizzes')).body.id;
    const roundId = (await app.post(`/api/quizzes/${sourceId}/rounds`)).body.id;
    const questionId = (await app.post(`/api/quizzes/${sourceId}/rounds/${roundId}/questions`)).body.id;
    await app.post(`/api/quizzes/${sourceId}/rounds/${roundId}/questions/${questionId}/options`);
    db.exec(`CREATE TRIGGER reject_copied_option BEFORE INSERT ON answer_options
      BEGIN SELECT RAISE(ABORT, 'copy failure'); END`);
    assert.throws(() => duplicateQuiz(db, sourceId), /copy failure/);
    assert.equal((await app.get('/api/quizzes')).body.length, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM rounds').get()?.count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM questions').get()?.count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM answer_options').get()?.count, 1);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
