import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { initializeDatabase } from './db.js';
import { createApp } from './app.js';
import { createQuizServer } from './realtime.js';
import { createQuiz } from './quizzes.js';
import { createRound } from './rounds.js';
import { createQuestion, createOption } from './questions.js';
import { mediaFile } from './media.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'quiz-test-game-'));
  const path = join(directory, 'quiz.sqlite');
  let db = initializeDatabase(path);
  const quiz = createQuiz(db), round = createRound(db, quiz.id), question = createQuestion(db, round.id);
  db.prepare("UPDATE questions SET text_ru = 'Вопрос', text_en = 'Question', points = 3 WHERE id = ?").run(question.id);
  const options = [true, false].map(correct => {
    const option = createOption(db, question.id);
    db.prepare("UPDATE answer_options SET text_ru = 'Ответ', text_en = 'Answer', is_correct = ? WHERE id = ?").run(Number(correct), option.id);
    return option;
  });
  return {
    directory, quiz, question, options,
    get db() { return db; }, get api() { return request(createApp(db)); },
    restart() { db.close(); db = initializeDatabase(path); },
    close() { db.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test('real session keeps normal gameplay, frozen content/media and restart identity', async () => {
  const f = fixture();
  try {
    const image = readFileSync(new URL('./fixtures/media/sample.jpg', import.meta.url));
    const media = (await f.api.post(`/api/quizzes/${f.quiz.id}/media`).attach('file', image, 'sample.jpg').expect(201)).body;
    f.db.prepare('UPDATE questions SET media_json = ? WHERE id = ?').run(JSON.stringify([{ mediaId: media.id, playBeforeTimer: false }]), f.question.id);
    const room = (await f.api.post(`/api/quizzes/${f.quiz.id}/rooms`).expect(201)).body;
    assert.equal(f.db.prepare('SELECT is_test FROM game_sessions WHERE id = ?').get(room.id)!.is_test, 0);
    assert.equal((await f.api.get(`/api/rooms/code/${room.code.toLowerCase()}`).expect(200)).body.isTest, undefined);
    await f.api.post(`/api/rooms/${room.id}/start`).expect(409);
    const identity = (await f.api.post(`/api/rooms/code/${room.code}/players`).send({ name: 'Alice', language: 'en' }).expect(201)).body;
    await f.api.post(`/api/rooms/${room.id}/start`).expect(200);
    const frozen = f.db.prepare('SELECT snapshot_json FROM game_sessions WHERE id = ?').get(room.id)!.snapshot_json;
    f.db.exec("UPDATE questions SET points = 99, text_en = 'Changed'; UPDATE answer_options SET is_correct = 0; UPDATE quizzes SET title = 'Changed'");
    await f.api.delete(`/api/quizzes/${f.quiz.id}`).expect(204);
    await f.api.post(`/api/rooms/code/${room.code}/players`).send({ name: 'Bob', language: 'ru' }).expect(409);
    await f.api.post(`/api/rooms/${room.id}/start-round`).expect(200);
    await f.api.post(`/api/rooms/${room.id}/start-question`).expect(200);
    for (const audience of ['host', 'screen']) {
      const state = (await f.api.get(`/api/rooms/${room.id}/game/${audience}`).expect(200)).body;
      assert.equal(state.room.isTest, undefined);
      assert.equal(state.game.textEn, 'Question');
      assert.ok(state.game.timer.remainingMs > 0);
      if (audience === 'screen') assert.doesNotMatch(JSON.stringify(state), /isCorrect/);
    }
    await f.api.post(`/api/rooms/${room.id}/pause`).expect(200);
    f.restart();
    const runtime = createQuizServer(f.db);
    runtime.deadlines.stop(); await runtime.io.close();
    const restored = (await f.api.post(`/api/rooms/${room.id}/reconnect`).send({ token: identity.token }).expect(200)).body;
    assert.equal(restored.room.isTest, undefined); assert.equal(restored.room.state, 'PAUSED');
    assert.equal(f.db.prepare('SELECT snapshot_json FROM game_sessions WHERE id = ?').get(room.id)!.snapshot_json, frozen);
    assert.deepEqual(readFileSync(mediaFile(f.db, room.id, media.id, true)), image);
    await f.api.get(`/api/rooms/${room.id}/media/${media.id}/content`).expect(200);
    await f.api.post(`/api/rooms/${room.id}/resume`).expect(200);
    const answering = (await f.api.post(`/api/rooms/${room.id}/reconnect`).send({ token: identity.token }).expect(200)).body;
    assert.equal(answering.game.text, 'Question');
    assert.doesNotMatch(JSON.stringify(answering), /isCorrect|correctOption|mediaUrl/);
    const answer = { token: identity.token, questionId: f.question.id, optionId: f.options[0].id };
    await f.api.post(`/api/rooms/${room.id}/answers`).send(answer).expect(200);
    f.restart();
    const reveal = (await f.api.post(`/api/rooms/${room.id}/reconnect`).send({ token: identity.token }).expect(200)).body;
    assert.deepEqual(reveal.game.result, { outcome: 'correct', points: 3 });
    assert.equal(reveal.game.submission.optionId, f.options[0].id);
    await f.api.post(`/api/rooms/${room.id}/answers`).send({ ...answer, optionId: f.options[1].id }).expect(200);
    for (const action of ['next', 'final-results', 'show-winner']) await f.api.post(`/api/rooms/${room.id}/${action}`).expect(200);
    const winner = (await f.api.get(`/api/rooms/${room.id}/game/host`)).body;
    assert.equal(winner.game.leaderboard[0].totalPoints, 3);
    assert.equal(winner.room.isTest, undefined);
  } finally { f.close(); }
});
