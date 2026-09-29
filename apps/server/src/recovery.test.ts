import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import request from 'supertest';
import { io as connect, type Socket } from 'socket.io-client';
import { initializeDatabase } from './db.js';
import { createApp } from './app.js';
import { createQuizServer } from './realtime.js';
import { createQuiz } from './quizzes.js';
import { createRound } from './rounds.js';
import { createQuestion, createOption } from './questions.js';
import { createDeadlineManager } from './deadlines.js';
import { autoPauseForDisconnectedPlayer } from './pause.js';

async function fixture(db: ReturnType<typeof initializeDatabase>) {
  const quiz = createQuiz(db);
  const round = createRound(db, quiz.id);
  db.prepare('UPDATE rounds SET show_leaderboard_after = 1 WHERE id = ?').run(round.id);
  const questions = [0, 1].map(() => {
    const question = createQuestion(db, round.id);
    db.prepare("UPDATE questions SET text_ru = 'Вопрос', text_en = 'Question' WHERE id = ?").run(question.id);
    const options = [1, 0].map(correct => {
      const option = createOption(db, question.id);
      db.prepare("UPDATE answer_options SET text_ru = 'Ответ', text_en = 'Answer', is_correct = ? WHERE id = ?").run(correct, option.id);
      return option;
    });
    return { question, options };
  });
  const api = request(createApp(db));
  const room = (await api.post(`/api/quizzes/${quiz.id}/rooms`).expect(201)).body;
  const identities = [];
  for (const name of ['Alice', 'Bob']) identities.push((await api.post(`/api/rooms/code/${room.code}/players`).send({ name, language: 'en' }).expect(201)).body);
  return { room, identities, questions, root: `/api/rooms/${room.id}` };
}

// HTTP and socket projections sample wall-clock time independently. Keep every
// durable field in the comparison, including the frozen remainder while paused.
const stable = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) => {
  if (key !== 'timer' || !item) return item;
  const { serverNow: _now, remainingMs: _remaining, ...durable } = item;
  return durable;
}));

test('fresh Host/Screen subscriptions and Player identity restore every major game state', async () => {
  const db = initializeDatabase(':memory:');
  const f = await fixture(db);
  const { server, io } = createQuizServer(db);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const api = request(server);
  const sockets: Socket[] = [];
  async function open(audience: string, token?: string) {
    const socket = connect(`http://127.0.0.1:${(server.address() as { port: number }).port}`, { transports: ['websocket'], forceNew: true });
    sockets.push(socket); await once(socket, 'connect');
    const snapshot = once(socket, 'lobby:state', { signal: AbortSignal.timeout(3000) });
    socket.emit('lobby:subscribe', { roomId: f.room.id, audience, token });
    return { socket, state: (await snapshot)[0] };
  }
  async function disconnect(socket: Socket) {
    const done = once(io.sockets.sockets.get(socket.id!)!, 'disconnect');
    socket.disconnect(); await done;
  }
  async function restore(state: string, closed = false) {
    const before = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(f.room.id);
    const answers = db.prepare('SELECT * FROM player_answers').all();
    for (const audience of ['host', 'screen']) {
      const http = (await api.get(`${f.root}/game/${audience}`).expect(200)).body;
      const fresh = await open(audience);
      assert.deepEqual(stable(fresh.state), stable(http));
      assert.equal(http.room.state, state);
      assert.equal(Boolean(http.room.closedAt), closed);
      assert.equal(http.game?.state ?? null, closed || state === 'LOBBY' ? null : state);
      if (state === 'PAUSED') assert.equal(http.game.timer, undefined);
      if (closed) assert.equal(http.game, null);
      await disconnect(fresh.socket);
    }
    for (const identity of f.identities) {
      const player = (await api.post(`${f.root}/reconnect`).send({ token: identity.token }).expect(200)).body;
      assert.deepEqual(player.player, identity.player);
      assert.equal(player.active, !closed);
      assert.equal(player.room.state, state);
      if (closed) assert.equal(player.game, null);
    }
    assert.equal(db.prepare('SELECT count(*) n FROM session_players').get()!.n, 2);
    assert.deepEqual(db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(f.room.id), before);
    assert.deepEqual(db.prepare('SELECT * FROM player_answers').all(), answers);
  }
  async function submit(question: number, player: number) {
    const q = f.questions[question];
    await api.post(`${f.root}/answers`).send({ token: f.identities[player].token, questionId: q.question.id, optionId: q.options[0].id }).expect(200);
  }
  try {
    await restore('LOBBY');
    await api.post(`${f.root}/start`).expect(200); await restore('ROUND_INTRO');
    await api.post(`${f.root}/start-round`).expect(200); await restore('QUESTION');
    await api.post(`${f.root}/start-question`).expect(200); await restore('ANSWERING');
    const deadline = db.prepare('SELECT answer_deadline_at FROM game_sessions').get()!.answer_deadline_at;
    await submit(0, 0); await restore('ANSWERING');
    const accepted = (await api.post(`${f.root}/reconnect`).send({ token: f.identities[0].token })).body.game;
    assert.deepEqual(accepted.submission, { submitted: true, optionId: f.questions[0].options[0].id });
    assert.equal(accepted.timer.deadlineAt, deadline);
    assert.equal(accepted.correctOptionId, undefined);
    const aliceReload = (await open('player', f.identities[0].token)).socket;
    await disconnect(aliceReload);
    assert.equal(db.prepare('SELECT state FROM game_sessions').get()!.state, 'ANSWERING');
    await api.post(`${f.root}/pause`).expect(200); await restore('PAUSED');
    await api.post(`${f.root}/resume`).expect(200);
    let bob = (await open('player', f.identities[1].token)).socket;
    await disconnect(bob); await restore('PAUSED');
    let host = (await api.get(`${f.root}/game/host`)).body;
    assert.equal(host.game.disconnectedPlayer.present, false);
    bob = (await open('player', f.identities[1].token)).socket;
    await restore('PAUSED');
    host = (await api.get(`${f.root}/game/host`)).body;
    assert.equal(host.game.disconnectedPlayer.present, true);
    await api.post(`${f.root}/wait-for-player`).expect(200);
    await disconnect(bob); await api.post(`${f.root}/continue-without-player`).expect(200);
    await restore('ANSWER_REVEAL');
    const result = (await api.post(`${f.root}/reconnect`).send({ token: f.identities[1].token })).body.game;
    assert.deepEqual(result.result, { outcome: 'unanswered', points: 0 });
    assert.equal(result.excluded, true);
    await api.post(`${f.root}/next`).expect(200); await api.post(`${f.root}/start-question`).expect(200);
    const next = (await api.post(`${f.root}/reconnect`).send({ token: f.identities[1].token })).body.game;
    assert.equal(next.excluded, false); assert.equal(next.options.length, 2);
    await open('player', f.identities[1].token);
    const alice = (await open('player', f.identities[0].token)).socket;
    await disconnect(alice); await api.post(`${f.root}/continue-without-player`).expect(200);
    await restore('ANSWERING');
    const excluded = (await api.post(`${f.root}/reconnect`).send({ token: f.identities[0].token })).body.game;
    assert.equal(excluded.excluded, true); assert.deepEqual(excluded.options, []);
    const excludedReload = (await open('player', f.identities[0].token)).socket;
    assert.deepEqual((await api.get(`${f.root}/game/host`)).body.game.answers, { answered: 0, expected: 1 });
    await disconnect(excludedReload);
    assert.equal(db.prepare('SELECT state FROM game_sessions').get()!.state, 'ANSWERING');
    await submit(1, 1); await restore('ANSWER_REVEAL');
    await api.post(`${f.root}/next`).expect(200); await restore('ROUND_END');
    await api.post(`${f.root}/show-leaderboard`).expect(200); await restore('LEADERBOARD');
    await api.post(`${f.root}/final-results`).expect(200); await restore('FINAL_RESULTS');
    await api.post(`${f.root}/show-winner`).expect(200); await restore('WINNER_SCREEN');
    await api.post(`${f.root}/close`).expect(200); await restore('WINNER_SCREEN', true);
  } finally { sockets.forEach(socket => socket.disconnect()); await new Promise<void>(resolve => io.close(() => resolve())); db.close(); }
});

for (const state of ['ANSWERING', 'manual', 'player_disconnect', 'ANSWER_REVEAL', 'LEADERBOARD', 'FINAL_RESULTS']) {
  test(`Close wins from ${state}, rejects commands, and stale deadline cannot score`, async () => {
    const db = initializeDatabase(':memory:');
    const f = await fixture(db);
    const jobs: { callback: () => void; cancelled: boolean }[] = [];
    let now = Date.now();
    let changes = 0;
    const manager = createDeadlineManager(db, () => changes++, { clock: () => now, schedule(callback) {
      const job = { callback, cancelled: false }; jobs.push(job); return () => { job.cancelled = true; };
    } });
    const api = request(createApp(db, roomId => manager.sync(roomId), () => true));
    try {
      await api.post(`${f.root}/start`).expect(200); await api.post(`${f.root}/start-round`).expect(200);
      await api.post(`${f.root}/start-question`).expect(200);
      assert.equal(jobs.length, 1);
      if (state === 'manual') await api.post(`${f.root}/pause`).expect(200);
      if (state === 'player_disconnect') autoPauseForDisconnectedPlayer(db, f.room.id, f.identities[0].player.id);
      if (['ANSWER_REVEAL', 'LEADERBOARD', 'FINAL_RESULTS'].includes(state)) {
        for (const identity of f.identities) await api.post(`${f.root}/answers`).send({ token: identity.token, questionId: f.questions[0].question.id, optionId: f.questions[0].options[0].id }).expect(200);
        if (state !== 'ANSWER_REVEAL') {
          await api.post(`${f.root}/next`).expect(200); await api.post(`${f.root}/start-question`).expect(200);
          for (const identity of f.identities) await api.post(`${f.root}/answers`).send({ token: identity.token, questionId: f.questions[1].question.id, optionId: f.questions[1].options[0].id }).expect(200);
          await api.post(`${f.root}/next`).expect(200); await api.post(`${f.root}/show-leaderboard`).expect(200);
          if (state === 'FINAL_RESULTS') await api.post(`${f.root}/final-results`).expect(200);
        }
      }
      const closed = (await api.post(`${f.root}/close`).expect(200)).body;
      assert.ok(closed.closedAt); assert.ok(jobs.every(job => job.cancelled));
      const before = db.prepare('SELECT * FROM game_sessions').get();
      const scores = db.prepare('SELECT * FROM question_scores').all();
      now += 3600000;
      for (const job of jobs) job.callback();
      assert.equal(changes, 0);
      for (const action of ['start', 'start-round', 'start-question', 'pause', 'resume', 'wait-for-player', 'continue-without-player', 'next', 'show-leaderboard', 'next-round', 'final-results', 'show-winner']) await api.post(`${f.root}/${action}`).expect(409);
      await api.post(`${f.root}/answers`).send({ token: f.identities[0].token, questionId: f.questions[0].question.id, optionId: f.questions[0].options[0].id }).expect(409);
      assert.deepEqual((await api.post(`${f.root}/close`).expect(200)).body, closed);
      for (const audience of ['host', 'screen']) assert.equal((await api.get(`${f.root}/game/${audience}`)).body.game, null);
      const player = (await api.post(`${f.root}/reconnect`).send({ token: f.identities[0].token }).expect(200)).body;
      assert.equal(player.active, false); assert.equal(player.game, null); assert.deepEqual(player.player, f.identities[0].player);
      assert.deepEqual(db.prepare('SELECT * FROM game_sessions').get(), before);
      assert.deepEqual(db.prepare('SELECT * FROM question_scores').all(), scores);
    } finally { manager.stop(); db.close(); }
  });
}
