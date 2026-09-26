import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { initializeDatabase } from './db.js';

test('SQLite initializes its migration ledger and reopens cleanly', () => {
  const directory = mkdtempSync(join(tmpdir(), 'home-quiz-'));
  const path = join(directory, 'nested', 'quiz.sqlite');

  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const db = initializeDatabase(path);
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
      assert.equal(table?.name, 'schema_migrations');
      const quizTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'quizzes'").get();
      assert.equal(quizTable?.name, 'quizzes');
      const roundsTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rounds'").get();
      assert.equal(roundsTable?.name, 'rounds');
      for (const name of ['questions', 'answer_options']) {
        assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)?.name, name);
      }
      const migration = db.prepare('SELECT version FROM schema_migrations').all();
      assert.deepEqual(migration.map((row) => row.version), [1, 2, 3, 4, 5, 6]);
      db.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('migration from Phase 2C preserves existing players, tokens, closed rooms and foreign keys', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const directory = mkdtempSync(join(tmpdir(), 'quiz-upgrade-'));
  const path = join(directory, 'quiz.sqlite');
  const old = new DatabaseSync(path);
  // The three affected tables as persisted by Phase 2C; migrations 1–5 are already applied.
  old.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
    INSERT INTO schema_migrations VALUES (1), (2), (3), (4), (5);
    CREATE TABLE quizzes (id TEXT PRIMARY KEY, title TEXT NOT NULL, theme_id TEXT NOT NULL,
      default_answer_time_seconds INTEGER NOT NULL, shuffle_answers INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO quizzes VALUES ('quiz', 'Party', 'default', 30, 0, 'now', 'now');
    CREATE TABLE game_sessions (id TEXT PRIMARY KEY, code TEXT NOT NULL,
      quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
      state TEXT NOT NULL, created_at TEXT NOT NULL, closed_at TEXT);
    CREATE UNIQUE INDEX game_sessions_active_code ON game_sessions(code) WHERE closed_at IS NULL;
    INSERT INTO game_sessions VALUES ('room', 'ABCDE', 'quiz', 'LOBBY', 'now', NULL), ('closed', 'FGHJK', 'quiz', 'LOBBY', 'now', 'later');
    CREATE TABLE session_players (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
      display_name TEXT NOT NULL, normalized_name TEXT NOT NULL, language TEXT NOT NULL CHECK (language IN ('ru', 'en')),
      token_hash TEXT NOT NULL UNIQUE, joined_at TEXT NOT NULL, removed_at TEXT);
    CREATE UNIQUE INDEX session_players_active_name ON session_players(session_id, normalized_name) WHERE removed_at IS NULL;
    INSERT INTO session_players VALUES ('player', 'room', 'Alice', 'alice', 'en', 'original-token-hash', 'now', NULL);`);
  old.close();
  try {
    const db = initializeDatabase(path);
    try {
      assert.equal(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      const player = db.prepare('SELECT * FROM session_players').get()!;
      assert.equal(player.token_hash, 'original-token-hash');
      assert.equal(player.session_id, 'room');
      assert.equal(player.in_roster, 0);
      assert.equal(db.prepare("SELECT closed_at FROM game_sessions WHERE id = 'closed'").get()!.closed_at, 'later');
      assert.throws(() => db.exec("UPDATE session_players SET session_id = 'missing'"), /FOREIGN KEY/);
      db.exec("DELETE FROM quizzes WHERE id = 'quiz'");
      assert.equal(db.prepare('SELECT count(*) AS n FROM game_sessions').get()!.n, 0);
      assert.equal(db.prepare('SELECT count(*) AS n FROM session_players').get()!.n, 0);
    } finally { db.close(); }
    const reopened = initializeDatabase(path);
    reopened.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
