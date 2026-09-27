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
import { createQuestion, createOption, listOptions, updateQuestion } from './questions.js';
import { validateQuizReadiness } from './validation.js';
import { createGameSnapshot, parseGameSnapshot, getGameSnapshot } from './snapshot.js';
import { getPlayerGame, getSurfaceState, startQuestion } from './game.js';
import { submitAnswer } from './answers.js';
import { completeQuestion } from './reveal.js';
import { autoPauseForDisconnectedPlayer, waitForPlayer } from './pause.js';

function setup(db: ReturnType<typeof initializeDatabase>) {
  const quiz = createQuiz(db);
  const round = createRound(db, quiz.id);
  const api = request(createApp(db));
  const base = `/api/quizzes/${quiz.id}/rounds/${round.id}/questions`;
  const fields = { type: 'yes_no' as const, textRu: 'Это верно?', textEn: 'Is it true?', points: 4, answerTimeSeconds: 30, showOptionsOnScreen: false };
  return { quiz, round, api, base, fields };
}

test('Yes / No creation, fixed options, correctness, deterministic conversion and reload', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'yes-no-'));
  const path = join(directory, 'quiz.sqlite');
  let db = initializeDatabase(path);
  try {
    const { api, base, fields } = setup(db);
    const question = (await api.post(base).send({ type: 'yes_no' }).expect(201)).body;
    const options = (await api.get(`${base}/${question.id}/options`).expect(200)).body;
    assert.deepEqual(options.map((o: any) => [o.textRu, o.textEn, o.isCorrect]), [['Да', 'Yes', true], ['Нет', 'No', false]]);
    await api.post(`${base}/${question.id}/options`).expect(400);
    await api.delete(`${base}/${question.id}/options/${options[0].id}`).expect(400);
    for (const [index, correct] of [[0, false], [1, true]] as const) await api.put(`${base}/${question.id}/options/${options[index].id}`).send({ textRu: options[index].textRu, textEn: options[index].textEn, isCorrect: correct }).expect(400);
    await api.put(`${base}/${question.id}/options/${options[1].id}/correct`).expect(200);
    await api.put(`${base}/${question.id}`).send({ ...fields, type: 'single_choice' }).expect(200);
    const extra = (await api.post(`${base}/${question.id}/options`).expect(201)).body;
    await api.put(`${base}/${question.id}/options/${extra.id}/correct`).expect(200);
    await api.put(`${base}/${question.id}`).send(fields).expect(200);
    const normalized = listOptions(db, question.id);
    assert.deepEqual(normalized.map(o => o.id), options.map((o: any) => o.id));
    assert.deepEqual(normalized.map(o => o.isCorrect), [true, false]);
    db.close(); db = initializeDatabase(path);
    assert.equal(db.prepare('SELECT type FROM questions WHERE id = ?').get(question.id)!.type, 'yes_no');
    assert.deepEqual(listOptions(db, question.id), normalized);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const invalid of ['one', 'three', 'zero-correct', 'two-correct']) test(`Yes / No readiness, Start and snapshot independently reject ${invalid}`, async () => {
  const db = initializeDatabase(':memory:');
  try {
    const { quiz, round, api, fields } = setup(db);
    const q = createQuestion(db, round.id, 'yes_no');
    updateQuestion(db, round.id, q.id, fields);
    assert.equal(validateQuizReadiness(db, quiz.id)!.ready, true);
    const valid = createGameSnapshot(db, quiz.id);
    assert.deepEqual(parseGameSnapshot(JSON.stringify(valid)), valid);
    const options = valid.rounds[0].questions[0].options;
    const room = (await api.post(`/api/quizzes/${quiz.id}/rooms`).expect(201)).body;
    await api.post(`/api/rooms/code/${room.code}/players`).send({ name: 'Alice', language: 'en' }).expect(201);
    if (invalid === 'one') { db.prepare('DELETE FROM answer_options WHERE id = ?').run(options[1].id); options.pop(); }
    if (invalid === 'three') {
      const id = 'third';
      db.prepare("INSERT INTO answer_options SELECT ?, question_id, text_ru, text_en, 0, 2, created_at, updated_at FROM answer_options LIMIT 1").run(id);
      options.push({ ...options[1], id, position: 2 });
    }
    if (invalid.endsWith('correct')) {
      const correct = invalid === 'two-correct'; db.prepare('UPDATE answer_options SET is_correct = ?').run(Number(correct)); options.forEach(o => { o.isCorrect = correct; });
    }
    assert.equal(validateQuizReadiness(db, quiz.id)!.ready, false);
    assert.throws(() => parseGameSnapshot(JSON.stringify(valid)), /Invalid game snapshot/);
    assert.throws(() => createGameSnapshot(db, quiz.id), /Invalid game snapshot/);
    await api.post(`/api/rooms/${room.id}/start`).expect(409);
  } finally { db.close(); }
});

test('mixed single-select game freezes, navigates, retries, restores disconnect and scores all outcomes', async () => {
  const db = initializeDatabase(':memory:');
  try {
    const { quiz, round, api, fields } = setup(db);
    const first = createQuestion(db, round.id);
    updateQuestion(db, round.id, first.id, { ...fields, type: 'single_choice', points: 2 });
    for (const correct of [1, 0]) {
      const o = createOption(db, first.id);
      db.prepare("UPDATE answer_options SET text_ru = 'Ответ', text_en = 'Answer', is_correct = ? WHERE id = ?").run(correct, o.id);
    }
    const second = createQuestion(db, round.id, 'yes_no'); updateQuestion(db, round.id, second.id, fields);
    const room = (await api.post(`/api/quizzes/${quiz.id}/rooms`).expect(201)).body;
    const identities = [];
    for (const name of ['Alice', 'Bob', 'Carol']) identities.push((await api.post(`/api/rooms/code/${room.code}/players`).send({ name, language: 'en' }).expect(201)).body);
    const root = `/api/rooms/${room.id}`;
    await api.post(`${root}/start`).expect(200);
    const frozen = getGameSnapshot(db, room.id)!;
    assert.equal(frozen.schemaVersion, 1);
    db.prepare("UPDATE answer_options SET text_en = 'Changed', is_correct = 0 WHERE question_id = ?").run(second.id);
    await api.delete(`/api/quizzes/${quiz.id}`).expect(204);
    assert.deepEqual(getGameSnapshot(db, room.id), frozen);
    await api.post(`${root}/start-round`).expect(200);
    for (const [index, q] of frozen.rounds[0].questions.entries()) {
      assert.equal((await api.get(root)).body.state, 'QUESTION');
      startQuestion(db, room.id, 100000);
      assert.doesNotMatch(JSON.stringify(getPlayerGame(db, room.id, 'en', identities[0].player.id)), /isCorrect|correctOptionId/);
      const answer = (playerIndex: number, optionIndex: number) => ({ token: identities[playerIndex].token, questionId: q.id, optionId: q.options[optionIndex].id });
      assert.ok('submission' in submitAnswer(db, room.id, answer(0, 0), () => 101000));
      assert.deepEqual(submitAnswer(db, room.id, answer(0, 1), () => 102000), { inserted: false, submission: { submitted: true, optionId: q.options[0].id } });
      if (index === 1) {
        assert.equal(autoPauseForDisconnectedPlayer(db, room.id, identities[0].player.id, () => 102000), false);
        assert.equal(autoPauseForDisconnectedPlayer(db, room.id, identities[1].player.id, () => 102000), true);
        assert.equal(getPlayerGame(db, room.id, 'en', identities[0].player.id), null);
        assert.equal(getSurfaceState(db, room.id, 'host')!.room.state, 'PAUSED');
        assert.ok('room' in waitForPlayer(db, room.id, () => true, () => 103000));
        assert.deepEqual((getPlayerGame(db, room.id, 'en', identities[0].player.id) as any).submission, { submitted: true, optionId: q.options[0].id });
      }
      assert.ok('submission' in submitAnswer(db, room.id, answer(1, 1), () => 104000));
      assert.equal(completeQuestion(db, room.id, () => 140000), true);
      assert.deepEqual((getSurfaceState(db, room.id, 'screen')!.game as any).statistics, { correct: 1, wrong: 1, unanswered: 1 });
      assert.deepEqual((getPlayerGame(db, room.id, 'en', identities[0].player.id) as any).result, { outcome: 'correct', points: q.points });
      await api.post(`${root}/next`).expect(200);
    }
    const scores = db.prepare('SELECT player_id, SUM(awarded_points) total FROM question_scores GROUP BY player_id').all();
    assert.equal(scores.find(s => s.player_id === identities[0].player.id)!.total, 6);
    assert.deepEqual(scores.filter(s => s.player_id !== identities[0].player.id).map(s => s.total), [0, 0]);
    assert.equal((await api.get(root)).body.state, 'ROUND_END');
  } finally { db.close(); }
});

test('Yes / No option failure rolls back creation and conversion', () => {
  const db = initializeDatabase(':memory:');
  try {
    const { round, fields } = setup(db);
    const existing = createQuestion(db, round.id);
    db.exec("CREATE TRIGGER fail_option BEFORE INSERT ON answer_options BEGIN SELECT RAISE(ABORT, 'option failure'); END");
    assert.throws(() => createQuestion(db, round.id, 'yes_no'), /option failure/);
    assert.equal(db.prepare('SELECT count(*) n FROM questions').get()!.n, 1);
    assert.throws(() => updateQuestion(db, round.id, existing.id, fields), /option failure/);
    assert.equal(db.prepare('SELECT type FROM questions').get()!.type, 'single_choice');
    assert.equal(listOptions(db, existing.id).length, 0);
  } finally { db.close(); }
});

test('Phase 5A migration preserves old options and active version-1 game snapshots', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'yes-no-migration-'));
  const path = join(directory, 'quiz.sqlite');
  let db = initializeDatabase(path);
  try {
    const { quiz, round, fields, api } = setup(db);
    const q = createQuestion(db, round.id);
    updateQuestion(db, round.id, q.id, { ...fields, type: 'single_choice' });
    for (const correct of [1, 0]) {
      const o = createOption(db, q.id);
      db.prepare("UPDATE answer_options SET text_ru = 'Ответ', text_en = 'Answer', is_correct = ? WHERE id = ?").run(correct, o.id);
    }
    const room = (await api.post(`/api/quizzes/${quiz.id}/rooms`).expect(201)).body;
    await api.post(`/api/rooms/code/${room.code}/players`).send({ name: 'Alice', language: 'en' }).expect(201);
    await api.post(`/api/rooms/${room.id}/start`).expect(200);
    await api.post(`/api/rooms/${room.id}/start-round`).expect(200);
    startQuestion(db, room.id, 100000);
    const tables = ['questions', 'answer_options', 'game_sessions', 'session_players'];
    const before = tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
    const oldSchema = String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'questions'").get()!.sql).replace("type IN ('single_choice', 'yes_no', 'multiple_choice')", "type = 'single_choice'");
    db.exec('PRAGMA foreign_keys = OFF; BEGIN');
    db.exec('CREATE TEMP TABLE saved_questions AS SELECT * FROM questions; DROP TABLE questions');
    db.exec(oldSchema);
    db.exec('INSERT INTO questions SELECT * FROM saved_questions; DROP TABLE saved_questions; CREATE INDEX questions_round_position ON questions(round_id, position); DELETE FROM schema_migrations WHERE version IN (15, 16); COMMIT; PRAGMA foreign_keys = ON');
    db.close(); db = initializeDatabase(path);
    tables.forEach((table, index) => assert.deepEqual(db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(), before[index]));
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(getGameSnapshot(db, room.id)!.rounds[0].questions[0].type, 'single_choice');
    createQuestion(db, round.id, 'yes_no');
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
