import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { initializeDatabase } from './db.js';
import { createQuiz } from './quizzes.js';
import { createRound } from './rounds.js';
import { createQuestion, createOption } from './questions.js';
import { createQuizServer } from './realtime.js';
import { createApp } from './app.js';
import { startQuestion, getSurfaceState } from './game.js';
import * as pause from './pause.js';
import { submitAnswer } from './answers.js';
import { createDeadlineManager } from './deadlines.js';

async function fixture(db: ReturnType<typeof initializeDatabase>) {
  const quiz = createQuiz(db);
  const round = createRound(db, quiz.id);
  const question = createQuestion(db, round.id);
  db.prepare("UPDATE questions SET text_ru = 'Вопрос', text_en = 'Question' WHERE id = ?").run(question.id);
  const options = [1, 0].map(correct => {
    const option = createOption(db, question.id);
    db.prepare("UPDATE answer_options SET text_ru = 'Ответ', text_en = 'Answer', is_correct = ? WHERE id = ?").run(correct, option.id);
    return option;
  });
  const api = request(createApp(db));
  const room = (await api.post(`/api/quizzes/${quiz.id}/rooms`).expect(201)).body;
  const identities = [];
  for (const name of ['Alice', 'Bob', 'Carol']) identities.push((await api.post(`/api/rooms/code/${room.code}/players`).send({ name, language: 'en' }).expect(201)).body);
  const root = `/api/rooms/${room.id}`;
  return { api, room, identities, root, question, options };
}
const row = (db: ReturnType<typeof initializeDatabase>, id: string) => db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(id)!;
const event = (socket: Socket, name = 'lobby:state') => once(socket, name, { signal: AbortSignal.timeout(3000) }).then(([value]) => value);

test('Player subscription requires a valid room-scoped roster identity and never leaks its token', async () => {
  const db = initializeDatabase(':memory:');
  const f = await fixture(db);
  const other = await fixture(db);
  const { server, io } = createQuizServer(db);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const socket = connect(`http://127.0.0.1:${(server.address() as { port: number }).port}`, { transports: ['websocket'] });
  try {
    await once(socket, 'connect');
    for (const token of [undefined, 'invalid', other.identities[0].token]) {
      const reply = Promise.race([event(socket, 'lobby:error').then(() => 'error'), event(socket).then(() => 'state')]);
      socket.emit('lobby:subscribe', { roomId: f.room.id, audience: 'player', token });
      assert.equal(await reply, 'error');
      assert.equal(io.sockets.sockets.get(socket.id!)!.rooms.size, 1);
    }
    for (const audience of ['player', 'host', 'screen']) {
      const reply = event(socket);
      socket.emit('lobby:subscribe', { roomId: f.room.id, audience, ...(audience === 'player' ? { token: f.identities[0].token } : {}) });
      assert.ok(!JSON.stringify(await reply).includes(f.identities[0].token));
      assert.ok(![...io.sockets.sockets.get(socket.id!)!.rooms].some(name => name.includes(f.identities[0].token)));
    }
    db.prepare('UPDATE session_players SET removed_at = ? WHERE id = ?').run('now', f.identities[2].player.id);
    await f.api.post(`${f.root}/start`).expect(200);
    db.prepare('UPDATE session_players SET removed_at = NULL WHERE id = ?').run(f.identities[2].player.id);
    const rejected = event(socket, 'lobby:error');
    socket.emit('lobby:subscribe', { roomId: f.room.id, audience: 'player', token: f.identities[2].token });
    await rejected;
    assert.equal(io.sockets.sockets.get(socket.id!)!.rooms.size, 1);
  } finally { socket.disconnect(); await new Promise<void>(resolve => io.close(() => resolve())); db.close(); }
});

for (const offset of [-10000, 0, 1]) test(`disconnect transaction at deadline ${offset}ms preserves pause/Reveal ordering`, async () => {
  assert.equal(typeof pause.autoPauseForDisconnectedPlayer, 'function');
  const db = initializeDatabase(':memory:');
  try {
    const f = await fixture(db);
    await f.api.post(`${f.root}/start`).expect(200); await f.api.post(`${f.root}/start-round`).expect(200);
    startQuestion(db, f.room.id, 0);
    const deadline = Date.parse(String(row(db, f.room.id).answer_deadline_at));
    let now = deadline + offset;
    const jobs: (() => void)[] = [];
    const manager = createDeadlineManager(db, () => {}, { clock: () => now, schedule: cb => { jobs.push(cb); return () => {}; } });
    if (offset < 0) manager.sync(f.room.id);
    assert.equal(pause.autoPauseForDisconnectedPlayer(db, f.room.id, f.identities[0].player.id, () => now), true);
    const state = row(db, f.room.id);
    if (offset < 0) {
      assert.equal(state.state, 'PAUSED'); assert.equal(state.pause_reason, 'player_disconnect');
      assert.equal(state.paused_player_id, f.identities[0].player.id); assert.equal(state.paused_remaining_ms, 10000);
      const host = getSurfaceState(db, f.room.id, 'host')!.game!;
      assert.deepEqual(host, { state: 'PAUSED', pausedFromState: 'ANSWERING', remainingMs: 10000, reason: 'player_disconnect', disconnectedPlayer: { id: f.identities[0].player.id, name: 'Alice', present: false } });
      assert.deepEqual(getSurfaceState(db, f.room.id, 'screen')!.game, { state: 'PAUSED', pausedFromState: 'ANSWERING', remainingMs: 10000 });
      assert.deepEqual(Object.keys(getSurfaceState(db, f.room.id, 'player')!), ['room']);
      manager.sync(f.room.id); now = deadline + 100000; jobs[0]();
      assert.deepEqual(row(db, f.room.id), state);
      assert.equal((submitAnswer(db, f.room.id, { token: f.identities[1].token, questionId: f.question.id, optionId: f.options[0].id }, () => now) as { status: number }).status, 409);
      assert.equal(pause.autoPauseForDisconnectedPlayer(db, f.room.id, f.identities[1].player.id), false);
      assert.deepEqual(row(db, f.room.id), state);
    } else {
      assert.equal(state.state, 'ANSWER_REVEAL'); assert.equal(state.pause_reason, null);
      assert.equal(db.prepare('SELECT count(*) n FROM question_scores').get()!.n, 3);
    }
    manager.stop();
  } finally { db.close(); }
});

for (const state of ['LOBBY', 'ROUND_INTRO', 'QUESTION', 'ANSWER_REVEAL', 'ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS', 'WINNER_SCREEN', 'manual', 'closed', 'non-roster', 'missing', 'submitted']) {
  test(`disconnect does not pause or mutate ${state}`, async () => {
    const db = initializeDatabase(':memory:');
    try {
      const f = await fixture(db);
      if (state !== 'LOBBY') await f.api.post(`${f.root}/start`).expect(200);
      if (!['LOBBY', 'ROUND_INTRO'].includes(state)) {
        await f.api.post(`${f.root}/start-round`).expect(200);
        if (state !== 'QUESTION') startQuestion(db, f.room.id, 0);
      }
      if (['ANSWER_REVEAL', 'ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS', 'WINNER_SCREEN'].includes(state)) {
        for (const identity of f.identities) submitAnswer(db, f.room.id, { token: identity.token, questionId: f.question.id, optionId: f.options[0].id }, () => 1);
        if (state !== 'ANSWER_REVEAL') db.prepare('UPDATE game_sessions SET state = ?, answer_started_at = NULL, answer_deadline_at = NULL WHERE id = ?').run(state, f.room.id);
      }
      if (state === 'manual') pause.pauseGame(db, f.room.id, () => 1000);
      if (state === 'closed') await f.api.post(`${f.root}/close`).expect(200);
      if (state === 'non-roster') db.prepare('UPDATE session_players SET in_roster = 0 WHERE id = ?').run(f.identities[0].player.id);
      if (state === 'submitted') assert.ok('submission' in submitAnswer(db, f.room.id, { token: f.identities[0].token, questionId: f.question.id, optionId: f.options[0].id }, () => 1));
      const before = row(db, f.room.id);
      const answers = db.prepare('SELECT * FROM player_answers').all();
      assert.equal(pause.autoPauseForDisconnectedPlayer(db, state === 'missing' ? 'missing' : f.room.id, f.identities[0].player.id, () => 10000), false);
      assert.deepEqual(row(db, f.room.id), before);
      assert.deepEqual(db.prepare('SELECT * FROM player_answers').all(), answers);
      if (state === 'manual') { assert.equal(before.pause_reason, 'manual'); assert.equal(before.paused_player_id, null); }
    } finally { db.close(); }
  });
}

for (const replacement of ['disconnect', 'audience', 'room', 'identity', 'invalid']) test(`last-socket ${replacement} pauses; two tabs, same identity resubscribe and reconnect are safe`, async () => {
  const db = initializeDatabase(':memory:');
  const f = await fixture(db);
  const other = await fixture(db);
  const { server, io } = createQuizServer(db);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const api = request(server);
  const sockets: Socket[] = [];
  async function open(audience: string, token?: string) {
    const socket = connect(`http://127.0.0.1:${(server.address() as { port: number }).port}`, { transports: ['websocket'], forceNew: true });
    sockets.push(socket); await once(socket, 'connect');
    await subscribe(socket, { roomId: f.room.id, audience, token });
    return socket;
  }
  async function subscribe(socket: Socket, input: unknown, name = 'lobby:state') {
    const response = event(socket, name); socket.emit('lobby:subscribe', input); return response;
  }
  async function disconnect(socket: Socket) {
    const done = once(io.sockets.sockets.get(socket.id!)!, 'disconnect'); socket.disconnect(); await done;
  }
  try {
    const host = await open('host'); const screen = await open('screen');
    const a = await open('player', f.identities[0].token);
    const a2 = await open('player', f.identities[0].token);
    const b = await open('player', f.identities[1].token);
    await api.post(`${f.root}/start`).expect(200); await api.post(`${f.root}/start-round`).expect(200); await api.post(`${f.root}/start-question`).expect(200);
    // Transport disconnects for non-Player surfaces have no gameplay effect.
    const extraHost = await open('host'); const extraScreen = await open('screen');
    await disconnect(extraHost); await disconnect(extraScreen);
    await subscribe(a, { roomId: f.room.id, audience: 'player', token: f.identities[0].token });
    await disconnect(a2);
    assert.equal(row(db, f.room.id).state, 'ANSWERING');
    // Drain prior broadcasts with fresh snapshots before observing the loss.
    for (const [socket, audience, token] of [[host, 'host'], [screen, 'screen'], [b, 'player', f.identities[1].token]] as const) await subscribe(socket, { roomId: f.room.id, audience, token });
    const updates = [host, screen, b].map(socket => event(socket));
    if (replacement === 'disconnect') await disconnect(a);
    else await subscribe(a, replacement === 'audience' ? { roomId: f.room.id, audience: 'screen' }
      : replacement === 'room' ? { roomId: other.room.id, audience: 'player', token: other.identities[0].token }
      : replacement === 'identity' ? { roomId: f.room.id, audience: 'player', token: f.identities[2].token }
      : { roomId: f.room.id, audience: 'player', token: 'invalid' }, replacement === 'invalid' ? 'lobby:error' : 'lobby:state');
    const [h, s, p] = await Promise.all(updates);
    assert.equal(h.game.disconnectedPlayer.name, 'Alice'); assert.equal(h.game.reason, 'player_disconnect');
    assert.equal(s.room.state, 'PAUSED'); assert.equal(s.game.disconnectedPlayer, undefined);
    assert.equal(p.room.state, 'PAUSED'); assert.deepEqual(Object.keys(p), ['room']);
    for (const payload of [h, s, p]) for (const identity of f.identities) assert.ok(!JSON.stringify(payload).includes(identity.token));
    const frozen = row(db, f.room.id);
    assert.equal(h.game.disconnectedPlayer.present, false);
    await api.post(`${f.root}/wait-for-player`).expect(409);
    const returned = event(host);
    const restored = await open('player', f.identities[0].token);
    assert.equal((await returned).game.disconnectedPlayer.present, true);
    const otherTab = await open('player', f.identities[0].token);
    await disconnect(restored);
    assert.equal((await api.get(`${f.root}/game/host`)).body.game.disconnectedPlayer.present, true);
    const absent = event(host);
    await disconnect(otherTab);
    assert.equal((await absent).game.disconnectedPlayer.present, false);
    assert.deepEqual(row(db, f.room.id), frozen);
    const back = event(host);
    const finalTab = await open('player', f.identities[0].token);
    assert.equal((await back).game.disconnectedPlayer.present, true);
    assert.deepEqual(row(db, f.room.id), frozen);
    assert.equal((await api.post(`${f.root}/reconnect`).send({ token: f.identities[0].token })).body.room.state, 'PAUSED');
    // Clear any replacement membership while paused; it must not overwrite Alice.
    if (a.connected) await disconnect(a);
    assert.deepEqual(row(db, f.room.id), frozen);
    await api.post(`${f.root}/wait-for-player`).expect(200);
    await api.post(`${f.root}/answers`).send({ token: f.identities[0].token, questionId: f.question.id, optionId: f.options[0].id }).expect(200);
    await disconnect(finalTab);
    assert.equal(row(db, f.room.id).state, 'ANSWERING');
    assert.equal(db.prepare('SELECT count(*) n FROM player_answers WHERE player_id = ?').get(f.identities[0].player.id)!.n, 1);
    // No stale original membership can mask this new last-socket loss.
    const bobUpdate = event(host);
    await disconnect(b);
    assert.equal((await bobUpdate).game.disconnectedPlayer.name, 'Bob');
    await api.post(`${f.root}/close`).expect(200);
  } finally { sockets.forEach(socket => socket.disconnect()); await new Promise<void>(resolve => io.close(() => resolve())); db.close(); }
});

test('restart preserves auto-pause metadata; empty runtime presence never pauses running games', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'quiz-presence-'));
  const path = join(directory, 'quiz.sqlite'); let db = initializeDatabase(path);
  try {
    const f = await fixture(db);
    await f.api.post(`${f.root}/start`).expect(200); await f.api.post(`${f.root}/start-round`).expect(200);
    startQuestion(db, f.room.id, Date.now());
    let runtime = createQuizServer(db);
    assert.equal(row(db, f.room.id).state, 'ANSWERING');
    runtime.deadlines.stop(); await new Promise<void>(resolve => runtime.io.close(() => resolve()));
    pause.autoPauseForDisconnectedPlayer(db, f.room.id, f.identities[0].player.id);
    const frozen = row(db, f.room.id);
    db.close(); db = initializeDatabase(path);
    runtime = createQuizServer(db);
    assert.deepEqual(row(db, f.room.id), frozen);
    assert.equal(getSurfaceState(db, f.room.id, 'host')!.game!.state, 'PAUSED');
    assert.equal((getSurfaceState(db, f.room.id, 'host')!.game as { disconnectedPlayer: { name: string } }).disconnectedPlayer.name, 'Alice');
    runtime.deadlines.stop(); await new Promise<void>(resolve => runtime.io.close(() => resolve()));
    await request(createApp(db)).post(`${f.root}/continue-without-player`).expect(200);
    assert.equal(row(db, f.room.id).pause_reason, null); assert.equal(row(db, f.room.id).paused_player_id, null);
    db.close(); db = initializeDatabase(path);
    runtime = createQuizServer(db);
    assert.equal(row(db, f.room.id).state, 'ANSWERING');
    runtime.deadlines.stop(); await new Promise<void>(resolve => runtime.io.close(() => resolve()));
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('migration 13 preserves Phase 4A pauses and enforces reason invariants', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'quiz-presence-migration-'));
  const path = join(directory, 'quiz.sqlite'); let db = initializeDatabase(path);
  try {
    const f = await fixture(db);
    await f.api.post(`${f.root}/start`).expect(200); await f.api.post(`${f.root}/start-round`).expect(200);
    startQuestion(db, f.room.id, 0); pause.pauseGame(db, f.room.id, () => 1000);
    const before = row(db, f.room.id);
    const players = db.prepare('SELECT * FROM session_players').all();
    const source = readFileSync(new URL('./db.ts', import.meta.url), 'utf8');
    const schema = source.split('version: 12,')[1].split('sql: `')[1].split('INSERT INTO game_sessions_new')[0].replace('CREATE TABLE game_sessions_new', 'CREATE TABLE old_sessions');
    const columns = Object.keys(before).filter(key => !['pause_reason', 'paused_player_id'].includes(key)).join(', ');
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`${schema} INSERT INTO old_sessions SELECT ${columns} FROM game_sessions;
      DROP TRIGGER delete_quiz_lobbies; DROP TABLE game_sessions; ALTER TABLE old_sessions RENAME TO game_sessions;
      CREATE UNIQUE INDEX game_sessions_active_code ON game_sessions(code) WHERE closed_at IS NULL;
      CREATE TRIGGER delete_quiz_lobbies BEFORE DELETE ON quizzes BEGIN DELETE FROM game_sessions WHERE quiz_id = OLD.id AND state = 'LOBBY'; END;
      DROP TABLE question_exclusions; DELETE FROM schema_migrations WHERE version >= 13`);
    db.close(); db = initializeDatabase(path);
    assert.deepEqual(row(db, f.room.id), before); assert.equal(before.pause_reason, 'manual'); assert.equal(before.paused_player_id, null);
    assert.deepEqual(db.prepare('SELECT * FROM session_players').all(), players);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    for (const update of ["pause_reason = NULL", "pause_reason = 'unknown'", "pause_reason = 'player_disconnect'", "paused_player_id = 'someone'"]) assert.throws(() => db.exec(`UPDATE game_sessions SET ${update}`), /CHECK/);
    pause.resumeGame(db, f.room.id, () => 1000);
    for (const update of ["pause_reason = 'manual'", "paused_player_id = 'someone'"]) assert.throws(() => db.exec(`UPDATE game_sessions SET ${update}`), /CHECK/);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});


test('Wait requires live presence and preserves frozen time and expected responders', async () => {
  const db = initializeDatabase(':memory:');
  try {
    const f = await fixture(db);
    await f.api.post(`${f.root}/start`).expect(200); await f.api.post(`${f.root}/start-round`).expect(200);
    startQuestion(db, f.room.id, Date.now());
    pause.autoPauseForDisconnectedPlayer(db, f.room.id, f.identities[0].player.id);
    const frozen = row(db, f.room.id);
    await f.api.post(`${f.root}/resume`).expect(409);
    await f.api.post(`${f.root}/wait-for-player`).expect(409).expect(({ body }) => assert.equal(body.error, 'Player has not reconnected yet.'));
    assert.deepEqual(row(db, f.room.id), frozen);
    let present = false;
    const api = request(createApp(db, () => {}, (roomId, playerId) => present && roomId === f.room.id && playerId === f.identities[0].player.id));
    assert.equal((await api.get(`${f.root}/game/host`)).body.game.disconnectedPlayer.present, false);
    present = true;
    assert.equal((await api.get(`${f.root}/game/host`)).body.game.disconnectedPlayer.present, true);
    await api.post(`${f.root}/wait-for-player`).expect(200);
    const resumed = row(db, f.room.id);
    assert.equal(resumed.state, 'ANSWERING');
    assert.equal(Date.parse(String(resumed.answer_deadline_at)) - Date.parse(String(resumed.answer_started_at)), frozen.paused_remaining_ms);
    assert.equal(db.prepare('SELECT count(*) n FROM question_exclusions').get()!.n, 0);
    assert.equal((await api.get(`${f.root}/game/host`)).body.game.answers.expected, 3);
    await api.post(`${f.root}/answers`).send({ token: f.identities[0].token, questionId: f.question.id, optionId: f.options[0].id }).expect(200);
    await api.post(`${f.root}/wait-for-player`).expect(409);
  } finally { db.close(); }
});

for (const immediate of [false, true]) test(`Continue excludes only current question; immediate Reveal=${immediate}`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'quiz-exclusion-'));
  const path = join(directory, 'quiz.sqlite'); let db = initializeDatabase(path);
  try {
    const f = await fixture(db);
    // Add a second frozen question to test restored participation.
    const roundId = String(db.prepare('SELECT round_id FROM questions WHERE id = ?').get(f.question.id)!.round_id);
    const next = createQuestion(db, roundId);
    db.prepare("UPDATE questions SET text_ru = 'Следующий', text_en = 'Next' WHERE id = ?").run(next.id);
    const nextOptions = [1, 0].map(correct => {
      const option = createOption(db, next.id);
      db.prepare("UPDATE answer_options SET text_ru = 'Ответ', text_en = 'Answer', is_correct = ? WHERE id = ?").run(correct, option.id);
      return option;
    });
    await f.api.post(`${f.root}/start`).expect(200); await f.api.post(`${f.root}/start-round`).expect(200);
    startQuestion(db, f.room.id, Date.now());
    if (immediate) for (const identity of f.identities.slice(1)) await f.api.post(`${f.root}/answers`).send({ token: identity.token, questionId: f.question.id, optionId: f.options[0].id }).expect(200);
    pause.autoPauseForDisconnectedPlayer(db, f.room.id, f.identities[0].player.id);
    const remaining = row(db, f.room.id).paused_remaining_ms;
    await f.api.post(`${f.root}/continue-without-player`).expect(200);
    assert.equal(row(db, f.room.id).state, immediate ? 'ANSWER_REVEAL' : 'ANSWERING');
    if (immediate) { assert.equal(row(db, f.room.id).answer_deadline_at, null); assert.equal(row(db, f.room.id).answer_started_at, null); }
    assert.equal(row(db, f.room.id).pause_reason, null);
    assert.equal(db.prepare('SELECT in_roster FROM session_players WHERE id = ?').get(f.identities[0].player.id)!.in_roster, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM question_exclusions').get()!.n, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM player_answers WHERE player_id = ?').get(f.identities[0].player.id)!.n, 0);
    await f.api.post(`${f.root}/continue-without-player`).expect(409);
    if (!immediate) {
      const resumed = row(db, f.room.id);
      assert.equal(Date.parse(String(resumed.answer_deadline_at)) - Date.parse(String(resumed.answer_started_at)), remaining);
      const game = (await f.api.post(`${f.root}/reconnect`).send({ token: f.identities[0].token }).expect(200)).body.game;
      assert.equal(game.excluded, true); assert.deepEqual(game.options, []);
      await f.api.post(`${f.root}/answers`).send({ token: f.identities[0].token, questionId: f.question.id, optionId: f.options[0].id }).expect(409);
      assert.equal(pause.autoPauseForDisconnectedPlayer(db, f.room.id, f.identities[0].player.id), false);
      assert.equal(pause.autoPauseForDisconnectedPlayer(db, f.room.id, f.identities[1].player.id), true);
      await f.api.post(`${f.root}/continue-without-player`).expect(200);
      // Exclusions survive restart; only Carol is still expected.
      db.close(); db = initializeDatabase(path);
      const api = request(createApp(db));
      assert.deepEqual((await api.get(`${f.root}/game/host`)).body.game.answers, { answered: 0, expected: 1 });
      await api.post(`${f.root}/answers`).send({ token: f.identities[2].token, questionId: f.question.id, optionId: f.options[0].id }).expect(200);
    }
    const api = request(createApp(db));
    const score = db.prepare('SELECT result, awarded_points FROM question_scores WHERE player_id = ?').get(f.identities[0].player.id)!;
    assert.equal(score.result, 'unanswered'); assert.equal(score.awarded_points, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM question_scores').get()!.n, 3);
    let scheduled = 0;
    const manager = createDeadlineManager(db, () => {}, { schedule: () => { scheduled++; return () => {}; } });
    manager.sync(f.room.id); assert.equal(scheduled, 0); manager.stop();
    await api.post(`${f.root}/next`).expect(200); await api.post(`${f.root}/start-question`).expect(200);
    assert.equal((await api.get(`${f.root}/game/host`)).body.game.answers.expected, 3);
    const game = (await api.post(`${f.root}/reconnect`).send({ token: f.identities[0].token })).body.game;
    assert.equal(game.excluded, false); assert.equal(game.options.length, 2);
    await api.post(`${f.root}/answers`).send({ token: f.identities[0].token, questionId: next.id, optionId: nextOptions[0].id }).expect(200);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const state of ['manual', 'closed', 'submitted', 'excluded', 'missing']) test(`resolution rejects ${state} without mutations`, async () => {
  const db = initializeDatabase(':memory:');
  try {
    const f = await fixture(db);
    await f.api.post(`${f.root}/start`).expect(200); await f.api.post(`${f.root}/start-round`).expect(200);
    startQuestion(db, f.room.id, Date.now());
    if (state === 'manual') pause.pauseGame(db, f.room.id);
    else pause.autoPauseForDisconnectedPlayer(db, f.room.id, f.identities[0].player.id);
    if (state === 'closed') await f.api.post(`${f.root}/close`).expect(200);
    if (state === 'submitted') db.prepare('INSERT INTO player_answers VALUES (?, ?, ?, ?, ?)').run(f.room.id, f.identities[0].player.id, f.question.id, f.options[0].id, new Date().toISOString());
    if (state === 'excluded') db.prepare('INSERT INTO question_exclusions VALUES (?, ?, ?)').run(f.room.id, f.question.id, f.identities[0].player.id);
    const before = row(db, f.room.id);
    const api = request(createApp(db, () => {}, () => true));
    for (const action of ['wait-for-player', 'continue-without-player']) await api.post(`/api/rooms/${state === 'missing' ? 'missing' : f.room.id}/${action}`).expect(state === 'missing' ? 404 : 409);
    assert.deepEqual(row(db, f.room.id), before);
  } finally { db.close(); }
});

test('two-player realtime smoke: Wait, Continue to Reveal, reconnect, and next-question participation', async () => {
  const db = initializeDatabase(':memory:');
  const f = await fixture(db);
  const roundId = String(db.prepare('SELECT round_id FROM questions WHERE id = ?').get(f.question.id)!.round_id);
  const questions = [{ question: f.question, options: f.options }];
  for (let n = 0; n < 2; n++) {
    const question = createQuestion(db, roundId);
    db.prepare("UPDATE questions SET text_ru = 'Вопрос', text_en = 'Question' WHERE id = ?").run(question.id);
    const options = [1, 0].map(correct => {
      const option = createOption(db, question.id);
      db.prepare("UPDATE answer_options SET text_ru = 'Ответ', text_en = 'Answer', is_correct = ? WHERE id = ?").run(correct, option.id);
      return option;
    });
    questions.push({ question, options });
  }
  db.prepare("UPDATE session_players SET removed_at = 'before start' WHERE id = ?").run(f.identities[2].player.id);
  const { server, io } = createQuizServer(db);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const api = request(server);
  const sockets: Socket[] = [];
  async function open(audience: string, token?: string) {
    const socket = connect(`http://127.0.0.1:${(server.address() as { port: number }).port}`, { transports: ['websocket'], forceNew: true });
    sockets.push(socket); await once(socket, 'connect');
    const reply = event(socket); socket.emit('lobby:subscribe', { roomId: f.room.id, audience, token }); await reply;
    return socket;
  }
  async function disconnect(socket: Socket) {
    const done = once(io.sockets.sockets.get(socket.id!)!, 'disconnect'); socket.disconnect(); await done;
  }
  async function submit(index: number, player: number) {
    await api.post(`${f.root}/answers`).send({ token: f.identities[player].token, questionId: questions[index].question.id, optionId: questions[index].options[0].id }).expect(200);
  }
  try {
    const host = await open('host'); await open('screen');
    let alice = await open('player', f.identities[0].token); await open('player', f.identities[1].token);
    await api.post(`${f.root}/start`).expect(200); await api.post(`${f.root}/start-round`).expect(200); await api.post(`${f.root}/start-question`).expect(200);
    // Refresh subscription to drain earlier Host states.
    const fresh = event(host); host.emit('lobby:subscribe', { roomId: f.room.id, audience: 'host' }); await fresh;
    const paused = event(host); await disconnect(alice); assert.equal((await paused).room.state, 'PAUSED');
    const frozen = row(db, f.room.id);
    await api.post(`${f.root}/wait-for-player`).expect(409);
    const returned = event(host); alice = await open('player', f.identities[0].token);
    assert.equal((await returned).game.disconnectedPlayer.present, true);
    assert.deepEqual(row(db, f.room.id), frozen);
    await api.post(`${f.root}/wait-for-player`).expect(200);
    const resumed = row(db, f.room.id);
    assert.equal(Date.parse(String(resumed.answer_deadline_at)) - Date.parse(String(resumed.answer_started_at)), frozen.paused_remaining_ms);
    await submit(0, 0); await submit(0, 1);
    await api.post(`${f.root}/next`).expect(200); await api.post(`${f.root}/start-question`).expect(200);
    await submit(1, 1); await disconnect(alice);
    assert.equal(row(db, f.room.id).state, 'PAUSED');
    await api.post(`${f.root}/continue-without-player`).expect(200);
    assert.equal(row(db, f.room.id).state, 'ANSWER_REVEAL'); assert.equal(row(db, f.room.id).answer_deadline_at, null);
    alice = await open('player', f.identities[0].token);
    const result = (await api.post(`${f.root}/reconnect`).send({ token: f.identities[0].token }).expect(200)).body.game;
    assert.deepEqual(result.result, { outcome: 'unanswered', points: 0 });
    assert.equal(result.submission.submitted, false);
    // Untimed direct Reveal remains manually pausable/resumable.
    await api.post(`${f.root}/pause`).expect(200); await api.post(`${f.root}/resume`).expect(200);
    await api.post(`${f.root}/next`).expect(200); await api.post(`${f.root}/start-question`).expect(200);
    const next = (await api.post(`${f.root}/reconnect`).send({ token: f.identities[0].token }).expect(200)).body.game;
    assert.equal(next.excluded, false); assert.equal(next.options.length, 2);
    assert.equal((await api.get(`${f.root}/game/host`)).body.game.answers.expected, 2);
    await disconnect(alice); assert.equal(row(db, f.room.id).state, 'PAUSED');
    alice = await open('player', f.identities[0].token);
    await api.post(`${f.root}/wait-for-player`).expect(200); await submit(2, 0); await submit(2, 1);
    assert.equal(row(db, f.room.id).state, 'ANSWER_REVEAL');
    await api.post(`${f.root}/close`).expect(200);
  } finally { sockets.forEach(socket => socket.disconnect()); await new Promise<void>(resolve => io.close(() => resolve())); db.close(); }
});

test('Continue rolls back exclusion and scores if scoring cannot commit', async () => {
  const db = initializeDatabase(':memory:');
  try {
    const f = await fixture(db);
    await f.api.post(`${f.root}/start`).expect(200); await f.api.post(`${f.root}/start-round`).expect(200);
    startQuestion(db, f.room.id, Date.now());
    for (const identity of f.identities.slice(1)) await f.api.post(`${f.root}/answers`).send({ token: identity.token, questionId: f.question.id, optionId: f.options[0].id }).expect(200);
    pause.autoPauseForDisconnectedPlayer(db, f.room.id, f.identities[0].player.id);
    const frozen = row(db, f.room.id);
    db.exec("CREATE TRIGGER reject_scoring BEFORE INSERT ON question_scores BEGIN SELECT RAISE(ABORT, 'scoring failure'); END");
    assert.throws(() => pause.continueWithoutPlayer(db, f.room.id), /scoring failure/);
    assert.deepEqual(row(db, f.room.id), frozen);
    assert.equal(db.prepare('SELECT count(*) n FROM question_exclusions').get()!.n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM question_scores').get()!.n, 0);
  } finally { db.close(); }
});
