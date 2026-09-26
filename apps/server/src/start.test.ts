import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import request from 'supertest';
import { initializeDatabase } from './db.js';
import { createApp } from './app.js';
import { createQuiz } from './quizzes.js';
import { createRound, reorderRounds } from './rounds.js';
import { createQuestion, createOption, reorderQuestions, reorderOptions } from './questions.js';

function fixture(db: ReturnType<typeof initializeDatabase>) {
  const quiz = createQuiz(db);
  db.prepare('UPDATE quizzes SET title = ?, theme_id = ?, default_answer_time_seconds = ?, shuffle_answers = ? WHERE id = ?')
    .run('Frozen party', 'halloween', 45, 1, quiz.id);
  const rounds = [0, 1].map(i => {
    const round = createRound(db, quiz.id);
    db.prepare('UPDATE rounds SET description_ru = ?, description_en = ?, show_leaderboard_after = 1 WHERE id = ?').run('Описание', 'Description', round.id);
    const questions = [0, 1].map(j => {
      const question = createQuestion(db, round.id);
      db.prepare('UPDATE questions SET text_ru = ?, text_en = ?, points = 3, answer_time_seconds = 12, show_options_on_screen = 1 WHERE id = ?')
        .run(`Вопрос ${i}/${j}`, `Question ${i}/${j}`, question.id);
      const options = [1, 0].map(correct => {
        const option = createOption(db, question.id);
        db.prepare('UPDATE answer_options SET text_ru = ?, text_en = ?, is_correct = ? WHERE id = ?').run('Ответ', 'Answer', correct, option.id);
        return option;
      });
      reorderOptions(db, question.id, options.map(o => o.id).reverse());
      return { ...question, options: options.reverse() };
    });
    reorderQuestions(db, round.id, questions.map(q => q.id).reverse());
    return { ...round, questions: questions.reverse() };
  });
  reorderRounds(db, quiz.id, rounds.map(r => r.id).reverse());
  return { quiz, rounds: rounds.reverse() };
}

async function lobby(db: ReturnType<typeof initializeDatabase>, players = 1) {
  const content = fixture(db);
  const api = request(createApp(db));
  const { body: room } = await api.post(`/api/quizzes/${content.quiz.id}/rooms`).expect(201);
  const identities = [];
  for (const name of ['Alice', 'Bob'].slice(0, players)) {
    identities.push((await api.post(`/api/rooms/code/${room.code}/players`).send({ name, language: 'en' }).expect(201)).body);
  }
  return { ...content, room, api, identities };
}

for (const scenario of ['missing', 'closed', 'empty', 'invalid', 'removed-only'] as const) {
  test(`Start rejects ${scenario} and leaves no partial game`, async () => {
    const db = initializeDatabase(':memory:');
    try {
      const { api, room } = await lobby(db, scenario === 'empty' ? 0 : 1);
      if (scenario === 'closed') await api.post(`/api/rooms/${room.id}/close`).expect(200);
      if (scenario === 'invalid') db.exec("UPDATE questions SET text_en = ''");
      if (scenario === 'removed-only') db.exec("UPDATE session_players SET removed_at = 'now'");
      const result = await api.post(`/api/rooms/${scenario === 'missing' ? 'missing' : room.id}/start`);
      assert.equal(result.status, scenario === 'missing' ? 404 : 409);
      if (scenario === 'invalid') assert.equal(result.body.validation.ready, false);
      const stored = db.prepare('SELECT state, snapshot_json, roster_locked_at FROM game_sessions WHERE id = ?').get(room.id)!;
      assert.deepEqual({ ...stored }, { state: 'LOBBY', snapshot_json: null, roster_locked_at: null });
      assert.equal(db.prepare('SELECT count(*) AS n FROM session_players WHERE in_roster = 1').get()!.n, 0);
    } finally { db.close(); }
  });
}

test('Start freezes ordered content and active roster; edits, deletion and restart preserve the game', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'quiz-start-'));
  const path = join(directory, 'quiz.sqlite');
  let db = initializeDatabase(path);
  try {
    const { api, room, quiz, rounds, identities } = await lobby(db, 2);
    const removed = (await api.post(`/api/rooms/code/${room.code}/players`).send({ name: 'Removed', language: 'ru' }).expect(201)).body;
    db.prepare("UPDATE session_players SET removed_at = 'now' WHERE id = ?").run(removed.player.id);
    db.prepare('UPDATE quizzes SET title = ? WHERE id = ?').run('Last Lobby edit', quiz.id);
    const started = (await api.post(`/api/rooms/${room.id}/start`).expect(200)).body;
    assert.equal(started.state, 'ROUND_INTRO');
    assert.equal(started.quizTitle, 'Last Lobby edit');
    const stored = db.prepare('SELECT snapshot_json, roster_locked_at FROM game_sessions WHERE id = ?').get(room.id)!;
    assert.ok(Number.isFinite(Date.parse(String(stored.roster_locked_at))));
    const snapshot = JSON.parse(String(stored.snapshot_json));
    assert.deepEqual(Object.keys(snapshot).sort(), ['schemaVersion', 'title', 'themeId', 'defaultAnswerTimeSeconds', 'shuffleAnswers', 'rounds'].sort());
    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.title, 'Last Lobby edit');
    assert.equal(snapshot.themeId, 'halloween');
    assert.equal(snapshot.defaultAnswerTimeSeconds, 45);
    assert.equal(snapshot.shuffleAnswers, true);
    assert.deepEqual(snapshot.rounds.map((r: any) => r.id), rounds.map(r => r.id));
    for (const [i, round] of snapshot.rounds.entries()) {
      assert.equal(round.position, i);
      assert.equal(round.titleRu, 'Новый раунд');
      assert.equal(round.titleEn, 'New Round');
      assert.equal(round.descriptionRu, 'Описание');
      assert.equal(round.descriptionEn, 'Description');
      assert.equal(round.showLeaderboardAfter, true);
      assert.deepEqual(round.questions.map((q: any) => q.id), rounds[i].questions.map(q => q.id));
      for (const [j, question] of round.questions.entries()) {
        assert.equal(question.position, j);
        assert.equal(question.type, 'single_choice');
        assert.equal(question.textRu, `Вопрос ${1 - i}/${1 - j}`);
        assert.equal(question.textEn, `Question ${1 - i}/${1 - j}`);
        assert.equal(question.points, 3);
        assert.equal(question.answerTimeSeconds, 12);
        assert.equal(question.showOptionsOnScreen, true);
        assert.deepEqual(question.options.map((o: any) => o.id), rounds[i].questions[j].options.map(o => o.id));
        assert.deepEqual(question.options.map((o: any) => [o.position, o.textRu, o.textEn, o.isCorrect]), [[0, 'Ответ', 'Answer', false], [1, 'Ответ', 'Answer', true]]);
      }
    }
    const roster = () => db.prepare('SELECT id FROM session_players WHERE in_roster = 1 ORDER BY id').all().map(p => p.id);
    assert.deepEqual(roster(), identities.map(p => p.player.id).sort());
    await api.post(`/api/rooms/${room.id}/start`).expect(409);
    const late = await api.post(`/api/rooms/code/${room.code}/players`).send({ name: 'Charlie', language: 'en' }).expect(409);
    assert.match(late.body.error, /started|accepting/i);
    await api.post(`/api/rooms/${room.id}/reconnect`).send({ token: removed.token }).expect(401);
    db.exec("UPDATE quizzes SET title = 'Changed'; UPDATE rounds SET title_en = 'Changed', position = position + 10; UPDATE questions SET text_en = 'Changed', position = position + 10; UPDATE answer_options SET text_en = 'Changed', is_correct = 1 - is_correct, position = position + 10");
    db.prepare('DELETE FROM rounds WHERE id = ?').run(rounds[0].id);
    assert.equal(db.prepare('SELECT snapshot_json FROM game_sessions WHERE id = ?').get(room.id)!.snapshot_json, stored.snapshot_json);
    await api.delete(`/api/quizzes/${quiz.id}`).expect(204);
    db.close();
    db = initializeDatabase(path);
    const reopened = request(createApp(db));
    const { getGameSnapshot } = await import('./snapshot.js');
    assert.deepEqual(getGameSnapshot(db, room.id), snapshot);
    // The reader returns independent data, never an editable/shared cache.
    const copy = getGameSnapshot(db, room.id)!;
    copy.rounds[0].titleEn = 'Local mutation';
    assert.deepEqual(getGameSnapshot(db, room.id), snapshot);
    assert.equal(db.prepare('SELECT snapshot_json FROM game_sessions WHERE id = ?').get(room.id)!.snapshot_json, stored.snapshot_json);
    assert.deepEqual(roster(), identities.map(p => p.player.id).sort());
    for (const path of [`/api/rooms/${room.id}`, `/api/rooms/${room.id}/lobby`, `/api/rooms/code/${room.code}`]) {
      const response = await reopened.get(path).expect(200);
      const publicRoom = response.body.room ?? response.body;
      assert.equal(publicRoom.quizTitle, 'Last Lobby edit');
      assert.equal(publicRoom.quizId, null);
      assert.equal(publicRoom.state, 'ROUND_INTRO');
      assert.doesNotMatch(JSON.stringify(response.body), /isCorrect|snapshot|options|questions/);
    }
    for (const identity of identities) {
      const response = await reopened.post(`/api/rooms/${room.id}/reconnect`).send({ token: identity.token }).expect(200);
      assert.equal(response.body.room.state, 'ROUND_INTRO');
      assert.equal(response.body.player.id, identity.player.id);
      assert.doesNotMatch(JSON.stringify(response.body), /isCorrect|snapshot|options|questions/);
    }
    await reopened.post(`/api/rooms/${room.id}/close`).expect(200);
    assert.equal((await reopened.post(`/api/rooms/${room.id}/reconnect`).send({ token: identities[0].token }).expect(200)).body.active, false);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a database failure during Start rolls back snapshot, state and roster together', async () => {
  const db = initializeDatabase(':memory:');
  try {
    const { room, api } = await lobby(db);
    db.exec(`CREATE TRIGGER fail_start BEFORE UPDATE OF state ON game_sessions
      WHEN NEW.state = 'ROUND_INTRO' BEGIN SELECT RAISE(ABORT, 'start failure'); END`);
    await api.post(`/api/rooms/${room.id}/start`).expect(500);
    assert.deepEqual({ ...db.prepare('SELECT state, snapshot_json, roster_locked_at FROM game_sessions WHERE id = ?').get(room.id) },
      { state: 'LOBBY', snapshot_json: null, roster_locked_at: null });
    assert.equal(db.prepare('SELECT count(*) AS n FROM session_players WHERE in_roster = 1').get()!.n, 0);
    db.exec('DROP TRIGGER fail_start');
    await api.post(`/api/rooms/${room.id}/start`).expect(200);
  } finally { db.close(); }
});

test('snapshot access validates stored version and nested types instead of trusting JSON', async () => {
  const { getGameSnapshot, parseGameSnapshot } = await import('./snapshot.js');
  const db = initializeDatabase(':memory:');
  try {
    const { api, room } = await lobby(db);
    assert.equal(getGameSnapshot(db, 'missing'), null);
    assert.equal(getGameSnapshot(db, room.id), null);
    await api.post(`/api/rooms/${room.id}/start`).expect(200);
    const snapshot = getGameSnapshot(db, room.id)!;
    for (const corrupt of [
      (s: any) => { s.schemaVersion = 99; },
      (s: any) => { s.rounds[0].questions[0].options[0].isCorrect = 'false'; },
      (s: any) => { s.rounds[0].questions[0].answerTimeSeconds = '12'; },
      (s: any) => { delete s.rounds[0].descriptionRu; },
      (s: any) => { s.rounds = []; },
    ]) {
      const copy = structuredClone(snapshot);
      corrupt(copy);
      assert.throws(() => parseGameSnapshot(JSON.stringify(copy)), /Invalid game snapshot/);
    }
    assert.throws(() => parseGameSnapshot('broken'), SyntaxError);
    db.prepare('UPDATE game_sessions SET snapshot_json = ? WHERE id = ?').run('{"schemaVersion":99}', room.id);
    assert.throws(() => getGameSnapshot(db, room.id), /Invalid game snapshot/);
  } finally { db.close(); }
});

for (const showOptions of [true, false]) test(`Round navigation restores frozen content with screen options ${showOptions}`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'quiz-game-'));
  const path = join(directory, 'quiz.sqlite');
  let db = initializeDatabase(path);
  try {
    const { api, room, quiz, identities } = await lobby(db);
    db.prepare('UPDATE questions SET show_options_on_screen = ?, answer_time_seconds = ?').run(Number(showOptions), showOptions ? 12 : null);
    db.exec("UPDATE answer_options SET text_en = CASE WHEN is_correct = 1 THEN 'Correct option' ELSE 'Other option' END");
    await api.post(`/api/rooms/${room.id}/start-round`).expect(409);
    await api.post('/api/rooms/missing/start-round').expect(404);
    await api.post(`/api/rooms/${room.id}/start`).expect(200);
    assert.deepEqual({ ...db.prepare('SELECT current_round_index, current_question_index FROM game_sessions').get() },
      { current_round_index: 0, current_question_index: null });
    const intro = (await api.get(`/api/rooms/${room.id}/game/host`).expect(200)).body;
    assert.deepEqual(intro.game, { state: 'ROUND_INTRO', roundNumber: 1, titleRu: 'Новый раунд', titleEn: 'New Round', descriptionRu: 'Описание', descriptionEn: 'Description', questionCount: 2 });
    db.exec("UPDATE rounds SET title_en = 'Edited'; UPDATE questions SET text_en = 'Edited'");
    assert.deepEqual((await api.get(`/api/rooms/${room.id}/game/host`)).body, intro);
    await api.delete(`/api/quizzes/${quiz.id}`).expect(204);
    assert.deepEqual((await api.get(`/api/rooms/${room.id}/game/screen`)).body.game, intro.game);
    await api.post(`/api/rooms/${room.id}/start-round`).expect(200);
    await api.post(`/api/rooms/${room.id}/start-round`).expect(409);
    const host = (await api.get(`/api/rooms/${room.id}/game/host`).expect(200)).body;
    assert.equal(host.game.state, 'QUESTION');
    assert.equal(host.game.textEn, 'Question 1/1');
    assert.equal(host.game.questionNumber, 1);
    assert.equal(host.game.roundNumber, 1);
    assert.equal(host.game.questionCount, 2);
    assert.equal(host.game.answerTimeSeconds, showOptions ? 12 : 45);
    assert.equal(host.game.points, 3);
    assert.deepEqual(host.game.options.map((o: any) => o.isCorrect), [false, true]);
    const screen = (await api.get(`/api/rooms/${room.id}/game/screen`).expect(200)).body;
    assert.equal(screen.game.textRu, 'Вопрос 1/1');
    assert.deepEqual(screen.game.options, showOptions ? [{ textRu: 'Ответ', textEn: 'Other option' }, { textRu: 'Ответ', textEn: 'Correct option' }] : undefined);
    assert.doesNotMatch(JSON.stringify(screen), /isCorrect|snapshot|Question 1\/0|points|answerTimeSeconds/);
    const player = (await api.post(`/api/rooms/${room.id}/reconnect`).send({ token: identities[0].token }).expect(200)).body;
    assert.equal(player.room.state, 'QUESTION');
    assert.doesNotMatch(JSON.stringify(player), /isCorrect|snapshot|options|Question 1\/|questions/);
    db.close();
    db = initializeDatabase(path);
    const restored = request(createApp(db));
    assert.deepEqual((await restored.get(`/api/rooms/${room.id}/game/host`)).body, host);
    assert.deepEqual((await restored.get(`/api/rooms/${room.id}/game/screen`)).body, screen);
    await restored.post(`/api/rooms/${room.id}/close`).expect(200);
    await restored.post(`/api/rooms/${room.id}/start-round`).expect(409);
    assert.equal((await restored.get(`/api/rooms/${room.id}/game/host`)).body.game, null);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const invalid of ['closed', 'snapshot', 'round']) test(`Start Round rejects ${invalid} without changing navigation`, async () => {
  const db = initializeDatabase(':memory:');
  try {
    const { api, room } = await lobby(db);
    await api.post(`/api/rooms/${room.id}/start`).expect(200);
    if (invalid === 'closed') await api.post(`/api/rooms/${room.id}/close`).expect(200);
    if (invalid === 'snapshot') db.exec(`UPDATE game_sessions SET snapshot_json = '{}'`);
    if (invalid === 'round') db.exec('UPDATE game_sessions SET current_round_index = 99');
    await api.post(`/api/rooms/${room.id}/start-round`).expect(409);
    assert.equal(db.prepare('SELECT state FROM game_sessions').get()!.state, 'ROUND_INTRO');
    assert.equal(db.prepare('SELECT current_question_index FROM game_sessions').get()!.current_question_index, null);
  } finally { db.close(); }
});

test('Start Round rolls back state and question navigation together on a database failure', async () => {
  const db = initializeDatabase(':memory:');
  try {
    const { api, room } = await lobby(db);
    await api.post(`/api/rooms/${room.id}/start`).expect(200);
    db.exec(`CREATE TRIGGER fail_round AFTER UPDATE OF state ON game_sessions
      WHEN NEW.state = 'QUESTION' BEGIN SELECT RAISE(ABORT, 'round failure'); END`);
    await api.post(`/api/rooms/${room.id}/start-round`).expect(500);
    assert.deepEqual({ ...db.prepare('SELECT state, current_round_index, current_question_index FROM game_sessions').get() },
      { state: 'ROUND_INTRO', current_round_index: 0, current_question_index: null });
    db.exec('DROP TRIGGER fail_round');
    await api.post(`/api/rooms/${room.id}/start-round`).expect(200);
  } finally { db.close(); }
});
