import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import request from 'supertest';
import { createApp } from './app.js';
import { initializeDatabase } from './db.js';
import { createQuiz } from './quizzes.js';
import { createRound } from './rounds.js';
import { createQuestion, createOption } from './questions.js';

function readyQuiz(db: ReturnType<typeof initializeDatabase>) {
  const quiz = createQuiz(db);
  const round = createRound(db, quiz.id);
  const question = createQuestion(db, round.id);
  db.prepare('UPDATE questions SET text_ru = ?, text_en = ? WHERE id = ?').run('Вопрос', 'Question', question.id);
  for (const correct of [1, 0]) {
    const option = createOption(db, question.id);
    db.prepare('UPDATE answer_options SET text_ru = ?, text_en = ?, is_correct = ? WHERE id = ?').run('Ответ', 'Answer', correct, option.id);
  }
  return quiz;
}

test('room API gates readiness and persists the Lobby lifecycle without freezing quiz content', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'quiz-rooms-'));
  const path = join(directory, 'quiz.sqlite');
  let db = initializeDatabase(path);
  let app = request(createApp(db));
  try {
    assert.equal((await app.post('/api/quizzes/missing/rooms')).status, 404);
    const draft = createQuiz(db);
    const rejected = await app.post(`/api/quizzes/${draft.id}/rooms`);
    assert.equal(rejected.status, 409);
    assert.deepEqual(rejected.body.validation, (await app.get(`/api/quizzes/${draft.id}/validation`)).body);
    const quiz = readyQuiz(db);
    const result = await app.post(`/api/quizzes/${quiz.id}/rooms`);
    assert.equal(result.status, 201);
    const room = result.body;
    assert.equal(room.quizId, quiz.id);
    assert.equal(room.quizTitle, quiz.title);
    assert.equal(room.state, 'LOBBY');
    assert.equal(room.closedAt, null);
    assert.ok(Number.isFinite(Date.parse(room.createdAt)));
    assert.match(room.code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/);
    const another = await app.post(`/api/quizzes/${quiz.id}/rooms`);
    assert.equal(another.status, 201);
    assert.notEqual(another.body.code, room.code);
    assert.equal((await app.get(`/api/rooms/code/${room.code.toLowerCase()}`)).body.id, room.id);
    assert.equal((await app.get('/api/rooms/code/ZZZZZ!')).status, 404);
    assert.equal((await app.get('/api/rooms/missing')).status, 404);
    assert.deepEqual(Object.keys(room).sort(), ['id', 'code', 'quizId', 'quizTitle', 'themeId', 'state', 'createdAt', 'closedAt'].sort());
    db.prepare('UPDATE quizzes SET title = ? WHERE id = ?').run('Edited in Lobby', quiz.id);
    db.prepare('UPDATE questions SET text_en = ?').run('Edited question');
    assert.equal(db.prepare('SELECT count(*) AS n FROM questions').get()?.n, 1);
    db.close();
    db = initializeDatabase(path);
    app = request(createApp(db));
    assert.deepEqual((await app.get(`/api/rooms/${room.id}`)).body, { ...room, quizTitle: 'Edited in Lobby' });
    const closed = await app.post(`/api/rooms/${room.id}/close`);
    assert.equal(closed.status, 200);
    assert.ok(Number.isFinite(Date.parse(closed.body.closedAt)));
    assert.deepEqual((await app.post(`/api/rooms/${room.id}/close`)).body, closed.body);
    assert.equal((await app.get(`/api/rooms/code/${room.code}`)).status, 404);
    assert.equal((await app.post('/api/rooms/missing/close')).status, 404);
    assert.equal((await app.get(`/api/rooms/code/${another.body.code}`)).status, 200);
    await app.delete(`/api/quizzes/${quiz.id}`);
    assert.equal((await app.get(`/api/rooms/code/${another.body.code}`)).status, 404);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('allocation retries collisions, enforces uniqueness, releases codes, and bounds retries', async () => {
  const { createRoom, closeRoom, getRoomByCode } = await import('./rooms.js');
  const db = initializeDatabase(':memory:');
  try {
    const quiz = readyQuiz(db);
    const first = createRoom(db, quiz.id, () => 'ABCDE');
    assert.ok('room' in first);
    let calls = 0;
    const second = createRoom(db, quiz.id, () => ++calls === 1 ? 'ABCDE' : 'FGHJK');
    assert.ok('room' in second);
    assert.equal(calls, 2);
    assert.equal(second.room.code, 'FGHJK');
    assert.throws(() => db.prepare('UPDATE game_sessions SET code = ? WHERE id = ?').run('ABCDE', second.room.id), /UNIQUE/);
    const exhausted = createRoom(db, quiz.id, () => 'ABCDE');
    assert.ok('status' in exhausted);
    assert.equal(exhausted.status, 503);
    db.exec('BEGIN');
    db.exec('ROLLBACK');
    closeRoom(db, first.room.id);
    const reused = createRoom(db, quiz.id, () => 'ABCDE');
    assert.ok('room' in reused);
    assert.notEqual(reused.room.id, first.room.id);
    assert.equal(getRoomByCode(db, 'ABCDE')?.id, reused.room.id);
  } finally { db.close(); }
});
