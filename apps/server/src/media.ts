import { randomUUID } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileTypeFromFile } from 'file-type';
import multer from 'multer';
import type { Express } from 'express';

export class MediaValidationError extends Error {}
export type MediaKind = 'image' | 'audio' | 'video';
export type MediaReference = { mediaId: string; playBeforeTimer: boolean };
export type Media = { id: string; quizId: string; name: string; kind: MediaKind; mimeType: string; sizeBytes: number; createdAt: string };
const formats: Record<string, { mime: string; kind: MediaKind }> = {
  jpg: { mime: 'image/jpeg', kind: 'image' }, jpeg: { mime: 'image/jpeg', kind: 'image' },
  png: { mime: 'image/png', kind: 'image' }, webp: { mime: 'image/webp', kind: 'image' }, gif: { mime: 'image/gif', kind: 'image' },
  mp3: { mime: 'audio/mpeg', kind: 'audio' }, wav: { mime: 'audio/wav', kind: 'audio' }, ogg: { mime: 'audio/ogg', kind: 'audio' },
  mp4: { mime: 'video/mp4', kind: 'video' }, webm: { mime: 'video/webm', kind: 'video' },
};
export const mediaLimits = { image: 20 * 1024 * 1024, audio: 100 * 1024 * 1024, video: 500 * 1024 * 1024 };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const validMediaId = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
export function mediaRoot(db: DatabaseSync): string {
  const row = db.prepare('PRAGMA database_list').all().find(row => row.name === 'main');
  if (!row?.file) throw new Error('Media storage requires a file-backed database.');
  return dirname(String(row.file));
}
export function mediaDirectory(db: DatabaseSync, ownerId: string, frozen = false): string {
  if (!validMediaId(ownerId)) throw new Error('Invalid storage identity.');
  return join(mediaRoot(db), frozen ? 'sessions' : 'quizzes', ownerId, 'media');
}
export function mediaFile(db: DatabaseSync, ownerId: string, id: string, frozen = false): string {
  if (!validMediaId(id)) throw new Error('Invalid media identity.');
  return join(mediaDirectory(db, ownerId, frozen), id);
}
export function listMedia(db: DatabaseSync, quizId: string): Media[] {
  return db.prepare(`SELECT id, quiz_id AS quizId, name, kind, mime_type AS mimeType, size_bytes AS sizeBytes, created_at AS createdAt
    FROM media WHERE quiz_id = ? ORDER BY created_at, id`).all(quizId) as Media[];
}
export function getMedia(db: DatabaseSync, quizId: string, id: string): Media | null {
  return listMedia(db, quizId).find(media => media.id === id) ?? null;
}
export function mediaAvailable(db: DatabaseSync, quizId: string, id: string): boolean {
  const media = getMedia(db, quizId, id);
  if (!media) return false;
  try { const stat = lstatSync(mediaFile(db, quizId, id)); return stat.isFile() && stat.size === media.sizeBytes; } catch { return false; }
}
export function validMediaMetadata(value: unknown): value is Omit<Media, 'quizId'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const media = value as Record<string, unknown>;
  return validMediaId(media.id) && typeof media.name === 'string' && !/[\\/\x00-\x1f\x7f]/.test(media.name)
    && typeof media.createdAt === 'string' && Number.isSafeInteger(media.sizeBytes) && Number(media.sizeBytes) > 0
    && Object.values(formats).some(format => format.kind === media.kind && format.mime === media.mimeType
      && Number(media.sizeBytes) <= mediaLimits[format.kind]);
}
export function validMediaReferences(value: unknown): value is MediaReference[] {
  return Array.isArray(value) && value.length <= 100 && value.every(ref => ref && typeof ref === 'object'
    && Object.keys(ref).length === 2 && validMediaId(ref.mediaId) && typeof ref.playBeforeTimer === 'boolean')
    && new Set(value.map(ref => ref.mediaId)).size === value.length;
}
export function referencesError(db: DatabaseSync, quizId: string, refs: MediaReference[]): string | null {
  for (const ref of refs) {
    const media = getMedia(db, quizId, ref.mediaId);
    if (!media || !mediaAvailable(db, quizId, ref.mediaId)) return 'Referenced media is missing or does not belong to this quiz.';
    if (ref.playBeforeTimer && media.kind === 'image') return 'Only audio/video can play before the timer.';
  }
  return null;
}
function uploadFormat(name: string, mime: string) {
  if (!name || name.length > 255 || /[\\/\x00-\x1f\x7f]/.test(name) || name === '.' || name === '..') throw new MediaValidationError('Invalid filename: paths are not allowed.');
  const format = formats[extname(name).slice(1).toLowerCase()];
  const canonicalMime = ({ 'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav', 'audio/mp3': 'audio/mpeg' } as Record<string, string>)[mime] ?? mime.split(';')[0].trim();
  if (!format || format.mime !== canonicalMime) throw new MediaValidationError('Unsupported extension or MIME type.');
  return format;
}
export function uploadFailure(error: unknown): { status: number; error: string } {
  if (error instanceof MediaValidationError) return { status: 400, error: error.message };
  if (error instanceof multer.MulterError) return { status: error.code === 'LIMIT_FILE_SIZE' ? 413 : 400, error: error.message };
  return { status: 500, error: 'Unable to store media.' };
}
export function mediaUpload(db: DatabaseSync) {
  const destination = join(mediaRoot(db), 'uploads');
  mkdirSync(destination, { recursive: true });
  return multer({ preservePath: true, storage: multer.diskStorage({ destination, filename: (_req, _file, cb) => cb(null, randomUUID()) }),
    limits: { fileSize: mediaLimits.video, files: 1, fields: 0, parts: 1, headerPairs: 32 },
    fileFilter: (_req, file, cb) => { try { uploadFormat(file.originalname, file.mimetype); cb(null, true); } catch (error) { cb(error as Error); } },
  }).single('file');
}
export async function validateMediaFile(path: string, name: string, mimeType: string, sizeBytes: number): Promise<MediaKind> {
  const format = uploadFormat(name, mimeType);
  if (!sizeBytes || sizeBytes > mediaLimits[format.kind]) throw new MediaValidationError(`File exceeds ${format.kind} limit or is empty.`);
  const detected = await fileTypeFromFile(path).catch(() => undefined);
  if (!detected || detected.mime.split(';')[0] !== format.mime) throw new MediaValidationError('File content does not match its extension and MIME type.');
  return format.kind;
}
export async function persistUpload(db: DatabaseSync, quizId: string, file: Express.Multer.File): Promise<Media> {
  let stored: string | undefined;
  try {
    const format = uploadFormat(file.originalname, file.mimetype);
    await validateMediaFile(file.path, file.originalname, file.mimetype, file.size);
    // Quiz could have been deleted while asynchronous signature detection was running.
    if (!db.prepare('SELECT id FROM quizzes WHERE id = ?').get(quizId)) throw new MediaValidationError('Quiz no longer exists.');
    const media: Media = { id: randomUUID(), quizId, name: file.originalname.normalize('NFKC').replace(/[^\p{L}\p{N} ._()-]/gu, '_').slice(0, 160),
      kind: format.kind, mimeType: format.mime, sizeBytes: file.size, createdAt: new Date().toISOString() };
    mkdirSync(mediaDirectory(db, quizId), { recursive: true });
    stored = mediaFile(db, quizId, media.id);
    renameSync(file.path, stored);
    db.prepare('INSERT INTO media (id, quiz_id, name, kind, mime_type, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(media.id, quizId, media.name, media.kind, media.mimeType, media.sizeBytes, media.createdAt);
    return media;
  } catch (error) { if (stored) rmSync(stored, { force: true }); throw error; }
  finally { rmSync(file.path, { force: true }); }
}
export function deleteMedia(db: DatabaseSync, quizId: string, id: string): boolean {
  if (!getMedia(db, quizId, id)) return false;
  // Leave question/pair references intact, including when the physical file is already missing.
  rmSync(mediaFile(db, quizId, id), { force: true });
  db.prepare('DELETE FROM media WHERE quiz_id = ? AND id = ?').run(quizId, id);
  return true;
}
export function copyQuizMedia(db: DatabaseSync, sourceId: string, targetId: string): Map<string, string> {
  const ids = new Map<string, string>();
  for (const media of listMedia(db, sourceId)) {
    if (!mediaAvailable(db, sourceId, media.id)) throw new Error('Cannot duplicate quiz with missing media files.');
    const id = randomUUID(); ids.set(media.id, id);
    mkdirSync(mediaDirectory(db, targetId), { recursive: true });
    copyFileSync(mediaFile(db, sourceId, media.id), mediaFile(db, targetId, id));
    db.prepare('INSERT INTO media (id, quiz_id, name, kind, mime_type, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, targetId, media.name, media.kind, media.mimeType, media.sizeBytes, new Date().toISOString());
  }
  return ids;
}
export function freezeMedia(db: DatabaseSync, quizId: string, sessionId: string, ids: string[]): Omit<Media, 'quizId'>[] {
  return [...new Set(ids)].map(id => {
    if (!mediaAvailable(db, quizId, id)) throw new Error('Referenced media is missing.');
    const { quizId: _owner, ...metadata } = getMedia(db, quizId, id)!;
    mkdirSync(mediaDirectory(db, sessionId, true), { recursive: true });
    copyFileSync(mediaFile(db, quizId, id), mediaFile(db, sessionId, id, true));
    return metadata;
  });
}
export function removeMediaDirectory(db: DatabaseSync, id: string, frozen = false) {
  if (!db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file) return;
  rmSync(mediaDirectory(db, id, frozen), { recursive: true, force: true });
}
