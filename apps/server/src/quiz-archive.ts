import { randomUUID, createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, copyFileSync, lstatSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, Readable } from 'node:stream';
import { crc32 } from 'node:zlib';
import type { DatabaseSync } from 'node:sqlite';
import multer from 'multer';
import * as yauzl from 'yauzl';
import * as yazl from 'yazl';
import { getQuiz, validateQuizChanges } from './quizzes.js';
import { validateRoundChanges } from './rounds.js';
import { validateQuestionChanges, validateOptionChanges } from './questions.js';
import { validMatchingSide, type MatchingSide } from './matching.js';
import { mediaRoot, mediaDirectory, mediaFile, validMediaId, validMediaMetadata, validateMediaFile, type Media } from './media.js';
import { readEditableQuizTree, parseGameSnapshot, type GameSnapshot } from './snapshot.js';

export class ArchiveValidationError extends Error {}
export const archiveLimits = { archiveBytes: 1024 * 1024 * 1024, totalBytes: 1024 * 1024 * 1024,
  manifestBytes: 8 * 1024 * 1024, media: 500, rounds: 100, questions: 2000, pairs: 100 };
type PortableMedia = Omit<Media, 'quizId'> & { sha256: string };
export type QuizArchiveManifest = { schemaVersion: 1; quiz: Omit<GameSnapshot, 'schemaVersion' | 'media'> & { id: string }; media: PortableMedia[] };
function invalid(message: string): never { throw new ArchiveValidationError(message); }
function fields(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length
    || Object.keys(value).some(key => !keys.includes(key))) invalid('Invalid manifest fields.');
}
function checked(result: { error: string } | object) { if ('error' in result) invalid(String(result.error)); }
function validateManifest(value: unknown): QuizArchiveManifest {
  fields(value, ['schemaVersion', 'quiz', 'media']);
  if (value.schemaVersion !== 1) invalid('Unsupported archive schema version. Expected 1.');
  fields(value.quiz, ['id', 'title', 'themeId', 'defaultAnswerTimeSeconds', 'shuffleAnswers', 'rounds']);
  const q = value.quiz;
  checked(validateQuizChanges({ title: q.title, themeId: q.themeId, defaultAnswerTimeSeconds: q.defaultAnswerTimeSeconds, shuffleAnswers: q.shuffleAnswers }));
  if (!Array.isArray(q.rounds) || q.rounds.length > archiveLimits.rounds || !Array.isArray(value.media) || value.media.length > archiveLimits.media) invalid('Archive count limit exceeded.');
  const ids = new Set<string>();
  const identity = (id: unknown) => { if (!validMediaId(id) || ids.has(id)) invalid('Invalid or duplicate manifest identity.'); ids.add(id); };
  identity(q.id);
  let questions = 0;
  for (const r of q.rounds) {
    fields(r, [...(Object.hasOwn(r, 'artMediaId') ? ['artMediaId'] : []), 'id', 'titleRu', 'titleEn', 'descriptionRu', 'descriptionEn', 'showLeaderboardAfter', 'position', 'questions']);
    identity(r.id);
    checked(validateRoundChanges({ titleRu: r.titleRu, titleEn: r.titleEn, descriptionRu: r.descriptionRu, descriptionEn: r.descriptionEn, showLeaderboardAfter: r.showLeaderboardAfter, artMediaId: r.artMediaId }));
    if (!Array.isArray(r.questions)) invalid('Invalid round content.');
    questions += r.questions.length;
    if (questions > archiveLimits.questions) invalid('Too many questions.');
    for (const question of r.questions) {
      const keys = ['id', 'type', 'textRu', 'textEn', 'points', 'answerTimeSeconds', 'showOptionsOnScreen', 'showCorrectCount', 'position', 'media', 'options'];
      if (Object.hasOwn(question, 'explanationRu') || Object.hasOwn(question, 'explanationEn')) keys.push('explanationRu', 'explanationEn');
      fields(question, question.type === 'matching' ? [...keys, 'pairs'] : keys);
      identity(question.id);
      checked(validateQuestionChanges({ type: question.type, textRu: question.textRu, textEn: question.textEn, points: question.points,
        answerTimeSeconds: question.answerTimeSeconds, showOptionsOnScreen: question.showOptionsOnScreen, ...(Object.hasOwn(question, 'explanationRu') ? { explanationRu: question.explanationRu, explanationEn: question.explanationEn } : {}), showCorrectCount: question.showCorrectCount, media: question.media }));
      if (!Array.isArray(question.options) || question.options.length > 10) invalid('Invalid answer options.');
      if (Boolean(String(question.textRu).trim()) !== Boolean(String(question.textEn).trim())
        || (!String(question.textRu).trim() && (question.media as unknown[]).length === 0)) invalid('Question needs bilingual text or media.');
      for (const option of question.options) {
        fields(option, ['id', 'textRu', 'textEn', 'isCorrect', 'position']); identity(option.id);
        checked(validateOptionChanges({ textRu: option.textRu, textEn: option.textEn, isCorrect: option.isCorrect }));
        if (!String(option.textRu).trim() || !String(option.textEn).trim()) invalid('Options need bilingual text.');
      }
      if (question.type === 'matching') {
        if (!Array.isArray(question.pairs) || question.pairs.length > archiveLimits.pairs) invalid('Invalid Matching pairs.');
        for (const pair of question.pairs) {
          fields(pair, ['id', 'left', 'right', 'position']); identity(pair.id);
          if (!validMatchingSide(pair.left, true) || !validMatchingSide(pair.right, true)) invalid('Incomplete Matching side.');
        }
      }
    }
  }
  for (const m of value.media) {
    fields(m, ['id', 'name', 'kind', 'mimeType', 'sizeBytes', 'createdAt', 'sha256']); identity(m.id);
    if (typeof m.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(m.sha256) || !validMediaMetadata(m)
      || String(m.name).length > 160 || String(m.createdAt).length > 100 || !Number.isFinite(Date.parse(String(m.createdAt)))) invalid('Invalid media metadata.');
  }
  const manifest = value as unknown as QuizArchiveManifest;
  const ordered = (items: { position: number }[]) => {
    if (items.some((item, i) => !Number.isSafeInteger(item.position) || item.position < 0 || (i > 0 && item.position <= items[i - 1].position))) invalid('Invalid authored ordering.');
  };
  ordered(manifest.quiz.rounds);
  for (const round of manifest.quiz.rounds) {
    if (round.artMediaId != null && !manifest.media.some(media => media.id === round.artMediaId && media.kind === 'image')) invalid('Missing round art.');
    ordered(round.questions);
    for (const question of round.questions) { ordered(question.options); ordered(question.pairs ?? []); }
    // Reuse the independent V1 parser: type/count/correctness/media rules. Empty rounds are editable drafts.
    if (round.questions.length) {
      try { parseGameSnapshot(JSON.stringify({ ...manifest.quiz, schemaVersion: 1, media: manifest.media, rounds: [round] })); }
      catch { invalid('Invalid V1 question rules or media references.'); }
    }
  }
  return manifest;
}
async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
function staging(db: DatabaseSync) {
  const uploads = join(mediaRoot(db), 'uploads'); mkdirSync(uploads, { recursive: true });
  return mkdtempSync(join(uploads, 'archive-'));
}
export function archiveUpload(db: DatabaseSync) {
  const destination = join(mediaRoot(db), 'uploads'); mkdirSync(destination, { recursive: true });
  // Uploaded names are never used as paths, including the ZIP's name itself.
  return multer({ storage: multer.diskStorage({ destination, filename: (_req, _file, cb) => cb(null, randomUUID()) }),
    limits: { fileSize: archiveLimits.archiveBytes, files: 1, fields: 0, parts: 1, headerPairs: 32 } }).single('file');
}
export async function exportQuizArchive(db: DatabaseSync, quizId: string): Promise<{ path: string; cleanup: () => void }> {
  if (!getQuiz(db, quizId)) invalid('Quiz not found.');
  const dir = staging(db);
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    // Capture editor rows and file copies synchronously so asynchronous hashing cannot mix editor revisions.
    const { schemaVersion: _version, media, ...quiz } = readEditableQuizTree(db, quizId);
    if ((media?.length ?? 0) > archiveLimits.media) invalid('Too many media files.');
    let total = 0;
    for (const m of media ?? []) {
      const path = mediaFile(db, quizId, m.id);
      const stat = lstatSync(path);
      total += stat.size;
      if (!stat.isFile() || stat.size !== m.sizeBytes || total > archiveLimits.totalBytes) invalid('Missing media or archive size limit exceeded.');
      copyFileSync(path, join(dir, m.id));
    }
    const portable: PortableMedia[] = [];
    for (const m of media ?? []) {
      await validateMediaFile(join(dir, m.id), m.name, m.mimeType, m.sizeBytes);
      portable.push({ ...m, sha256: await hashFile(join(dir, m.id)) });
    }
    const manifest = validateManifest({ schemaVersion: 1, quiz: { id: quizId, ...quiz }, media: portable });
    const json = Buffer.from(JSON.stringify(manifest, null, 2));
    if (json.length > archiveLimits.manifestBytes || total + json.length > archiveLimits.totalBytes) invalid('Manifest or archive exceeds limit.');
    const zip = new yazl.ZipFile();
    const path = join(dir, 'quiz.zip');
    const output = pipeline(zip.outputStream, createWriteStream(path));
    zip.on('error', error => (zip.outputStream as Readable).destroy(error));
    zip.addBuffer(json, 'manifest.json');
    for (const m of portable) zip.addFile(join(dir, m.id), `media/${m.id}`, { compress: false });
    zip.end(); await output;
    if (statSync(path).size > archiveLimits.archiveBytes) invalid('Archive exceeds size limit.');
    return { path, cleanup };
  } catch (error) { cleanup(); throw error; }
}
async function extractArchive(path: string, dir: string): Promise<Map<string, string>> {
  if (statSync(path).size > archiveLimits.archiveBytes) invalid('Archive exceeds size limit.');
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.open(path,
    { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true }, (err, zip) => err ? reject(err) : resolve(zip!)));
  const fd = openSync(path, 'r');
  try {
    if (zip.entryCount > archiveLimits.media + 1) invalid('Too many ZIP entries.');
    const files = new Map<string, string>();
    const spans: [number, number][] = [];
    let total = 0;
    await new Promise<void>((resolve, reject) => {
      zip.on('error', reject); zip.on('end', resolve);
      zip.on('entry', (entry: yauzl.Entry) => {
        void (async () => {
          const name = entry.fileName;
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (!(name === 'manifest.json' || /^media\/[a-f0-9-]{36}$/.test(name) && validMediaId(name.slice(6)))
            || files.has(name) || entry.generalPurposeBitFlag & ~(0x800 | 0x8) || ![0, 0x8000].includes(mode)
            || entry.externalFileAttributes & 0x10 || ![0, 8].includes(entry.compressionMethod)) invalid('Unsafe, duplicate or unexpected ZIP entry.');
          const limit = name === 'manifest.json' ? archiveLimits.manifestBytes : 500 * 1024 * 1024;
          total += entry.uncompressedSize;
          if (entry.uncompressedSize <= 0 || entry.uncompressedSize > limit || total > archiveLimits.totalBytes) invalid('ZIP expansion limit exceeded.');
          // Check local headers too: a safe central name must not conceal a different local path or flags.
          const header = Buffer.alloc(30);
          if (readSync(fd, header, 0, 30, entry.relativeOffsetOfLocalHeader) !== 30 || header.readUInt32LE(0) !== 0x04034b50
            || header.readUInt16LE(6) !== entry.generalPurposeBitFlag || header.readUInt16LE(8) !== entry.compressionMethod) invalid('Conflicting ZIP local header.');
          const nameLength = header.readUInt16LE(26), extraLength = header.readUInt16LE(28);
          const localName = Buffer.alloc(nameLength);
          if (readSync(fd, localName, 0, nameLength, entry.relativeOffsetOfLocalHeader + 30) !== nameLength
            || !localName.equals(Buffer.from(name))) invalid('Conflicting ZIP local filename.');
          const span: [number, number] = [entry.relativeOffsetOfLocalHeader, entry.relativeOffsetOfLocalHeader + 30 + nameLength + extraLength + entry.compressedSize];
          if (spans.some(([start, end]) => span[0] < end && span[1] > start)) invalid('Conflicting ZIP entries.');
          spans.push(span);
          const target = join(dir, String(files.size)); // Never extract an archive-controlled path.
          files.set(name, target);
          const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => zip.openReadStream(entry, (err, stream) => err ? reject(err) : resolve(stream!)));
          let size = 0, crc = 0;
          const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length; crc = crc32(chunk, crc);
            callback(size > limit || size > entry.uncompressedSize ? new ArchiveValidationError('ZIP expansion limit exceeded.') : null, chunk);
          } });
          await pipeline(stream, meter, createWriteStream(target, { flags: 'wx' }));
          if (size !== entry.uncompressedSize || crc !== entry.crc32) invalid('Corrupt ZIP entry.');
          zip.readEntry();
        })().catch(reject);
      });
      zip.readEntry();
    });
    return files;
  } finally { zip.close(); closeSync(fd); }
}
export async function importQuizArchive(db: DatabaseSync, path: string) {
  const dir = staging(db);
  const id = randomUUID();
  let transaction = false;
  try {
    const files = await extractArchive(path, dir);
    if (!files.has('manifest.json')) invalid('Missing manifest.json.');
    let input: unknown;
    try { input = JSON.parse(readFileSync(files.get('manifest.json')!, 'utf8')); } catch { invalid('Malformed JSON manifest.'); }
    const manifest = validateManifest(input);
    if (files.size !== manifest.media.length + 1) invalid('Unexpected or missing media entries.');
    for (const m of manifest.media) {
      const file = files.get(`media/${m.id}`);
      if (!file || statSync(file).size !== m.sizeBytes || await hashFile(file) !== m.sha256) invalid('Missing or corrupt media.');
      if (await validateMediaFile(file, m.name, m.mimeType, m.sizeBytes) !== m.kind) invalid('Media kind does not match content.');
    }
    const ids = new Map<string, string>([[manifest.quiz.id, id]]);
    const remap = (old: string) => { if (!ids.has(old)) ids.set(old, randomUUID()); return ids.get(old)!; };
    const side = (s: MatchingSide) => s.kind === 'image' ? { ...s, mediaId: remap(s.mediaId) } : s;
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE'); transaction = true;
    const q = manifest.quiz;
    db.prepare('INSERT INTO quizzes (id, title, theme_id, default_answer_time_seconds, shuffle_answers, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, q.title, q.themeId, q.defaultAnswerTimeSeconds, Number(q.shuffleAnswers), now, now);
    for (const m of manifest.media) {
      const mediaId = remap(m.id);
      mkdirSync(mediaDirectory(db, id), { recursive: true });
      renameSync(files.get(`media/${m.id}`)!, mediaFile(db, id, mediaId));
      db.prepare('INSERT INTO media (id, quiz_id, name, kind, mime_type, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(mediaId, id, m.name, m.kind, m.mimeType, m.sizeBytes, m.createdAt);
    }
    for (const r of q.rounds) {
      const roundId = remap(r.id);
      db.prepare('INSERT INTO rounds (id, quiz_id, title_ru, title_en, description_ru, description_en, show_leaderboard_after, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(roundId, id, r.titleRu, r.titleEn, r.descriptionRu, r.descriptionEn, Number(r.showLeaderboardAfter), r.position, now, now);
      db.prepare('UPDATE rounds SET art_media_id = ? WHERE id = ?').run(r.artMediaId ? remap(r.artMediaId) : null, roundId);
      for (const question of r.questions) {
        const questionId = remap(question.id);
        db.prepare('INSERT INTO questions (id, round_id, type, text_ru, text_en, points, answer_time_seconds, show_options_on_screen, show_correct_count, media_json, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(questionId, roundId, question.type, question.textRu, question.textEn, question.points, question.answerTimeSeconds,
            Number(question.showOptionsOnScreen), Number(question.showCorrectCount), JSON.stringify((question.media ?? []).map(ref => ({ ...ref, mediaId: remap(ref.mediaId) }))), question.position, now, now);
        db.prepare('UPDATE questions SET explanation_ru = ?, explanation_en = ? WHERE id = ?').run(question.explanationRu ?? '', question.explanationEn ?? '', questionId);
        for (const option of question.options) db.prepare('INSERT INTO answer_options (id, question_id, text_ru, text_en, is_correct, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(remap(option.id), questionId, option.textRu, option.textEn, Number(option.isCorrect), option.position, now, now);
        for (const pair of question.pairs ?? []) db.prepare('INSERT INTO matching_pairs (id, question_id, left_json, right_json, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(remap(pair.id), questionId, JSON.stringify(side(pair.left)), JSON.stringify(side(pair.right)), pair.position, now, now);
      }
    }
    db.exec('COMMIT'); transaction = false;
    return getQuiz(db, id)!;
  } catch (error) {
    if (transaction) db.exec('ROLLBACK');
    rmSync(dirname(mediaDirectory(db, id)), { recursive: true, force: true });
    throw error;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
