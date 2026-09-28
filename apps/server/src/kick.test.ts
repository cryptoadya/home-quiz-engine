import assert from 'node:assert/strict';
import { test } from 'node:test';
import request from 'supertest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { completeMedia, projectMediaPlayback } from './media-playback.js';
import { initializeDatabase } from './db.js';
import { createApp } from './app.js';
import { createQuiz } from './quizzes.js';
import { createRound } from './rounds.js';
import { createQuestion, createOption } from './questions.js';
import { kickPlayer } from './kick.js';
import { autoPauseForDisconnectedPlayer, pauseGame, resumeGame } from './pause.js';
import { startQuestion } from './game.js';
import { getAnswerCounts, submitAnswer } from './answers.js';
import { getLeaderboard } from './navigation.js';

async function setup(db = initializeDatabase(':memory:')) {
  const quiz = createQuiz(db), round = createRound(db, quiz.id), question = createQuestion(db, round.id);
  db.prepare("UPDATE rounds SET title_ru = 'Раунд', title_en = 'Round'").run();
  db.prepare("UPDATE questions SET text_ru = 'Вопрос', text_en = 'Question'").run();
  const options = [1, 0].map(correct => {
    const option = createOption(db, question.id);
    db.prepare("UPDATE answer_options SET text_ru = 'Ответ', text_en = 'Answer', is_correct = ? WHERE id = ?").run(correct, option.id);
    return option;
  });
  const broadcasts: string[] = [], api = request(createApp(db, id => broadcasts.push(id)));
  const room = (await api.post(`/api/quizzes/${quiz.id}/rooms`).expect(201)).body;
  const players = [];
  for (const name of ['Alice', 'Bob']) players.push((await api.post(`/api/rooms/code/${room.code}/players`).send({ name, language: 'en' }).expect(201)).body);
  const root = `/api/rooms/${room.id}`;
  const start = async () => { await api.post(`${root}/start`).expect(200); await api.post(`${root}/start-round`).expect(200); startQuestion(db, room.id); };
  const answer = (index: number) => submitAnswer(db, room.id, { token: players[index].token, questionId: question.id, optionId: options[0].id });
  return { db, api, room, root, players, question, options, broadcasts, start, answer };
}

test('Kick confirmation, scope, Lobby removal, revoked token and published roster', async () => {
  const s = await setup();
  try {
    const path = `${s.root}/players/${s.players[0].player.id}/kick`;
    const before = s.broadcasts.length;
    await s.api.post(path).expect(400);
    await s.api.post(`${s.root}/players/missing/kick`).send({ confirmed: true }).expect(404);
    assert.equal(s.broadcasts.length, before);
    await s.api.post(path).send({ confirmed: true }).expect(200);
    assert.equal(s.broadcasts.length, before + 1);
    assert.equal((await s.api.get(`${s.root}/players`)).body.length, 1);
    await s.api.post(`${s.root}/reconnect`).send({ token: s.players[0].token }).expect(401);
    await s.api.patch(`${s.root}/player`).send({ token: s.players[0].token, language: 'ru' }).expect(401);
    await s.api.post(path).send({ confirmed: true }).expect(404);
  } finally { s.db.close(); }
});

for (const submitted of [false, true]) test(`Kick during Answering preserves accepted records (${submitted}) and completes remaining roster`, async () => {
  const s = await setup();
  try {
    await s.start();
    if (submitted) s.answer(0); else s.answer(1);
    const accepted = s.db.prepare('SELECT * FROM player_answers').all();
    assert.ok('room' in kickPlayer(s.db, s.room.id, s.players[0].player.id, true));
    assert.deepEqual(s.db.prepare('SELECT * FROM player_answers').all(), accepted);
    if (submitted) { assert.deepEqual(getAnswerCounts(s.db, s.room.id, s.question.id), { answered: 0, expected: 1 }); s.answer(1); }
    assert.equal((await s.api.get(s.root)).body.state, 'ANSWER_REVEAL');
    assert.deepEqual(getLeaderboard(s.db, s.room.id).map(p => [p.displayName, p.totalPoints]), [['Bob', 1]]);
    await s.api.post(`${s.root}/answers`).send({ token: s.players[0].token, questionId: s.question.id, optionId: s.options[0].id }).expect(401);
    assert.equal(autoPauseForDisconnectedPlayer(s.db, s.room.id, s.players[0].player.id), false);
  } finally { s.db.close(); }
});

for (const manual of [false, true]) test(`Kick reuses disconnect resolution and retains manual pause (${manual})`, async () => {
  const s = await setup();
  try {
    await s.start(); s.answer(1);
    if (manual) pauseGame(s.db, s.room.id); else autoPauseForDisconnectedPlayer(s.db, s.room.id, s.players[0].player.id);
    const remaining = s.db.prepare('SELECT paused_remaining_ms FROM game_sessions').get()!.paused_remaining_ms;
    assert.ok('room' in kickPlayer(s.db, s.room.id, s.players[0].player.id, true));
    assert.equal(s.db.prepare('SELECT count(*) AS n FROM question_exclusions').get()!.n, 0);
    if (manual) {
      assert.equal((await s.api.get(s.root)).body.state, 'PAUSED');
      assert.equal(s.db.prepare('SELECT paused_remaining_ms FROM game_sessions').get()!.paused_remaining_ms, remaining);
      resumeGame(s.db, s.room.id);
    }
    assert.equal((await s.api.get(s.root)).body.state, 'ANSWER_REVEAL');
    assert.equal(s.db.prepare('SELECT count(*) AS n FROM question_scores').get()!.n, 1);
  } finally { s.db.close(); }
});

test('Kick after Continue excludes permanently; completed history cannot diverge from final roster', async () => {
  const s = await setup();
  try {
    await s.start(); s.answer(1);
    autoPauseForDisconnectedPlayer(s.db, s.room.id, s.players[0].player.id);
    await s.api.post(`${s.root}/continue-without-player`).expect(200);
    const answerRows = s.db.prepare('SELECT * FROM player_answers').all();
    const scores = s.db.prepare('SELECT * FROM question_scores').all();
    await s.api.post(`${s.root}/players/${s.players[0].player.id}/kick`).send({ confirmed: true }).expect(200);
    assert.deepEqual(s.db.prepare('SELECT * FROM player_answers').all(), answerRows);
    assert.deepEqual(s.db.prepare('SELECT * FROM question_scores').all(), scores);
    await s.api.post(`${s.root}/next`).expect(200);
    await s.api.post(`${s.root}/final-results`).expect(200);
    await s.api.post(`${s.root}/players/${s.players[1].player.id}/kick`).send({ confirmed: true }).expect(409);
    assert.deepEqual((await s.api.get('/api/history')).body[0].players.map((p: any) => p.displayName), ['Bob']);
  } finally { s.db.close(); }
});

test('Lobby rename is atomic/validated; language switches after Start preserve submissions and privacy', async () => {
  const s = await setup();
  try {
    const patch = (changes: object) => s.api.patch(`${s.root}/player`).send({ token: s.players[0].token, ...changes });
    await patch({ name: 'BOB' }).expect(409);
    await patch({ name: '<b>A</b>' }).expect(400);
    await patch({ language: 'de' }).expect(400);
    assert.equal((await patch({ name: 'Carol', language: 'ru' }).expect(200)).body.player.name, 'Carol');
    await s.start(); s.answer(0);
    await patch({ name: 'Alice' }).expect(409);
    const switched = (await patch({ language: 'en' }).expect(200)).body;
    assert.equal(switched.game.text, 'Question');
    assert.equal(switched.game.submission.optionId, s.options[0].id);
    assert.ok(!JSON.stringify(switched).includes('isCorrect'));
    assert.ok(!JSON.stringify(switched).includes('correctOption'));
  } finally { s.db.close(); }
});

test('Reveal explanations freeze at Start, stay private before Reveal, and validate bilingual completeness', async () => {
  const s = await setup();
  try {
    const path = `/api/quizzes/${s.room.quizId}/rounds/${s.question.roundId}/questions/${s.question.id}`;
    const fields = { type: 'single_choice', textRu: 'Вопрос', textEn: 'Question', points: 1, answerTimeSeconds: null, showOptionsOnScreen: false };
    await s.api.put(path).send({ ...fields, explanationRu: 'Секрет', explanationEn: '' }).expect(200);
    await s.api.post(`${s.root}/start`).expect(409);
    await s.api.put(path).send({ ...fields, explanationRu: 'Секрет', explanationEn: 'Secret explanation' }).expect(200);
    await s.start();
    await s.api.put(path).send({ ...fields, explanationRu: 'Изменено', explanationEn: 'Edited' }).expect(200);
    assert.equal((await s.api.get(`${s.root}/game/host`)).body.game.explanationEn, 'Secret explanation');
    assert.ok(!JSON.stringify((await s.api.get(`${s.root}/game/screen`)).body).includes('Secret explanation'));
    assert.ok(!JSON.stringify((await s.api.post(`${s.root}/reconnect`).send({ token: s.players[0].token })).body).includes('Secret explanation'));
    s.answer(0); s.answer(1);
    assert.equal((await s.api.get(`${s.root}/game/screen`)).body.game.explanationEn, 'Secret explanation');
  } finally { s.db.close(); }
});


test('Kick during pre-timer disconnect Pause restores the same media cursor and gates answering', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'kick-media-'));
  const s = await setup(initializeDatabase(join(directory, 'quiz.sqlite')));
  try {
    const video = (await s.api.post(`/api/quizzes/${s.room.quizId}/media`).attach('file', readFileSync(new URL('./fixtures/media/sample.mp4', import.meta.url)), 'clip.mp4').expect(201)).body;
    s.db.prepare('UPDATE questions SET media_json = ?').run(JSON.stringify([{ mediaId: video.id, playBeforeTimer: true }]));
    await s.start();
    assert.equal((await s.api.get(s.root)).body.state, 'QUESTION');
    assert.equal(autoPauseForDisconnectedPlayer(s.db, s.room.id, s.players[0].player.id), true);
    assert.ok('room' in kickPlayer(s.db, s.room.id, s.players[0].player.id, true));
    const cursor = s.db.prepare('SELECT pre_timer_media_id FROM game_sessions').get()!.pre_timer_media_id;
    assert.equal(cursor, video.id);
    assert.equal((await s.api.get(s.root)).body.state, 'QUESTION');
    assert.equal((s.answer(1) as { status: number }).status, 409);
    const playback = projectMediaPlayback(s.db, s.room.id, s.question.id, video.id, Date.now());
    assert.equal(playback.playing, true);
    assert.equal(completeMedia(s.db, s.room.id, s.question.id, video.id, playback.revision, 1), true);
    assert.deepEqual(getAnswerCounts(s.db, s.room.id, s.question.id), { expected: 1, answered: 0 });
    s.answer(1);
    assert.equal((await s.api.get(s.root)).body.state, 'ANSWER_REVEAL');
  } finally { s.db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Round art validates ownership/readiness, freezes independently, and stays off Player', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'round-art-'));
  const s = await setup(initializeDatabase(join(directory, 'quiz.sqlite')));
  try {
    const image = (await s.api.post(`/api/quizzes/${s.room.quizId}/media`).attach('file', readFileSync(new URL('./fixtures/media/sample.jpg', import.meta.url)), 'art.jpg').expect(201)).body;
    const fields = { titleRu: 'Раунд', titleEn: 'Round', descriptionRu: '', descriptionEn: '', showLeaderboardAfter: false };
    const path = `/api/quizzes/${s.room.quizId}/rounds/${s.question.roundId}`;
    await s.api.put(path).send({ ...fields, artMediaId: s.players[0].player.id }).expect(400);
    await s.api.put(path).send({ ...fields, artMediaId: image.id }).expect(200);
    await s.api.post(`${s.root}/start`).expect(200);
    const screen = (await s.api.get(`${s.root}/game/screen`)).body;
    assert.equal(screen.game.artUrl, `${s.root}/media/${image.id}/content`);
    assert.ok(!JSON.stringify((await s.api.post(`${s.root}/reconnect`).send({ token: s.players[0].token })).body).includes('artUrl'));
    await s.api.delete(`/api/quizzes/${s.room.quizId}/media/${image.id}`).expect(204);
    assert.equal((await s.api.get(`/api/quizzes/${s.room.quizId}/validation`)).body.ready, false);
    await s.api.get(screen.game.artUrl).expect(200).expect('Content-Type', /jpeg/);
  } finally { s.db.close(); rmSync(directory, { recursive: true, force: true }); }
});
