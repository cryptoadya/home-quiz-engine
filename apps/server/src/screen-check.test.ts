import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { initializeDatabase } from './db.js';
import { createQuiz } from './quizzes.js';
import { createQuizServer } from './realtime.js';

test('retired Test Game endpoint cannot create sessions', async () => {
  const db = initializeDatabase(':memory:');
  const quiz = createQuiz(db);
  const runtime = createQuizServer(db);
  try {
    await request(runtime.app).post(`/api/quizzes/${quiz.id}/test-games`).expect(404);
    assert.equal(db.prepare('SELECT count(*) AS n FROM game_sessions').get()!.n, 0);
  } finally { runtime.deadlines.stop(); await runtime.io.close(); db.close(); }
});

test('equipment check isolates quizzes, validates roles, reports playback and allocates no game', async () => {
  const db = initializeDatabase(':memory:');
  const quiz = createQuiz(db), other = createQuiz(db);
  const runtime = createQuizServer(db);
  runtime.server.listen(0, '127.0.0.1'); await once(runtime.server, 'listening');
  const url = `http://127.0.0.1:${(runtime.server.address() as { port: number }).port}`;
  const sockets = Array.from({ length: 3 }, () => connect(url, { transports: ['websocket'], autoConnect: false }));
  const [admin, screen, stranger] = sockets;
  const ack = (socket: Socket, event: string, input: unknown) => socket.timeout(1500).emitWithAck(event, input);
  try {
    await Promise.all(sockets.map(async socket => { const ready = once(socket, 'connect'); socket.connect(); await ready; }));
    assert.equal((await ack(admin, 'screen-check:subscribe', { quizId: quiz.id, role: 'admin' })).accepted, true);
    assert.equal((await ack(stranger, 'screen-check:subscribe', { quizId: 'missing', role: 'screen' })).accepted, false);
    assert.equal((await ack(stranger, 'screen-check:subscribe', { quizId: quiz.id, role: 'player' })).accepted, false);
    await ack(stranger, 'screen-check:subscribe', { quizId: other.id, role: 'screen' });
    const presence = once(admin, 'screen-check:presence');
    await ack(screen, 'screen-check:subscribe', { quizId: quiz.id, role: 'screen' });
    assert.equal((await presence)[0].screens, 1);
    assert.equal((await ack(screen, 'screen-check:command', { action: 'sound' })).accepted, false);
    assert.equal((await ack(admin, 'screen-check:command', { action: 'start-game' })).accepted, false);
    let leaked = 0; stranger.on('screen-check:command', () => leaked++);
    const command = once(screen, 'screen-check:command');
    assert.equal((await ack(admin, 'screen-check:command', { action: 'sound' })).accepted, true);
    const [{ revision, action }] = await command;
    assert.equal(action, 'sound');
    const report = once(admin, 'screen-check:report');
    await ack(screen, 'screen-check:report', { revision, status: 'blocked' });
    assert.equal((await report)[0].status, 'blocked');
    assert.equal((await ack(admin, 'screen-check:report', { revision, status: 'playing' })).accepted, false);
    assert.equal((await ack(screen, 'screen-check:report', { revision: revision - 1, status: 'playing' })).accepted, false);
    const stopped = once(screen, 'screen-check:command');
    await ack(admin, 'screen-check:command', { action: 'stop' }); await stopped;
    assert.equal(leaked, 0);
    const gone = once(admin, 'screen-check:presence'); screen.disconnect();
    assert.equal((await gone)[0].screens, 0);
    assert.equal((await ack(admin, 'screen-check:command', { action: 'sound' })).accepted, false);
    const reconnected = once(screen, 'connect'); screen.connect(); await reconnected;
    await ack(screen, 'screen-check:subscribe', { quizId: quiz.id, role: 'screen' });
    const orphanStopped = once(screen, 'screen-check:command'); admin.disconnect();
    assert.equal((await orphanStopped)[0].action, 'stop');
    assert.equal(db.prepare('SELECT count(*) AS n FROM game_sessions').get()!.n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM game_history').get()!.n, 0);
  } finally {
    sockets.forEach(socket => socket.disconnect()); runtime.deadlines.stop();
    await new Promise<void>(resolve => runtime.io.close(() => resolve())); db.close();
  }
});
