import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const defaultPath = fileURLToPath(new URL('../../../data/quiz.sqlite', import.meta.url));

const migrations: readonly { version: number; sql: string; rebuildForeignKeys?: boolean }[] = [
  {
    version: 1,
    sql: `CREATE TABLE quizzes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      theme_id TEXT NOT NULL,
      default_answer_time_seconds INTEGER NOT NULL,
      shuffle_answers INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  },
  {
    version: 2,
    sql: `CREATE TABLE rounds (
      id TEXT PRIMARY KEY,
      quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
      title_ru TEXT NOT NULL,
      title_en TEXT NOT NULL,
      description_ru TEXT NOT NULL,
      description_en TEXT NOT NULL,
      show_leaderboard_after INTEGER NOT NULL,
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX rounds_quiz_position ON rounds(quiz_id, position)`,
  },
  {
    version: 3,
    sql: `CREATE TABLE questions (
      id TEXT PRIMARY KEY,
      round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type = 'single_choice'),
      text_ru TEXT NOT NULL,
      text_en TEXT NOT NULL,
      points INTEGER NOT NULL CHECK (points > 0),
      answer_time_seconds INTEGER CHECK (answer_time_seconds IS NULL OR answer_time_seconds BETWEEN 1 AND 3600),
      show_options_on_screen INTEGER NOT NULL CHECK (show_options_on_screen IN (0, 1)),
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX questions_round_position ON questions(round_id, position);
    CREATE TABLE answer_options (
      id TEXT PRIMARY KEY,
      question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      text_ru TEXT NOT NULL,
      text_en TEXT NOT NULL,
      is_correct INTEGER NOT NULL CHECK (is_correct IN (0, 1)),
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX answer_options_question_position ON answer_options(question_id, position)`,
  },
  {
    version: 4,
    sql: `CREATE TABLE game_sessions (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL CHECK (length(code) = 5 AND code NOT GLOB '*[^ABCDEFGHJKMNPQRSTUVWXYZ23456789]*'),
      quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      closed_at TEXT
    );
    CREATE UNIQUE INDEX game_sessions_active_code ON game_sessions(code) WHERE closed_at IS NULL`,
  },
  {
    version: 5,
    sql: `CREATE TABLE session_players (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
      display_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      language TEXT NOT NULL CHECK (language IN ('ru', 'en')),
      token_hash TEXT NOT NULL UNIQUE,
      joined_at TEXT NOT NULL,
      removed_at TEXT
    );
    CREATE UNIQUE INDEX session_players_active_name
      ON session_players(session_id, normalized_name) WHERE removed_at IS NULL`,
  },
  {
    version: 6,
    rebuildForeignKeys: true,
    sql: `CREATE TABLE game_sessions_new (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL CHECK (length(code) = 5 AND code NOT GLOB '*[^ABCDEFGHJKMNPQRSTUVWXYZ23456789]*'),
      quiz_id TEXT REFERENCES quizzes(id) ON DELETE SET NULL,
      state TEXT NOT NULL CHECK (state IN ('LOBBY', 'ROUND_INTRO')),
      created_at TEXT NOT NULL,
      closed_at TEXT,
      snapshot_json TEXT CHECK (snapshot_json IS NULL OR json_valid(snapshot_json)),
      roster_locked_at TEXT,
      CHECK ((state = 'LOBBY' AND quiz_id IS NOT NULL AND snapshot_json IS NULL AND roster_locked_at IS NULL)
        OR (state = 'ROUND_INTRO' AND snapshot_json IS NOT NULL AND roster_locked_at IS NOT NULL))
    );
    INSERT INTO game_sessions_new (id, code, quiz_id, state, created_at, closed_at)
      SELECT id, code, quiz_id, state, created_at, closed_at FROM game_sessions;
    DROP TABLE game_sessions;
    ALTER TABLE game_sessions_new RENAME TO game_sessions;
    CREATE UNIQUE INDEX game_sessions_active_code ON game_sessions(code) WHERE closed_at IS NULL;
    ALTER TABLE session_players ADD COLUMN in_roster INTEGER NOT NULL DEFAULT 0 CHECK (in_roster IN (0, 1));
    CREATE TRIGGER delete_quiz_lobbies BEFORE DELETE ON quizzes BEGIN
      DELETE FROM game_sessions WHERE quiz_id = OLD.id AND state = 'LOBBY';
    END`,
  },
];

export function initializeDatabase(filePath = process.env.QUIZ_DB_PATH ?? defaultPath): DatabaseSync {
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);

  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    for (const migration of migrations) {
      const applied = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(migration.version);
      if (applied) continue;

      // Rebuild the parent table without cascading into existing player identities.
      // SQLite requires toggling foreign_keys outside the transaction.
      if (migration.rebuildForeignKeys) db.exec('PRAGMA foreign_keys = OFF');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(migration.sql);
        if (migration.rebuildForeignKeys && db.prepare('PRAGMA foreign_key_check').all().length) {
          throw new Error('Migration would leave invalid foreign keys.');
        }
        db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(migration.version);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      } finally {
        if (migration.rebuildForeignKeys) db.exec('PRAGMA foreign_keys = ON');
      }
    }

    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
