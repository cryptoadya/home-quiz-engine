import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import request from 'supertest';
import { createApp } from './app.js';
import { initializeDatabase } from './db.js';

test('health and quiz CRUD persist drafts with validation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'home-quiz-api-'));
  const path = join(directory, 'quiz.sqlite');
  const db = initializeDatabase(path);
  const app = request(createApp(db));
  try {
    const health = await app.get('/api/health');
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { status: 'ok' });

    const created = await app.post('/api/quizzes');
    assert.equal(created.status, 201);
    assert.match(created.body.id, /^[0-9a-f-]{36}$/);
    assert.equal(created.body.title, 'New Quiz');
    assert.equal(created.body.themeId, 'default');
    assert.equal(created.body.defaultAnswerTimeSeconds, 30);
    assert.equal(created.body.shuffleAnswers, false);
    assert.equal((await app.post('/api/quizzes').send({ title: 'Unexpected' })).status, 400);

    const id = created.body.id;
    assert.equal((await app.get('/api/quizzes')).body[0].id, id);
    assert.equal((await app.get(`/api/quizzes/${id}`)).body.title, 'New Quiz');

    const settings = { title: '  Party Quiz  ', themeId: 'halloween', defaultAnswerTimeSeconds: 45, shuffleAnswers: true };
    const updated = await app.put(`/api/quizzes/${id}`).send(settings);
    assert.equal(updated.status, 200);
    assert.equal(updated.body.title, 'Party Quiz');
    assert.equal(updated.body.themeId, 'halloween');
    assert.equal(updated.body.defaultAnswerTimeSeconds, 45);
    assert.equal(updated.body.shuffleAnswers, true);

    for (const invalid of [
      { ...settings, title: '   ' },
      { ...settings, title: 'a'.repeat(101) },
      { ...settings, themeId: 'other' },
      { ...settings, defaultAnswerTimeSeconds: 0 },
      { ...settings, defaultAnswerTimeSeconds: 1.5 },
      { ...settings, defaultAnswerTimeSeconds: 3601 },
      { ...settings, shuffleAnswers: 'yes' },
      { title: 'Incomplete' },
    ]) {
      const response = await app.put(`/api/quizzes/${id}`).send(invalid);
      assert.equal(response.status, 400);
      assert.equal(typeof response.body.error, 'string');
    }
    const malformed = await app.put(`/api/quizzes/${id}`).set('Content-Type', 'application/json').send('{');
    assert.equal(malformed.status, 400);
    assert.deepEqual(malformed.body, { error: 'Invalid JSON.' });
    assert.equal((await app.get(`/api/quizzes/${id}`)).body.title, 'Party Quiz');
    assert.equal((await app.get('/api/quizzes/missing')).status, 404);
    assert.equal((await app.put('/api/quizzes/missing').send(settings)).status, 404);
    assert.equal((await app.delete('/api/quizzes/missing')).status, 404);

    db.close();
    const reopened = initializeDatabase(path);
    assert.equal((await request(createApp(reopened)).get(`/api/quizzes/${id}`)).body.title, 'Party Quiz');
    assert.equal((await request(createApp(reopened)).delete(`/api/quizzes/${id}`)).status, 204);
    assert.deepEqual((await request(createApp(reopened)).get('/api/quizzes')).body, []);
    reopened.close();
  } finally {
    if (db.isOpen) db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
