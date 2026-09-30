import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ROUND_DESCRIPTION_MAX_LENGTH, roundDescriptionTooLong } from './round-description.js';

export type Round = {
  id: string;
  quizId: string;
  titleRu: string;
  titleEn: string;
  descriptionRu: string;
  descriptionEn: string;
  artMediaId?: string | null; showLeaderboardAfter: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
};

type RoundRow = {
  id: string; quiz_id: string; title_ru: string; title_en: string;
  art_media_id: string | null; description_ru: string; description_en: string; show_leaderboard_after: number;
  position: number; created_at: string; updated_at: string;
};

function toRound(row: RoundRow): Round {
  return {
    id: row.id, quizId: row.quiz_id, titleRu: row.title_ru, titleEn: row.title_en,
    artMediaId: row.art_media_id, descriptionRu: row.description_ru, descriptionEn: row.description_en,
    showLeaderboardAfter: Boolean(row.show_leaderboard_after), position: row.position,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function listRounds(db: DatabaseSync, quizId: string): Round[] {
  return (db.prepare('SELECT * FROM rounds WHERE quiz_id = ? ORDER BY position, id').all(quizId) as RoundRow[]).map(toRound);
}

export function getRound(db: DatabaseSync, quizId: string, id: string): Round | null {
  const row = db.prepare('SELECT * FROM rounds WHERE quiz_id = ? AND id = ?').get(quizId, id) as RoundRow | undefined;
  return row ? toRound(row) : null;
}

export function createRound(db: DatabaseSync, quizId: string): Round {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO rounds (id, quiz_id, title_ru, title_en, description_ru, description_en,
    show_leaderboard_after, position, created_at, updated_at)
    VALUES (?, ?, ?, ?, '', '', 0, (SELECT COALESCE(MAX(position), -1) + 1 FROM rounds WHERE quiz_id = ?), ?, ?)`)
    .run(id, quizId, 'Новый раунд', 'New Round', quizId, now, now);
  return getRound(db, quizId, id)!;
}

export type RoundChanges = Pick<Round, 'titleRu' | 'titleEn' | 'descriptionRu' | 'descriptionEn' | 'showLeaderboardAfter'> & { artMediaId?: string | null };

export function validateRoundChanges(value: unknown): { changes: RoundChanges } | { error: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { error: 'Round fields must be a JSON object.' };
  const input = value as Record<string, unknown>;
  if (input.artMediaId !== undefined && input.artMediaId !== null && (typeof input.artMediaId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.artMediaId))) return { error: 'Invalid round art ID.' };
  const keys = ['titleRu', 'titleEn', 'descriptionRu', 'descriptionEn', 'showLeaderboardAfter'];
  if (keys.some(key => !(key in input)) || Object.keys(input).some((key) => ![...keys, 'artMediaId'].includes(key))) {
    return { error: 'Provide both titles, both descriptions, and showLeaderboardAfter.' };
  }
  if (typeof input.titleRu !== 'string' || !input.titleRu.trim() || input.titleRu.trim().length > 100 ||
      typeof input.titleEn !== 'string' || !input.titleEn.trim() || input.titleEn.trim().length > 100) {
    return { error: 'RU and EN titles must each be 1–100 characters.' };
  }
  if (typeof input.descriptionRu !== 'string' || typeof input.descriptionEn !== 'string' ||
      Boolean(input.descriptionRu.trim()) !== Boolean(input.descriptionEn.trim())) {
    return { error: 'Provide both RU and EN descriptions, or leave both empty.' };
  }
  if (roundDescriptionTooLong(input.descriptionRu) || roundDescriptionTooLong(input.descriptionEn)) {
    return { error: `RU and EN descriptions must each be at most ${ROUND_DESCRIPTION_MAX_LENGTH} characters.` };
  }
  if (typeof input.showLeaderboardAfter !== 'boolean') return { error: 'showLeaderboardAfter must be a boolean.' };
  return { changes: { artMediaId: input.artMediaId as string | null | undefined,
    titleRu: input.titleRu.trim(), titleEn: input.titleEn.trim(),
    descriptionRu: input.descriptionRu.trim(), descriptionEn: input.descriptionEn.trim(),
    showLeaderboardAfter: input.showLeaderboardAfter,
  } };
}

export function updateRound(db: DatabaseSync, quizId: string, id: string, changes: RoundChanges): Round | null {
  const result = db.prepare(`UPDATE rounds SET art_media_id = CASE WHEN ? THEN ? ELSE art_media_id END, title_ru = ?, title_en = ?, description_ru = ?, description_en = ?,
    show_leaderboard_after = ?, updated_at = ? WHERE quiz_id = ? AND id = ?`).run(
    Number(changes.artMediaId !== undefined), changes.artMediaId ?? null, changes.titleRu, changes.titleEn, changes.descriptionRu, changes.descriptionEn,
    Number(changes.showLeaderboardAfter), new Date().toISOString(), quizId, id,
  );
  return result.changes ? getRound(db, quizId, id) : null;
}

export function deleteRound(db: DatabaseSync, quizId: string, id: string): boolean {
  return db.prepare('DELETE FROM rounds WHERE quiz_id = ? AND id = ?').run(quizId, id).changes > 0;
}

export function reorderRounds(db: DatabaseSync, quizId: string, ids: unknown): Round[] | null {
  const existing = listRounds(db, quizId);
  if (!Array.isArray(ids) || ids.length !== existing.length ||
      ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length ||
      ids.some((id) => !existing.some((round) => round.id === id))) return null;
  db.exec('BEGIN');
  try {
    const update = db.prepare('UPDATE rounds SET position = ?, updated_at = ? WHERE quiz_id = ? AND id = ?');
    const now = new Date().toISOString();
    ids.forEach((id, position) => update.run(position, now, quizId, id));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return listRounds(db, quizId);
}
