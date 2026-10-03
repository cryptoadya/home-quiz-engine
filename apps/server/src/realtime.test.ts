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
    const joinedState = nextState(host);
    const identity = (await request(server).post('/api/rooms/code/ABCDE/players').send({ name: 'Sam', language: 'en' })).body;
    await joinedState;
    state = nextState(player);
    player.emit('lobby:subscribe', { roomId: 'room', audience: 'player', token: identity.token });
    assert.equal((await state).players, undefined);
    for (const [name, language, count] of [['Alex', 'ru', 2], ['Jane', 'en', 3]] as const) {
      state = nextState(host);
      const playerState = nextState(player);
      const joined = await request(server).post('/api/rooms/code/ABCDE/players').send({ name, language });
      assert.equal(joined.status, 201);
      const payload = await state;
      assert.equal(payload.players.length, count);
      assert.deepEqual(Object.keys(payload.players[0]).sort(), ['id', 'joinedAt', 'language', 'name', 'present']);
      assert.ok(!JSON.stringify(payload).includes(joined.body.token));
      assert.equal((await playerState).players, undefined);
    }
    assert.equal((await request(server).get('/api/rooms/room/lobby')).body.players.length, 3);
    host.disconnect();
    await request(server).post('/api/rooms/room/close');
    state = nextState(host);
    host.connect();
    await once(host, 'connect');
    host.emit('lobby:subscribe', { roomId: 'room', audience: 'host' });
    const restored = await state;
    assert.ok(restored.room.closedAt);
    assert.equal(restored.players.length, 3);
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
  const identities = [];
  for (const name of ['Alice', 'Bob']) identities.push((await api.post(`/api/rooms/code/${room.code}/players`).send({ name, language: 'en' }).expect(201)).body);
  // A second authenticated tab keeps the old reload scenario in ANSWERING.
  const backup = connect(url, { transports: ['websocket'], forceNew: true });
  await once(backup, 'connect');
  const backupState = nextState(backup);
  backup.emit('lobby:subscribe', { roomId: room.id, audience: 'player', token: identities[0].token });
  await backupState;
  try {
    for (const [i, socket] of sockets.entries()) {
      const connected = once(socket, 'connect');
      socket.connect();
      await connected;
      const state = nextState(socket);
      socket.emit('lobby:subscribe', { roomId: room.id, audience: ['host', 'screen', 'player'][i], ...(i === 2 ? { token: identities[0].token } : {}) });
      await state;
    }

    db.prepare("UPDATE quizzes SET title = 'Final Lobby title', theme_id = 'unavailable-party-theme' WHERE id = ?").run(quiz.id);
    const states = sockets.map(nextState);
    await api.post(`/api/rooms/${room.id}/start`).expect(200);
    for (const [i, payload] of (await Promise.all(states)).entries()) {
      assert.equal(payload.room.state, 'ROUND_INTRO');
      assert.equal(payload.room.quizTitle, 'Final Lobby title');
      assert.equal(payload.room.themeId, 'unavailable-party-theme');
      assert.equal(payload.players?.length, i === 2 ? undefined : 2);
      assert.doesNotMatch(JSON.stringify(payload), /isCorrect|snapshot|questions|options|token/);
    }
    await api.post(`/api/rooms/code/${room.code}/players`).send({ name: 'Charlie', language: 'en' }).expect(409);
    db.prepare("UPDATE quizzes SET title = 'After start', theme_id = 'default' WHERE id = ?").run(quiz.id);
    await api.delete(`/api/quizzes/${quiz.id}`).expect(204);
    for (const [i, socket] of sockets.entries()) {
      socket.disconnect();
      const connected = once(socket, 'connect');
      socket.connect();
      await connected;
      const state = nextState(socket);
      socket.emit('lobby:subscribe', { roomId: room.id, audience: ['host', 'screen', 'player'][i], ...(i === 2 ? { token: identities[0].token } : {}) });
      const refreshed = await state;
      assert.equal(refreshed.room.state, 'ROUND_INTRO');
      assert.equal(refreshed.room.quizTitle, 'Final Lobby title');
      assert.equal(refreshed.room.themeId, 'unavailable-party-theme');
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
        if (i === 1) { assert.equal(payload.game.textRu, ''); assert.deepEqual(payload.game.media, []); }
        else assert.equal(payload.game, undefined);
      }
      const socket = sockets[i];
      socket.disconnect();
      const connected = once(socket, 'connect');
      socket.connect();
      await connected;
      const refreshed = nextState(socket);
      socket.emit('lobby:subscribe', { roomId: room.id, audience: ['host', 'screen', 'player'][i], ...(i === 2 ? { token: identities[0].token } : {}) });
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
      socket.emit('lobby:subscribe', { roomId: room.id, audience: ['host', 'screen', 'player'][i], ...(i === 2 ? { token: identities[0].token } : {}) });
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
      const answer = { token: identity.token, questionId: restored.game.questionId, optionId: restored.game.options[index].id };
      await api.post(`/api/rooms/${room.id}/answers`).send(answer).expect(200);
      for (const [audience, payload] of (await Promise.all(updates)).entries()) {
        assert.equal(payload.room.state, index === 1 ? 'ANSWER_REVEAL' : 'ANSWERING');
        if (index === 1 && audience === 1) {
          assert.equal(payload.game.options.filter((o: any) => o.isCorrect).length, 1);
          assert.deepEqual(payload.game.statistics, { correct: 1, wrong: 1, unanswered: 0 });
        }
        if (audience < 2) assert.deepEqual(payload.game.answers, { answered: index + 1, expected: 2 });
        else assert.deepEqual(Object.keys(payload), ['room']);
        assert.doesNotMatch(JSON.stringify(payload), /optionId|playerId|submitted|token/);
      }
      const reconnected = (await api.post(`/api/rooms/${room.id}/reconnect`).send({ token: identity.token }).expect(200)).body;
      assert.deepEqual(reconnected.game.submission, { submitted: true, optionId: answer.optionId });
    }

  } finally {
    backup.disconnect();
    sockets.forEach(socket => socket.disconnect());
    await new Promise<void>(resolve => io.close(() => resolve()));
    db.close();
  }
});

test('persisted deadline automatically broadcasts Reveal without further HTTP mutations', async () => {
  const db = initializeDatabase(':memory:');
  const { createRound } = await import('./rounds.js');
  const { createQuestion, createOption } = await import('./questions.js');
  const quiz = createQuiz(db);
  const round = createRound(db, quiz.id);
  const question = createQuestion(db, round.id);
  db.prepare("UPDATE questions SET text_ru = 'Вопрос', text_en = 'Question', answer_time_seconds = 1 WHERE id = ?").run(question.id);
  for (const correct of [1, 0]) {
    const option = createOption(db, question.id);
    db.prepare("UPDATE answer_options SET text_ru = 'Ответ', text_en = 'Answer', is_correct = ? WHERE id = ?").run(correct, option.id);
  }
  const { server, io } = createQuizServer(db);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const api = request(server);
  const sockets: Socket[] = [];
  try {
    const room = (await api.post(`/api/quizzes/${quiz.id}/rooms`).expect(201)).body;
    const identities = [];
    for (const name of ['Alice', 'Bob']) identities.push((await api.post(`/api/rooms/code/${room.code}/players`).send({ name, language: 'en' }).expect(201)).body);
    await api.post(`/api/rooms/${room.id}/start`).expect(200);
    await api.post(`/api/rooms/${room.id}/start-round`).expect(200);
    for (const audience of ['host', 'screen', 'player']) {
      const socket = connect(`http://127.0.0.1:${(server.address() as { port: number }).port}`, { transports: ['websocket'], forceNew: true });
      sockets.push(socket); await once(socket, 'connect');
      const state = nextState(socket); socket.emit('lobby:subscribe', { roomId: room.id, audience, ...(audience === 'player' ? { token: identities[0].token } : {}) }); await state;
    }
    let updates = sockets.map(nextState);
    await api.post(`/api/rooms/${room.id}/start-question`).expect(200); await Promise.all(updates);
    const game = (await api.post(`/api/rooms/${room.id}/reconnect`).send({ token: identities[0].token })).body.game;
    updates = sockets.map(nextState);
    await api.post(`/api/rooms/${room.id}/answers`).send({ token: identities[0].token, questionId: game.questionId, optionId: game.options[0].id }).expect(200);
    await Promise.all(updates);
    const reveals = await Promise.all(sockets.map(nextState)); // Actual scheduled wakeup, no polling/mutations.
    for (const reveal of reveals) assert.equal(reveal.room.state, 'ANSWER_REVEAL');
    assert.deepEqual(reveals[1].game.statistics, { correct: 1, wrong: 0, unanswered: 1 });
    assert.deepEqual(Object.keys(reveals[2]), ['room']);
    for (let i = 0; i < 2; i++) {
      const own = (await api.post(`/api/rooms/${room.id}/reconnect`).send({ token: identities[i].token })).body.game;
      assert.deepEqual(own.result, { outcome: i === 0 ? 'correct' : 'unanswered', points: i === 0 ? 1 : 0 });
    }
  } finally {
    sockets.forEach(socket => socket.disconnect());
    await new Promise<void>(resolve => io.close(() => resolve())); db.close();
  }
});

test('Kick revokes every authenticated tab and broadcasts remaining roster to Host/Screen', async () => {
  const db = initializeDatabase(':memory:'); const quiz = createQuiz(db);
  db.prepare("INSERT INTO game_sessions (id, code, quiz_id, state, created_at) VALUES ('kick-room', 'ABCDE', ?, 'LOBBY', 'now')").run(quiz.id);
  const { server, io } = createQuizServer(db);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const sockets: Socket[] = [];
  try {
    const identity = (await request(server).post('/api/rooms/code/ABCDE/players').send({ name: 'Alice', language: 'en' })).body;
    for (const audience of ['host', 'screen', 'player', 'player']) {
      const socket = connect(url, { transports: ['websocket'], forceNew: true }); sockets.push(socket);
      await once(socket, 'connect'); const snapshot = nextState(socket);
      socket.emit('lobby:subscribe', { roomId: 'kick-room', audience, token: identity.token }); await snapshot;
    }
    const states = sockets.slice(0, 2).map(nextState), removals = sockets.slice(2).map(socket => once(socket, 'player:removed'));
    await request(server).post(`/api/rooms/kick-room/players/${identity.player.id}/kick`).send({ confirmed: true }).expect(200);
    for (const state of await Promise.all(states)) assert.deepEqual(state.players, []);
    for (const [removed] of await Promise.all(removals)) assert.deepEqual(removed, { roomId: 'kick-room' });
    await request(server).post('/api/rooms/kick-room/reconnect').send({ token: identity.token }).expect(401);
    const rejected = once(sockets[0], 'lobby:error');
    sockets[0].emit('lobby:subscribe', { roomId: 'kick-room', audience: 'player', token: identity.token }); await rejected;
    assert.equal(io.sockets.sockets.get(sockets[0].id!)!.rooms.size, 1);
  } finally { sockets.forEach(socket => socket.disconnect()); await new Promise<void>(resolve => io.close(() => resolve())); db.close(); }
});
