import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { initializeDatabase } from './db.js';
import { createApp } from './app.js';
import { createQuiz } from './quizzes.js';
import { createRound } from './rounds.js';
import { createQuestion, createOption } from './questions.js';
import { startQuestion, getPlayerGame, getSurfaceState } from './game.js';
import { pauseGame, resumeGame } from './pause.js';
import { submitAnswer } from './answers.js';
import { createDeadlineManager } from './deadlines.js';
import { completeQuestion } from './reveal.js';

const epoch = Date.parse('2026-09-27T12:00:00Z');
async function setup(db: ReturnType<typeof initializeDatabase>) {
  const quiz = createQuiz(db);
  const round = createRound(db, quiz.id);
  db.prepare("UPDATE rounds SET title_ru = 'Раунд', title_en = 'Round' WHERE id = ?").run(round.id);
  const question = createQuestion(db, round.id);
  db.prepare("UPDATE questions SET text_ru = 'Вопрос', text_en = 'Question' WHERE id = ?").run(question.id);
  const options = [true, false].map(correct => {
    const option = createOption(db, question.id);
    db.prepare("UPDATE answer_options SET text_ru = 'Ответ', text_en = 'Answer', is_correct = ? WHERE id = ?").run(Number(correct), option.id);
    return option;
  });
  const broadcasts: string[] = [];
  const api = request(createApp(db, roomId => { db.exec('BEGIN IMMEDIATE; ROLLBACK'); broadcasts.push(roomId); }));
  const room = (await api.post(`/api/quizzes/${quiz.id}/rooms`).expect(201)).body;
  const identities = [];
  for (const name of ['Alice', 'Bob']) identities.push((await api.post(`/api/rooms/code/${room.code}/players`).send({ name, language: 'en' }).expect(201)).body);
  const root = `/api/rooms/${room.id}`;
  return { api, root, room, identities, question, options, broadcasts };
}
const session = (db: ReturnType<typeof initializeDatabase>) => db.prepare('SELECT * FROM game_sessions').get()!;

test('pause route rejects Lobby without broadcasting', async () => {
  const db = initializeDatabase(':memory:');
  try {
    const { api, root, broadcasts } = await setup(db);
    const before = broadcasts.length;
    await api.post(`${root}/pause`).expect(409);
    assert.equal(broadcasts.length, before);
  } finally { db.close(); }
});

for (const state of ['ROUND_INTRO', 'QUESTION', 'ANSWER_REVEAL', 'ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS']) {
  test(`Pause/Resume preserves ${state}, navigation, snapshot, answers and scores`, async () => {
    const db = initializeDatabase(':memory:');
    try {
      const { api, root, room, question, options, identities, broadcasts } = await setup(db);
      await api.post(`${root}/start`).expect(200);
      if (state !== 'ROUND_INTRO') await api.post(`${root}/start-round`).expect(200);
      if (!['ROUND_INTRO', 'QUESTION'].includes(state)) {
        startQuestion(db, room.id, epoch);
        for (const identity of identities) submitAnswer(db, room.id, { token: identity.token, questionId: question.id, optionId: options[0].id }, () => epoch + 100);
        if (state !== 'ANSWER_REVEAL') db.prepare('UPDATE game_sessions SET state = ?, answer_started_at = NULL, answer_deadline_at = NULL').run(state);
      }
      const before = session(db);
      const answers = db.prepare('SELECT * FROM player_answers').all();
      const scores = db.prepare('SELECT * FROM question_scores').all();
      const count = broadcasts.length;
      assert.equal((await api.post(`${root}/pause`).expect(200)).body.state, 'PAUSED');
      assert.equal(broadcasts.length, count + 1);
      assert.equal(session(db).paused_from_state, state);
      assert.equal(session(db).paused_remaining_ms, null);
      assert.ok(Date.parse(String(session(db).paused_at)));
      for (const audience of ['host', 'screen'] as const) {
        const projection = (await api.get(`${root}/game/${audience}`).expect(200)).body.game;
        assert.deepEqual(projection, { state: 'PAUSED', pausedFromState: state, remainingMs: null, ...(audience === 'host' ? { reason: 'manual', disconnectedPlayer: null } : {}) });
      }
      for (const action of ['pause', 'start', 'start-round', 'start-question', 'next', 'show-leaderboard', 'next-round', 'final-results', 'show-winner']) await api.post(`${root}/${action}`).expect(409);
      assert.equal((await api.post(`${root}/resume`).expect(200)).body.state, state);
      await api.post(`${root}/resume`).expect(409);
      assert.deepEqual(session(db), before);
      assert.deepEqual(db.prepare('SELECT * FROM player_answers').all(), answers);
      assert.deepEqual(db.prepare('SELECT * FROM question_scores').all(), scores);
    } finally { db.close(); }
  });
}

test('Answering freezes ten seconds across DB reopen; rejects Submit; resumes and expires once at new deadline', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'quiz-pause-'));
  const path = join(directory, 'quiz.sqlite');
  let db = initializeDatabase(path);
  try {
    const { api, root, room, question, options, identities } = await setup(db);
    await api.post(`${root}/start`).expect(200);
    await api.post(`${root}/start-round`).expect(200);
    startQuestion(db, room.id, epoch);
    const input = { token: identities[0].token, questionId: question.id, optionId: options[0].id };
    assert.ok('submission' in submitAnswer(db, room.id, input, () => epoch + 100));
    const deadline = Date.parse(String(session(db).answer_deadline_at));
    let now = deadline - 10000;
    const jobs: { callback: () => void; delay: number; cancelled: boolean }[] = [];
    let changes = 0;
    const optionsClock = { clock: () => now, schedule: (callback: () => void, delay: number) => {
      const job = { callback, delay, cancelled: false }; jobs.push(job); return () => { job.cancelled = true; };
    } };
    let manager = createDeadlineManager(db, () => { changes++; }, optionsClock);
    manager.recover();
    assert.equal(jobs.length, 1);
    assert.ok('room' in pauseGame(db, room.id, () => now));
    manager.sync(room.id);
    assert.equal(jobs[0].cancelled, true);
    assert.equal(session(db).paused_remaining_ms, 10000);
    assert.equal(session(db).answer_deadline_at, null);
    assert.equal(session(db).answer_started_at, null);
    const frozen = session(db);
    const answers = db.prepare('SELECT * FROM player_answers').all();
    const scores = db.prepare('SELECT * FROM question_scores').all();
    now += 600000;
    jobs[0].callback();
    assert.equal(completeQuestion(db, room.id, () => now), false);
    assert.equal(changes, 0);
    for (const identity of identities) {
      assert.equal((submitAnswer(db, room.id, { ...input, token: identity.token }, () => now) as { status: number }).status, 409);
    }
    manager.stop(); db.close(); db = initializeDatabase(path);
    assert.deepEqual(session(db), frozen);
    assert.deepEqual(db.prepare('SELECT * FROM player_answers').all(), answers);
    assert.deepEqual(db.prepare('SELECT * FROM question_scores').all(), scores);
    manager = createDeadlineManager(db, () => { changes++; }, optionsClock);
    manager.recover();
    assert.equal(jobs.length, 1);
    assert.equal(getSurfaceState(db, room.id, 'screen', now)!.room.state, 'PAUSED');
    assert.ok('room' in resumeGame(db, room.id, () => now));
    manager.sync(room.id);
    assert.equal(jobs.length, 2);
    assert.equal(jobs[1].delay, 10000);
    assert.equal(session(db).answer_started_at, new Date(now).toISOString());
    assert.equal(session(db).answer_deadline_at, new Date(now + 10000).toISOString());
    assert.equal(session(db).paused_at, null);
    assert.equal(session(db).paused_from_state, null);
    assert.equal(session(db).paused_remaining_ms, null);
    const player = getPlayerGame(db, room.id, 'en', identities[0].player.id, now)!;
    assert.deepEqual(player.submission, { submitted: true, optionId: options[0].id });
    assert.equal(player.timer!.remainingMs, 10000);
    assert.equal(player.timer!.durationSeconds, 10);
    jobs[0].callback(); // Cancelled before Pause: cannot interfere with the resumed timer.
    assert.equal(jobs.length, 2);
    manager.stop(); db.close(); db = initializeDatabase(path);
    manager = createDeadlineManager(db, () => { changes++; }, optionsClock);
    manager.recover();
    assert.equal(jobs.length, 3);
    assert.equal(jobs[2].delay, 10000);
    now += 10000;
    jobs[2].callback(); jobs[2].callback();
    assert.equal(session(db).state, 'ANSWER_REVEAL');
    assert.equal(changes, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM question_scores').get()!.n, 2);
    assert.deepEqual(db.prepare('SELECT * FROM player_answers').all(), answers);
    manager.stop();
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const offset of [-1, 0, 1]) test(`Pause expiry boundary at deadline ${offset}ms`, async () => {
  const db = initializeDatabase(':memory:');
  try {
    const { api, root, room } = await setup(db);
    await api.post(`${root}/start`).expect(200);
    await api.post(`${root}/start-round`).expect(200);
    startQuestion(db, room.id, epoch);
    const deadline = Date.parse(String(session(db).answer_deadline_at));
    const result = pauseGame(db, room.id, () => deadline + offset);
    if (offset < 0) {
      assert.ok('room' in result);
      assert.equal(session(db).paused_remaining_ms, 1);
      assert.equal(db.prepare('SELECT count(*) n FROM question_scores').get()!.n, 0);
      resumeGame(db, room.id, () => deadline + 60000);
      assert.equal(Date.parse(String(session(db).answer_deadline_at)), deadline + 60001);
    } else {
      assert.ok('status' in result);
      assert.equal(result.status, 409);
      assert.equal(session(db).state, 'ANSWER_REVEAL');
      assert.equal(session(db).paused_from_state, null);
      assert.equal(completeQuestion(db, room.id, () => deadline + offset), false);
      assert.equal(db.prepare('SELECT count(*) n FROM question_scores').get()!.n, 2);
      assert.equal(db.prepare('SELECT sum(awarded_points) n FROM question_scores').get()!.n, 0);
    }
  } finally { db.close(); }
});

test('expired Pause broadcasts committed Reveal; missing/closed/winner commands conflict safely', async () => {
  const db = initializeDatabase(':memory:');
  try {
    const { api, root, room, broadcasts } = await setup(db);
    await api.post('/api/rooms/missing/pause').expect(404);
    await api.post('/api/rooms/missing/resume').expect(404);
    await api.post(`${root}/resume`).expect(409);
    await api.post(`${root}/start`).expect(200);
    await api.post(`${root}/start-round`).expect(200);
    startQuestion(db, room.id, 0);
    const count = broadcasts.length;
    await api.post(`${root}/pause`).expect(409);
    assert.equal(broadcasts.length, count + 1);
    assert.equal(session(db).state, 'ANSWER_REVEAL');
    db.exec("UPDATE game_sessions SET state = 'WINNER_SCREEN', answer_started_at = NULL, answer_deadline_at = NULL");
    await api.post(`${root}/pause`).expect(409);
    db.exec("UPDATE game_sessions SET state = 'FINAL_RESULTS'");
    await api.post(`${root}/pause`).expect(200);
    await api.post(`${root}/close`).expect(200);
    await api.post(`${root}/resume`).expect(409);
    await api.post(`${root}/pause`).expect(409);
    assert.equal((await api.get(`${root}/game/screen`)).body.game, null);
    assert.equal(completeQuestion(db, room.id, () => epoch), false);
  } finally { db.close(); }
});

test('SQLite rejects incomplete pause metadata, incompatible navigation and invalid frozen timers', async () => {
  const db = initializeDatabase(':memory:');
  try {
    const { api, root, room } = await setup(db);
    await api.post(`${root}/start`).expect(200);
    assert.throws(() => db.exec("UPDATE game_sessions SET paused_at = '2026-09-27T12:00:00Z'"), /CHECK/);
    assert.throws(() => db.exec("UPDATE game_sessions SET state = 'PAUSED'"), /CHECK/);
    pauseGame(db, room.id, () => epoch);
    for (const update of ["paused_from_state = NULL", "paused_from_state = 'LOBBY'", "paused_from_state = 'WINNER_SCREEN'", "paused_at = NULL", "paused_at = 'invalid'", "paused_remaining_ms = 1", "current_question_index = 0", "state = 'ROUND_INTRO'"]) {
      assert.throws(() => db.exec(`UPDATE game_sessions SET ${update}`), /CHECK/);
    }
    resumeGame(db, room.id, () => epoch);
    await api.post(`${root}/start-round`).expect(200);
    startQuestion(db, room.id, epoch);
    pauseGame(db, room.id, () => epoch + 1000);
    for (const update of ["paused_remaining_ms = NULL", "paused_remaining_ms = 0", "paused_remaining_ms = -1", "paused_remaining_ms = 0.5", "current_question_index = NULL", "answer_deadline_at = '2026-09-27T12:01:00Z'"]) {
      assert.throws(() => db.exec(`UPDATE game_sessions SET ${update}`), /CHECK/);
    }
  } finally { db.close(); }
});

test('migration 12 preserves every migration 11 state and all dependent rows', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'quiz-pause-migration-'));
  const path = join(directory, 'quiz.sqlite');
  let db = initializeDatabase(path);
  try {
    for (const state of ['LOBBY', 'ROUND_INTRO', 'QUESTION', 'ANSWERING', 'ANSWER_REVEAL', 'ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS', 'WINNER_SCREEN']) {
      const { api, root, room, question, options, identities } = await setup(db);
      if (state === 'LOBBY') continue;
      await api.post(`${root}/start`).expect(200);
      if (state === 'ROUND_INTRO') continue;
      await api.post(`${root}/start-round`).expect(200);
      if (state === 'QUESTION') continue;
      startQuestion(db, room.id, epoch);
      if (state === 'ANSWERING') continue;
      for (const identity of identities) submitAnswer(db, room.id, { token: identity.token, questionId: question.id, optionId: options[0].id }, () => epoch + 1);
      if (state !== 'ANSWER_REVEAL') db.prepare('UPDATE game_sessions SET state = ?, answer_started_at = NULL, answer_deadline_at = NULL WHERE id = ?').run(state, room.id);
    }
    const tables = ['game_sessions', 'session_players', 'player_answers', 'question_scores'];
    const before = Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
    const source = readFileSync(new URL('./db.ts', import.meta.url), 'utf8');
    const schema = source.split('version: 11,')[1].split('sql: `')[1].split('INSERT INTO game_sessions_new')[0]
      .replace('CREATE TABLE game_sessions_new', 'CREATE TABLE old_sessions');
    const columns = 'id, code, quiz_id, state, created_at, closed_at, snapshot_json, roster_locked_at, current_round_index, current_question_index, answer_started_at, answer_deadline_at';
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`${schema} INSERT INTO old_sessions SELECT ${columns} FROM game_sessions;
      DROP TRIGGER delete_quiz_lobbies; DROP TABLE game_sessions; ALTER TABLE old_sessions RENAME TO game_sessions;
      CREATE UNIQUE INDEX game_sessions_active_code ON game_sessions(code) WHERE closed_at IS NULL;
      CREATE TRIGGER delete_quiz_lobbies BEFORE DELETE ON quizzes BEGIN DELETE FROM game_sessions WHERE quiz_id = OLD.id AND state = 'LOBBY'; END;
      DROP TABLE question_exclusions; DELETE FROM schema_migrations WHERE version >= 12 AND version < 17`);
    db.exec('ALTER TABLE questions DROP COLUMN show_correct_count; DELETE FROM schema_migrations WHERE version = 20');
    db.close(); db = initializeDatabase(path);
    for (const table of tables) assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all(), before[table]);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('live Pause/Resume reaches all audiences, subscription restores Pause, and closure cancels the timer', async () => {
  const { once } = await import('node:events');
  const { io: connect } = await import('socket.io-client');
  const { createQuizServer } = await import('./realtime.js');
  const db = initializeDatabase(':memory:');
  const fixture = await setup(db);
  await fixture.api.post(`${fixture.root}/start`).expect(200);
  const { server, io, deadlines } = createQuizServer(db);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const sockets = ['host', 'screen', 'player'].map(() => connect(url, { transports: ['websocket'], forceNew: true }));
  const api = request(server);
  const next = (socket: typeof sockets[number]) => new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Missing pause broadcast')), 3000);
    socket.once('lobby:state', state => { clearTimeout(timeout); resolve(state); });
  });
  try {
    await Promise.all(sockets.map(socket => once(socket, 'connect')));
    await Promise.all(sockets.map(async (socket, index) => {
      const response = next(socket);
      socket.emit('lobby:subscribe', { roomId: fixture.room.id, audience: ['host', 'screen', 'player'][index], ...(index === 2 ? { token: fixture.identities[0].token } : {}) });
      await response;
    }));
    async function command(action: string, expected: string) {
      const updates = sockets.map(next);
      await api.post(`${fixture.root}/${action}`).expect(200);
      const states = await Promise.all(updates);
      states.forEach((state, index) => {
        assert.equal(state.room.state, expected);
        if (index < 2) assert.equal(state.game.state, expected);
        else assert.deepEqual(Object.keys(state), ['room']);
      });
    }
    await command('pause', 'PAUSED'); await command('resume', 'ROUND_INTRO');
    await command('start-round', 'QUESTION'); await command('start-question', 'ANSWERING');
    await command('pause', 'PAUSED');
    for (const [index, socket] of sockets.entries()) {
      socket.disconnect(); socket.connect(); await once(socket, 'connect');
      const restored = next(socket);
      socket.emit('lobby:subscribe', { roomId: fixture.room.id, audience: ['host', 'screen', 'player'][index], ...(index === 2 ? { token: fixture.identities[0].token } : {}) });
      assert.equal((await restored).room.state, 'PAUSED');
    }
    await command('resume', 'ANSWERING'); await command('pause', 'PAUSED');
    const updates = sockets.map(next);
    await api.post(`${fixture.root}/close`).expect(200);
    for (const state of await Promise.all(updates)) assert.ok(state.room.closedAt);
    await api.post(`${fixture.root}/resume`).expect(409);
  } finally {
    sockets.forEach(socket => socket.disconnect()); deadlines.stop();
    await new Promise<void>(resolve => io.close(() => resolve())); db.close();
  }
});

test('paused Reveal reload preserves scored answers and completed timer context', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'quiz-paused-reveal-'));
  const path = join(directory, 'quiz.sqlite');
  let db = initializeDatabase(path);
  try {
    const { api, root, room, question, options, identities } = await setup(db);
    await api.post(`${root}/start`).expect(200);
    await api.post(`${root}/start-round`).expect(200);
    startQuestion(db, room.id, epoch);
    for (const identity of identities) submitAnswer(db, room.id, { token: identity.token, questionId: question.id, optionId: options[0].id }, () => epoch + 1);
    pauseGame(db, room.id, () => epoch + 2);
    const tables = ['game_sessions', 'session_players', 'player_answers', 'question_scores'];
    const before = Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
    db.close(); db = initializeDatabase(path);
    for (const table of tables) assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all(), before[table]);
    assert.equal(session(db).paused_from_state, 'ANSWER_REVEAL');
    assert.equal(session(db).answer_started_at, new Date(epoch).toISOString());
    resumeGame(db, room.id, () => epoch + 600000);
    const restored = getPlayerGame(db, room.id, 'en', identities[0].player.id)!;
    assert.equal(restored.state, 'ANSWER_REVEAL');
    assert.equal(restored.result!.outcome, 'correct');
    assert.deepEqual(restored.submission, { submitted: true, optionId: options[0].id });
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
