import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import request from 'supertest';
import { createApp } from './app.js';
import { initializeDatabase } from './db.js';
import { createQuiz } from './quizzes.js';

function room(db: ReturnType<typeof initializeDatabase>, id = 'room', code = 'ABCDE') {
  const quiz = createQuiz(db);
  db.prepare("INSERT INTO game_sessions (id, code, quiz_id, state, created_at) VALUES (?, ?, ?, 'LOBBY', ?)").run(id, code, quiz.id, new Date().toISOString());
}

test('join validates names, language, room state and reserves Unicode names per room', async () => {
  const db = initializeDatabase(':memory:');
  const api = request(createApp(db));
  try {
    room(db);
    room(db, 'other', 'FGHJK');
    const joinPlayer = (name: unknown, language: unknown = 'ru', code = 'abcde') => api.post(`/api/rooms/code/${code}/players`).send({ name, language });
    for (const name of ['', '   ', " - ' ", 'A1', 'A😀', '<b>Alex</b>', 'A!', 'A_B', 'A\nB', 'a'.repeat(21), 123]) {
      assert.equal((await joinPlayer(name)).status, 400, String(name));
    }
    assert.equal((await joinPlayer('Alex', 'de')).status, 400);
    for (const name of ['  Алексей  ', "Anne-Marie O'Neil", '李明', 'Élodie', 'Jose\u0301', 'a'.repeat(20)]) {
      const result = await joinPlayer(name);
      assert.equal(result.status, 201, name);
      assert.equal(result.body.player.name, name.trim());
    }
    for (const name of ['АЛЕКСЕЙ', 'éLODIE', 'JOSÉ']) assert.equal((await joinPlayer(name)).status, 409);
    assert.equal((await joinPlayer('АЛЕКСЕЙ', 'en', 'FGHJK')).status, 201);
    assert.equal((await joinPlayer('Alex', 'en', 'ZZZZZ')).status, 404);
    db.prepare("UPDATE game_sessions SET state = 'ROUND_INTRO' WHERE id = 'room'").run();
    assert.equal((await joinPlayer('Alex')).status, 409);
    await api.post('/api/rooms/room/close');
    assert.equal((await joinPlayer('Alex')).status, 404);
  } finally { db.close(); }
});

test('simultaneous joins enforce duplicate reservation and the 30-player boundary', async () => {
  const db = initializeDatabase(':memory:');
  const api = request(createApp(db));
  try {
    room(db);
    const app = createApp(db);
    const joinPlayer = (name: string) => request(app).post('/api/rooms/code/ABCDE/players').send({ name, language: 'en' });
    const raced = await Promise.all([joinPlayer('Alex'), joinPlayer('ALEX')]);
    assert.deepEqual(raced.map(r => r.status).sort(), [201, 409]);
    assert.throws(() => db.prepare(`INSERT INTO session_players (id, session_id, display_name, normalized_name, language, token_hash, joined_at)
      VALUES ('duplicate', 'room', 'ALEX', 'alex', 'en', 'hash', 'now')`).run(), /UNIQUE/);
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => joinPlayer(`Guest ${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + i % 26)}`)));
    assert.equal(results.filter(r => r.status === 201).length, 29);
    assert.equal(results.filter(r => r.status === 409).length, 1);
    assert.equal((await api.get('/api/rooms/room/players')).body.length, 30);
  } finally { db.close(); }
});

test('hashed tokens restore durable identity, stay private, and remain scoped after closure/code reuse', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'quiz-players-'));
  const path = join(directory, 'quiz.sqlite');
  let db = initializeDatabase(path);
  try {
    room(db);
    room(db, 'other', 'FGHJK');
    let api = request(createApp(db));
    const joined = await api.post('/api/rooms/code/ABCDE/players').send({ name: 'Alex', language: 'ru' });
    assert.equal(joined.status, 201);
    const { player, token } = joined.body;
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    const stored = db.prepare('SELECT token_hash FROM session_players WHERE id = ?').get(player.id);
    assert.notEqual(stored?.token_hash, token);
    assert.match(String(stored?.token_hash), /^[a-f0-9]{64}$/);
    const roster = await api.get('/api/rooms/room/players');
    assert.deepEqual(roster.body, [player]);
    assert.deepEqual(Object.keys(player).sort(), ['id', 'joinedAt', 'language', 'name']);
    assert.ok(!JSON.stringify((await api.get('/api/rooms/room')).body).includes(token));
    db.close();
    db = initializeDatabase(path);
    api = request(createApp(db));
    const reconnect = (id: string, value: unknown) => api.post(`/api/rooms/${id}/reconnect`).send({ token: value });
    const restored = await reconnect('room', token);
    assert.equal(restored.status, 200);
    assert.deepEqual(restored.body.player, player);
    assert.equal(restored.body.active, true);
    assert.equal(restored.body.room.id, 'room');
    assert.equal(restored.body.token, undefined);
    assert.equal((await reconnect('other', token)).status, 401);
    assert.equal((await reconnect('room', 'invalid')).status, 401);
    assert.equal((await reconnect('room', null)).status, 401);
    await api.post('/api/rooms/room/close');
    room(db, 'reused', 'ABCDE');
    assert.equal((await reconnect('reused', token)).status, 401);
    const closed = await reconnect('room', token);
    assert.equal(closed.status, 200);
    assert.equal(closed.body.active, false);
    assert.ok(closed.body.room.closedAt);
    assert.equal((await api.get('/api/rooms/room/players')).status, 404);
    assert.equal((await api.get('/api/rooms/missing/players')).status, 404);
    db.prepare('UPDATE session_players SET removed_at = ? WHERE id = ?').run('now', player.id);
    assert.equal((await reconnect('room', token)).status, 401);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
