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
import { getLeaderboard } from './navigation.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'quiz-history-'));
  const path = join(directory, 'quiz.sqlite');
  let db = initializeDatabase(path);
  const quiz = createQuiz(db), round = createRound(db, quiz.id);
  db.prepare("UPDATE quizzes SET title = 'Original party' WHERE id = ?").run(quiz.id);
  const questions = [3, 2].map(points => {
    const question = createQuestion(db, round.id);
    db.prepare("UPDATE questions SET text_ru = 'Вопрос', text_en = 'Private question', points = ? WHERE id = ?").run(points, question.id);
    const options = [true, false].map(correct => {
      const option = createOption(db, question.id);
      db.prepare("UPDATE answer_options SET text_ru = 'Ответ', text_en = 'Private answer', is_correct = ? WHERE id = ?").run(Number(correct), option.id);
      return option;
    });
    return { ...question, options };
  });
  return {
    path, quiz, questions,
    get db() { return db; }, get api() { return request(createApp(db)); },
    restart() { db.close(); db = initializeDatabase(path); },
    close() { db.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

async function start(f: ReturnType<typeof fixture>, names = ['Alice']) {
  const room = (await f.api.post(`/api/quizzes/${f.quiz.id}/rooms`).expect(201)).body;
  const identities = [];
  for (const name of names) identities.push((await f.api.post(`/api/rooms/code/${room.code}/players`).send({ name, language: 'en' }).expect(201)).body);
  await f.api.post(`/api/rooms/${room.id}/start`).expect(200);
  return { room, identities, root: `/api/rooms/${room.id}` };
}

async function play(f: ReturnType<typeof fixture>, game: Awaited<ReturnType<typeof start>>) {
  await f.api.post(`${game.root}/start-round`).expect(200);
  for (const question of f.questions) {
    await f.api.post(`${game.root}/start-question`).expect(200);
    for (const identity of game.identities) {
      if (f.db.prepare('SELECT removed_at, in_roster FROM session_players WHERE id = ?').get(identity.player.id)!.removed_at !== null) continue;
      await f.api.post(`${game.root}/answers`).send({ token: identity.token, questionId: question.id,
        optionId: question.options[identity.player.name === 'Carol' ? 1 : 0].id }).expect(200);
    }
    await f.api.post(`${game.root}/next`).expect(200);
  }
}

async function history(f: ReturnType<typeof fixture>) {
  return (await f.api.get('/api/history').expect(200).expect('Cache-Control', 'no-store')).body;
}

test('completed real game appears once with stable timestamp, final roster/totals and a minimal durable API', async () => {
  const f = fixture();
  try {
    const media = (await f.api.post(`/api/quizzes/${f.quiz.id}/media`)
      .attach('file', readFileSync(new URL('./fixtures/media/sample.jpg', import.meta.url)), 'private.jpg').expect(201)).body;
    f.db.prepare('UPDATE questions SET media_json = ? WHERE id = ?').run(JSON.stringify([{ mediaId: media.id, playBeforeTimer: false }]), f.questions[0].id);
    const game = await start(f, ['Alice', 'Bob', 'Carol', 'Removed']);
    // Original identity must already be durable before the source can be deleted.
    await f.api.put(`/api/quizzes/${f.quiz.id}`).send({ title: 'Renamed party', themeId: f.quiz.themeId,
      defaultAnswerTimeSeconds: f.quiz.defaultAnswerTimeSeconds, shuffleAnswers: f.quiz.shuffleAnswers }).expect(200);
    await f.api.delete(`/api/quizzes/${f.quiz.id}`).expect(204);
    assert.equal(f.db.prepare('SELECT quiz_id FROM game_sessions WHERE id = ?').get(game.room.id)!.quiz_id, null);
    f.restart();
    await play(f, game);
    const removed = game.identities.pop()!;
    // Removal before Final Results excludes even players with earned points.
    f.db.prepare('UPDATE session_players SET removed_at = ? WHERE id = ?').run(new Date().toISOString(), removed.player.id);
    assert.deepEqual(await history(f), []);
    const standings = getLeaderboard(f.db, game.room.id);
    assert.deepEqual(standings.map(p => [p.displayName, p.totalPoints, p.rank]), [['Alice', 5, 1], ['Bob', 5, 1], ['Carol', 0, 3]]);
    const before = Date.now();
    await f.api.post(`${game.root}/final-results`).expect(200);
    const entries = await history(f);
    const completedAt = entries[0].completedAt;
    assert.ok(Date.parse(completedAt) >= before && Date.parse(completedAt) <= Date.now());
    assert.deepEqual(entries, [{ sessionId: game.room.id, completedAt, quizId: f.quiz.id, quizTitle: 'Original party',
      players: standings.map(({ rank: _rank, ...player }) => player) }]);
    // Exact object shapes above allow only identity/title/time and final totals.
    const serialized = JSON.stringify(entries);
    for (const secret of ['Private question', 'Private answer', 'private.jpg', media.id, ...game.identities.map(i => i.token), removed.player.id]) assert.ok(!serialized.includes(secret));
    assert.doesNotMatch(serialized, /answer|correct|snapshot|media|token|language|rank/i);
    assert.deepEqual(JSON.parse(String(f.db.prepare('SELECT players_json FROM game_history WHERE session_id = ?').get(game.room.id)!.players_json)), entries[0].players);
    await f.api.post(`${game.root}/final-results`).expect(409);
    await f.api.post(`${game.root}/pause`).expect(200);
    f.restart();
    await f.api.post(`${game.root}/resume`).expect(200);
    await f.api.post(`${game.root}/reconnect`).send({ token: game.identities[0].token }).expect(200);
    await f.api.post(`${game.root}/show-winner`).expect(200);
    f.restart();
    assert.deepEqual(await history(f), entries);
    await f.api.post(`${game.root}/close`).expect(200);
    await f.api.post(`${game.root}/close`).expect(200);
    f.restart();
    assert.deepEqual(await history(f), entries);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM game_history WHERE completed_at IS NOT NULL').get()!.n, 1);
  } finally { f.close(); }
});

test('legacy test sessions and incomplete games stay out of history after restart', async () => {
  const f = fixture();
  try {
    assert.deepEqual(await history(f), []);
    const abandoned = await start(f);
    await f.api.post(`${abandoned.root}/close`).expect(200);
    const unfinished = await start(f);
    await play(f, unfinished); // Round End is still incomplete, even with all answers scored.
    await f.api.post(`${unfinished.root}/close`).expect(200);
    const lobby = (await f.api.post(`/api/quizzes/${f.quiz.id}/rooms`).expect(201)).body;
    await f.api.post(`/api/rooms/${lobby.id}/close`).expect(200);
    const game = await start(f);
    f.db.prepare('UPDATE game_sessions SET is_test = 1 WHERE id = ?').run(game.room.id);
    await play(f, game);
    await f.api.post(`${game.root}/final-results`).expect(200);
    assert.ok(f.db.prepare('SELECT completed_at FROM game_history WHERE session_id = ?').get(game.room.id)!.completed_at);
    // Query parameters cannot opt tests into this endpoint.
    assert.deepEqual((await f.api.get('/api/history?isTest=true').expect(200)).body, []);
    await f.api.post(`${game.root}/show-winner`).expect(200);
    await f.api.post(`${game.root}/close`).expect(200);
    f.restart();
    assert.deepEqual(await history(f), []);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM game_history WHERE session_id = ?').get(game.room.id)!.n, 1);
    assert.ok(f.db.prepare('SELECT id FROM game_sessions WHERE id = ?').get(abandoned.room.id));
  } finally { f.close(); }
});

test('history orders newest completions first and excludes non-roster players', async () => {
  const f = fixture();
  try {
    const games = [await start(f), await start(f)];
    for (const game of games) { await play(f, game); await f.api.post(`${game.root}/final-results`).expect(200); }
    // Deterministic completion dates avoid relying on millisecond clock resolution.
    games.forEach((game, index) => f.db.prepare('UPDATE game_history SET completed_at = ? WHERE session_id = ?')
      .run(`2026-09-2${index + 1}T10:00:00.000Z`, game.room.id));
    assert.deepEqual((await history(f)).map((entry: { sessionId: string }) => entry.sessionId), games.map(g => g.room.id).reverse());
    const game = await start(f, ['Alice', 'Nonroster']);
    f.db.prepare('UPDATE session_players SET in_roster = 0 WHERE id = ?').run(game.identities.pop()!.player.id);
    await play(f, game); await f.api.post(`${game.root}/final-results`).expect(200);
    assert.deepEqual((await history(f))[0].players.map((p: { displayName: string }) => p.displayName), ['Alice']);
  } finally { f.close(); }
});

test('completion and final transition roll back together when history persistence fails', async () => {
  const f = fixture();
  try {
    const game = await start(f); await play(f, game);
    f.db.exec("CREATE TRIGGER fail_history BEFORE UPDATE OF completed_at ON game_history BEGIN SELECT RAISE(ABORT, 'history failure'); END;");
    await f.api.post(`${game.root}/final-results`).expect(500);
    assert.equal((await f.api.get(game.root)).body.state, 'ROUND_END');
    assert.deepEqual(await history(f), []);
    f.db.exec('DROP TRIGGER fail_history');
    await f.api.post(`${game.root}/final-results`).expect(200);
    assert.equal((await history(f)).length, 1);
  } finally { f.close(); }
});

test('Phase 8C migration preserves available frozen identity without inventing old completion dates', async () => {
  const f = fixture();
  try {
    const game = await start(f); await play(f, game);
    await f.api.post(`${game.root}/final-results`).expect(200);
    f.db.exec('DROP TABLE game_history; DELETE FROM schema_migrations WHERE version = 25');
    f.restart();
    assert.deepEqual(await history(f), []);
    const identity = f.db.prepare('SELECT * FROM game_history WHERE session_id = ?').get(game.room.id)!;
    assert.equal(identity.quiz_id, f.quiz.id); assert.equal(identity.quiz_title, 'Original party');
    assert.equal(identity.completed_at, null); assert.equal(identity.players_json, null);
    await f.api.post(`${game.root}/show-winner`).expect(200);
    assert.deepEqual(await history(f), []);
  } finally { f.close(); }
});
