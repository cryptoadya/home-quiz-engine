import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { initializeDatabase } from './db.js';
import { createApp } from './app.js';
import { mediaFile, mediaDirectory, mediaLimits } from './media.js';
import { getGameSnapshot, parseGameSnapshot } from './snapshot.js';
import { duplicateQuiz } from './quizzes.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=', 'base64');
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'quiz-media-'));
  const path = join(dir, 'quiz.sqlite'); const db = initializeDatabase(path);
  return { dir, path, db, app: request(createApp(db)), close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
async function ready(app: ReturnType<typeof request>) {
  const quiz = (await app.post('/api/quizzes')).body;
  const round = (await app.post(`/api/quizzes/${quiz.id}/rounds`)).body;
  await app.put(`/api/quizzes/${quiz.id}/rounds/${round.id}`).send({ titleRu: 'Раунд', titleEn: 'Round', descriptionRu: '', descriptionEn: '', showLeaderboardAfter: false });
  const base = `/api/quizzes/${quiz.id}/rounds/${round.id}/questions`;
  const question = (await app.post(base)).body;
  const changes = { type: 'single_choice', textRu: 'Вопрос', textEn: 'Question', points: 1, answerTimeSeconds: null, showOptionsOnScreen: false };
  await app.put(`${base}/${question.id}`).send(changes);
  for (const isCorrect of [true, false]) {
    const option = (await app.post(`${base}/${question.id}/options`)).body;
    await app.put(`${base}/${question.id}/options/${option.id}`).send({ textRu: 'Ответ', textEn: 'Answer', isCorrect });
  }
  return { quiz, base: `${base}/${question.id}`, question, changes };
}

test('upload/list/content/delete use stable identities, safe names and quiz isolation; restart persists', async () => {
  const f = fixture();
  try {
    const q = (await f.app.post('/api/quizzes')).body.id;
    const other = (await f.app.post('/api/quizzes')).body.id;
    const base = `/api/quizzes/${q}/media`;
    const a = (await f.app.post(base).attach('file', png, { filename: 'photo<1>.PNG', contentType: 'image/png' }).expect(201)).body;
    const b = (await f.app.post(base).attach('file', png, { filename: 'photo<1>.PNG', contentType: 'image/png' }).expect(201)).body;
    assert.notEqual(a.id, b.id); assert.equal(a.name, 'photo_1_.PNG');
    assert.deepEqual(Object.keys(a).sort(), ['id', 'quizId', 'name', 'kind', 'mimeType', 'sizeBytes', 'createdAt'].sort());
    assert.deepEqual(readFileSync(mediaFile(f.db, q, a.id)), png);
    assert.equal((await f.app.get(base)).body.length, 2);
    assert.deepEqual((await f.app.get(`/api/quizzes/${other}/media`)).body, []);
    await f.app.delete(`/api/quizzes/${other}/media/${a.id}`).expect(404);
    await f.app.get(`/api/quizzes/${other}/media/${a.id}/content`).expect(404);
    await f.app.get(`${base}/${a.id}/content`).expect(200).expect('X-Content-Type-Options', 'nosniff');
    const reopened = initializeDatabase(f.path);
    try { assert.equal((await request(createApp(reopened)).get(base)).body.length, 2); } finally { reopened.close(); }
    await f.app.delete(`${base}/${a.id}`).expect(204);
    await f.app.get(`${base}/${a.id}/content`).expect(404);
    assert.deepEqual(readdirSync(mediaDirectory(f.db, q)), [b.id]);
    await f.app.delete(`/api/quizzes/${q}`).expect(204);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM media').get()!.n, 0);
    assert.throws(() => readdirSync(mediaDirectory(f.db, q)), /ENOENT/);
  } finally { f.close(); }
});

test('upload rejects paths, unsupported types, mismatched/invalid signatures, empty files and oversized images; staging is cleaned', async () => {
  const f = fixture();
  try {
    const q = (await f.app.post('/api/quizzes')).body.id;
    const base = `/api/quizzes/${q}/media`;
    for (const [filename, contentType, bytes] of [
      ['file.svg', 'image/svg+xml', Buffer.from('<svg/>')], ['x.png', 'image/jpeg', png],
      ['x.jpg', 'image/jpeg', png], ['x.png', 'image/png', Buffer.from('invalid')],
      ['x.png', 'image/png', Buffer.alloc(0)],
      ['x.png', 'image/png', Buffer.alloc(mediaLimits.image + 1)],
    ] as const) await f.app.post(base).attach('file', bytes, { filename, contentType }).expect(400);
    for (const name of ['../escape.png', 'C:\\escape.png', '/tmp/escape.png']) {
      const body = Buffer.concat([Buffer.from(`--boundary\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: image/png\r\n\r\n`), png, Buffer.from('\r\n--boundary--\r\n')]);
      await f.app.post(base).set('Content-Type', 'multipart/form-data; boundary=boundary').send(body).expect(400);
    }
    await f.app.post(base).expect(400);
    await f.app.post(base).field('path', '../outside').attach('file', png, { filename: 'x.png', contentType: 'image/png' }).expect(400);
    await f.app.post(base).attach('other', png, { filename: 'x.png', contentType: 'image/png' }).expect(400);
    assert.deepEqual((await f.app.get(base)).body, []);
    assert.deepEqual(readdirSync(join(f.dir, 'uploads')), []);
    assert.throws(() => mediaFile(f.db, q, '../outside'), /Invalid/);
    assert.throws(() => mediaFile(f.db, '../outside', q), /Invalid/);
    await f.app.get(`${base}/..%2F..%2Fescape/content`).expect(404);
    await f.app.post('/api/quizzes/missing/media').attach('file', png, { filename: 'x.png', contentType: 'image/png' }).expect(404);
  } finally { f.close(); }
});

test('referenced removal blocks readiness and Start without rewriting references; frozen media survives source and duplicate deletion', async () => {
  const f = fixture();
  try {
    const { quiz, base, question, changes } = await ready(f.app);
    const mbase = `/api/quizzes/${quiz.id}/media`;
    const image = (await f.app.post(mbase).attach('file', gif, { filename: 'animation.gif', contentType: 'image/gif' }).expect(201)).body;
    const refs = [{ mediaId: image.id, playBeforeTimer: false }];
    await f.app.put(base).send({ ...changes, media: refs }).expect(200);
    await f.app.put(base).send({ ...changes, media: [{ ...refs[0], playBeforeTimer: true }] }).expect(400);
    const other = (await ready(f.app));
    await f.app.put(other.base).send({ ...other.changes, media: refs }).expect(400);
    await f.app.put(base).send({ ...changes, media: [{ mediaId: '../bad', playBeforeTimer: false }] }).expect(400);
    const copy = (await f.app.post(`/api/quizzes/${quiz.id}/duplicate`).expect(201)).body;
    const copiedMedia = (await f.app.get(`/api/quizzes/${copy.id}/media`)).body[0];
    assert.notEqual(copiedMedia.id, image.id);
    const copiedQuestion = f.db.prepare('SELECT q.* FROM questions q JOIN rounds r ON r.id = q.round_id WHERE r.quiz_id = ?').get(copy.id)!;
    assert.equal(JSON.parse(String(copiedQuestion.media_json))[0].mediaId, copiedMedia.id);
    assert.deepEqual(readFileSync(mediaFile(f.db, copy.id, copiedMedia.id)), gif);
    const room = (await f.app.post(`/api/quizzes/${quiz.id}/rooms`).expect(201)).body;
    await f.app.post(`/api/rooms/code/${room.code}/players`).send({ name: 'Alice', language: 'en' }).expect(201);
    await f.app.post(`/api/rooms/${room.id}/start`).expect(200);
    const frozen = getGameSnapshot(f.db, room.id)!;
    assert.deepEqual(frozen.rounds[0].questions[0].media, refs);
    assert.equal(frozen.media?.[0].id, image.id);
    assert.deepEqual(readFileSync(mediaFile(f.db, room.id, image.id, true)), gif);
    const lobby = (await f.app.post(`/api/quizzes/${quiz.id}/rooms`).expect(201)).body;
    await f.app.delete(`${mbase}/${image.id}`).expect(204);
    const validation = (await f.app.get(`/api/quizzes/${quiz.id}/validation`)).body;
    assert.equal(validation.ready, false); assert.ok(validation.problems.some((p: { code: string }) => p.code === 'QUESTION_MEDIA_MISSING'));
    assert.deepEqual((await f.app.get(base.replace(`/${question.id}`, ''))).body[0].media, refs);
    await f.app.post(`/api/rooms/${lobby.id}/start`).expect(409);
    await f.app.delete(`/api/quizzes/${quiz.id}`).expect(204);
    assert.deepEqual(getGameSnapshot(f.db, room.id), frozen);
    assert.deepEqual(readFileSync(mediaFile(f.db, room.id, image.id, true)), gif);
    assert.equal((await f.app.get(`/api/quizzes/${copy.id}/validation`)).body.ready, true);
    const reopened = initializeDatabase(f.path);
    try { assert.deepEqual(getGameSnapshot(reopened, room.id), frozen); assert.deepEqual(readFileSync(mediaFile(reopened, room.id, image.id, true)), gif); } finally { reopened.close(); }
    await f.app.delete(`/api/quizzes/${copy.id}`).expect(204);
    assert.deepEqual(readFileSync(mediaFile(f.db, room.id, image.id, true)), gif);
  } finally { f.close(); }
});

test('missing physical files and damaged sizes block readiness; failed duplication cleans copies and database rows', async () => {
  const f = fixture();
  try {
    const { quiz, base, changes } = await ready(f.app);
    const media = (await f.app.post(`/api/quizzes/${quiz.id}/media`).attach('file', png, { filename: 'x.png', contentType: 'image/png' })).body;
    await f.app.put(base).send({ ...changes, media: [{ mediaId: media.id, playBeforeTimer: false }] }).expect(200);
    writeFileSync(mediaFile(f.db, quiz.id, media.id), 'damaged');
    assert.equal((await f.app.get(`/api/quizzes/${quiz.id}/validation`)).body.ready, false);
    assert.throws(() => duplicateQuiz(f.db, quiz.id), /missing/);
    assert.equal((await f.app.get('/api/quizzes')).body.length, 1);
    writeFileSync(mediaFile(f.db, quiz.id, media.id), png);
    f.db.exec("CREATE TRIGGER copy_failure BEFORE INSERT ON questions BEGIN SELECT RAISE(ABORT, 'copy failure'); END");
    assert.throws(() => duplicateQuiz(f.db, quiz.id), /copy failure/);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM media').get()!.n, 1);
    assert.deepEqual(readdirSync(join(f.dir, 'quizzes')).filter(id => existsSync(join(f.dir, 'quizzes', id, 'media'))), [quiz.id]);
    rmSync(mediaFile(f.db, quiz.id, media.id));
    await f.app.delete(`/api/quizzes/${quiz.id}/media/${media.id}`).expect(204);
  } finally { f.close(); }
});

test('Matching image references enforce image kind/ownership, remap on duplicate, freeze and become invalid when removed', async () => {
  const f = fixture();
  try {
    const { quiz, base, changes } = await ready(f.app);
    await f.app.put(base).send({ ...changes, type: 'matching' }).expect(200);
    const pairs = (await f.app.get(`${base}/pairs`)).body;
    const media = (await f.app.post(`/api/quizzes/${quiz.id}/media`).attach('file', png, { filename: 'x.png', contentType: 'image/png' })).body;
    const left = { kind: 'image', mediaId: media.id }; const right = { kind: 'text', textRu: 'Ответ', textEn: 'Answer' };
    for (const pair of pairs) await f.app.put(`${base}/pairs/${pair.id}`).send({ left, right }).expect(200);
    assert.equal((await f.app.get(`/api/quizzes/${quiz.id}/validation`)).body.ready, true);
    const other = await ready(f.app);
    await f.app.put(other.base).send({ ...other.changes, type: 'matching' });
    const foreignPair = (await f.app.get(`${other.base}/pairs`)).body[0];
    await f.app.put(`${other.base}/pairs/${foreignPair.id}`).send({ left, right }).expect(400);
    const copy = (await f.app.post(`/api/quizzes/${quiz.id}/duplicate`)).body;
    const copiedId = (await f.app.get(`/api/quizzes/${copy.id}/media`)).body[0].id;
    const copiedPairs = f.db.prepare('SELECT p.left_json FROM matching_pairs p JOIN questions q ON q.id = p.question_id JOIN rounds r ON r.id = q.round_id WHERE r.quiz_id = ?').all(copy.id);
    assert.ok(copiedPairs.every(p => JSON.parse(String(p.left_json)).mediaId === copiedId));
    const room = (await f.app.post(`/api/quizzes/${quiz.id}/rooms`)).body;
    await f.app.post(`/api/rooms/code/${room.code}/players`).send({ name: 'Alice', language: 'en' });
    await f.app.post(`/api/rooms/${room.id}/start`).expect(200);
    const frozen = getGameSnapshot(f.db, room.id)!;
    assert.equal(frozen.rounds[0].questions[0].pairs?.[0].left.kind, 'image');
    assert.throws(() => parseGameSnapshot(JSON.stringify({ ...frozen, media: [] })), /reference/);
    await f.app.delete(`/api/quizzes/${quiz.id}/media/${media.id}`).expect(204);
    assert.ok((await f.app.get(`/api/quizzes/${quiz.id}/validation`)).body.problems.some((p: { code: string }) => p.code === 'MATCHING_MEDIA_MISSING'));
    assert.deepEqual((await f.app.get(`${base}/pairs`)).body[0].left, left);
  } finally { f.close(); }
});


test('all supported extensions store canonical kinds/MIME, allow timed audio/video references, and reject audio Matching sides', async () => {
  const f = fixture();
  try {
    const { quiz, base, changes } = await ready(f.app);
    for (const [extension, kind, mime] of [
      ['jpg', 'image', 'image/jpeg'], ['jpeg', 'image', 'image/jpeg'], ['png', 'image', 'image/png'],
      ['webp', 'image', 'image/webp'], ['gif', 'image', 'image/gif'], ['mp3', 'audio', 'audio/mpeg'],
      ['wav', 'audio', 'audio/wav'], ['ogg', 'audio', 'audio/ogg'], ['mp4', 'video', 'video/mp4'], ['webm', 'video', 'video/webm'],
    ]) {
      const bytes = extension === 'png' ? png : extension === 'gif' ? gif : readFileSync(new URL(`./fixtures/media/sample.${extension === 'jpeg' ? 'jpg' : extension}`, import.meta.url));
      const media = (await f.app.post(`/api/quizzes/${quiz.id}/media`).attach('file', bytes, { filename: `sample.${extension}`, contentType: mime }).expect(201)).body;
      assert.equal(media.kind, kind); assert.equal(media.mimeType, mime); assert.equal(media.sizeBytes, bytes.length);
      if (kind !== 'image') await f.app.put(base).send({ ...changes, media: [{ mediaId: media.id, playBeforeTimer: true }] }).expect(200);
      if (kind === 'audio') {
        await f.app.put(base).send({ ...changes, type: 'matching' }).expect(200);
        const pair = (await f.app.get(`${base}/pairs`)).body[0];
        await f.app.put(`${base}/pairs/${pair.id}`).send({ left: { kind: 'image', mediaId: media.id }, right: { kind: 'text', textRu: 'Текст', textEn: 'Text' } }).expect(400);
        await f.app.put(base).send(changes).expect(200);
      }
    }
    assert.equal((await f.app.get(`/api/quizzes/${quiz.id}/media`)).body.length, 10);
  } finally { f.close(); }
});

test('media-only questions are ready, incomplete bilingual text is invalid, and reference order/flags survive omitted updates', async () => {
  const f = fixture();
  try {
    const { quiz, base, changes } = await ready(f.app);
    const refs = [];
    for (const name of ['first.png', 'second.png']) {
      const media = (await f.app.post(`/api/quizzes/${quiz.id}/media`).attach('file', png, { filename: name, contentType: 'image/png' })).body;
      refs.push({ mediaId: media.id, playBeforeTimer: false });
    }
    const reversed = [...refs].reverse();
    await f.app.put(base).send({ ...changes, textRu: '', textEn: '', media: reversed }).expect(200);
    assert.equal((await f.app.get(`/api/quizzes/${quiz.id}/validation`)).body.ready, true);
    const updated = (await f.app.put(base).send({ ...changes, textRu: '', textEn: 'Only English' }).expect(200)).body;
    assert.deepEqual(updated.media, reversed);
    assert.equal((await f.app.get(`/api/quizzes/${quiz.id}/validation`)).body.ready, false);
    await f.app.put(base).send({ ...changes, media: [refs[0], refs[0]] }).expect(400);
    await f.app.put(base).send({ ...changes, media: [{ ...refs[0], path: '../bad' }] }).expect(400);
    f.db.prepare("UPDATE questions SET media_json = 'null', text_ru = '', text_en = '' WHERE id = ?").run(base.split('/').at(-1)!);
    const invalid = (await f.app.get(`/api/quizzes/${quiz.id}/validation`).expect(200)).body;
    assert.equal(invalid.ready, false);
    assert.ok(invalid.problems.some((p: { code: string }) => p.code === 'QUESTION_MEDIA_MISSING'));
  } finally { f.close(); }
});

test('failed Start rolls back frozen files, snapshot and roster; repeated Start keeps frozen files', async () => {
  const f = fixture();
  try {
    const { quiz, base, changes } = await ready(f.app);
    const media = (await f.app.post(`/api/quizzes/${quiz.id}/media`).attach('file', png, { filename: 'x.png', contentType: 'image/png' })).body;
    await f.app.put(base).send({ ...changes, media: [{ mediaId: media.id, playBeforeTimer: false }] });
    const room = (await f.app.post(`/api/quizzes/${quiz.id}/rooms`)).body;
    await f.app.post(`/api/rooms/code/${room.code}/players`).send({ name: 'Alice', language: 'en' });
    f.db.exec("CREATE TRIGGER failed_start BEFORE UPDATE OF snapshot_json ON game_sessions BEGIN SELECT RAISE(ABORT, 'start failed'); END");
    const { startRoom } = await import('./rooms.js');
    assert.throws(() => startRoom(f.db, room.id), /start failed/);
    assert.equal(getGameSnapshot(f.db, room.id), null);
    assert.equal(f.db.prepare('SELECT in_roster FROM session_players').get()!.in_roster, 0);
    assert.equal(existsSync(mediaDirectory(f.db, room.id, true)), false);
    f.db.exec('DROP TRIGGER failed_start');
    await f.app.post(`/api/rooms/${room.id}/start`).expect(200);
    await f.app.post(`/api/rooms/${room.id}/start`).expect(409);
    assert.deepEqual(readFileSync(mediaFile(f.db, room.id, media.id, true)), png);
  } finally { f.close(); }
});
