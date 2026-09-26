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
    assert.deepEqual([...io.sockets.sockets.get(host.id!)!.rooms].filter(r => r !== host.id), ['lobby:other:roster']);
  } finally {
    host.disconnect(); player.disconnect(); invalid.disconnect();
    await new Promise<void>(resolve => io.close(() => resolve()));
    db.close();
  }
});
