import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
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
    const player = (await f.app.post(`/api/rooms/code/${room.code}/players`).send({ name: 'Alice', language: 'en' })).body;
    await f.app.post(`/api/rooms/${room.id}/start`).expect(200);
    await f.app.post(`/api/rooms/${room.id}/start-round`).expect(200);
    await f.app.post(`/api/rooms/${room.id}/start-question`).expect(200);
    const host = (await f.app.get(`/api/rooms/${room.id}/game/host`)).body.game;
    const screen = (await f.app.get(`/api/rooms/${room.id}/game/screen`)).body.game;
    assert.equal(screen.leftItems[0].mediaId, media.id);
    assert.equal(screen.rightItems[0].kind, 'text');
    assert.equal(screen.correctMapping, undefined);
    assert.ok(host.correctMapping);
    assert.deepEqual((await f.app.get(screen.leftItems[0].mediaUrl).expect(200)).body, png);
    const restored = (await f.app.post(`/api/rooms/${room.id}/reconnect`).send({ token: player.token }).expect(200)).body.game;
    assert.equal(restored.leftItems[0].mediaId, media.id);
    assert.equal(restored.correctMapping, undefined);
    const reopened = initializeDatabase(f.path);
    try {
      const again = (await request(createApp(reopened)).post(`/api/rooms/${room.id}/reconnect`).send({ token: player.token }).expect(200)).body.game;
      assert.deepEqual(again.leftItems, restored.leftItems);
      assert.deepEqual(again.rightItems, restored.rightItems);
    } finally { reopened.close(); }
    const frozen = getGameSnapshot(f.db, room.id)!;
    assert.equal(frozen.rounds[0].questions[0].pairs?.[0].left.kind, 'image');
    assert.throws(() => parseGameSnapshot(JSON.stringify({ ...frozen, media: [] })), /reference/);
    await f.app.delete(`/api/quizzes/${quiz.id}/media/${media.id}`).expect(204);
    assert.deepEqual((await f.app.get(screen.leftItems[0].mediaUrl).expect(200)).body, png);
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

test('frozen image content and projections survive source deletion/reconnect/restart; manifest and paths isolate sessions', async () => {
  const f = fixture();
  try {
    const { quiz, base, changes } = await ready(f.app);
    const images = [];
    for (const [filename, bytes, contentType] of [['x.png', png, 'image/png'], ['x.gif', gif, 'image/gif']] as const) {
      images.push((await f.app.post(`/api/quizzes/${quiz.id}/media`).attach('file', bytes, { filename, contentType })).body);
    }
    await f.app.put(base).send({ ...changes, media: images.map(image => ({ mediaId: image.id, playBeforeTimer: false })) });
    const room = (await f.app.post(`/api/quizzes/${quiz.id}/rooms`)).body;
    const player = (await f.app.post(`/api/rooms/code/${room.code}/players`).send({ name: 'Alice', language: 'en' })).body;
    const content = `/api/rooms/${room.id}/media/${images[1].id}/content`;
    await f.app.get(content).expect(404);
    await f.app.post(`/api/rooms/${room.id}/start`).expect(200);
    await f.app.post(`/api/rooms/${room.id}/start-round`).expect(200);
    await f.app.post(`/api/rooms/${room.id}/start-question`).expect(200);
    const screen = (await f.app.get(`/api/rooms/${room.id}/game/screen`)).body.game;
    assert.deepEqual(screen.media.map((item: { mediaId: string }) => item.mediaId), images.map(image => image.id));
    assert.equal(screen.media[1].mediaUrl, content);
    const restored = (await f.app.post(`/api/rooms/${room.id}/reconnect`).send({ token: player.token }).expect(200)).body;
    assert.ok(!JSON.stringify(restored).includes(images[0].id));
    await f.app.delete(`/api/quizzes/${quiz.id}`).expect(204);
    const served = await f.app.get(content).expect(200).expect('Content-Type', /image\/gif/).expect('X-Content-Type-Options', 'nosniff');
    assert.deepEqual(served.body, gif);
    const reopened = initializeDatabase(f.path);
    try {
      const app = request(createApp(reopened));
      assert.deepEqual((await app.get(content).expect(200)).body, gif);
      assert.deepEqual((await app.get(`/api/rooms/${room.id}/game/screen`)).body.game.media, screen.media);
    } finally { reopened.close(); }
    await f.app.get(`/api/rooms/${quiz.id}/media/${images[1].id}/content`).expect(404);
    await f.app.get(`/api/rooms/${room.id}/media/${quiz.id}/content`).expect(404);
    await f.app.get(`/api/rooms/${room.id}/media/%2e%2e%2foutside/content`).expect(404);
    const snapshot = getGameSnapshot(f.db, room.id)!;
    f.db.prepare('UPDATE game_sessions SET snapshot_json = ? WHERE id = ?').run(JSON.stringify({ ...snapshot, media: [] }), room.id);
    assert.deepEqual((await f.app.get(content).expect(404)).body, { error: 'Media not found.' });
    f.db.prepare('UPDATE game_sessions SET snapshot_json = ? WHERE id = ?').run(JSON.stringify(snapshot), room.id);
    writeFileSync(mediaFile(f.db, room.id, images[1].id, true), 'broken');
    assert.deepEqual((await f.app.get(content).expect(404)).body, { error: 'Media not found.' });
    rmSync(mediaFile(f.db, room.id, images[1].id, true));
    await f.app.get(content).expect(404);
    const outside = join(f.dir, 'outside.gif'); writeFileSync(outside, gif);
    symlinkSync(outside, mediaFile(f.db, room.id, images[1].id, true));
    await f.app.get(content).expect(404);
  } finally { f.close(); }
});

test('frozen audio/video ranges, authoritative controls, ordered media, realtime and restart recovery leave timer untouched', async () => {
  const { createQuizServer } = await import('./realtime.js');
  const { io: connect } = await import('socket.io-client');
  const { once } = await import('node:events');
  const f = fixture();
  const runtime = createQuizServer(f.db);
  runtime.server.listen(0, '127.0.0.1');
  await once(runtime.server, 'listening');
  const app = request(runtime.server);
  const sockets: ReturnType<typeof connect>[] = [];
  const next = (socket: ReturnType<typeof connect>) => new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Missing media state')), 3000);
    socket.once('lobby:state', state => { clearTimeout(timeout); resolve(state); });
  });
  try {
    const { quiz, base, changes } = await ready(app);
    const media = [];
    for (const [filename, contentType, bytes] of [['sample.wav', 'audio/wav', readFileSync(new URL('./fixtures/media/sample.wav', import.meta.url))], ['animation.gif', 'image/gif', gif], ['sample.mp4', 'video/mp4', readFileSync(new URL('./fixtures/media/sample.mp4', import.meta.url))], ['sample.mp3', 'audio/mpeg', readFileSync(new URL('./fixtures/media/sample.mp3', import.meta.url))], ['sample.ogg', 'audio/ogg', readFileSync(new URL('./fixtures/media/sample.ogg', import.meta.url))], ['sample.webm', 'video/webm', readFileSync(new URL('./fixtures/media/sample.webm', import.meta.url))]] as const) {
      media.push((await app.post(`/api/quizzes/${quiz.id}/media`).attach('file', bytes, { filename, contentType }).expect(201)).body);
    }
    await app.put(base).send({ ...changes, media: media.map(item => ({ mediaId: item.id, playBeforeTimer: item.kind !== 'image' })) }).expect(200);
    const room = (await app.post(`/api/quizzes/${quiz.id}/rooms`).expect(201)).body;
    const player = (await app.post(`/api/rooms/code/${room.code}/players`).send({ name: 'Alice', language: 'en' })).body;
    const root = `/api/rooms/${room.id}`;
    await app.post(`${root}/start`).expect(200);
    await app.post(`${root}/start-round`).expect(200);
    await app.post(`${root}/start-question`).expect(200);
    const timer = () => f.db.prepare('SELECT state, answer_started_at, answer_deadline_at FROM game_sessions WHERE id = ?').get(room.id);
    const before = timer();
    for (const item of media.filter(item => item.kind !== 'image')) {
      const bytes = readFileSync(mediaFile(f.db, room.id, item.id, true));
      const result = await app.get(`${root}/media/${item.id}/content`).set('Range', 'bytes=0-15').expect(206).expect('Content-Type', new RegExp(item.mimeType)).expect('X-Content-Type-Options', 'nosniff');
      assert.equal(result.headers['content-range'], `bytes 0-15/${bytes.length}`);
      assert.deepEqual(result.body, bytes.subarray(0, 16));
      const suffix = await app.get(`${root}/media/${item.id}/content`).set('Range', 'bytes=-8').expect(206);
      assert.deepEqual(suffix.body, bytes.subarray(-8));
      await app.get(`${root}/media/${item.id}/content`).set('Range', `bytes=${bytes.length}-`).expect(416);
    }
    const port = (runtime.server.address() as { port: number }).port;
    for (const audience of ['host', 'screen']) {
      const socket = connect(`http://127.0.0.1:${port}`, { transports: ['websocket'], forceNew: true }); sockets.push(socket);
      await once(socket, 'connect');
      const pending = next(socket); socket.emit('lobby:subscribe', { roomId: room.id, audience });
      const state = await pending;
      assert.deepEqual(state.game.media.map((item: any) => item.mediaId), media.map(item => item.id));
      assert.equal(state.game.media[0].playback.playing, false);
    }
    const playerSocket = connect(`http://127.0.0.1:${port}`, { transports: ['websocket'], forceNew: true }); sockets.push(playerSocket);
    await once(playerSocket, 'connect');
    const playerInitial = next(playerSocket);
    playerSocket.emit('lobby:subscribe', { roomId: room.id, audience: 'player', token: player.token });
    assert.equal((await playerInitial).game, undefined);
    const command = async (index: number, action: string) => {
      const pending = sockets.map(next);
      await app.post(`${root}/media/${media[index].id}/${action}`).send({ questionId: base.split('/').at(-1) }).expect(200);
      const states = await Promise.all(pending);
      assert.deepEqual(timer(), before);
      assert.ok(states.slice(0, 2).every(state => state.game.media.filter((item: any) => item.playback?.playing).length <= 1));
      assert.ok(media.every(item => !JSON.stringify(states[2]).includes(item.id)));
      assert.equal(states[2].game, undefined);
      return states[1].game.media;
    };
    let projected = await command(0, 'play');
    assert.equal(projected[0].playback.playing, true);
    projected = await command(2, 'play');
    assert.equal(projected[0].playback.playing, false); assert.equal(projected[2].playback.playing, true);
    projected = await command(2, 'pause');
    assert.equal(projected[2].playback.playing, false); assert.ok(projected[2].playback.positionSeconds > 0);
    projected = await command(0, 'restart');
    assert.equal(projected[0].playback.playing, true); assert.ok(projected[0].playback.positionSeconds < 1);
    for (const [index, action] of [[1, 'play'], [0, 'invalid']] as const) await app.post(`${root}/media/${media[index].id}/${action}`).send({ questionId: base.split('/').at(-1) }).expect(409);
    await app.post(`${root}/media/${media[0].id}/play`).send({ questionId: 'stale' }).expect(409);
    const safe = (await app.post(`${root}/reconnect`).send({ token: player.token })).body;
    assert.ok(media.every(item => !JSON.stringify(safe).includes(item.id)));
    await app.delete(`/api/quizzes/${quiz.id}`).expect(204);
    for (const item of media) await app.get(`${root}/media/${item.id}/content`).expect(200);
    for (const [index, audience] of ['host', 'screen'].entries()) {
      sockets[index].disconnect();
      const pending = next(sockets[index]); sockets[index].connect(); await once(sockets[index], 'connect');
      sockets[index].emit('lobby:subscribe', { roomId: room.id, audience });
      assert.equal((await pending).game.media[0].playback.playing, true);
    }
    const reopened = initializeDatabase(f.path);
    try {
      for (const audience of ['host', 'screen']) {
        const state = (await request(createApp(reopened)).get(`${root}/game/${audience}`)).body;
        assert.equal(state.game.media[0].playback.playing, true);
        assert.equal(state.game.media[2].playback.playing, false);
        assert.equal(state.game.media[2].playback.positionSeconds, projected[2].playback.positionSeconds);
        assert.deepEqual(state.game.media.map((item: any) => item.mediaId), media.map(item => item.id));
      }
    } finally { reopened.close(); }
    const frozenFile = mediaFile(f.db, room.id, media[0].id, true);
    const original = readFileSync(frozenFile);
    writeFileSync(frozenFile, 'damaged');
    await app.get(`${root}/media/${media[0].id}/content`).expect(404);
    rmSync(frozenFile);
    const outside = join(f.dir, 'outside.wav'); writeFileSync(outside, original);
    symlinkSync(outside, frozenFile);
    await app.get(`${root}/media/${media[0].id}/content`).expect(404);
  } finally {
    sockets.forEach(socket => socket.disconnect());
    await new Promise<void>(resolve => runtime.io.close(() => resolve()));
    f.close();
  }
});
