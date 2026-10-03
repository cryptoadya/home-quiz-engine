import assert from 'node:assert/strict';
import { test } from 'node:test';
import request from 'supertest';
import { initializeDatabase } from './db.js';
import { createApp } from './app.js';
import { createQuiz } from './quizzes.js';
import { createRound } from './rounds.js';
import { createQuestion, createOption } from './questions.js';
import { autoPauseForDisconnectedPlayer } from './pause.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportQuizArchive, importQuizArchive } from './quiz-archive.js';
import { listRounds } from './rounds.js';
import { completeQuestion } from './reveal.js';

async function setup(db: ReturnType<typeof initializeDatabase>, reserveCount = 3, tied = true) {
  const api = request(createApp(db));
  const quiz = createQuiz(db);
  const reserve = createRound(db, quiz.id); // Reserve may precede regular rounds in the editor.
  const { id, quizId, position, createdAt, updatedAt, ...fields } = reserve;
  await api.put(`/api/quizzes/${quiz.id}/rounds/${id}`).send({ ...fields, isTiebreak: true }).expect(200);
  const main = createRound(db, quiz.id);
  function question(roundId: string) {
    const q = createQuestion(db, roundId);
    db.prepare('UPDATE questions SET text_ru = ?, text_en = ? WHERE id = ?').run('Вопрос', 'Question', q.id);
    const options = [true, false].map(correct => {
      const o = createOption(db, q.id);
      db.prepare('UPDATE answer_options SET text_ru = ?, text_en = ?, is_correct = ? WHERE id = ?').run(correct ? 'Да' : 'Нет', correct ? 'Yes' : 'No', Number(correct), o.id);
      return o.id;
    });
    return { id: q.id, options };
  }
  const extras = Array.from({ length: reserveCount }, () => question(reserve.id));
  const regular = question(main.id);
  const room = (await api.post(`/api/quizzes/${quiz.id}/rooms`).expect(201)).body;
  const root = `/api/rooms/${room.id}`;
  const players = [];
  for (const name of ['Alice', 'Bob', 'Charlie', 'Spectator']) players.push((await api.post(`/api/rooms/code/${room.code}/players`).send({ name, language: 'en' }).expect(201)).body);
  await api.post(`${root}/start`).expect(200);
  assert.equal((await api.get(`${root}/game/host`)).body.game.roundNumber, 1);
  await api.post(`${root}/start-round`).expect(200);
  await api.post(`${root}/start-question`).expect(200);
  for (const [i, p] of players.entries()) await api.post(`${root}/answers`).send({ token: p.token, questionId: regular.id, optionId: regular.options[i < (tied ? 3 : 1) ? 0 : 1] }).expect(200);
  await api.post(`${root}/next`).expect(200);
  assert.equal((await api.get(`${root}/game/host`)).body.game.nextAction, 'final-results');
  await api.post(`${root}/final-results`).expect(200);
  return { api, root, room, players, extras, quiz };
}

test('only first-place finalists answer reserve questions; elimination and winner do not change main points', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quiz-tiebreak-'));
  const path = join(dir, 'quiz.sqlite');
  let db = initializeDatabase(path);
  try {
    const fixture = await setup(db);
    let api = fixture.api;
    const { root, room, players, extras, quiz } = fixture;
    const archive = await exportQuizArchive(db, quiz.id);
    try {
      const copy = await importQuizArchive(db, archive.path);
      assert.deepEqual(listRounds(db, copy.id).map(r => Boolean(r.isTiebreak)), [true, false]);
    } finally { archive.cleanup(); }
    const before = (await api.get(`${root}/game/host`)).body.game.leaderboard;
    assert.equal((await api.get(`${root}/game/host`)).body.game.canStartTiebreak, true);
    await api.post(`${root}/start-tiebreak`).expect(200);
    await api.post(`${root}/start-tiebreak`).expect(409);
    await api.post(`${root}/players/${players[0].player.id}/kick`).send({ confirmed: true }).expect(409);
    await api.delete(`/api/quizzes/${quiz.id}`).expect(204); // Uses frozen reserve content.
    async function play(index: number, answers: number[]) {
      await api.post(`${root}/start-question`).expect(200);
      const q = extras[index];
      assert.equal((await api.post(`${root}/reconnect`).send({ token: players[3].token })).body.game, null);
      await api.post(`${root}/answers`).send({ token: players[3].token, questionId: q.id, optionId: q.options[0] }).expect(409);
      assert.equal(autoPauseForDisconnectedPlayer(db, room.id, players[3].player.id), false);
      for (const [i, a] of answers.entries()) await api.post(`${root}/answers`).send({ token: players[i].token, questionId: q.id, optionId: q.options[a] }).expect(200);
      assert.equal((await api.get(root)).body.state, 'ANSWER_REVEAL');
      assert.equal((await api.get(`${root}/game/screen`)).body.game.statistics.unanswered, 0);
    }
    await play(0, [1, 1, 1]); // All wrong: nobody is eliminated.
    await api.post(`${root}/next`).expect(200);
    await play(1, [0, 0, 1]); // Two contenders remain.
    await api.post(`${root}/next`).expect(200);
    db.close(); db = initializeDatabase(path); api = request(createApp(db));
    assert.equal((await api.get(root)).body.tiebreak.contenderIds.length, 2);
    await api.post(`${root}/start-question`).expect(200);
    const q = extras[2];
    await api.post(`${root}/answers`).send({ token: players[2].token, questionId: q.id, optionId: q.options[0] }).expect(409);
    for (const [i, a] of [1, 0].entries()) await api.post(`${root}/answers`).send({ token: players[i].token, questionId: q.id, optionId: q.options[a] }).expect(200);
    await api.post(`${root}/next`).expect(200);
    assert.equal((await api.get(root)).body.state, 'FINAL_RESULTS');
    assert.deepEqual((await api.get(`${root}/game/host`)).body.game.leaderboard, before);
    await api.post(`${root}/show-winner`).expect(200);
    assert.deepEqual((await api.get(`${root}/game/screen`)).body.game.leaderboard.map((p: { displayName: string }) => p.displayName), ['Bob']);
    const history = (await api.get('/api/history')).body;
    assert.deepEqual(history[0].tiebreak.winnerIds, [players[1].player.id]);
    assert.deepEqual(history[0].players.map((p: { totalPoints: number }) => p.totalPoints), [1, 1, 1, 0]);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a timed-out reserve question scores only finalists and all unanswered finalists continue', async () => {
  const db = initializeDatabase(':memory:');
  try {
    const { api, root, room, players } = await setup(db);
    await api.post(`${root}/start-tiebreak`).expect(200);
    await api.post(`${root}/start-question`).expect(200);
    const deadline = db.prepare('SELECT answer_deadline_at FROM game_sessions WHERE id = ?').get(room.id)!.answer_deadline_at;
    assert.equal(completeQuestion(db, room.id, () => Date.parse(String(deadline)) + 1), true);
    const game = (await api.get(`${root}/game/screen`)).body.game;
    assert.deepEqual(game.statistics, { correct: 0, wrong: 0, unanswered: 3 });
    assert.deepEqual((await api.get(root)).body.tiebreak.contenderIds, players.slice(0, 3).map(p => p.player.id));
    await api.post(`${root}/next`).expect(200);
    assert.equal((await api.get(root)).body.state, 'QUESTION');
  } finally { db.close(); }
});

test('exhausted reserve preserves joint winners and a unique main winner cannot start tiebreak', async () => {
  for (const tied of [true, false]) {
    const db = initializeDatabase(':memory:');
    try {
      const { api, root, players, extras } = await setup(db, 1, tied);
      if (tied) {
        await api.post(`${root}/start-tiebreak`).expect(200);
        await api.post(`${root}/start-question`).expect(200);
        for (const p of players.slice(0, 3)) await api.post(`${root}/answers`).send({ token: p.token, questionId: extras[0].id, optionId: extras[0].options[0] }).expect(200);
        await api.post(`${root}/next`).expect(200);
        assert.equal((await api.get(`${root}/game/host`)).body.game.canStartTiebreak, false);
      } else await api.post(`${root}/start-tiebreak`).expect(409);
      await api.post(`${root}/show-winner`).expect(200);
      assert.equal((await api.get(`${root}/game/screen`)).body.game.leaderboard.length, tied ? 3 : 1);
    } finally { db.close(); }
  }
});
