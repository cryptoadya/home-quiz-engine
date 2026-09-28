import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import request from 'supertest';
import { initializeDatabase } from './db.js';
import { createApp } from './app.js';
import { createQuiz } from './quizzes.js';
import { createRound } from './rounds.js';
import { createQuestion, createOption } from './questions.js';
import { getGameSnapshot } from './snapshot.js';

for (const themeId of ['default', 'halloween', 'missing-theme']) {
  test(`theme ${themeId} survives Start, editor changes, reconnect, deletion and restart with scoring intact`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'quiz-theme-'));
    const path = join(directory, 'quiz.sqlite');
    let db = initializeDatabase(path);
    try {
      const quiz = createQuiz(db);
      const round = createRound(db, quiz.id);
      const question = createQuestion(db, round.id);
      db.prepare("UPDATE questions SET text_ru = 'Вопрос', text_en = 'Question', points = 3 WHERE id = ?").run(question.id);
      const options = [true, false].map(correct => {
        const option = createOption(db, question.id);
        db.prepare("UPDATE answer_options SET text_ru = 'Ответ', text_en = 'Answer', is_correct = ? WHERE id = ?").run(Number(correct), option.id);
        return option;
      });
      let api = request(createApp(db));
      const media = (await api.post(`/api/quizzes/${quiz.id}/media`).attach('file', new URL('./fixtures/media/sample.mp4', import.meta.url).pathname, { contentType: 'video/mp4' }).expect(201)).body;
      db.prepare('UPDATE questions SET media_json = ? WHERE id = ?').run(JSON.stringify([{ mediaId: media.id, playBeforeTimer: false }]), question.id);
      const settings = { title: 'Party', themeId, defaultAnswerTimeSeconds: 30, shuffleAnswers: false };
      await api.put(`/api/quizzes/${quiz.id}`).send({ ...settings, themeId: themeId === 'default' ? 'halloween' : 'default' }).expect(200);
      const { body: room } = await api.post(`/api/quizzes/${quiz.id}/rooms`).expect(201);
      assert.equal(room.themeId, themeId === 'default' ? 'halloween' : 'default');
      const { body: identity } = await api.post(`/api/rooms/code/${room.code}/players`).send({ name: 'Alex', language: 'en' }).expect(201);
      await api.put(`/api/quizzes/${quiz.id}`).send({ ...settings, themeId }).expect(200);
      assert.equal((await api.get(`/api/rooms/${room.id}`)).body.themeId, themeId);
      const started = await api.post(`/api/rooms/${room.id}/start`).expect(200);
      assert.equal(started.body.themeId, themeId);
      assert.equal(getGameSnapshot(db, room.id)!.themeId, themeId);
      await api.put(`/api/quizzes/${quiz.id}`).send({ ...settings, themeId: 'after-start' }).expect(200);
      await api.post(`/api/rooms/${room.id}/start-round`).expect(200);
      await api.post(`/api/rooms/${room.id}/start-question`).expect(200);
      const restored = (await api.post(`/api/rooms/${room.id}/reconnect`).send({ token: identity.token }).expect(200)).body;
      assert.equal(restored.room.themeId, themeId);
      assert.doesNotMatch(JSON.stringify(restored), /isCorrect|correctOption|mediaUrl|playback/);
      const deadline = restored.game.timer.deadlineAt;
      for (const action of ['play', 'pause', 'restart']) {
        await api.post(`/api/rooms/${room.id}/media/${media.id}/${action}`).send({ questionId: question.id }).expect(200);
        const projection = (await api.get(`/api/rooms/${room.id}/game/screen`).expect(200)).body;
        assert.equal(projection.room.themeId, themeId);
        assert.equal(projection.game.timer.deadlineAt, deadline);
        assert.equal(projection.game.media[0].mediaId, media.id);
        assert.equal(projection.game.media[0].playback.playing, action !== 'pause');
      }
      await api.post(`/api/rooms/${room.id}/answers`).send({ token: identity.token, questionId: question.id, optionId: options[0].id }).expect(200);
      await api.delete(`/api/quizzes/${quiz.id}`).expect(204);
      db.close(); db = initializeDatabase(path); api = request(createApp(db));
      for (const audience of ['host', 'screen']) {
        const projection = (await api.get(`/api/rooms/${room.id}/game/${audience}`).expect(200)).body;
        assert.equal(projection.room.themeId, themeId);
        assert.equal(projection.game.state, 'ANSWER_REVEAL');
      }
      const recovery = (await api.post(`/api/rooms/${room.id}/reconnect`).send({ token: identity.token }).expect(200)).body;
      assert.equal(recovery.room.themeId, themeId);
      const frozenMedia = await api.get(`/api/rooms/${room.id}/media/${media.id}/content`).expect(200);
      assert.match(frozenMedia.headers['content-type'], /video\/mp4/);
      assert.ok(frozenMedia.body.length > 0);
      assert.deepEqual(recovery.game.result, { outcome: 'correct', points: 3 });
      // Missing legacy presentation metadata must not invalidate playable content.
      const legacy = getGameSnapshot(db, room.id)!;
      delete (legacy as Partial<typeof legacy>).themeId;
      db.prepare('UPDATE game_sessions SET snapshot_json = ? WHERE id = ?').run(JSON.stringify(legacy), room.id);
      assert.equal(getGameSnapshot(db, room.id)!.themeId, 'default');
      db.close(); db = initializeDatabase(path); api = request(createApp(db));
      const missingRecovery = (await api.post(`/api/rooms/${room.id}/reconnect`).send({ token: identity.token }).expect(200)).body;
      assert.equal(missingRecovery.room.themeId, 'default');
      assert.deepEqual(missingRecovery.game.result, { outcome: 'correct', points: 3 });
      assert.equal(JSON.parse(String(db.prepare('SELECT snapshot_json FROM game_sessions WHERE id = ?').get(room.id)!.snapshot_json)).themeId, undefined);
    } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}
