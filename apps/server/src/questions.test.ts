import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import request from 'supertest';
import { createApp } from './app.js';
import { initializeDatabase } from './db.js';

test('Single Choice drafts, options, ordering, ownership, and cascades', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'home-quiz-questions-'));
  const db = initializeDatabase(join(directory, 'quiz.sqlite'));
  const app = request(createApp(db));
  try {
    const quiz = (await app.post('/api/quizzes')).body.id;
    const otherQuiz = (await app.post('/api/quizzes')).body.id;
    const round = (await app.post(`/api/quizzes/${quiz}/rounds`)).body.id;
    const otherRound = (await app.post(`/api/quizzes/${quiz}/rounds`)).body.id;
    const base = `/api/quizzes/${quiz}/rounds/${round}/questions`;
    const first = await app.post(base);
    const second = await app.post(base);
    assert.equal(first.status, 201);
    assert.match(first.body.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual([first.body.type, first.body.textRu, first.body.textEn, first.body.points, first.body.answerTimeSeconds, first.body.showOptionsOnScreen, first.body.position],
      ['single_choice', '', '', 1, null, false, 0]);
    assert.equal((await app.post(base).send({ textRu: 'unexpected' })).status, 400);
    assert.equal((await app.post(`/api/quizzes/${otherQuiz}/rounds/${round}/questions`)).status, 404);
    const q = `${base}/${first.body.id}`;
    const draft = { type: 'single_choice', textRu: 'Вопрос', textEn: '', points: 2, answerTimeSeconds: 45, showOptionsOnScreen: true };
    assert.equal((await app.put(q).send(draft)).status, 200);
    const { showOptionsOnScreen: _legacy, ...normalDraft } = draft;
    const normalSave = await app.put(q).send(normalDraft).expect(200);
    assert.equal(normalSave.body.showOptionsOnScreen, true, 'Omitted legacy field preserves stored archive compatibility');
    assert.equal((await app.get(base)).body[0].textEn, '');
    for (const changes of [
      { ...draft, type: 'other' }, { ...draft, textRu: 1 }, { ...draft, textEn: 'x'.repeat(5001) },
      { ...draft, points: 0 }, { ...draft, points: 1.5 }, { ...draft, points: '2' },
      { ...draft, answerTimeSeconds: 0 }, { ...draft, answerTimeSeconds: 3601 },
      { ...draft, showOptionsOnScreen: 1 }, { textRu: 'missing' },
    ]) assert.equal((await app.put(q).send(changes)).status, 400);
    assert.equal((await app.put(`/api/quizzes/${quiz}/rounds/${otherRound}/questions/${first.body.id}`).send(draft)).status, 404);
    assert.equal((await app.delete(`/api/quizzes/${otherQuiz}/rounds/${round}/questions/${first.body.id}`)).status, 404);
    for (const ids of [[first.body.id], [first.body.id, first.body.id], [first.body.id, 'foreign']]) {
      assert.equal((await app.put(`${base}/order`).send({ ids })).status, 400);
    }
    assert.equal((await app.put(`${base}/order`).send({ ids: [second.body.id, first.body.id] })).status, 200);
    assert.deepEqual((await app.get(base)).body.map((item: { id: string }) => item.id), [second.body.id, first.body.id]);

    const opts = `${q}/options`;
    assert.deepEqual((await app.get(opts)).body, []);
    const one = await app.post(opts);
    const two = await app.post(opts);
    assert.equal(one.status, 201);
    assert.match(one.body.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual([one.body.textRu, one.body.textEn, one.body.isCorrect, one.body.position], ['', '', false, 0]);
    assert.equal((await app.post(opts).send({ textRu: 'unexpected' })).status, 400);
    const optionDraft = { textRu: 'Ответ', textEn: '', isCorrect: false };
    assert.equal((await app.put(`${opts}/${one.body.id}`).send(optionDraft)).status, 200);
    assert.equal((await app.get(opts)).body[0].textEn, '');
    for (const changes of [
      { ...optionDraft, textRu: 1 }, { ...optionDraft, textEn: 'x'.repeat(501) },
      { ...optionDraft, isCorrect: 'yes' }, { textRu: 'missing' },
    ]) assert.equal((await app.put(`${opts}/${one.body.id}`).send(changes)).status, 400);
    assert.equal((await app.get(`/api/quizzes/${quiz}/rounds/${otherRound}/questions/${first.body.id}/options`)).status, 404);
    assert.equal((await app.put(`${opts}/order`).send({ ids: [one.body.id, one.body.id] })).status, 400);
    assert.equal((await app.put(`${opts}/order`).send({ ids: [two.body.id, one.body.id] })).status, 200);
    assert.deepEqual((await app.get(opts)).body.map((item: { id: string }) => item.id), [two.body.id, one.body.id]);
    assert.equal((await app.put(`${opts}/${one.body.id}/correct`)).status, 200);
    assert.deepEqual((await app.get(opts)).body.map((item: { isCorrect: boolean }) => item.isCorrect), [false, true]);
    assert.equal((await app.put(`${opts}/${two.body.id}/correct`)).status, 200);
    assert.deepEqual((await app.get(opts)).body.map((item: { isCorrect: boolean }) => item.isCorrect), [true, false]);
    assert.equal((await app.delete(`${opts}/${two.body.id}`)).status, 204);
    assert.equal((await app.get(opts)).body.some((item: { isCorrect: boolean }) => item.isCorrect), false);
    for (let index = 0; index < 9; index++) assert.equal((await app.post(opts)).status, 201);
    assert.equal((await app.post(opts)).status, 400);
    assert.equal((await app.delete(q)).status, 204);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM answer_options WHERE question_id = ?').get(first.body.id)?.count, 0);
    assert.equal((await app.delete(`/api/quizzes/${quiz}/rounds/${round}`)).status, 204);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM questions WHERE round_id = ?').get(round)?.count, 0);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
