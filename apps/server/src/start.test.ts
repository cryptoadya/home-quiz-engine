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

for (const override of [12, null]) test(`Start Question persists frozen ${override === null ? 'default' : 'override'} timer and safe identity projection`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'quiz-timer-'));
  const path = join(directory, 'quiz.sqlite');
  let db = initializeDatabase(path);
  try {
    const { api, room, quiz, identities, rounds } = await lobby(db);
    db.prepare('UPDATE questions SET answer_time_seconds = ?').run(override);
    await api.post(`/api/rooms/${room.id}/start-question`).expect(409);
    await api.post('/api/rooms/missing/start-question').expect(404);
    await api.post(`/api/rooms/${room.id}/start`).expect(200);
    await api.post(`/api/rooms/${room.id}/start-question`).expect(409);
    await api.post(`/api/rooms/${room.id}/start-round`).expect(200);
    const before = Date.now();
    await api.post(`/api/rooms/${room.id}/start-question`).expect(200);
    const stored = db.prepare('SELECT state, answer_started_at, answer_deadline_at FROM game_sessions').get()!;
    assert.equal(stored.state, 'ANSWERING');
    const start = Date.parse(String(stored.answer_started_at));
    const deadline = Date.parse(String(stored.answer_deadline_at));
    assert.ok(start >= before && start <= Date.now());
    assert.equal(deadline - start, (override ?? 45) * 1000);
    await api.post(`/api/rooms/${room.id}/start-question`).expect(409);
    db.exec('UPDATE quizzes SET default_answer_time_seconds = 999; UPDATE questions SET answer_time_seconds = 999');
    await api.delete(`/api/quizzes/${quiz.id}`).expect(204);
    const { getSurfaceState } = await import('./game.js');
    for (const [now, remaining, expired] of [[deadline - 1, 1, false], [deadline, 0, true], [deadline + 1000, 0, true]] as const) {
      const projected = getSurfaceState(db, room.id, 'screen', now) as any;
      assert.equal(projected.game.state, 'ANSWERING');
      assert.equal(projected.game.timer.remainingMs, remaining);
      assert.equal(projected.game.timer.expired, expired);
      assert.equal(projected.game.timer.deadlineAt, stored.answer_deadline_at);
      assert.doesNotMatch(JSON.stringify(projected), /isCorrect|snapshot|Question 1\/0|points/);
    }
    for (const language of ['en', 'ru']) {
      db.prepare('UPDATE session_players SET language = ? WHERE id = ?').run(language, identities[0].player.id);
      const projection = (await api.post(`/api/rooms/${room.id}/reconnect`).send({ token: identities[0].token }).expect(200)).body;
      assert.equal(projection.game.questionId, rounds[0].questions[0].id);
      assert.equal(projection.game.text, language === 'en' ? 'Question 1/1' : 'Вопрос 1/1');
      assert.deepEqual(projection.game.options.map((o: any) => o.id), rounds[0].questions[0].options.map(o => o.id));
      assert.deepEqual(Object.keys(projection.game.options[0]).sort(), ['id', 'text']);
      assert.doesNotMatch(JSON.stringify(projection), /isCorrect|snapshot|textRu|textEn|points|Question 1\/0/);
    }
    await api.post(`/api/rooms/${room.id}/reconnect`).send({ token: 'invalid' }).expect(401);
    await api.post('/api/rooms/other/reconnect').send({ token: identities[0].token }).expect(401);
    db.exec('UPDATE session_players SET in_roster = 0');
    await api.post(`/api/rooms/${room.id}/reconnect`).send({ token: identities[0].token }).expect(401);
    db.exec('UPDATE session_players SET in_roster = 1');
    db.close(); db = initializeDatabase(path);
    const restored = request(createApp(db));
    const host = (await restored.get(`/api/rooms/${room.id}/game/host`).expect(200)).body;
    assert.equal(host.game.timer.deadlineAt, stored.answer_deadline_at);
    assert.equal(host.game.timer.durationSeconds, override ?? 45);
    assert.equal(host.game.textEn, 'Question 1/1');
    assert.ok(host.game.options.some((o: any) => o.isCorrect));
    await restored.post(`/api/rooms/${room.id}/start-question`).expect(409);
    assert.deepEqual(db.prepare('SELECT state, answer_started_at, answer_deadline_at FROM game_sessions').get(), stored);
    await restored.post(`/api/rooms/${room.id}/close`).expect(200);
    await restored.post(`/api/rooms/${room.id}/start-question`).expect(409);
    assert.equal((await restored.get(`/api/rooms/${room.id}/game/host`)).body.game, null);
    assert.equal((await restored.post(`/api/rooms/${room.id}/reconnect`).send({ token: identities[0].token })).body.game, null);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const invalid of ['closed', 'question', 'duration', 'failure']) test(`Start Question rejects ${invalid} atomically`, async () => {
  const db = initializeDatabase(':memory:');
  try {
    const { api, room } = await lobby(db);
    await api.post(`/api/rooms/${room.id}/start`).expect(200);
    await api.post(`/api/rooms/${room.id}/start-round`).expect(200);
    if (invalid === 'closed') await api.post(`/api/rooms/${room.id}/close`).expect(200);
    if (invalid === 'question') db.exec('UPDATE game_sessions SET current_question_index = 99');
    if (invalid === 'duration') db.exec("UPDATE game_sessions SET snapshot_json = json_set(snapshot_json, '$.rounds[0].questions[0].answerTimeSeconds', 0)");
    if (invalid === 'failure') db.exec("CREATE TRIGGER fail_timer AFTER UPDATE ON game_sessions WHEN NEW.state = 'ANSWERING' BEGIN SELECT RAISE(ABORT, 'timer failure'); END");
    await api.post(`/api/rooms/${room.id}/start-question`).expect(invalid === 'failure' ? 500 : 409);
    assert.deepEqual({ ...db.prepare('SELECT state, answer_started_at, answer_deadline_at FROM game_sessions').get() },
      { state: 'QUESTION', answer_started_at: null, answer_deadline_at: null });
  } finally { db.close(); }
});

test('injected server time sets the exact deadline; projections and repeat actions never extend it', async () => {
  const db = initializeDatabase(':memory:');
  try {
    const { api, room } = await lobby(db);
    await api.post(`/api/rooms/${room.id}/start`).expect(200);
    await api.post(`/api/rooms/${room.id}/start-round`).expect(200);
    const { startQuestion, getSurfaceState } = await import('./game.js');
    const now = Date.parse('2026-09-26T12:00:00.000Z');
    assert.equal(startQuestion(db, room.id, now).room?.state, 'ANSWERING');
    assert.deepEqual({ ...db.prepare('SELECT answer_started_at, answer_deadline_at FROM game_sessions').get() },
      { answer_started_at: '2026-09-26T12:00:00.000Z', answer_deadline_at: '2026-09-26T12:00:12.000Z' });
    assert.equal(startQuestion(db, room.id, now + 20000).status, 409);
    const state = getSurfaceState(db, room.id, 'host', now + 20000) as any;
    assert.equal(state.game.timer.deadlineAt, '2026-09-26T12:00:12.000Z');
    assert.equal(state.game.timer.expired, true);
    assert.equal(state.room.state, 'ANSWERING');
  } finally { db.close(); }
});

// Phase 3C: exercise HTTP authorization and durable submissions together.
test('answers are immutable, private, counted once and restored after DB reopen', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'quiz-answers-'));
  const path = join(directory, 'quiz.sqlite');
  let db = initializeDatabase(path);
  try {
    const { room, identities, api, rounds } = await lobby(db, 2);
    await api.post(`/api/rooms/${room.id}/start`).expect(200);
    await api.post(`/api/rooms/${room.id}/start-round`).expect(200);
    await api.post(`/api/rooms/${room.id}/start-question`).expect(200);
    const q = rounds[0].questions[0];
    const deadline = Date.parse(String(db.prepare('SELECT answer_deadline_at FROM game_sessions').get()!.answer_deadline_at));
    t.mock.method(Date, 'now', () => deadline - 1);
    let broadcasts = 0;
    const submitApi = request(createApp(db, () => {
      broadcasts++;
      const observer = initializeDatabase(path);
      try { assert.equal(observer.prepare('SELECT count(*) AS n FROM player_answers').get()!.n, 1); } finally { observer.close(); }
    }));
    const body = { token: identities[0].token, questionId: q.id, optionId: q.options[0].id };
    const initial = (await api.get(`/api/rooms/${room.id}/game/host`)).body;
    assert.deepEqual(initial.game.answers, { answered: 0, expected: 2 });
    const accepted = (await submitApi.post(`/api/rooms/${room.id}/answers`).send(body).expect(200)).body;
    assert.deepEqual(accepted, { submitted: true, optionId: body.optionId });
    for (const optionId of [body.optionId, q.options[1].id]) {
      assert.deepEqual((await submitApi.post(`/api/rooms/${room.id}/answers`).send({ ...body, optionId }).expect(200)).body, accepted);
    }
    t.mock.method(Date, 'now', () => deadline + 1);
    assert.deepEqual((await submitApi.post(`/api/rooms/${room.id}/answers`).send(body).expect(200)).body, accepted);
    await submitApi.post(`/api/rooms/${room.id}/answers`).send({ ...body, optionId: 'missing' }).expect(400);
    await submitApi.post(`/api/rooms/${room.id}/answers`).send({ ...body, questionId: rounds[0].questions[1].id }).expect(409);
    const late = await submitApi.post(`/api/rooms/${room.id}/answers`).send({ ...body, token: identities[1].token }).expect(409);
    assert.equal(late.body.code, 'DEADLINE_REACHED');
    assert.equal(broadcasts, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM player_answers').get()!.n, 1);
    assert.equal(db.prepare('SELECT option_ids_json FROM player_answers').get()!.option_ids_json, JSON.stringify([body.optionId]));
    for (const audience of ['host', 'screen']) {
      const state = (await api.get(`/api/rooms/${room.id}/game/${audience}`)).body;
      assert.deepEqual(state.game.answers, { answered: 1, expected: 2 });
      assert.equal(state.room.state, 'ANSWERING');
      assert.doesNotMatch(JSON.stringify(state), /optionId|option_id|submitted|playerId/);
    }
    db.close(); db = initializeDatabase(path);
    const restored = (await request(createApp(db)).post(`/api/rooms/${room.id}/reconnect`).send({ token: body.token }).expect(200)).body;
    assert.deepEqual(restored.game.submission, accepted);
    assert.doesNotMatch(JSON.stringify(restored), /isCorrect|correctOption|score|answered/);
    assert.throws(() => db.prepare('INSERT INTO player_answers SELECT * FROM player_answers').run(), /UNIQUE/);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const offset of [-1, 0, 1]) test(`submission deadline offset ${offset} is decided by server time`, async (t) => {
  const db = initializeDatabase(':memory:');
  try {
    const { api, room, identities, rounds } = await lobby(db);
    await api.post(`/api/rooms/${room.id}/start`).expect(200);
    await api.post(`/api/rooms/${room.id}/start-round`).expect(200);
    await api.post(`/api/rooms/${room.id}/start-question`).expect(200);
    const deadline = Date.parse(String(db.prepare('SELECT answer_deadline_at FROM game_sessions').get()!.answer_deadline_at));
    t.mock.method(Date, 'now', () => deadline + offset);
    const q = rounds[0].questions[0];
    const response = await api.post(`/api/rooms/${room.id}/answers`).send({ token: identities[0].token, questionId: q.id, optionId: q.options[0].id }).expect(offset < 0 ? 200 : 409);
    if (offset >= 0) assert.equal(response.body.code, 'DEADLINE_REACHED');
    assert.equal(db.prepare('SELECT count(*) AS n FROM player_answers').get()!.n, offset < 0 ? 1 : 0);
    assert.equal(db.prepare('SELECT state FROM game_sessions').get()!.state, offset < 0 ? 'ANSWER_REVEAL' : 'ANSWERING');
  } finally { db.close(); }
});

for (const scenario of ['missing', 'invalid-token', 'other-room-token', 'non-roster', 'lobby', 'question', 'closed', 'wrong-question', 'missing-option', 'other-question-option', 'malformed']) {
  test(`Submit rejects ${scenario} without inserting`, async () => {
    const db = initializeDatabase(':memory:');
    try {
      const { api, room, identities, rounds } = await lobby(db);
      if (scenario !== 'lobby') {
        await api.post(`/api/rooms/${room.id}/start`).expect(200);
        await api.post(`/api/rooms/${room.id}/start-round`).expect(200);
        if (scenario !== 'question') await api.post(`/api/rooms/${room.id}/start-question`).expect(200);
      }
      const q = rounds[0].questions[0];
      const body = { token: identities[0].token, questionId: q.id, optionId: q.options[0].id };
      let status = 409;
      if (scenario === 'missing') status = 404;
      if (scenario === 'invalid-token') { body.token = 'invalid'; status = 401; }
      if (scenario === 'other-room-token') { body.token = (await lobby(db)).identities[0].token; status = 401; }
      if (scenario === 'non-roster') { db.exec('UPDATE session_players SET in_roster = 0'); status = 401; }
      if (scenario === 'closed') await api.post(`/api/rooms/${room.id}/close`).expect(200);
      if (scenario === 'wrong-question') body.questionId = rounds[0].questions[1].id;
      if (scenario === 'missing-option') { body.optionId = 'missing'; status = 400; }
      if (scenario === 'other-question-option') { body.optionId = rounds[0].questions[1].options[0].id; status = 400; }
      if (scenario === 'malformed') status = 400;
      await api.post(`/api/rooms/${scenario === 'missing' ? 'missing' : room.id}/answers`).send(scenario === 'malformed' ? { ...body, optionId: [] } : body).expect(status);
      assert.equal(db.prepare('SELECT count(*) AS n FROM player_answers').get()!.n, 0);
    } finally { db.close(); }
  });
}

test('Phase 3B migration preserves every phase, frozen state, roster and timer without fake answers', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'quiz-answer-migration-'));
  const path = join(directory, 'quiz.sqlite');
  let db = initializeDatabase(path);
  try {
    for (const phase of ['LOBBY', 'ROUND_INTRO', 'QUESTION', 'ANSWERING']) {
      const { api, room } = await lobby(db);
      if (phase !== 'LOBBY') await api.post(`/api/rooms/${room.id}/start`).expect(200);
      if (phase === 'QUESTION' || phase === 'ANSWERING') await api.post(`/api/rooms/${room.id}/start-round`).expect(200);
      if (phase === 'ANSWERING') await api.post(`/api/rooms/${room.id}/start-question`).expect(200);
    }
    // Remove only migration 9's additive schema to reproduce an actual 3B DB.
    db.exec('DROP TABLE player_answers; DELETE FROM schema_migrations WHERE version IN (9, 17)');
    const sessions = db.prepare('SELECT * FROM game_sessions ORDER BY id').all();
    const players = db.prepare('SELECT * FROM session_players ORDER BY id').all();
    db.close(); db = initializeDatabase(path);
    assert.deepEqual(db.prepare('SELECT * FROM game_sessions ORDER BY id').all(), sessions);
    assert.deepEqual(db.prepare('SELECT * FROM session_players ORDER BY id').all(), players);
    assert.equal(db.prepare('SELECT count(*) AS n FROM player_answers').get()!.n, 0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('last accepted answer reveals immediately and scores the locked roster once', async () => {
  const db = initializeDatabase(':memory:');
  try {
    const { api, room, rounds, identities } = await lobby(db, 2);
    await api.post(`/api/rooms/${room.id}/start`).expect(200);
    await api.post(`/api/rooms/${room.id}/start-round`).expect(200);
    await api.post(`/api/rooms/${room.id}/start-question`).expect(200);
    const q = rounds[0].questions[0];
    for (let i = 0; i < 2; i++) {
      await api.post(`/api/rooms/${room.id}/answers`).send({ token: identities[i].token, questionId: q.id, optionId: q.options[i].id }).expect(200);
      assert.equal((await api.get(`/api/rooms/${room.id}`)).body.state, i === 0 ? 'ANSWERING' : 'ANSWER_REVEAL');
    }
    const scores = db.prepare('SELECT awarded_points FROM question_scores ORDER BY awarded_points').all();
    assert.deepEqual(scores.map(s => s.awarded_points), [0, 3]);
    assert.ok(Date.now() < Date.parse(String(db.prepare('SELECT answer_deadline_at FROM game_sessions').get()!.answer_deadline_at)));
  } finally { db.close(); }
});

for (const count of [0, 1, 2]) test(`timeout freezes ${count} answers, scores all players, and restores private Reveal after restart`, async () => {
  const { startQuestion, getPlayerGame, getSurfaceState } = await import('./game.js');
  const { submitAnswer } = await import('./answers.js');
  const { completeQuestion } = await import('./reveal.js');
  const directory = mkdtempSync(join(tmpdir(), 'quiz-reveal-'));
  const path = join(directory, 'quiz.sqlite');
  let db = initializeDatabase(path);
  try {
    const { api, room, rounds, identities, quiz } = await lobby(db, 2);
    const third = (await api.post(`/api/rooms/code/${room.code}/players`).send({ name: 'Charlie', language: 'ru' }).expect(201)).body;
    identities.push(third);
    await api.post(`/api/rooms/${room.id}/start`).expect(200);
    await api.post(`/api/rooms/${room.id}/start-round`).expect(200);
    const now = 100000;
    startQuestion(db, room.id, now);
    const q = rounds[0].questions[0];
    for (let i = 0; i < count; i++) {
      assert.ok('submission' in submitAnswer(db, room.id, { token: identities[i].token, questionId: q.id, optionId: q.options[i].id }, () => now + 11999));
    }
    for (const audience of ['screen', 'player'] as const) assert.doesNotMatch(JSON.stringify(getSurfaceState(db, room.id, audience)), /isCorrect|correctOptionId|awarded_points/);
    assert.doesNotMatch(JSON.stringify(getPlayerGame(db, room.id, 'en', identities[0].player.id)), /isCorrect|correctOptionId|outcome/);
    assert.equal(completeQuestion(db, room.id, () => now + 11999), false);
    assert.equal('status' in submitAnswer(db, room.id, { token: third.token, questionId: q.id, optionId: q.options[0].id }, () => now + 12000), true);
    db.exec('UPDATE questions SET points = 99; UPDATE answer_options SET is_correct = 0');
    await api.delete(`/api/quizzes/${quiz.id}`).expect(204);
    assert.equal(completeQuestion(db, room.id, () => now + 12000), true);
    assert.equal(completeQuestion(db, room.id, () => now + 13000), false);
    assert.equal(db.prepare('SELECT count(*) AS n FROM player_answers').get()!.n, count);
    const scores = db.prepare('SELECT player_id, result, awarded_points FROM question_scores').all();
    assert.equal(scores.length, 3);
    assert.deepEqual(scores.map(s => s.awarded_points).sort(), count === 2 ? [0, 0, 3] : [0, 0, 0]);
    assert.equal(scores.filter(s => s.result === 'unanswered').length, 3 - count);
    assert.throws(() => db.exec('INSERT INTO question_scores SELECT * FROM question_scores'), /UNIQUE/);
    assert.equal(db.prepare('SELECT sum(awarded_points) AS total FROM question_scores WHERE player_id = ?').get(identities[1].player.id)!.total, count === 2 ? 3 : 0);
    const screen = getSurfaceState(db, room.id, 'screen') as any;
    assert.equal(screen.game.options.filter((o: any) => o.isCorrect).length, 1);
    assert.deepEqual(screen.game.statistics, { correct: count === 2 ? 1 : 0, wrong: count >= 1 ? 1 : 0, unanswered: 3 - count });
    assert.doesNotMatch(JSON.stringify(screen.game), /player_id|option_id|submission|token/);
    assert.equal((getSurfaceState(db, room.id, 'host') as any).game.points, 3);
    const own = (await api.post(`/api/rooms/${room.id}/reconnect`).send({ token: identities[0].token, playerId: identities[1].player.id }).expect(200)).body.game;
    assert.equal(own.result.outcome, count ? 'wrong' : 'unanswered');
    assert.equal(own.result.points, 0);
    assert.equal(own.correctOptionId, q.options[1].id);
    assert.doesNotMatch(JSON.stringify(own), new RegExp(identities[1].player.id + '|rank|leaderboard'));
    db.close(); db = initializeDatabase(path);
    assert.equal(completeQuestion(db, room.id), false);
    assert.deepEqual(getPlayerGame(db, room.id, 'en', identities[0].player.id), own);
    assert.equal(db.prepare('SELECT count(*) AS n FROM question_scores').get()!.n, 3);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('deadline manager recovers persisted deadlines, rechecks early wakes and ignores stale/closed callbacks', async () => {
  const { createDeadlineManager } = await import('./deadlines.js');
  const { startQuestion } = await import('./game.js');
  const directory = mkdtempSync(join(tmpdir(), 'quiz-deadlines-'));
  const path = join(directory, 'quiz.sqlite');
  let db = initializeDatabase(path);
  try {
    const { api, room } = await lobby(db, 2);
    await api.post(`/api/rooms/${room.id}/start`).expect(200);
    await api.post(`/api/rooms/${room.id}/start-round`).expect(200);
    startQuestion(db, room.id, 100000);
    db.close(); db = initializeDatabase(path);
    let now = 105000;
    const jobs: { callback: () => void; delay: number; cancelled: boolean }[] = [];
    let broadcasts = 0;
    const options = { clock: () => now, schedule: (callback: () => void, delay: number) => {
      const job = { callback, delay, cancelled: false }; jobs.push(job); return () => { job.cancelled = true; };
    } };
    let manager = createDeadlineManager(db, () => broadcasts++, options);
    manager.recover();
    assert.equal(jobs[0].delay, 7000);
    jobs[0].callback(); // Early wake must not reveal.
    assert.equal(broadcasts, 0);
    assert.equal(jobs[1].delay, 7000);
    manager.stop();
    assert.equal(jobs[1].cancelled, true);
    db.close(); db = initializeDatabase(path);
    now = 112000;
    manager = createDeadlineManager(db, () => broadcasts++, options);
    manager.recover(); // Restart with overdue question completes immediately.
    assert.equal(broadcasts, 1);
    jobs[0].callback(); jobs[1].callback(); manager.recover();
    assert.equal(broadcasts, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM question_scores').get()!.n, 2);
    manager.stop();
    const second = await lobby(db, 2);
    await second.api.post(`/api/rooms/${second.room.id}/start`).expect(200);
    await second.api.post(`/api/rooms/${second.room.id}/start-round`).expect(200);
    startQuestion(db, second.room.id, now);
    manager = createDeadlineManager(db, () => broadcasts++, options);
    manager.recover();
    const stale = jobs.at(-1)!;
    await second.api.post(`/api/rooms/${second.room.id}/close`).expect(200);
    manager.sync(second.room.id);
    now += 12000; stale.callback();
    assert.equal(stale.cancelled, true);
    assert.equal(broadcasts, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM question_scores WHERE session_id = ?').get(second.room.id)!.n, 0);
    manager.stop();
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Reveal scoring failure rolls back final submission and partial scores; retry completes once', async () => {
  const { submitAnswer } = await import('./answers.js');
  const { completeQuestion } = await import('./reveal.js');
  const db = initializeDatabase(':memory:');
  try {
    const { api, room, rounds, identities } = await lobby(db, 2);
    await api.post(`/api/rooms/${room.id}/start`).expect(200);
    await api.post(`/api/rooms/${room.id}/start-round`).expect(200);
    await api.post(`/api/rooms/${room.id}/start-question`).expect(200);
    const q = rounds[0].questions[0];
    const answer = (i: number) => ({ token: identities[i].token, questionId: q.id, optionId: q.options[i].id });
    submitAnswer(db, room.id, answer(0));
    db.exec("CREATE TRIGGER fail_score AFTER INSERT ON question_scores BEGIN SELECT RAISE(ABORT, 'score failure'); END");
    assert.throws(() => submitAnswer(db, room.id, answer(1)), /score failure/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM player_answers').get()!.n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM question_scores').get()!.n, 0);
    assert.equal(db.prepare('SELECT state FROM game_sessions').get()!.state, 'ANSWERING');
    db.exec('DROP TRIGGER fail_score');
    assert.ok('submission' in submitAnswer(db, room.id, answer(1)));
    assert.equal(completeQuestion(db, room.id), false);
    assert.deepEqual(submitAnswer(db, room.id, { ...answer(1), optionId: q.options[0].id }), { inserted: false, submission: { submitted: true, optionId: q.options[1].id } });
    assert.equal(db.prepare('SELECT count(*) AS n FROM question_scores').get()!.n, 2);
  } finally { db.close(); }
});
