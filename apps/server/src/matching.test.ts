import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { initializeDatabase } from './db.js';
import { createApp } from './app.js';
import { createQuiz, duplicateQuiz } from './quizzes.js';
import { createRound, listRounds } from './rounds.js';
import { createQuestion, listOptions, listQuestions, updateQuestion } from './questions.js';
import { listPairs, updatePair } from './matching.js';
import { validateQuizReadiness } from './validation.js';
import { createGameSnapshot, getGameSnapshot, parseGameSnapshot } from './snapshot.js';
import { startQuestion } from './game.js';

const fields = { type: 'matching' as const, textRu: 'Соедините', textEn: 'Match', points: 2, answerTimeSeconds: null, showOptionsOnScreen: false };
const side = (text = 'Item') => ({ kind: 'text' as const, textRu: 'Элемент', textEn: text });
function setup(db: ReturnType<typeof initializeDatabase>) {
  const quiz = createQuiz(db); const round = createRound(db, quiz.id);
  const q = createQuestion(db, round.id, 'matching'); updateQuestion(db, round.id, q.id, fields);
  const api = request(createApp(db));
  const base = `/api/quizzes/${quiz.id}/rounds/${round.id}/questions/${q.id}`;
  return { quiz, round, q, api, base };
}
function fill(db: ReturnType<typeof initializeDatabase>, id: string) {
  listPairs(db, id).forEach((pair, i) => updatePair(db, id, pair.id, { left: side(`Left ${i}`), right: side(`Right ${i}`) }));
}

test('Matching scoped CRUD, reorder, duplication, cascades and durable reload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'matching-')); const path = join(dir, 'quiz.sqlite');
  let db = initializeDatabase(path);
  try {
    const { q, quiz, api, base } = setup(db);
    const created = (await api.post(base.slice(0, base.lastIndexOf('/'))).send({ type: 'matching' }).expect(201)).body;
    assert.equal(listPairs(db, created.id).length, 2);
    await api.delete(base.replace(q.id, created.id)).expect(204);
    assert.deepEqual(listPairs(db, created.id), []);
    const original = listPairs(db, q.id);
    assert.equal(original.length, 2); assert.deepEqual(listOptions(db, q.id), []);
    await api.put(`${base}/pairs/${original[0].id}`).send({ left: side('A'), right: side('B') }).expect(200);
    const added = (await api.post(`${base}/pairs`).expect(201)).body;
    await api.post(`${base}/pairs`).send({ left: side() }).expect(400);
    await api.put(`${base}/pairs/order`).send({ ids: [added.id, added.id] }).expect(400);
    await api.put(`${base}/pairs/order`).send({ ids: [added.id, original[1].id, original[0].id] }).expect(200);
    await api.delete(`${base}/pairs/${original[1].id}`).expect(204);
    await api.put(`${base}/pairs/${added.id}`).send({ left: side(), right: { kind: 'image', mediaId: 'future' } }).expect(400);
    await api.put(`${base}/pairs/${added.id}`).send({ left: side(), right: { ...side(), textEn: 'x'.repeat(501) } }).expect(400);
    await api.put(`${base}/pairs/missing`).send({ left: side(), right: side() }).expect(404);
    await api.get(base.replace(quiz.id, 'foreign') + '/pairs').expect(404);
    await api.post(`${base}/options`).expect(409);
    const persisted = listPairs(db, q.id);
    db.close(); db = initializeDatabase(path);
    assert.deepEqual(listPairs(db, q.id), persisted);
    const copy = duplicateQuiz(db, quiz.id)!;
    const copiedQ = listQuestions(db, listRounds(db, copy.id)[0].id)[0];
    const copiedPairs = listPairs(db, copiedQ.id);
    assert.deepEqual(copiedPairs.map(p => [p.left, p.right, p.position]), persisted.map(p => [p.left, p.right, p.position]));
    assert.ok(copiedPairs.every(p => !persisted.some(source => source.id === p.id)));
    await request(createApp(db)).delete(`/api/quizzes/${quiz.id}`).expect(204);
    assert.deepEqual(listPairs(db, q.id), []);
    assert.equal(listPairs(db, copiedQ.id).length, 2);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const type of ['single_choice', 'yes_no', 'multiple_choice'] as const) test(`Matching conversion to/from ${type} clears inactive structures atomically`, async () => {
  const db = initializeDatabase(':memory:');
  try {
    const { q, round, api, base, quiz } = setup(db); fill(db, q.id);
    await api.put(base).send({ ...fields, type }).expect(200);
    assert.deepEqual(listPairs(db, q.id), []);
    assert.equal(listOptions(db, q.id).length, type === 'yes_no' ? 2 : 0);
    await api.post(`${base}/pairs`).expect(409);
    if (type !== 'yes_no') {
      for (const correct of [true, type === 'multiple_choice']) {
        const option = (await api.post(`${base}/options`).expect(201)).body;
        await api.put(`${base}/options/${option.id}`).send({ textRu: 'Ответ', textEn: 'Answer', isCorrect: correct }).expect(200);
      }
    }
    assert.equal(validateQuizReadiness(db, quiz.id)!.ready, true);
    const legacy = createGameSnapshot(db, quiz.id);
    assert.deepEqual(parseGameSnapshot(JSON.stringify(legacy)), legacy);
    await api.put(base).send(fields).expect(200);
    assert.deepEqual(listOptions(db, q.id), []); assert.equal(listPairs(db, q.id).length, 2);
    assert.equal(validateQuizReadiness(db, quiz.id)!.ready, false);
    fill(db, q.id); assert.equal(validateQuizReadiness(db, quiz.id)!.ready, true);
    db.exec("CREATE TRIGGER fail_pair BEFORE INSERT ON matching_pairs BEGIN SELECT RAISE(ABORT, 'pair failure'); END");
    updateQuestion(db, round.id, q.id, { ...fields, type });
    const before = listOptions(db, q.id);
    assert.throws(() => updateQuestion(db, round.id, q.id, fields), /pair failure/);
    assert.equal(listQuestions(db, round.id)[0].type, type);
    assert.deepEqual(listOptions(db, q.id), before);
    assert.throws(() => createQuestion(db, round.id, 'matching'), /pair failure/);
    assert.equal(listQuestions(db, round.id).length, 1);
  } finally { db.close(); }
});

test('Matching readiness, Start, immutable snapshot and gameplay boundary', async () => {
  const db = initializeDatabase(':memory:');
  try {
    const { q, quiz, api, base } = setup(db);
    assert.equal(validateQuizReadiness(db, quiz.id)!.ready, false);
    assert.throws(() => createGameSnapshot(db, quiz.id), /Invalid game snapshot/);
    fill(db, q.id);
    assert.equal(validateQuizReadiness(db, quiz.id)!.ready, true);
    const room = (await api.post(`/api/quizzes/${quiz.id}/rooms`).expect(201)).body;
    await api.post(`/api/rooms/code/${room.code}/players`).send({ name: 'Alice', language: 'en' }).expect(201);
    const pair = listPairs(db, q.id)[0];
    updatePair(db, q.id, pair.id, { left: side(), right: { ...side(), textEn: ' ' } });
    await api.post(`/api/rooms/${room.id}/start`).expect(409);
    fill(db, q.id);
    await api.post(`/api/rooms/${room.id}/start`).expect(200);
    const frozen = getGameSnapshot(db, room.id)!;
    await api.put(`${base}/pairs/${pair.id}`).send({ left: side('Edited'), right: side('Edited') }).expect(200);
    await api.delete(`/api/quizzes/${quiz.id}`).expect(204);
    assert.deepEqual(getGameSnapshot(db, room.id), frozen);
    await api.post(`/api/rooms/${room.id}/start-round`).expect(200);
    assert.ok('room' in startQuestion(db, room.id));
    assert.equal(db.prepare('SELECT state FROM game_sessions WHERE id = ?').get(room.id)!.state, 'ANSWERING');
    const playerState = (await api.get(`/api/rooms/${room.id}`)).body;
    assert.doesNotMatch(JSON.stringify(playerState), /pairs|left|right/);
  } finally { db.close(); }
});

for (const invalid of ['one', 'empty', 'language', 'shape', 'image', 'order', 'duplicate', 'options', 'long']) test(`Matching snapshot independently rejects ${invalid}`, () => {
  const db = initializeDatabase(':memory:');
  try {
    const { q, quiz } = setup(db); fill(db, q.id);
    const tree = createGameSnapshot(db, quiz.id); const question = tree.rounds[0].questions[0]; const pairs = question.pairs!;
    if (invalid === 'one') pairs.pop();
    if (invalid === 'empty') pairs.length = 0;
    if (invalid === 'language') pairs[0].left = { ...side(), textRu: ' ' };
    if (invalid === 'shape') (pairs[0] as any).right = { kind: 'text', textRu: 'Текст' };
    if (invalid === 'image') pairs[0].right = { kind: 'image', mediaId: 'unresolved' };
    if (invalid === 'order') pairs.reverse();
    if (invalid === 'duplicate') pairs[1].id = pairs[0].id;
    if (invalid === 'options') question.options.push({ id: 'stale', textRu: 'Да', textEn: 'Yes', isCorrect: true, position: 0 });
    if (invalid === 'long') pairs[0].left = { ...side(), textEn: 'x'.repeat(501) };
    assert.throws(() => parseGameSnapshot(JSON.stringify(tree)), /Invalid game snapshot/);
  } finally { db.close(); }
});

test('Phase 5B migration preserves editor data, accepted answers, roster and old snapshots', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'matching-migration-')); const path = join(dir, 'quiz.sqlite');
  let db = initializeDatabase(path);
  try {
    const { q, round, quiz, api, base } = setup(db);
    updateQuestion(db, round.id, q.id, { ...fields, type: 'yes_no' });
    const room = (await api.post(`/api/quizzes/${quiz.id}/rooms`).expect(201)).body;
    const player = (await api.post(`/api/rooms/code/${room.code}/players`).send({ name: 'Alice', language: 'en' }).expect(201)).body;
    await api.post(`/api/rooms/${room.id}/start`).expect(200);
    await api.post(`/api/rooms/${room.id}/start-round`).expect(200);
    startQuestion(db, room.id);
    await api.post(`/api/rooms/${room.id}/answers`).send({ token: player.token, questionId: q.id, optionId: listOptions(db, q.id)[0].id }).expect(200);
    const tables = ['questions', 'answer_options', 'game_sessions', 'session_players', 'player_answers', 'question_scores'];
    const before = tables.map(table => db.prepare(`SELECT * FROM ${table}`).all());
    db.exec('ALTER TABLE questions DROP COLUMN media_json; DROP TABLE media; DELETE FROM schema_migrations WHERE version = 21; ALTER TABLE questions DROP COLUMN show_correct_count; DELETE FROM schema_migrations WHERE version = 20');
    const oldSchema = String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'questions'").get()!.sql).replace(", 'matching'", '');
    db.exec('PRAGMA foreign_keys = OFF; BEGIN; DROP TABLE matching_pairs; CREATE TEMP TABLE saved AS SELECT * FROM questions; DROP TABLE questions');
    db.exec(oldSchema);
    db.exec('INSERT INTO questions SELECT * FROM saved; DROP TABLE saved; CREATE INDEX questions_round_position ON questions(round_id, position); DELETE FROM schema_migrations WHERE version = 18; COMMIT; PRAGMA foreign_keys = ON');
    db.close(); db = initializeDatabase(path);
    tables.forEach((table, i) => assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all(), before[i]));
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(getGameSnapshot(db, room.id)!.rounds[0].questions[0].type, 'yes_no');
    await request(createApp(db)).put(base).send(fields).expect(200);
    assert.equal(listPairs(db, q.id).length, 2);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const invalid of ['one', 'blank-left', 'missing-right', 'image', 'long']) test(`Matching readiness rejects persisted ${invalid}`, () => {
  const db = initializeDatabase(':memory:');
  try {
    const { q, quiz } = setup(db); fill(db, q.id);
    const pair = listPairs(db, q.id)[0];
    if (invalid === 'one') db.prepare('DELETE FROM matching_pairs WHERE id = ?').run(pair.id);
    else {
      const value = invalid === 'blank-left' ? { ...side(), textRu: ' ' }
        : invalid === 'missing-right' ? { kind: 'text', textRu: 'Текст' }
        : invalid === 'image' ? { kind: 'image', mediaId: 'future' }
        : { ...side(), textEn: 'x'.repeat(501) };
      db.prepare('UPDATE matching_pairs SET right_json = ? WHERE id = ?').run(JSON.stringify(value), pair.id);
    }
    const validation = validateQuizReadiness(db, quiz.id)!;
    assert.equal(validation.ready, false);
    assert.ok(validation.problems.some(p => p.code === (invalid === 'one' ? 'MATCHING_TOO_FEW_PAIRS' : 'MATCHING_SIDE_INCOMPLETE')));
    assert.throws(() => createGameSnapshot(db, quiz.id), /Invalid game snapshot/);
  } finally { db.close(); }
});

test('option snapshot rejects active pairs and accepts legacy option-only structures', () => {
  const db = initializeDatabase(':memory:');
  try {
    const { q, quiz, round } = setup(db);
    updateQuestion(db, round.id, q.id, { ...fields, type: 'yes_no' });
    const tree = createGameSnapshot(db, quiz.id);
    assert.deepEqual(parseGameSnapshot(JSON.stringify(tree)), tree);
    tree.rounds[0].questions[0].pairs = [{ id: 'stale', left: side(), right: side(), position: 0 }];
    assert.throws(() => parseGameSnapshot(JSON.stringify(tree)), /Invalid game snapshot/);
  } finally { db.close(); }
});
