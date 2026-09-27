import { validMediaId } from './media.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

// Image references share the quiz-owned media identity boundary.
export type MatchingSide = { kind: 'text'; textRu: string; textEn: string } | { kind: 'image'; mediaId: string };
export type MatchingPair = {
  id: string; questionId: string; left: MatchingSide; right: MatchingSide;
  position: number; createdAt: string; updatedAt: string;
};
export type PairChanges = Pick<MatchingPair, 'left' | 'right'>;
type PairRow = { id: string; question_id: string; left_json: string; right_json: string; position: number; created_at: string; updated_at: string };
const toPair = (row: PairRow): MatchingPair => ({ id: row.id, questionId: row.question_id,
  left: JSON.parse(row.left_json), right: JSON.parse(row.right_json), position: row.position,
  createdAt: row.created_at, updatedAt: row.updated_at });
export function validTextSide(value: unknown, complete = false): value is Extract<MatchingSide, { kind: 'text' }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const side = value as Record<string, unknown>;
  return Object.keys(side).length === 3 && side.kind === 'text'
    && typeof side.textRu === 'string' && typeof side.textEn === 'string'
    && side.textRu.length <= 500 && side.textEn.length <= 500
    && (!complete || Boolean(side.textRu.trim() && side.textEn.trim()));
}
export function validMatchingSide(value: unknown, complete = false): value is MatchingSide {
  if (validTextSide(value, complete)) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const side = value as Record<string, unknown>;
  return Object.keys(side).length === 2 && side.kind === 'image' && validMediaId(side.mediaId);
}
export function validatePairChanges(value: unknown): { changes: PairChanges } | { error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'Pair fields must be an object.' };
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 2 || !validMatchingSide(input.left) || !validMatchingSide(input.right)) {
    return { error: 'Provide left and right bilingual text sides or image media IDs.' };
  }
  return { changes: input as PairChanges };
}
export function listPairs(db: DatabaseSync, questionId: string): MatchingPair[] {
  return (db.prepare('SELECT * FROM matching_pairs WHERE question_id = ? ORDER BY position, id').all(questionId) as PairRow[]).map(toPair);
}
export function getPair(db: DatabaseSync, questionId: string, id: string): MatchingPair | null {
  const row = db.prepare('SELECT * FROM matching_pairs WHERE question_id = ? AND id = ?').get(questionId, id) as PairRow | undefined;
  return row ? toPair(row) : null;
}
export function createPair(db: DatabaseSync, questionId: string): MatchingPair {
  const id = randomUUID();
  const now = new Date().toISOString();
  const blank = JSON.stringify({ kind: 'text', textRu: '', textEn: '' });
  db.prepare(`INSERT INTO matching_pairs (id, question_id, left_json, right_json, position, created_at, updated_at)
    VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM matching_pairs WHERE question_id = ?), ?, ?)`)
    .run(id, questionId, blank, blank, questionId, now, now);
  return getPair(db, questionId, id)!;
}
export function updatePair(db: DatabaseSync, questionId: string, id: string, changes: PairChanges): MatchingPair {
  db.prepare('UPDATE matching_pairs SET left_json = ?, right_json = ?, updated_at = ? WHERE question_id = ? AND id = ?')
    .run(JSON.stringify(changes.left), JSON.stringify(changes.right), new Date().toISOString(), questionId, id);
  return getPair(db, questionId, id)!;
}
export function deletePair(db: DatabaseSync, questionId: string, id: string): void {
  db.prepare('DELETE FROM matching_pairs WHERE question_id = ? AND id = ?').run(questionId, id);
}
export function reorderPairs(db: DatabaseSync, questionId: string, ids: unknown): MatchingPair[] | null {
  const pairs = listPairs(db, questionId);
  if (!Array.isArray(ids) || ids.length !== pairs.length || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !pairs.some(pair => pair.id === id))) return null;
  db.exec('BEGIN');
  try {
    const update = db.prepare('UPDATE matching_pairs SET position = ?, updated_at = ? WHERE question_id = ? AND id = ?');
    const now = new Date().toISOString();
    ids.forEach((id, index) => update.run(index, now, questionId, id));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return listPairs(db, questionId);
}
