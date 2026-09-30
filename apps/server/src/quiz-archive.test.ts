import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import * as yazl from 'yazl';
import * as yauzl from 'yauzl';
import request from 'supertest';
import { initializeDatabase } from './db.js';
import { createApp } from './app.js';
import { createQuiz, updateQuiz, deleteQuiz } from './quizzes.js';
import { createRound, updateRound } from './rounds.js';
import { createQuestion, updateQuestion, createOption, updateOption, listOptions } from './questions.js';
import { listPairs, updatePair } from './matching.js';
import { listMedia, mediaFile } from './media.js';
import { readEditableQuizTree } from './snapshot.js';
import { exportQuizArchive, importQuizArchive, archiveLimits } from './quiz-archive.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=', 'base64');
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'quiz-archive-')); const db = initializeDatabase(join(dir, 'quiz.sqlite'));
  return { dir, db, app: request(createApp(db)), close() { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
async function seed(f: ReturnType<typeof fixture>, themeId = 'halloween') {
  const quiz = createQuiz(f.db);
  updateQuiz(f.db, quiz.id, { title: 'Праздник / Party', themeId, defaultAnswerTimeSeconds: 43, shuffleAnswers: true });
  const media = [];
  for (const [name, type, bytes] of [
    ['art.png', 'image/png', png], ['animation.gif', 'image/gif', gif],
    ['sound.mp3', 'audio/mpeg', readFileSync(new URL('./fixtures/media/sample.mp3', import.meta.url))],
    ['film.mp4', 'video/mp4', readFileSync(new URL('./fixtures/media/sample.mp4', import.meta.url))],
  ] as const) media.push((await f.app.post(`/api/quizzes/${quiz.id}/media`).attach('file', bytes, { filename: name, contentType: type }).expect(201)).body);
  for (let i = 0; i < 2; i++) {
    const r = createRound(f.db, quiz.id);
    updateRound(f.db, quiz.id, r.id, { titleRu: `Раунд ${i}`, titleEn: `Round ${i}`, descriptionRu: 'Описание', descriptionEn: 'Description', artMediaId: media[0].id, showLeaderboardAfter: i === 0 });
    for (const type of ['single_choice', 'multiple_choice', 'yes_no', 'matching'] as const) {
      const q = createQuestion(f.db, r.id, type);
      updateQuestion(f.db, r.id, q.id, { type, textRu: 'Вопрос?', textEn: 'Question?', points: 3, answerTimeSeconds: 17,
        explanationRu: 'Объяснение', explanationEn: 'Explanation', showOptionsOnScreen: true, showCorrectCount: false,
        media: [...media].reverse().map((m, index) => ({ mediaId: m.id, playBeforeTimer: index < 2 })) });
      if (type === 'matching') {
        const pairs = listPairs(f.db, q.id);
        updatePair(f.db, q.id, pairs[0].id, { left: { kind: 'image', mediaId: media[0].id }, right: { kind: 'text', textRu: 'Картинка', textEn: 'Picture' } });
        updatePair(f.db, q.id, pairs[1].id, { left: { kind: 'text', textRu: 'Анимация', textEn: 'Animation' }, right: { kind: 'image', mediaId: media[1].id } });
      } else {
        const options = type === 'yes_no' ? listOptions(f.db, q.id) : [createOption(f.db, q.id), createOption(f.db, q.id), createOption(f.db, q.id)];
        options.forEach((o, index) => updateOption(f.db, q.id, o.id, { textRu: `Ответ ${index}`, textEn: `Answer ${index}`, isCorrect: type === 'multiple_choice' ? index < 2 : index === 0 }));
      }
    }
  }
  return quiz.id;
}
async function unzip(path: string) {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.open(path, { lazyEntries: true }, (err, zip) => err ? reject(err) : resolve(zip!)));
  const entries = new Map<string, Buffer>();
  await new Promise<void>((resolve, reject) => {
    zip.on('error', reject); zip.on('end', resolve);
    zip.on('entry', entry => zip.openReadStream(entry, async (err, stream) => {
      if (err) return reject(err);
      try { const chunks = []; for await (const chunk of stream!) chunks.push(chunk); entries.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); }
      catch (error) { reject(error); }
    })); zip.readEntry();
  });
  return entries;
}
async function zipBytes(entries: [string, Buffer, number?][]) {
  const zip = new yazl.ZipFile(); const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => { zip.outputStream.on('data', chunk => chunks.push(chunk)); zip.outputStream.on('end', () => resolve(Buffer.concat(chunks))); zip.outputStream.on('error', reject); });
  for (const [name, data, mode] of entries) zip.addBuffer(data, name, { compress: false, ...(mode ? { mode } : {}) });
  zip.end(); return result;
}
async function archiveEntries(f: ReturnType<typeof fixture>) {
  const id = await seed(f); const archive = await exportQuizArchive(f.db, id);
  try { return { id, entries: await unzip(archive.path) }; } finally { archive.cleanup(); }
}
function normalize(tree: ReturnType<typeof readEditableQuizTree>, idMap: Map<string, string>) {
  return JSON.parse(JSON.stringify({ ...tree, media: [...tree.media ?? []].sort((a, b) => a.name.localeCompare(b.name)) }, (key, value) => key === 'createdAt' ? undefined :
    (key === 'id' || key === 'mediaId' || key === 'artMediaId') ? idMap.get(value) : value));
}
function identities(tree: ReturnType<typeof readEditableQuizTree>) {
  return [...[...(tree.media ?? [])].sort((a, b) => a.name.localeCompare(b.name)).map(m => m.id), ...tree.rounds.flatMap(r => [r.id, ...r.questions.flatMap(q => [q.id, ...q.options.map(o => o.id), ...(q.pairs ?? []).map(p => p.id)])])];
}
function gameplay(f: ReturnType<typeof fixture>) {
  return ['game_sessions', 'session_players', 'player_answers', 'question_scores', 'question_exclusions', 'media_playback'].map(table => f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
}

test('portable HTTP export → delete source → import → edit/launch: all types, ordered media, settings, fresh consistent IDs and no gameplay', async () => {
  const f = fixture();
  try {
    const id = await seed(f);
    // Freeze one Test Game, then edit the source: export must read the editable state, never this played snapshot.
    const room = (await f.app.post(`/api/quizzes/${id}/test-games`).expect(201)).body;
    await f.app.post(`/api/rooms/code/${room.code}/players`).send({ name: 'Alice', language: 'en' }).expect(201);
    await f.app.post(`/api/rooms/${room.id}/start`).expect(200);
    updateQuiz(f.db, id, { title: 'Текущий / Current', themeId: 'halloween', defaultAnswerTimeSeconds: 49, shuffleAnswers: false });
    const before = readEditableQuizTree(f.db, id);
    const archiveResponse = await f.app.get(`/api/quizzes/${id}/export`).buffer(true).parse((response, callback) => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => callback(null, Buffer.concat(chunks)));
    }).expect(200).expect('Content-Type', /zip/).expect('Content-Disposition', /quiz.zip/);
    const path = join(f.dir, 'portable.zip'); writeFileSync(path, archiveResponse.body);
    const entries = await unzip(path); const manifest = JSON.parse(entries.get('manifest.json')!.toString());
    assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.quiz.title, 'Текущий / Current');
    assert.deepEqual([...entries.keys()].sort(), ['manifest.json', ...manifest.media.map((m: { id: string }) => `media/${m.id}`)].sort());
    assert.deepEqual(Object.keys(manifest).sort(), ['media', 'quiz', 'schemaVersion']);
    assert.ok(!/snapshot_json|sessionToken|isTest|scores|history|players|roomId/.test(JSON.stringify(manifest)));
    deleteQuiz(f.db, id); assert.equal(existsSync(join(f.dir, 'quizzes', id, 'media')), false);
    const counts = gameplay(f);
    const imported = (await f.app.post('/api/quizzes/import').attach('file', readFileSync(path), 'portable.zip').expect(201)).body;
    assert.notEqual(imported.id, id); assert.deepEqual(gameplay(f), counts);
    const after = readEditableQuizTree(f.db, imported.id);
    const oldIds = identities(before), newIds = identities(after);
    assert.equal(new Set(newIds).size, newIds.length); assert.ok(newIds.every(newId => !oldIds.includes(newId)));
    const oldMap = new Map(oldIds.map((id, i) => [id, String(i)])); const newMap = new Map(newIds.map((id, i) => [id, String(i)]));
    assert.deepEqual(normalize(after, newMap), normalize(before, oldMap));
    for (const m of listMedia(f.db, imported.id)) assert.deepEqual(readFileSync(mediaFile(f.db, imported.id, m.id)), entries.get(`media/${before.media!.find(old => old.name === m.name)!.id}`));
    assert.equal((await f.app.get(`/api/quizzes/${imported.id}/validation`).expect(200)).body.ready, true);
    await f.app.put(`/api/quizzes/${imported.id}`).send({ title: 'Edited import', themeId: imported.themeId, defaultAnswerTimeSeconds: 60, shuffleAnswers: true }).expect(200);
    const lobby = (await f.app.post(`/api/quizzes/${imported.id}/rooms`).expect(201)).body;
    await f.app.post(`/api/rooms/code/${lobby.code}/players`).send({ name: 'Bob', language: 'ru' }).expect(201);
    await f.app.post(`/api/rooms/${lobby.id}/start`).expect(200);
  } finally { f.close(); }
});

test('long uploaded media names keep validated extensions through export and import', async () => {
  const f = fixture();
  try {
    const quiz = createQuiz(f.db);
    const samples = [
      { name: `${'a'.repeat(180)}.mp3`, fixture: 'sample.mp3', mime: 'audio/mpeg', suffix: '.mp3' },
      { name: `${'é'.repeat(70)}${'a'.repeat(50)}.webm`, fixture: 'sample.webm', mime: 'video/webm', suffix: '.webm' },
      { name: `${'b'.repeat(180)}.jpeg`, fixture: 'sample.jpg', mime: 'image/jpeg', suffix: '.jpeg' },
      { name: 'photo<1>.jpg', fixture: 'sample.jpg', mime: 'image/jpeg', suffix: '.jpg' },
      { name: 'short.mp3', fixture: 'sample.mp3', mime: 'audio/mpeg', suffix: '.mp3' },
    ];
    const uploaded = [];
    for (const sample of samples) {
      const response = await f.app.post(`/api/quizzes/${quiz.id}/media`).attach('file', readFileSync(new URL(`./fixtures/media/${sample.fixture}`, import.meta.url)), { filename: sample.name, contentType: sample.mime });
      assert.equal(response.status, 201, `${sample.suffix}: ${JSON.stringify(response.body)}`);
      const item = response.body;
      assert.ok(item.name.endsWith(sample.suffix)); assert.ok(item.name.length <= 160); assert.ok(item.name.length > sample.suffix.length);
      uploaded.push(item);
    }
    assert.equal(uploaded[3].name, 'photo_1_.jpg'); assert.equal(uploaded[4].name, 'short.mp3');
    const archive = await exportQuizArchive(f.db, quiz.id);
    try {
      const copy = await importQuizArchive(f.db, archive.path);
      assert.deepEqual(listMedia(f.db, copy.id).map(item => item.name).sort(), uploaded.map(item => item.name).sort());
    } finally { archive.cleanup(); }
    await f.app.post(`/api/quizzes/${quiz.id}/media`).attach('file', readFileSync(new URL('./fixtures/media/sample.mp3', import.meta.url)), { filename: `${'x'.repeat(252)}.mp3`, contentType: 'audio/mpeg' }).expect(400);
  } finally { f.close(); }
});

test('unavailable theme ID survives import; empty editable Draft creates no game records', async () => {
  const f = fixture();
  try {
    const q = createQuiz(f.db); updateQuiz(f.db, q.id, { title: 'Draft', themeId: 'custom-unavailable', defaultAnswerTimeSeconds: 30, shuffleAnswers: false });
    const archive = await exportQuizArchive(f.db, q.id);
    try { const copy = await importQuizArchive(f.db, archive.path); assert.equal(copy.themeId, 'custom-unavailable'); assert.deepEqual(gameplay(f), [0, 0, 0, 0, 0, 0]); }
    finally { archive.cleanup(); }
  } finally { f.close(); }
});

test('rejects unsupported/malformed manifests, V1 rules, relationships, missing/corrupt media and dangerous metadata before persistence', async () => {
  const f = fixture();
  try {
    const { entries } = await archiveEntries(f);
    const original = JSON.parse(entries.get('manifest.json')!.toString());
    const cases: [string, (m: typeof original, entries: Map<string, Buffer>) => void][] = [
      ['unsupported', m => { m.schemaVersion = 2; }], ['fields', m => { m.history = []; }],
      ['bilingual type', m => { m.quiz.rounds[0].questions[0].textRu = 42; }],
      ['correctness', m => { m.quiz.rounds[0].questions[0].options.forEach((o: { isCorrect: boolean }) => o.isCorrect = false); }],
      ['duplicate IDs', m => { m.quiz.rounds[0].questions[0].options[1].id = m.quiz.rounds[0].questions[0].options[0].id; }],
      ['bad ordering', m => { m.quiz.rounds[1].position = 0; }],
      ['foreign media reference', m => { m.quiz.rounds[0].questions[0].media[0].mediaId = randomUUID(); }],
      ['missing media', (m, e) => { e.delete(`media/${m.media[0].id}`); }],
      ['corrupt media hash', (m, e) => { const bytes = Buffer.from(e.get(`media/${m.media[0].id}`)!); bytes[bytes.length - 1] ^= 1; e.set(`media/${m.media[0].id}`, bytes); }],
      ['invalid signature with matching hash', (m, e) => { const bytes = Buffer.alloc(m.media[0].sizeBytes); e.set(`media/${m.media[0].id}`, bytes); m.media[0].sha256 = createHash('sha256').update(bytes).digest('hex'); }],
      ['bad metadata size', m => { m.media[0].sizeBytes++; }], ['metadata filename traversal', m => { m.media[0].name = '../art.png'; }],
      ['metadata MIME', m => { m.media[0].mimeType = 'audio/mpeg'; m.media[0].kind = 'audio'; }],
      ['image before timer', m => { m.quiz.rounds[0].questions[0].media[3].playBeforeTimer = true; }],
      ['media kind mismatch', m => { m.media[0].kind = 'video'; }],
      ['too many pairs', m => { m.quiz.rounds[0].questions[3].pairs = Array(101).fill(m.quiz.rounds[0].questions[3].pairs[0]); }],
    ];
    const count = f.db.prepare('SELECT COUNT(*) AS n FROM quizzes').get()!.n;
    const dirs = readdirSync(join(f.dir, 'quizzes')).sort();
    for (const [label, mutate] of cases) {
      const m = structuredClone(original), e = new Map(entries); mutate(m, e); e.set('manifest.json', Buffer.from(JSON.stringify(m)));
      const bytes = await zipBytes([...e]);
      const response = await f.app.post('/api/quizzes/import').attach('file', bytes, 'quiz.zip');
      assert.equal(response.status, 400, label); assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM quizzes').get()!.n, count, label);
      assert.deepEqual(readdirSync(join(f.dir, 'quizzes')).sort(), dirs); assert.deepEqual(readdirSync(join(f.dir, 'uploads')), []);
    }
    await f.app.post('/api/quizzes/import').attach('file', await zipBytes([['manifest.json', Buffer.from('{bad')]]), 'quiz.zip').expect(400);
    await f.app.post('/api/quizzes/import').attach('file', Buffer.from('not a zip'), 'quiz.zip').expect(400);
  } finally { f.close(); }
});

test('ZIP traversal, absolute/backslash paths, duplicates, directories, symlinks, encrypted entries, CRC corruption and limits are rejected', async () => {
  const f = fixture();
  try {
    const { entries } = await archiveEntries(f);
    const base = [...entries] as [string, Buffer, number?][];
    const attacks = [
      await zipBytes([...base, ['manifest.json', entries.get('manifest.json')!]]),
      await zipBytes([...base, ['media', Buffer.from('conflict')]]),
      await zipBytes([...base, ['extra-file.txt', Buffer.from('unexpected')]]),
      await zipBytes(base.map(([name, bytes]) => [name, bytes, 0o120777])),
    ];
    for (const target of ['../attack.bin', '/tmp/evil.bin', 'C:/evilxx.bin', 'a\\evilxx.bin']) {
      const safe = 'x'.repeat(target.length);
      const bytes = await zipBytes([...base, [safe, Buffer.from('attack')]]);
      // Patch both local and central filenames, since the ZIP writer itself refuses dangerous paths.
      for (let i = bytes.indexOf(safe); i !== -1; i = bytes.indexOf(safe, i + target.length)) bytes.write(target, i, 'utf8');
      attacks.push(bytes);
    }
    const directory = await zipBytes([...base, ['directoryX', Buffer.from('x')]]);
    for (let i = directory.indexOf('directoryX'); i !== -1; i = directory.indexOf('directoryX', i + 10)) directory.write('directory/', i);
    attacks.push(directory);
    // Central directory is safe, but local header alone contains a traversal path.
    const localPath = await zipBytes(base); localPath.write('../evilxx.zip', 30); attacks.push(localPath);
    const conflict = await zipBytes(base); const directoryEntries = [];
    for (let offset = conflict.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); offset !== -1; offset = conflict.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), offset + 4)) directoryEntries.push(offset);
    conflict.writeUInt32LE(conflict.readUInt32LE(directoryEntries[1] + 42), directoryEntries[2] + 42); attacks.push(conflict);
    const crc = await zipBytes(base); const central = crc.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); crc[central + 16] ^= 1; attacks.push(crc);
    const encrypted = await zipBytes(base); const c = encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); encrypted[c + 8] |= 1; attacks.push(encrypted);
    for (const bytes of attacks) { await f.app.post('/api/quizzes/import').attach('file', bytes, 'quiz.zip').expect(400); assert.deepEqual(readdirSync(join(f.dir, 'uploads')), []); }
    const saved = archiveLimits.manifestBytes;
    try { archiveLimits.manifestBytes = 20; await f.app.post('/api/quizzes/import').attach('file', await zipBytes(base), 'quiz.zip').expect(400); }
    finally { archiveLimits.manifestBytes = saved; }
    const mediaLimit = archiveLimits.media;
    try { archiveLimits.media = 1; await f.app.post('/api/quizzes/import').attach('file', await zipBytes(base), 'quiz.zip').expect(400); }
    finally { archiveLimits.media = mediaLimit; }
  } finally { f.close(); }
});

test('database failure after moving media rolls back all content and cleans persistent/staging trees; retry succeeds', async () => {
  const f = fixture();
  try {
    const { entries } = await archiveEntries(f); const bytes = await zipBytes([...entries]);
    const before = f.db.prepare('SELECT COUNT(*) AS n FROM quizzes').get()!.n;
    const dirs = readdirSync(join(f.dir, 'quizzes')).sort();
    f.db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON questions BEGIN SELECT RAISE(ABORT, 'forced import failure'); END");
    await f.app.post('/api/quizzes/import').attach('file', bytes, 'quiz.zip').expect(400);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM quizzes').get()!.n, before);
    assert.deepEqual(readdirSync(join(f.dir, 'quizzes')).sort(), dirs); assert.deepEqual(readdirSync(join(f.dir, 'uploads')), []);
    assert.deepEqual(gameplay(f), [0, 0, 0, 0, 0, 0]);
    f.db.exec('DROP TRIGGER fail_import');
    await f.app.post('/api/quizzes/import').attach('file', bytes, 'quiz.zip').expect(201);
  } finally { f.close(); }
});

test('export rejects missing/corrupt owned media and cleans temporary archive files', async () => {
  const f = fixture();
  try {
    const id = await seed(f); const m = listMedia(f.db, id)[0];
    writeFileSync(mediaFile(f.db, id, m.id), Buffer.alloc(m.sizeBytes));
    await assert.rejects(exportQuizArchive(f.db, id)); assert.deepEqual(readdirSync(join(f.dir, 'uploads')), []);
    rmSync(mediaFile(f.db, id, m.id));
    await assert.rejects(exportQuizArchive(f.db, id)); assert.deepEqual(readdirSync(join(f.dir, 'uploads')), []);
  } finally { f.close(); }
});

test('pre-8E version-1 archives without round art or explanations remain importable', async () => {
  const f = fixture();
  try {
    const { entries } = await archiveEntries(f);
    const manifest = JSON.parse(entries.get('manifest.json')!.toString());
    for (const round of manifest.quiz.rounds) {
      delete round.artMediaId;
      for (const question of round.questions) { delete question.explanationRu; delete question.explanationEn; }
    }
    entries.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
    const imported = (await f.app.post('/api/quizzes/import').attach('file', await zipBytes([...entries]), 'legacy.zip').expect(201)).body;
    const tree = readEditableQuizTree(f.db, imported.id);
    assert.equal(tree.rounds[0].artMediaId, null);
    assert.equal(tree.rounds[0].questions[0].explanationEn, '');
    assert.equal((await f.app.get(`/api/quizzes/${imported.id}/validation`)).body.ready, true);
  } finally { f.close(); }
});
