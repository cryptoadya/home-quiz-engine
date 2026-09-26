import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { initializeDatabase } from './db.js';
import { createQuiz } from './quizzes.js';
import { createQuizServer } from './realtime.js';

const nextState = (socket: Socket) => new Promise<any>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('No lobby snapshot')), 3000);
  socket.once('lobby:state', state => { clearTimeout(timeout); resolve(state); });
});

test('shared HTTP/socket server validates subscriptions, broadcasts safe state and resyncs from SQLite', async () => {
  const db = initializeDatabase(':memory:');
  const quiz = createQuiz(db);
  for (const [id, code] of [['room', 'ABCDE'], ['other', 'FGHJK']]) {
    db.prepare("INSERT INTO game_sessions (id, code, quiz_id, state, created_at) VALUES (?, ?, ?, 'LOBBY', 'now')").run(id, code, quiz.id);
  }
  const { server, io } = createQuizServer(db);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const host = connect(url, { transports: ['websocket'], forceNew: true });
  const player = connect(url, { transports: ['websocket'], forceNew: true });
  const invalid = connect(url, { transports: ['websocket'], forceNew: true });
  try {
    await Promise.all([once(host, 'connect'), once(player, 'connect'), once(invalid, 'connect')]);
    assert.equal((await request(server).get('/api/health')).status, 200);
    for (const roomId of ['missing', null, {}, '']) {
      const error = once(invalid, 'lobby:error');
      invalid.emit('lobby:subscribe', { roomId, audience: 'host' });
      await error;
      assert.equal(io.sockets.sockets.get(invalid.id!)!.rooms.size, 1);
    }
    for (const audience of [null, ['player'], { toString: null }, 'admin']) {
      const error = once(invalid, 'lobby:error');
      invalid.emit('lobby:subscribe', { roomId: 'room', audience });
      await error;
      assert.equal(io.sockets.sockets.get(invalid.id!)!.rooms.size, 1);
    }
    let state = nextState(host);
    host.emit('lobby:subscribe', { roomId: 'room', audience: 'host' });
    assert.deepEqual((await state).players, []);
    state = nextState(player);
    player.emit('lobby:subscribe', { roomId: 'room', audience: 'player' });
    assert.equal((await state).players, undefined);
    for (const [name, language, count] of [['Alex', 'ru', 1], ['Jane', 'en', 2]] as const) {
      state = nextState(host);
      const playerState = nextState(player);
      const joined = await request(server).post('/api/rooms/code/ABCDE/players').send({ name, language });
      assert.equal(joined.status, 201);
      const payload = await state;
      assert.equal(payload.players.length, count);
      assert.deepEqual(Object.keys(payload.players[0]).sort(), ['id', 'joinedAt', 'language', 'name']);
      assert.ok(!JSON.stringify(payload).includes(joined.body.token));
      assert.equal((await playerState).players, undefined);
    }
    assert.equal((await request(server).get('/api/rooms/room/lobby')).body.players.length, 2);
    host.disconnect();
    await request(server).post('/api/rooms/room/close');
    state = nextState(host);
    host.connect();
    await once(host, 'connect');
    host.emit('lobby:subscribe', { roomId: 'room', audience: 'host' });
    const restored = await state;
    assert.ok(restored.room.closedAt);
    assert.equal(restored.players.length, 2);
    // Repeated close also supplies the current durable snapshot to connected clients.
    state = nextState(host);
    const closedPlayer = nextState(player);
    await request(server).post('/api/rooms/room/close');
    assert.ok((await state).room.closedAt);
    assert.ok((await closedPlayer).room.closedAt);
    state = nextState(host);
    host.emit('lobby:subscribe', { roomId: 'other', audience: 'screen' });
    assert.equal((await state).room.id, 'other');
    assert.deepEqual([...io.sockets.sockets.get(host.id!)!.rooms].filter(r => r !== host.id), ['lobby:other:screen']);
  } finally {
    host.disconnect(); player.disconnect(); invalid.disconnect();
    await new Promise<void>(resolve => io.close(() => resolve()));
    db.close();
  }
});

test('Start broadcasts ROUND_INTRO to Host, Screen and Player without answers and refreshes from frozen data', async () => {
  const db = initializeDatabase(':memory:');
  const quiz = createQuiz(db);
  const { createRound } = await import('./rounds.js');
  const { createQuestion, createOption } = await import('./questions.js');
  const round = createRound(db, quiz.id);
  const question = createQuestion(db, round.id);
  db.prepare("UPDATE questions SET text_ru = 'Вопрос', text_en = 'Question' WHERE id = ?").run(question.id);
  for (const correct of [1, 0]) {
    const option = createOption(db, question.id);
    db.prepare("UPDATE answer_options SET text_ru = 'Ответ', text_en = 'Answer', is_correct = ? WHERE id = ?").run(correct, option.id);
  }
  const { server, io } = createQuizServer(db);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const api = request(server);
  const room = (await api.post(`/api/quizzes/${quiz.id}/rooms`).expect(201)).body;
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const sockets = ['host', 'screen', 'player'].map(() => connect(url, { transports: ['websocket'], autoConnect: false, forceNew: true }));
  try {
    for (const [i, socket] of sockets.entries()) {
      const connected = once(socket, 'connect');
      socket.connect();
      await connected;
      const state = nextState(socket);
      socket.emit('lobby:subscribe', { roomId: room.id, audience: ['host', 'screen', 'player'][i] });
      await state;
    }
    const identities = [];
    for (const name of ['Alice', 'Bob']) identities.push((await api.post(`/api/rooms/code/${room.code}/players`).send({ name, language: 'en' }).expect(201)).body);
    db.prepare("UPDATE quizzes SET title = 'Final Lobby title' WHERE id = ?").run(quiz.id);
    const states = sockets.map(nextState);
    await api.post(`/api/rooms/${room.id}/start`).expect(200);
    for (const [i, payload] of (await Promise.all(states)).entries()) {
      assert.equal(payload.room.state, 'ROUND_INTRO');
      assert.equal(payload.room.quizTitle, 'Final Lobby title');
      assert.equal(payload.players?.length, i === 2 ? undefined : 2);
      assert.doesNotMatch(JSON.stringify(payload), /isCorrect|snapshot|questions|options|token/);
    }
    await api.post(`/api/rooms/code/${room.code}/players`).send({ name: 'Charlie', language: 'en' }).expect(409);
    db.prepare("UPDATE quizzes SET title = 'After start' WHERE id = ?").run(quiz.id);
    await api.delete(`/api/quizzes/${quiz.id}`).expect(204);
    for (const [i, socket] of sockets.entries()) {
      socket.disconnect();
      const connected = once(socket, 'connect');
      socket.connect();
      await connected;
      const state = nextState(socket);
      socket.emit('lobby:subscribe', { roomId: room.id, audience: ['host', 'screen', 'player'][i] });
      const refreshed = await state;
      assert.equal(refreshed.room.state, 'ROUND_INTRO');
      assert.equal(refreshed.room.quizTitle, 'Final Lobby title');
    }
    const questionStates = sockets.map(nextState);
    await api.post(`/api/rooms/${room.id}/start-round`).expect(200);
    const questionPayloads = await Promise.all(questionStates);
    for (const [i, payload] of questionPayloads.entries()) {
      assert.equal(payload.room.state, 'QUESTION');
      if (i === 0) {
        assert.equal(payload.game.textEn, 'Question');
        assert.equal(payload.game.answerTimeSeconds, 30);
        assert.equal(payload.game.options[0].isCorrect, true);
      } else {
        assert.doesNotMatch(JSON.stringify(payload), /isCorrect|snapshot|options|points|answerTimeSeconds/);
        if (i === 1) assert.equal(payload.game.textRu, 'Вопрос');
        else assert.equal(payload.game, undefined);
      }
      const socket = sockets[i];
      socket.disconnect();
      const connected = once(socket, 'connect');
      socket.connect();
      await connected;
      const refreshed = nextState(socket);
      socket.emit('lobby:subscribe', { roomId: room.id, audience: ['host', 'screen', 'player'][i] });
      assert.deepEqual(await refreshed, payload);
    }
    const answeringStates = sockets.map(nextState);
    await api.post(`/api/rooms/${room.id}/start-question`).expect(200);
    const answering = await Promise.all(answeringStates);
    const deadline = answering[0].game.timer.deadlineAt;
    for (const [i, payload] of answering.entries()) {
      assert.equal(payload.room.state, 'ANSWERING');
      if (i < 2) assert.equal(payload.game.timer.deadlineAt, deadline);
      if (i > 0) assert.doesNotMatch(JSON.stringify(payload), /isCorrect|snapshot|token|points/);
      if (i === 2) assert.deepEqual(Object.keys(payload), ['room']);
      const socket = sockets[i];
      socket.disconnect();
      const connected = once(socket, 'connect');
      socket.connect(); await connected;
      const refreshed = nextState(socket);
      socket.emit('lobby:subscribe', { roomId: room.id, audience: ['host', 'screen', 'player'][i] });
      const restored = await refreshed;
      assert.equal(restored.room.state, 'ANSWERING');
      if (i < 2) assert.equal(restored.game.timer.deadlineAt, deadline);
    }
    for (const identity of identities) {
      assert.equal((await api.post(`/api/rooms/${room.id}/reconnect`).send({ token: identity.token }).expect(200)).body.game.timer.deadlineAt, deadline);
    }
    for (const [index, identity] of identities.entries()) {
      const restored = (await api.post(`/api/rooms/${room.id}/reconnect`).send({ token: identity.token }).expect(200)).body;
      const updates = sockets.map(nextState);
      const answer = { token: identity.token, questionId: restored.game.questionId, optionId: restored.game.options[0].id };
      await api.post(`/api/rooms/${room.id}/answers`).send(answer).expect(200);
      for (const [audience, payload] of (await Promise.all(updates)).entries()) {
        assert.equal(payload.room.state, 'ANSWERING');
        if (audience < 2) assert.deepEqual(payload.game.answers, { answered: index + 1, expected: 2 });
        else assert.deepEqual(Object.keys(payload), ['room']);
        assert.doesNotMatch(JSON.stringify(payload), /optionId|playerId|submitted|token/);
      }
      const reconnected = (await api.post(`/api/rooms/${room.id}/reconnect`).send({ token: identity.token }).expect(200)).body;
      assert.deepEqual(reconnected.game.submission, { submitted: true, optionId: answer.optionId });
    }

  } finally {
    sockets.forEach(socket => socket.disconnect());
    await new Promise<void>(resolve => io.close(() => resolve()));
    db.close();
  }
});
