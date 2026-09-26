import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { getRoom, getRoomByCode, type Room } from './rooms.js';

type Player = { id: string; name: string; language: 'ru' | 'en'; joinedAt: string };
type Failure = { status: number; error: string };
type Identity = { player: Player; room: Room; active: boolean };
const publicFields = 'id, display_name AS name, language, joined_at AS joinedAt';
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function listPlayers(db: DatabaseSync, roomId: string): Player[] {
  return db.prepare(`SELECT ${publicFields} FROM session_players
    WHERE session_id = ? AND CASE
      WHEN (SELECT roster_locked_at FROM game_sessions WHERE id = session_id) IS NULL THEN removed_at IS NULL
      ELSE in_roster = 1 END ORDER BY joined_at, id`).all(roomId) as Player[];
}

export function joinPlayer(db: DatabaseSync, code: string, body: unknown): (Identity & { token: string }) | Failure {
  const input = body as { name?: unknown; language?: unknown } | null;
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  // Combining marks belong to a preceding letter; only literal spaces and the two separators are allowed.
  if (!name || [...name].length > 20 || !/^(?:\p{L}\p{M}*|[ '\-])+$/u.test(name) || !/\p{L}/u.test(name)) {
    return { status: 400, error: 'Name must contain letters and be at most 20 characters; spaces, hyphens and apostrophes are allowed.' };
  }
  if (input?.language !== 'ru' && input?.language !== 'en') return { status: 400, error: 'Language must be ru or en.' };
  // Canonical equivalence and Unicode lowercase affect only the reservation key, never the displayed name.
  const normalizedName = name.normalize('NFC').toLowerCase().normalize('NFC');
  db.exec('BEGIN IMMEDIATE');
  let committed = false;
  try {
    const room = getRoomByCode(db, code);
    if (!room) return { status: 404, error: 'Active room not found.' };
    if (room.state !== 'LOBBY') return { status: 409, error: 'Game has already started; room is no longer accepting players.' };
    const count = db.prepare('SELECT count(*) AS n FROM session_players WHERE session_id = ? AND removed_at IS NULL').get(room.id)!;
    if (Number(count.n) >= 30) return { status: 409, error: 'Room is full (30 players).' };
    const player: Player = { id: randomUUID(), name, language: input.language, joinedAt: new Date().toISOString() };
    const token = randomBytes(32).toString('base64url');
    const inserted = db.prepare(`INSERT INTO session_players
      (id, session_id, display_name, normalized_name, language, token_hash, joined_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, normalized_name) WHERE removed_at IS NULL DO NOTHING`)
      .run(player.id, room.id, name, normalizedName, player.language, hashToken(token), player.joinedAt);
    if (!inserted.changes) return { status: 409, error: 'That name is already taken in this room.' };
    db.exec('COMMIT');
    committed = true;
    return { player, room, active: true, token };
  } finally {
    if (!committed) db.exec('ROLLBACK');
  }
}

export function reconnectPlayer(db: DatabaseSync, roomId: string, token: unknown): Identity | Failure {
  const invalid: Failure = { status: 401, error: 'Invalid player reconnect token.' };
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return invalid;
  const player = db.prepare(`SELECT ${publicFields} FROM session_players
    WHERE session_id = ? AND token_hash = ? AND removed_at IS NULL
      AND ((SELECT roster_locked_at FROM game_sessions WHERE id = session_id) IS NULL OR in_roster = 1)`).get(roomId, hashToken(token)) as Player | undefined;
  const room = getRoom(db, roomId);
  if (!player || !room) return invalid;
  return { player, room, active: room.closedAt === null };
}
