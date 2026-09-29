import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { initializeDatabase } from './db.js';
import { createApp } from './app.js';
import { createQuiz } from './quizzes.js';
import { createRound } from './rounds.js';
import { createQuestion, createOption, updateQuestion, updateOption } from './questions.js';
import { createPair, listPairs, updatePair } from './matching.js';
import { matchingContent } from './matching-game.js';
import { getGameSnapshot } from './snapshot.js';
import { getPlayerGame, getSurfaceState, startQuestion } from './game.js';
import { submitAnswer } from './answers.js';
import { completeQuestion } from './reveal.js';
import { autoPauseForDisconnectedPlayer, continueWithoutPlayer, waitForPlayer } from './pause.js';

async function fixture(db: ReturnType<typeof initializeDatabase>, mixed = false) {
  const quiz = createQuiz(db), round = createRound(db, quiz.id);
  const types = mixed ? ['matching', 'matching', 'single_choice', 'yes_no', 'multiple_choice'] as const : ['matching'] as const;
  for (const type of types) {
    const q = createQuestion(db, round.id, type);
    updateQuestion(db, round.id, q.id, { type, textRu: 'Вопрос', textEn: 'Question', points: 5, answerTimeSeconds: 30, showOptionsOnScreen: true });
    if (type === 'matching') {
      createPair(db, q.id);
      listPairs(db, q.id).forEach((pair, i) => updatePair(db, q.id, pair.id, { left: { kind: 'text', textRu: `Слева ${i}`, textEn: `Left ${i}` }, right: { kind: 'text', textRu: `Справа ${i}`, textEn: `Right ${i}` } }));
    } else if (type !== 'yes_no') {
      for (const isCorrect of type === 'multiple_choice' ? [true, true, false] : [true, false]) updateOption(db, q.id, createOption(db, q.id).id, { textRu: 'Ответ', textEn: 'Answer', isCorrect });
    }
  }
  const api = request(createApp(db));
  const room = (await api.post(`/api/quizzes/${quiz.id}/rooms`).expect(201)).body;
  const players = [];
  for (const name of ['Alice', 'Bob']) players.push((await api.post(`/api/rooms/code/${room.code}/players`).send({ name, language: 'en' }).expect(201)).body);
  const root = `/api/rooms/${room.id}`;
  await api.post(`${root}/start`).expect(200);
  const snapshot = getGameSnapshot(db, room.id)!;
  await api.delete(`/api/quizzes/${quiz.id}`).expect(204);
  await api.post(`${root}/start-round`).expect(200);
  assert.ok('room' in startQuestion(db, room.id, 1000));
  const q = snapshot.rounds[0].questions[0], content = matchingContent(room.id, q);
  const answer = { token: players[0].token, questionId: q.id, mapping: content.correctMapping };
  return { room, players, root, snapshot, q, content, answer };
}

for (const mode of ['exact', 'partial', 'wrong'] as const) test(`Matching ${mode} scoring is all-or-nothing`, async () => {
  const db = initializeDatabase(':memory:');
  try {
    const f = await fixture(db); const mapping = structuredClone(f.answer.mapping);
    if (mode === 'partial') [mapping[0].rightId, mapping[1].rightId] = [mapping[1].rightId, mapping[0].rightId];
    if (mode === 'wrong') mapping.forEach((pair, i) => pair.rightId = f.answer.mapping[(i + 1) % mapping.length].rightId);
    assert.ok('submission' in submitAnswer(db, f.room.id, { ...f.answer, mapping }, () => 2000));
    assert.equal(completeQuestion(db, f.room.id, () => 31000), true);
    const result = getPlayerGame(db, f.room.id, 'en', f.players[0].player.id) as any;
    assert.deepEqual(result.result, { outcome: mode === 'exact' ? 'correct' : 'wrong', points: mode === 'exact' ? 5 : 0 });
    assert.deepEqual(result.correctMapping, f.content.correctMapping);
    assert.deepEqual((getPlayerGame(db, f.room.id, 'ru', f.players[1].player.id) as any).result, { outcome: 'unanswered', points: 0 });
    assert.equal(completeQuestion(db, f.room.id, () => 32000), false);
  } finally { db.close(); }
});

test('Matching rejects incomplete, malformed, duplicate, foreign and mixed submissions even on retry; accepted mappings are immutable and safe', async () => {
  const db = initializeDatabase(':memory:');
  try {
    const f = await fixture(db), [a, b, c] = f.answer.mapping;
    const invalid = [undefined, null, {}, [], [a], [a, a, c], [a, { ...b, rightId: a.rightId }, c], [a, { ...b, leftId: 'foreign' }, c], [a, { ...b, rightId: 'foreign' }, c], [a, { ...b, extra: true }, c], [a, { leftId: 1, rightId: b.rightId }, c], [a, null, c]];
    for (const mapping of invalid) assert.equal((submitAnswer(db, f.room.id, { ...f.answer, mapping }, () => 2000) as any).status, 400);
    assert.equal((submitAnswer(db, f.room.id, { ...f.answer, optionId: 'mixed' }, () => 2000) as any).status, 400);
    const safe = getPlayerGame(db, f.room.id, 'en', f.players[0].player.id) as any;
    assert.doesNotMatch(JSON.stringify(safe), /correctMapping|isCorrect|correctOption|"pairs"|"position"/);
    for (const pair of f.q.pairs!) assert.ok(!JSON.stringify(safe).includes(pair.id));
    const screen = getSurfaceState(db, f.room.id, 'screen') as any;
    assert.equal(screen.game.leftItems.length, 3); assert.equal(screen.game.correctMapping, undefined);
    assert.deepEqual((getSurfaceState(db, f.room.id, 'host') as any).game.correctMapping, f.content.correctMapping);
    const accepted = submitAnswer(db, f.room.id, { ...f.answer, mapping: [...f.answer.mapping].reverse() }, () => 2000) as any;
    const alternate = f.answer.mapping.map((pair, i) => ({ ...pair, rightId: f.answer.mapping[(i + 1) % 3].rightId }));
    assert.deepEqual(submitAnswer(db, f.room.id, { ...f.answer, mapping: alternate }, () => 999999), { submission: accepted.submission, inserted: false });
    for (const mapping of invalid) assert.equal((submitAnswer(db, f.room.id, { ...f.answer, mapping }) as any).status, 400);
    assert.equal(autoPauseForDisconnectedPlayer(db, f.room.id, f.players[0].player.id, () => 2200), false);
    assert.doesNotMatch(JSON.stringify(getPlayerGame(db, f.room.id, 'en', f.players[0].player.id)), /correctMapping|"outcome"/);
    assert.ok('submission' in submitAnswer(db, f.room.id, { ...f.answer, token: f.players[1].token }, () => 2300));
    assert.deepEqual(submitAnswer(db, f.room.id, { ...f.answer, mapping: alternate }, () => 999999), { submission: accepted.submission, inserted: false });
    assert.deepEqual((getSurfaceState(db, f.room.id, 'screen') as any).game.correctMapping, f.content.correctMapping);
  } finally { db.close(); }
});

test('Matching exact deadline rejects Submit and unanswered timeout scores zero', async () => {
  const db = initializeDatabase(':memory:');
  try {
    const f = await fixture(db);
    assert.equal((submitAnswer(db, f.room.id, f.answer, () => 31000) as any).code, 'DEADLINE_REACHED');
    assert.equal(completeQuestion(db, f.room.id, () => 31000), true);
    assert.equal(db.prepare('SELECT count(*) n FROM player_answers').get()!.n, 0);
    for (const p of f.players) assert.deepEqual((getPlayerGame(db, f.room.id, 'en', p.player.id) as any).result, { outcome: 'unanswered', points: 0 });
  } finally { db.close(); }
});

test('Matching reconnect/restart, disconnect Pause + Wait/Continue, exclusion and mixed frozen navigation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'matching-game-')), path = join(dir, 'quiz.sqlite');
  let db = initializeDatabase(path);
  try {
    const f = await fixture(db, true);
    assert.equal(autoPauseForDisconnectedPlayer(db, f.room.id, f.players[1].player.id, () => 2000), true);
    assert.equal((submitAnswer(db, f.room.id, f.answer) as any).status, 409);
    assert.equal((waitForPlayer(db, f.room.id, () => false, () => 3000) as any).status, 409);
    db.close(); db = initializeDatabase(path);
    assert.equal((getSurfaceState(db, f.room.id, 'host') as any).game.state, 'PAUSED');
    assert.ok('room' in waitForPlayer(db, f.room.id, () => true, () => 4000));
    const accepted = submitAnswer(db, f.room.id, f.answer, () => 5000) as any;
    db.close(); db = initializeDatabase(path);
    const reconnect = (await request(createApp(db)).post(`${f.root}/reconnect`).send({ token: f.players[0].token }).expect(200)).body;
    assert.deepEqual(reconnect.game.submission, accepted.submission);
    assert.equal(autoPauseForDisconnectedPlayer(db, f.room.id, f.players[1].player.id, () => 6000), true);
    assert.ok('room' in continueWithoutPlayer(db, f.room.id, () => 7000));
    assert.equal((submitAnswer(db, f.room.id, { ...f.answer, token: f.players[1].token }) as any).status, 409);
    assert.deepEqual((getPlayerGame(db, f.room.id, 'en', f.players[1].player.id) as any).result, { outcome: 'unanswered', points: 0 });
    for (const q of f.snapshot.rounds[0].questions.slice(1)) {
      await request(createApp(db)).post(`${f.root}/next`).expect(200); assert.ok('room' in startQuestion(db, f.room.id, 10000));
      if (q.type === 'matching') {
        assert.equal(autoPauseForDisconnectedPlayer(db, f.room.id, f.players[1].player.id, () => 11000), true);
        assert.ok('room' in continueWithoutPlayer(db, f.room.id, () => 12000, () => true));
        const excluded = getPlayerGame(db, f.room.id, 'en', f.players[1].player.id) as any;
        assert.equal(excluded.excluded, true); assert.deepEqual(excluded.leftItems, []);
        const answer = { token: f.players[1].token, questionId: q.id, mapping: matchingContent(f.room.id, q).correctMapping };
        assert.equal((submitAnswer(db, f.room.id, answer, () => 12500) as any).status, 409);
        assert.equal(autoPauseForDisconnectedPlayer(db, f.room.id, f.players[1].player.id, () => 12500), false);
        assert.ok('submission' in submitAnswer(db, f.room.id, { ...answer, token: f.players[0].token }, () => 13000));
      } else {
        for (const p of f.players) {
          assert.equal((getPlayerGame(db, f.room.id, 'en', p.player.id) as any).excluded, false);
          assert.ok('submission' in submitAnswer(db, f.room.id, { token: p.token, questionId: q.id, ...(q.type === 'multiple_choice' ? { optionIds: q.options.filter(o => o.isCorrect).map(o => o.id) } : { optionId: q.options.find(o => o.isCorrect)!.id }) }, () => 13000));
        }
      }
    }
    assert.equal(db.prepare('SELECT SUM(awarded_points) n FROM question_scores WHERE player_id = ?').get(f.players[0].player.id)!.n, 25);
    assert.equal(db.prepare('SELECT SUM(awarded_points) n FROM question_scores WHERE player_id = ?').get(f.players[1].player.id)!.n, 15);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
