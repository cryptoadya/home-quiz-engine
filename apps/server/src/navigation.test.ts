import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { io as connect, type Socket } from 'socket.io-client';
import { createQuizServer } from './realtime.js';
import { test } from 'node:test';
import request from 'supertest';
import { initializeDatabase } from './db.js';
import { createApp } from './app.js';
import { createQuiz } from './quizzes.js';
import { createRound } from './rounds.js';
import { createQuestion, createOption } from './questions.js';
import { getLeaderboard, navigate } from './navigation.js';
import { getSurfaceState } from './game.js';

async function setup(db: ReturnType<typeof initializeDatabase>, players = ['Alice', 'Bob']) {
  const quiz = createQuiz(db);
  const rounds = [0, 1].map(i => {
    const round = createRound(db, quiz.id);
    db.prepare('UPDATE rounds SET title_ru = ?, title_en = ?, show_leaderboard_after = ? WHERE id = ?').run(`Раунд ${i}`, `Round ${i}`, i === 0 ? 1 : 0, round.id);
    const questions = Array.from({ length: i === 0 ? 2 : 1 }, (_, j) => {
      const question = createQuestion(db, round.id);
      db.prepare('UPDATE questions SET text_ru = ?, text_en = ?, points = ? WHERE id = ?').run(`Вопрос ${i}/${j}`, `Question ${i}/${j}`, j === 0 ? 3 : 2, question.id);
      const options = [true, false].map(correct => {
        const option = createOption(db, question.id);
        db.prepare('UPDATE answer_options SET text_ru = ?, text_en = ?, is_correct = ? WHERE id = ?').run('Ответ', 'Answer', Number(correct), option.id);
        return option;
      });
      return { ...question, options };
    });
    return { ...round, questions };
  });
  const broadcasts: string[] = [];
  const api = request(createApp(db, roomId => {
    // Callback must only see fully committed data.
    db.exec('BEGIN IMMEDIATE; ROLLBACK');
    broadcasts.push(roomId);
  }));
  const room = (await api.post(`/api/quizzes/${quiz.id}/rooms`).expect(201)).body;
  const identities = [];
  for (const name of players) identities.push((await api.post(`/api/rooms/code/${room.code}/players`).send({ name, language: 'en' }).expect(201)).body);
  await api.post(`/api/rooms/${room.id}/start`).expect(200);
  return { api, room, quiz, rounds, identities, broadcasts };
}

for (const tied of [false, true]) test(`complete frozen multi-round loop, durable boundaries and ${tied ? 'tied winners' : 'single winner'}`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'quiz-navigation-'));
  const path = join(directory, 'quiz.sqlite');
  let db = initializeDatabase(path);
  try {
    const fixture = await setup(db);
    const { room, rounds, identities, quiz } = fixture;
    let api = fixture.api;
    const root = `/api/rooms/${room.id}`;
    const frozen = db.prepare('SELECT snapshot_json FROM game_sessions').get()!.snapshot_json;
    db.exec("UPDATE questions SET text_en = 'EDITED'; UPDATE rounds SET show_leaderboard_after = 0");
    await api.delete(`/api/quizzes/${quiz.id}`).expect(204);
    async function restore(expected: string) {
      const before = (await api.get(`${root}/game/host`).expect(200)).body;
      assert.equal(before.room.state, expected);
      db.close(); db = initializeDatabase(path); api = request(createApp(db));
      assert.deepEqual((await api.get(`${root}/game/host`).expect(200)).body, before);
      assert.equal((await api.get(`${root}/game/screen`).expect(200)).body.game.state, expected);
      const player = (await api.post(`${root}/reconnect`).send({ token: identities[0].token }).expect(200)).body;
      assert.equal(player.room.state, expected);
      assert.equal(db.prepare('SELECT snapshot_json FROM game_sessions').get()!.snapshot_json, frozen);
    }
    async function play(round: number, question: number) {
      await api.post(`${root}/start-question`).expect(200);
      const q = rounds[round].questions[question];
      for (const [index, identity] of identities.entries()) {
        await api.post(`${root}/answers`).send({ token: identity.token, questionId: q.id, optionId: q.options[tied || index === 0 ? 0 : 1].id }).expect(200);
      }
      assert.equal((await api.get(root)).body.state, 'ANSWER_REVEAL');
    }
    await api.post(`${root}/start-round`).expect(200);
    const broadcastCount = fixture.broadcasts.length;
    for (const action of ['next', 'show-leaderboard', 'next-round', 'final-results', 'show-winner']) await api.post(`${root}/${action}`).expect(409);
    assert.equal(fixture.broadcasts.length, broadcastCount);
    await play(0, 0);
    assert.equal((await api.get(`${root}/game/host`)).body.game.nextAction, 'next');
    const scoresBefore = db.prepare('SELECT * FROM question_scores').all();
    const answersBefore = db.prepare('SELECT * FROM player_answers').all();
    await api.post(`${root}/next`).expect(200);
    assert.deepEqual({ ...db.prepare('SELECT current_round_index, current_question_index, answer_started_at, answer_deadline_at FROM game_sessions').get()! },
      { current_round_index: 0, current_question_index: 1, answer_started_at: null, answer_deadline_at: null });
    assert.deepEqual(db.prepare('SELECT * FROM question_scores').all(), scoresBefore);
    assert.deepEqual(db.prepare('SELECT * FROM player_answers').all(), answersBefore);
    const questionProjection = (await api.get(`${root}/game/screen`)).body.game;
    assert.equal(questionProjection.state, 'QUESTION');
    assert.equal(questionProjection.textEn, 'Question 0/1');
    assert.equal(questionProjection.timer, undefined);
    await api.post(`${root}/next`).expect(409);
    await play(0, 1);
    await api.post(`${root}/next`).expect(200);
    await restore('ROUND_END');
    assert.equal((await api.get(`${root}/game/host`)).body.game.nextAction, 'show-leaderboard');
    await api.post(`${root}/next-round`).expect(409);
    await api.post(`${root}/final-results`).expect(409);
    await api.post(`${root}/show-leaderboard`).expect(200);
    await restore('LEADERBOARD');
    const standings = (await api.get(`${root}/game/host`)).body.game.leaderboard;
    assert.deepEqual(standings.map((p: { totalPoints: number }) => p.totalPoints), tied ? [5, 5] : [5, 0]);
    await api.post(`${root}/show-leaderboard`).expect(409);
    await api.post(`${root}/next-round`).expect(200);
    assert.equal((await api.get(root)).body.state, 'ROUND_INTRO');
    assert.deepEqual({ ...db.prepare('SELECT current_round_index, current_question_index, answer_started_at, answer_deadline_at FROM game_sessions').get()! },
      { current_round_index: 1, current_question_index: null, answer_started_at: null, answer_deadline_at: null });
    assert.equal(db.prepare('SELECT count(*) n FROM question_scores').get()!.n, 4);
    await api.post(`${root}/start-round`).expect(200);
    await play(1, 0);
    await api.post(`${root}/next`).expect(200);
    await api.post(`${root}/show-leaderboard`).expect(409);
    await api.post(`${root}/next-round`).expect(409);
    assert.equal((await api.get(`${root}/game/host`)).body.game.nextAction, 'final-results');
    await api.post(`${root}/show-winner`).expect(409);
    await api.post(`${root}/final-results`).expect(200);
    await restore('FINAL_RESULTS');
    const final = (await api.get(`${root}/game/screen`)).body.game;
    assert.deepEqual(final.leaderboard.map((p: { totalPoints: number }) => p.totalPoints), tied ? [8, 8] : [8, 0]);
    await api.post(`${root}/final-results`).expect(409);
    await api.post(`${root}/show-winner`).expect(200);
    await restore('WINNER_SCREEN');
    const winners = (await api.get(`${root}/game/screen`)).body.game.leaderboard;
    assert.equal(winners.length, tied ? 2 : 1);
    assert.ok(winners.every((p: { rank: number; totalPoints: number }) => p.rank === 1 && p.totalPoints === 8));
    await api.post(`${root}/show-winner`).expect(409);
    await api.post(`${root}/close`).expect(200);
    for (const action of ['next', 'show-leaderboard', 'next-round', 'final-results', 'show-winner']) await api.post(`${root}/${action}`).expect(409);
    assert.equal((await api.get(`${root}/game/host`)).body.game, null);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('standings derive 1,1,3 ranks with stable joined/ID order, zero totals and roster filtering', async () => {
  const db = initializeDatabase(':memory:');
  try {
    const { room, identities, rounds } = await setup(db, ['Alice', 'Bob', 'Carol', 'Removed', 'Nonroster']);
    db.prepare('UPDATE session_players SET removed_at = ? WHERE id = ?').run('now', identities[3].player.id);
    db.prepare('UPDATE session_players SET in_roster = 0 WHERE id = ?').run(identities[4].player.id);
    identities.forEach((identity, index) => {
      db.prepare('UPDATE session_players SET joined_at = ? WHERE id = ?').run(`2026-09-27T00:00:0${index}.000Z`, identity.player.id);
      if (index !== 2) db.prepare("INSERT INTO question_scores VALUES (?, ?, ?, 'correct', ?)").run(room.id, rounds[0].questions[0].id, identity.player.id, index < 2 ? 10 : 100);
    });
    const standings = getLeaderboard(db, room.id);
    assert.deepEqual(standings.map(p => [p.displayName, p.totalPoints, p.rank]), [['Alice', 10, 1], ['Bob', 10, 1], ['Carol', 0, 3]]);
    db.exec("UPDATE session_players SET joined_at = 'same'");
    assert.deepEqual(getLeaderboard(db, room.id).slice(0, 2).map(p => p.playerId), identities.slice(0, 2).map(p => p.player.id).sort());
    // Invalid frozen indexes roll back rather than overflow into a completed boundary.
    db.exec("UPDATE game_sessions SET state = 'ANSWER_REVEAL', current_question_index = 99, answer_started_at = '2026-09-27T00:00:00Z', answer_deadline_at = '2026-09-27T00:00:30Z'");
    assert.equal('status' in navigate(db, room.id, 'next'), true);
    assert.equal(db.prepare('SELECT state FROM game_sessions').get()!.state, 'ANSWER_REVEAL');
    assert.equal(getSurfaceState(db, room.id, 'player')!.room.state, 'ANSWER_REVEAL');
  } finally { db.close(); }
});

test('navigation broadcasts committed projections to every audience and socket reconnect restores the final boundary', async () => {
  const db = initializeDatabase(':memory:');
  const { room, rounds, identities } = await setup(db);
  const { server, io, deadlines } = createQuizServer(db);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const sockets = ['host', 'screen', 'player'].map(() => connect(url, { transports: ['websocket'], forceNew: true }));
  const api = request(server);
  const root = `/api/rooms/${room.id}`;
  const nextState = (socket: Socket) => new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Missing navigation broadcast')), 3000);
    socket.once('lobby:state', state => { clearTimeout(timeout); resolve(state); });
  });
  try {
    await Promise.all(sockets.map(socket => once(socket, 'connect')));
    await Promise.all(sockets.map(async (socket, index) => {
      const state = nextState(socket);
      socket.emit('lobby:subscribe', { roomId: room.id, audience: ['host', 'screen', 'player'][index], ...(index === 2 ? { token: identities[0].token } : {}) });
      assert.equal((await state).room.state, 'ROUND_INTRO');
    }));
    async function command(action: string, expected: string) {
      const updates = sockets.map(nextState);
      await api.post(`${root}/${action}`).expect(200);
      const states = await Promise.all(updates);
      assert.equal(db.prepare('SELECT state FROM game_sessions').get()!.state, expected);
      states.forEach((state, index) => {
        assert.equal(state.room.state, expected);
        if (index < 2) assert.equal(state.game.state, expected);
        else assert.deepEqual(Object.keys(state), ['room']);
      });
    }
    for (const [roundIndex, round] of rounds.entries()) {
      await command('start-round', 'QUESTION');
      for (const [questionIndex, question] of round.questions.entries()) {
        await command('start-question', 'ANSWERING');
        for (const identity of identities) await api.post(`${root}/answers`).send({ token: identity.token, questionId: question.id, optionId: question.options[0].id }).expect(200);
        await command('next', questionIndex + 1 < round.questions.length ? 'QUESTION' : 'ROUND_END');
      }
      if (roundIndex === 0) { await command('show-leaderboard', 'LEADERBOARD'); await command('next-round', 'ROUND_INTRO'); }
      else { await command('final-results', 'FINAL_RESULTS'); await command('show-winner', 'WINNER_SCREEN'); }
    }
    sockets[1].disconnect();
    const restored = nextState(sockets[1]);
    sockets[1].connect(); await once(sockets[1], 'connect');
    sockets[1].emit('lobby:subscribe', { roomId: room.id, audience: 'screen' });
    assert.equal((await restored).game.state, 'WINNER_SCREEN');
  } finally {
    sockets.forEach(socket => socket.disconnect()); deadlines.stop();
    await new Promise<void>(resolve => io.close(() => resolve())); db.close();
  }
});

test('Phase 3E parent-table migration preserves Reveal state, scores, answers and foreign keys', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'quiz-navigation-migration-'));
  const path = join(directory, 'quiz.sqlite');
  let db = initializeDatabase(path);
  try {
    const { room, rounds, identities, api } = await setup(db);
    const root = `/api/rooms/${room.id}`;
    await api.post(`${root}/start-round`).expect(200);
    await api.post(`${root}/start-question`).expect(200);
    for (const identity of identities) await api.post(`${root}/answers`).send({ token: identity.token, questionId: rounds[0].questions[0].id, optionId: rounds[0].questions[0].options[0].id }).expect(200);
    const before = Object.fromEntries(['game_sessions', 'session_players', 'player_answers', 'question_scores'].map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
    // Restore the Phase 3D parent table constraints before applying migration 11.
    const migrationSource = readFileSync(new URL('./db.ts', import.meta.url), 'utf8');
    const migration10 = migrationSource.split('version: 10,')[1].split('version: 11,')[0];
    const schema = migration10.split('sql: `')[1].split('INSERT INTO game_sessions_new')[0]
      .replace('CREATE TABLE game_sessions_new', 'CREATE TABLE old_sessions');
    const columns = 'id, code, quiz_id, state, created_at, closed_at, snapshot_json, roster_locked_at, current_round_index, current_question_index, answer_started_at, answer_deadline_at';
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`${schema}; INSERT INTO old_sessions SELECT ${columns} FROM game_sessions;
      DROP TRIGGER delete_quiz_lobbies; DROP TABLE game_sessions; ALTER TABLE old_sessions RENAME TO game_sessions;
      CREATE UNIQUE INDEX game_sessions_active_code ON game_sessions(code) WHERE closed_at IS NULL;
      CREATE TRIGGER delete_quiz_lobbies BEFORE DELETE ON quizzes BEGIN DELETE FROM game_sessions WHERE quiz_id = OLD.id AND state = 'LOBBY'; END;
      DROP TABLE question_exclusions; DELETE FROM schema_migrations WHERE version >= 11 AND version < 17`);
    db.exec('ALTER TABLE questions DROP COLUMN media_json; DROP TABLE media; DELETE FROM schema_migrations WHERE version = 21; ALTER TABLE questions DROP COLUMN show_correct_count; DELETE FROM schema_migrations WHERE version = 20');
    db.close(); db = initializeDatabase(path);
    for (const [table, rows] of Object.entries(before)) assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all(), rows);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    const result = navigate(db, room.id, 'next');
    assert.ok('room' in result);
    assert.equal(result.room.state, 'QUESTION');
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
