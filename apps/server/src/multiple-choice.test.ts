import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { initializeDatabase } from './db.js';
import { createApp } from './app.js';
import { createQuiz } from './quizzes.js';
import { createRound } from './rounds.js';
import { createQuestion, createOption, updateQuestion, updateOption } from './questions.js';
import { validateQuizReadiness } from './validation.js';
import { createGameSnapshot, getGameSnapshot, parseGameSnapshot } from './snapshot.js';
import { getPlayerGame, getSurfaceState, startQuestion } from './game.js';
import { submitAnswer } from './answers.js';
import { completeQuestion } from './reveal.js';
import { autoPauseForDisconnectedPlayer, continueWithoutPlayer, pauseGame, resumeGame } from './pause.js';

const fields = { type: 'multiple_choice' as const, textRu: 'Выберите', textEn: 'Choose', points: 5, answerTimeSeconds: 30, showOptionsOnScreen: false };
function fixture(db: ReturnType<typeof initializeDatabase>, correct = [true, true, false]) {
  const quiz = createQuiz(db), round = createRound(db, quiz.id), q = createQuestion(db, round.id, 'multiple_choice');
  updateQuestion(db, round.id, q.id, fields);
  const options = correct.map((isCorrect, i) => updateOption(db, q.id, createOption(db, q.id).id, { textRu: `Ответ ${i}`, textEn: `Answer ${i}`, isCorrect }));
  const api = request(createApp(db));
  return { quiz, round, q, options, api };
}
for (const correct of [[], [true], [false, false], [true, false], Array(11).fill(true)]) test(`Multiple Choice rejects invalid shape ${JSON.stringify(correct)}`, async () => {
  const db = initializeDatabase(':memory:');
  try {
    const f = fixture(db, correct);
    assert.equal(validateQuizReadiness(db, f.quiz.id)!.ready, false);
    assert.throws(() => createGameSnapshot(db, f.quiz.id));
    await f.api.post(`/api/quizzes/${f.quiz.id}/rooms`).expect(409);
  } finally { db.close(); }
});

test('Multiple Choice API persists independent correctness and validates frozen shapes', async () => {
  const db = initializeDatabase(':memory:');
  try {
    const f = fixture(db);
    const base = `/api/quizzes/${f.quiz.id}/rounds/${f.round.id}/questions`;
    const created = (await f.api.post(base).send({ type: 'multiple_choice' }).expect(201)).body;
    await f.api.delete(`${base}/${created.id}`).expect(204);
    const path = `${base}/${f.q.id}/options/${f.options[2].id}`;
    await f.api.put(path).send({ textRu: 'Три', textEn: 'Three', isCorrect: true }).expect(200);
    await f.api.put(`${path}/correct`).expect(400);
    assert.equal(validateQuizReadiness(db, f.quiz.id)!.ready, true);
    const snapshot = createGameSnapshot(db, f.quiz.id);
    for (const count of [0, 1, 11]) {
      const bad = structuredClone(snapshot); const options = bad.rounds[0].questions[0].options;
      bad.rounds[0].questions[0].options = count === 11 ? Array.from({ length: 11 }, (_, i) => ({ ...options[0], id: String(i), position: i })) : options.slice(0, count);
      assert.throws(() => parseGameSnapshot(JSON.stringify(bad)));
    }
    snapshot.rounds[0].questions[0].options.forEach((o, i) => o.isCorrect = i === 0);
    assert.throws(() => parseGameSnapshot(JSON.stringify(snapshot)));
  } finally { db.close(); }
});

for (const selected of [[0, 1], [1, 0], [0], [0, 1, 2], [0, 2]]) test(`exact set scoring ${selected}`, async () => {
  const db = initializeDatabase(':memory:');
  try {
    const f = fixture(db), room = (await f.api.post(`/api/quizzes/${f.quiz.id}/rooms`).expect(201)).body;
    const identity = (await f.api.post(`/api/rooms/code/${room.code}/players`).send({ name: 'Alice', language: 'en' }).expect(201)).body;
    const root = `/api/rooms/${room.id}`;
    await f.api.post(`${root}/start`).expect(200); await f.api.post(`${root}/start-round`).expect(200); startQuestion(db, room.id, 1000);
    assert.ok('submission' in submitAnswer(db, room.id, { token: identity.token, questionId: f.q.id, optionIds: selected.map(i => f.options[i].id) }, () => 2000));
    const game = getPlayerGame(db, room.id, 'en', identity.player.id) as any;
    assert.deepEqual(game.result, { outcome: selected.length === 2 && selected.includes(1) && !selected.includes(2) ? 'correct' : 'wrong', points: selected.length === 2 && selected.includes(1) && !selected.includes(2) ? 5 : 0 });
    assert.deepEqual(new Set(game.correctOptionIds), new Set(f.options.slice(0, 2).map(o => o.id)));
  } finally { db.close(); }
});

test('two-player mixed quiz reuses immutable Submit, Pause, reconnect, Continue exclusion and frozen navigation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'multiple-choice-')), path = join(directory, 'quiz.sqlite');
  let db = initializeDatabase(path);
  try {
    const f = fixture(db);
    for (const type of ['single_choice', 'yes_no'] as const) {
      const q = createQuestion(db, f.round.id, type); updateQuestion(db, f.round.id, q.id, { ...fields, type });
      if (type === 'single_choice') for (const isCorrect of [true, false]) updateOption(db, q.id, createOption(db, q.id).id, { textRu: 'Ответ', textEn: 'Answer', isCorrect });
    }
    const room = (await f.api.post(`/api/quizzes/${f.quiz.id}/rooms`).expect(201)).body;
    const ids = [];
    for (const name of ['Alice', 'Bob']) ids.push((await f.api.post(`/api/rooms/code/${room.code}/players`).send({ name, language: 'en' }).expect(201)).body);
    const root = `/api/rooms/${room.id}`;
    await f.api.post(`${root}/start`).expect(200); const frozen = getGameSnapshot(db, room.id)!;
    await f.api.delete(`/api/quizzes/${f.quiz.id}`).expect(204); await f.api.post(`${root}/start-round`).expect(200);
    startQuestion(db, room.id, 1000);
    const answer = { token: ids[0].token, questionId: f.q.id, optionIds: f.options.slice(0, 2).map(o => o.id) };
    const game = getPlayerGame(db, room.id, 'en', ids[0].player.id) as any;
    assert.equal(game.requiredCorrectCount, 2); assert.doesNotMatch(JSON.stringify(game), /isCorrect|correctOptionId/);
    assert.doesNotMatch(JSON.stringify(getSurfaceState(db, room.id, 'screen')), /isCorrect|correctOptionId/);
    for (const optionIds of [[], ['missing'], [answer.optionIds[0], answer.optionIds[0]], [1]]) assert.equal((submitAnswer(db, room.id, { ...answer, optionIds }, () => 2000) as any).status, 400);
    mock.method(Date, 'now', () => 2000);
    const api = request(createApp(db));
    const accepted = (await api.post(`${root}/answers`).send(answer).expect(200)).body;
    assert.deepEqual(new Set(accepted.optionIds), new Set(answer.optionIds));
    assert.deepEqual(submitAnswer(db, room.id, { ...answer, optionIds: [f.options[2].id] }, () => 999999), { inserted: false, submission: accepted });
    assert.equal(autoPauseForDisconnectedPlayer(db, room.id, ids[0].player.id, () => 2100), false);
    assert.ok('room' in pauseGame(db, room.id, () => 2200));
    assert.equal((submitAnswer(db, room.id, answer) as any).status, 409);
    assert.ok('room' in resumeGame(db, room.id, () => 3000));
    db.close(); db = initializeDatabase(path);
    const reconnect = (await request(createApp(db)).post(`${root}/reconnect`).send({ token: ids[0].token }).expect(200)).body;
    assert.deepEqual(reconnect.game.submission, accepted);
    assert.deepEqual(getGameSnapshot(db, room.id), frozen);
    assert.equal(autoPauseForDisconnectedPlayer(db, room.id, ids[1].player.id, () => 4000), true);
    assert.ok('room' in continueWithoutPlayer(db, room.id, () => 5000));
    assert.deepEqual((getPlayerGame(db, room.id, 'en', ids[1].player.id) as any).result, { outcome: 'unanswered', points: 0 });
    assert.equal(completeQuestion(db, room.id, () => 6000), false);
    for (const q of frozen.rounds[0].questions.slice(1)) {
      const api = request(createApp(db)); await api.post(`${root}/next`).expect(200); startQuestion(db, room.id, 10000);
      for (const identity of ids) assert.ok('submission' in submitAnswer(db, room.id, { token: identity.token, questionId: q.id, optionId: q.options.find(o => o.isCorrect)!.id }, () => 11000));
    }
    const totals = db.prepare('SELECT player_id, SUM(awarded_points) total FROM question_scores GROUP BY player_id').all();
    assert.equal(totals.find(r => r.player_id === ids[0].player.id)!.total, 15); assert.equal(totals.find(r => r.player_id === ids[1].player.id)!.total, 10);
  } finally { mock.restoreAll(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('legacy scalar answers migrate without changing submissions, timestamps, snapshots or retry semantics', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'answer-set-upgrade-')), path = join(directory, 'quiz.sqlite');
  let db = initializeDatabase(path);
  try {
    const f = fixture(db, [true, false]); updateQuestion(db, f.round.id, f.q.id, { ...fields, type: 'single_choice' });
    const room = (await f.api.post(`/api/quizzes/${f.quiz.id}/rooms`).expect(201)).body;
    const identity = (await f.api.post(`/api/rooms/code/${room.code}/players`).send({ name: 'Alice', language: 'en' }).expect(201)).body;
    await f.api.post(`/api/rooms/${room.id}/start`).expect(200); await f.api.post(`/api/rooms/${room.id}/start-round`).expect(200); startQuestion(db, room.id, 1000);
    const input = { token: identity.token, questionId: f.q.id, optionId: f.options[0].id };
    const accepted = submitAnswer(db, room.id, input, () => 2000);
    const snapshot = getGameSnapshot(db, room.id), before = db.prepare('SELECT * FROM player_answers').get()!;
    const source = (await import('node:fs')).readFileSync(new URL('./db.ts', import.meta.url), 'utf8');
    const legacy = source.split('version: 9,')[1].split('sql: `')[1].split('`')[0].replace('CREATE TABLE player_answers', 'CREATE TABLE legacy_answers');
    db.exec(`${legacy}; INSERT INTO legacy_answers SELECT session_id, player_id, question_id, json_extract(answer_json, '$.optionIds[0]'), submitted_at FROM player_answers; DROP TABLE player_answers; ALTER TABLE legacy_answers RENAME TO player_answers; DELETE FROM schema_migrations WHERE version IN (17, 19)`);
    db.close(); db = initializeDatabase(path);
    assert.deepEqual(db.prepare('SELECT * FROM player_answers').get(), before);
    assert.deepEqual(getGameSnapshot(db, room.id), snapshot);
    assert.deepEqual(submitAnswer(db, room.id, { ...input, optionId: f.options[1].id }, () => 999999), { ...(accepted as any), inserted: false });
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
