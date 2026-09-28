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

for (const isTest of [true, false]) test(`${isTest ? 'test' : 'real'} session keeps normal gameplay, frozen content/media and restart identity`, async () => {
  const f = fixture();
  try {
    const image = readFileSync(new URL('./fixtures/media/sample.jpg', import.meta.url));
    const media = (await f.api.post(`/api/quizzes/${f.quiz.id}/media`).attach('file', image, 'sample.jpg').expect(201)).body;
    f.db.prepare('UPDATE questions SET media_json = ? WHERE id = ?').run(JSON.stringify([{ mediaId: media.id, playBeforeTimer: false }]), f.question.id);
    const room = (await f.api.post(`/api/quizzes/${f.quiz.id}/${isTest ? 'test-games' : 'rooms'}`).expect(201)).body;
    assert.equal(room.isTest, isTest);
    assert.equal(f.db.prepare('SELECT is_test FROM game_sessions WHERE id = ?').get(room.id)!.is_test, Number(isTest));
    assert.equal((await f.api.get(`/api/rooms/code/${room.code.toLowerCase()}`).expect(200)).body.isTest, isTest);
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
      assert.equal(state.room.isTest, isTest);
      assert.equal(state.game.textEn, 'Question');
      assert.ok(state.game.timer.remainingMs > 0);
      if (audience === 'screen') assert.doesNotMatch(JSON.stringify(state), /isCorrect/);
    }
    await f.api.post(`/api/rooms/${room.id}/pause`).expect(200);
    f.restart();
    const runtime = createQuizServer(f.db);
    runtime.deadlines.stop(); await runtime.io.close();
    const restored = (await f.api.post(`/api/rooms/${room.id}/reconnect`).send({ token: identity.token }).expect(200)).body;
    assert.equal(restored.room.isTest, isTest); assert.equal(restored.room.state, 'PAUSED');
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
    assert.equal(winner.room.isTest, isTest);
  } finally { f.close(); }
});

test('Test Game creation and Start both enforce readiness', async () => {
  const f = fixture();
  try {
    await f.api.post('/api/quizzes/missing/test-games').expect(404);
    const draft = createQuiz(f.db);
    await f.api.post(`/api/quizzes/${draft.id}/test-games`).expect(409);
    const room = (await f.api.post(`/api/quizzes/${f.quiz.id}/test-games`).expect(201)).body;
    await f.api.post(`/api/rooms/code/${room.code}/players`).send({ name: 'Alice', language: 'en' }).expect(201);
    f.db.exec("UPDATE questions SET text_en = ''");
    await f.api.post(`/api/rooms/${room.id}/start`).expect(409);
    assert.equal((await f.api.get(`/api/rooms/${room.id}`)).body.state, 'LOBBY');
  } finally { f.close(); }
});

test('startup cleans only tests closed at least seven days ago, including frozen media and dependent records', async () => {
  const f = fixture();
  try {
    const image = readFileSync(new URL('./fixtures/media/sample.jpg', import.meta.url));
    const media = (await f.api.post(`/api/quizzes/${f.quiz.id}/media`).attach('file', image, 'sample.jpg')).body;
    f.db.prepare('UPDATE questions SET media_json = ?').run(JSON.stringify([{ mediaId: media.id, playBeforeTimer: false }]));
    const now = Date.now(), cutoff = now - 7 * 86400000;
    const sessions = [];
    for (const kind of ['old-test', 'boundary-test', 'recent-test', 'open-test', 'open-lobby', 'old-real', 'old-lobby']) {
      const room = (await f.api.post(`/api/quizzes/${f.quiz.id}/${kind === 'old-real' ? 'rooms' : 'test-games'}`).expect(201)).body;
      const identity = (await f.api.post(`/api/rooms/code/${room.code}/players`).send({ name: 'Alice', language: 'en' })).body;
      if (!kind.endsWith('lobby')) {
        for (const action of ['start', 'start-round', 'start-question']) await f.api.post(`/api/rooms/${room.id}/${action}`).expect(200);
        if (kind !== 'open-test') await f.api.post(`/api/rooms/${room.id}/answers`).send({ token: identity.token, questionId: f.question.id, optionId: f.options[0].id }).expect(200);
      }
      if (!kind.startsWith('open-')) {
        await f.api.post(`/api/rooms/${room.id}/close`).expect(200);
        f.db.prepare('UPDATE game_sessions SET closed_at = ? WHERE id = ?').run(new Date(cutoff + (kind === 'recent-test' ? 60000 : kind === 'boundary-test' ? 0 : -1)).toISOString(), room.id);
      }
      // Creation age cannot make an open/recently closed test eligible.
      f.db.prepare('UPDATE game_sessions SET created_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', room.id);
      sessions.push({ kind, room });
    }
    f.restart();
    const { cleanupTestGames } = await import('./test-games.js');
    assert.equal(cleanupTestGames(f.db, now), 3);
    for (const { kind, room } of sessions) {
      const removed = ['old-test', 'boundary-test', 'old-lobby'].includes(kind);
      await f.api.get(`/api/rooms/${room.id}`).expect(removed ? 404 : 200);
      assert.equal(existsSync(mediaFile(f.db, room.id, media.id, true)), !removed && !kind.endsWith('lobby'));
      if (removed) for (const table of ['session_players', 'player_answers', 'question_scores', 'media_playback']) {
        assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE session_id = ?`).get(room.id)!.n, 0);
      }
    }
    assert.ok(existsSync(mediaFile(f.db, f.quiz.id, media.id)));
    assert.equal(cleanupTestGames(f.db, now), 0);
    // Check the actual runtime startup boundary as well.
    const recent = sessions.find(s => s.kind === 'recent-test')!.room;
    f.db.prepare('UPDATE game_sessions SET closed_at = ? WHERE id = ?').run(new Date(cutoff - 1).toISOString(), recent.id);
    const runtime = createQuizServer(f.db); runtime.deadlines.stop(); await runtime.io.close();
    await f.api.get(`/api/rooms/${recent.id}`).expect(404);
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { f.close(); }
});

test('Phase 8A upgrade defaults existing sessions to real and constrains the durable marker', async () => {
  const f = fixture();
  try {
    const room = (await f.api.post(`/api/quizzes/${f.quiz.id}/rooms`).expect(201)).body;
    const before = f.db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(room.id)!;
    f.db.exec('ALTER TABLE game_sessions DROP COLUMN is_test; DELETE FROM schema_migrations WHERE version = 24');
    f.restart();
    assert.deepEqual(f.db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(room.id), before);
    assert.equal((await f.api.get(`/api/rooms/${room.id}`)).body.isTest, false);
    for (const value of ['NULL', '2', '-1']) assert.throws(() => f.db.exec(`UPDATE game_sessions SET is_test = ${value}`), /constraint/i);
  } finally { f.close(); }
});

test('Test Game reuses pre-timer media, disconnect Pause/Wait, realtime reconnect and authoritative timeout', async () => {
  const { once } = await import('node:events');
  const { io: connect } = await import('socket.io-client');
  const { completeQuestion } = await import('./reveal.js');
  const f = fixture();
  const audio = readFileSync(new URL('./fixtures/media/sample.mp3', import.meta.url));
  const media = (await f.api.post(`/api/quizzes/${f.quiz.id}/media`).attach('file', audio, 'sample.mp3')).body;
  f.db.prepare('UPDATE questions SET media_json = ?').run(JSON.stringify([{ mediaId: media.id, playBeforeTimer: true }]));
  const room = (await f.api.post(`/api/quizzes/${f.quiz.id}/test-games`).expect(201)).body;
  const identity = (await f.api.post(`/api/rooms/code/${room.code}/players`).send({ name: 'Alice', language: 'en' })).body;
  const runtime = createQuizServer(f.db);
  runtime.server.listen(0, '127.0.0.1'); await once(runtime.server, 'listening');
  const url = `http://127.0.0.1:${(runtime.server.address() as { port: number }).port}`;
  const player = connect(url, { transports: ['websocket'], autoConnect: false });
  const screen = connect(url, { transports: ['websocket'], autoConnect: false });
  const api = request(runtime.server);
  async function subscribe(socket: typeof player, audience: 'player' | 'screen') {
    const update = once(socket, 'lobby:state');
    socket.emit('lobby:subscribe', { roomId: room.id, audience, ...(audience === 'player' ? { token: identity.token } : {}) });
    const [state] = await update;
    assert.equal(state.room.isTest, true);
    return state;
  }
  try {
    player.connect(); screen.connect();
    await Promise.all([once(player, 'connect'), once(screen, 'connect')]);
    await subscribe(player, 'player'); await subscribe(screen, 'screen');
    for (const action of ['start', 'start-round', 'start-question']) await api.post(`/api/rooms/${room.id}/${action}`).expect(200);
    const preTimer = (await api.get(`/api/rooms/${room.id}/game/screen`)).body.game;
    assert.equal(preTimer.state, 'QUESTION'); assert.equal(preTimer.preTimer.mediaId, media.id);
    await api.post(`/api/rooms/${room.id}/answers`).send({ token: identity.token, questionId: f.question.id, optionId: f.options[0].id }).expect(409);
    const accepted = await new Promise<{ accepted: boolean }>(resolve => screen.emit('media:ended', {
      roomId: room.id, questionId: f.question.id, mediaId: media.id, revision: preTimer.media[0].playback.revision, duration: 1,
    }, resolve));
    assert.equal(accepted.accepted, true);
    const pauseUpdate = once(screen, 'lobby:state'); player.disconnect();
    assert.equal((await pauseUpdate)[0].room.state, 'PAUSED');
    await api.post(`/api/rooms/${room.id}/wait-for-player`).expect(409);
    const connected = once(player, 'connect'); player.connect(); await connected;
    const reconnected = await subscribe(player, 'player'); assert.equal(reconnected.room.state, 'PAUSED');
    await api.post(`/api/rooms/${room.id}/wait-for-player`).expect(200);
    const deadline = f.db.prepare('SELECT answer_deadline_at FROM game_sessions WHERE id = ?').get(room.id)!.answer_deadline_at;
    await api.post(`/api/rooms/${room.id}/media/${media.id}/restart`).send({ questionId: f.question.id }).expect(200);
    assert.equal(f.db.prepare('SELECT answer_deadline_at FROM game_sessions WHERE id = ?').get(room.id)!.answer_deadline_at, deadline);
    assert.equal(completeQuestion(f.db, room.id, () => Date.parse(String(deadline))), true);
    const reveal = (await api.post(`/api/rooms/${room.id}/reconnect`).send({ token: identity.token }).expect(200)).body;
    assert.deepEqual(reveal.game.result, { outcome: 'unanswered', points: 0 });
    assert.equal(reveal.room.isTest, true);
  } finally {
    player.disconnect(); screen.disconnect(); runtime.deadlines.stop();
    await new Promise<void>(resolve => runtime.io.close(() => resolve())); f.close();
  }
});
