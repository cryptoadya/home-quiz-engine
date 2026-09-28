import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { initializeDatabase } from './db.js';

const legacyEditorSchema = `CREATE TABLE rounds (id TEXT PRIMARY KEY);
  CREATE TABLE questions (id TEXT PRIMARY KEY, round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type = 'single_choice'), text_ru TEXT NOT NULL, text_en TEXT NOT NULL,
    points INTEGER NOT NULL CHECK (points > 0), answer_time_seconds INTEGER,
    show_options_on_screen INTEGER NOT NULL, position INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX questions_round_position ON questions(round_id, position);
  CREATE TABLE answer_options (id TEXT PRIMARY KEY, question_id TEXT REFERENCES questions(id) ON DELETE CASCADE);`;

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
      assert.deepEqual(migration.map((row) => row.version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
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
  old.exec(legacyEditorSchema);
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

test('Phase 2D Lobby and started sessions migrate navigation without changing snapshots or roster', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const directory = mkdtempSync(join(tmpdir(), 'quiz-navigation-'));
  const path = join(directory, 'quiz.sqlite');
  const old = new DatabaseSync(path);
  const snapshot = JSON.stringify({ schemaVersion: 1, title: 'Frozen', themeId: 'default', defaultAnswerTimeSeconds: 30, shuffleAnswers: false,
    rounds: [{ id: 'r', titleRu: 'Раунд', titleEn: 'Round', descriptionRu: '', descriptionEn: '', showLeaderboardAfter: false, position: 0,
      questions: [{ id: 'q', type: 'single_choice', textRu: 'Вопрос', textEn: 'Question', points: 1, answerTimeSeconds: null, showOptionsOnScreen: false, position: 0,
        options: [{ id: 'a', textRu: 'Да', textEn: 'Yes', isCorrect: true, position: 0 }, { id: 'b', textRu: 'Нет', textEn: 'No', isCorrect: false, position: 1 }] }] }] });
  old.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
    INSERT INTO schema_migrations VALUES (1), (2), (3), (4), (5), (6);
    CREATE TABLE quizzes (id TEXT PRIMARY KEY, title TEXT, theme_id TEXT NOT NULL);
    INSERT INTO quizzes VALUES ('quiz', 'Editable', 'default');
    CREATE TABLE game_sessions (id TEXT PRIMARY KEY, code TEXT NOT NULL, quiz_id TEXT REFERENCES quizzes(id) ON DELETE SET NULL,
      state TEXT NOT NULL CHECK (state IN ('LOBBY', 'ROUND_INTRO')), created_at TEXT NOT NULL, closed_at TEXT,
      snapshot_json TEXT CHECK (snapshot_json IS NULL OR json_valid(snapshot_json)), roster_locked_at TEXT,
      CHECK ((state = 'LOBBY' AND quiz_id IS NOT NULL AND snapshot_json IS NULL AND roster_locked_at IS NULL)
        OR (state = 'ROUND_INTRO' AND snapshot_json IS NOT NULL AND roster_locked_at IS NOT NULL)));
    CREATE UNIQUE INDEX game_sessions_active_code ON game_sessions(code) WHERE closed_at IS NULL;
    CREATE TRIGGER delete_quiz_lobbies BEFORE DELETE ON quizzes BEGIN
      DELETE FROM game_sessions WHERE quiz_id = OLD.id AND state = 'LOBBY'; END;
    INSERT INTO game_sessions VALUES ('lobby', 'ABCDE', 'quiz', 'LOBBY', 'now', NULL, NULL, NULL);
    CREATE TABLE session_players (id TEXT PRIMARY KEY, session_id TEXT REFERENCES game_sessions(id) ON DELETE CASCADE,
      token_hash TEXT, in_roster INTEGER);`);
  old.prepare("INSERT INTO game_sessions VALUES ('started', 'FGHJK', NULL, 'ROUND_INTRO', 'now', NULL, ?, 'locked')").run(snapshot);
  old.exec("INSERT INTO session_players VALUES ('player', 'started', 'unchanged-hash', 1)");
  old.exec(legacyEditorSchema);
  old.close();
  try {
    const db = initializeDatabase(path);
    try {
      assert.equal(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      const read = (id: string) => ({ ...db.prepare('SELECT current_round_index, current_question_index FROM game_sessions WHERE id = ?').get(id) });
      assert.deepEqual(read('lobby'), { current_round_index: null, current_question_index: null });
      assert.deepEqual(read('started'), { current_round_index: 0, current_question_index: null });
      assert.equal(db.prepare("SELECT snapshot_json FROM game_sessions WHERE id = 'started'").get()!.snapshot_json, snapshot);
      assert.deepEqual({ ...db.prepare('SELECT * FROM session_players').get() }, { id: 'player', session_id: 'started', token_hash: 'unchanged-hash', in_roster: 1 });
      for (const sql of [
        "UPDATE game_sessions SET current_round_index = 0 WHERE id = 'lobby'",
        "UPDATE game_sessions SET current_round_index = NULL WHERE id = 'started'",
        "UPDATE game_sessions SET current_round_index = -1 WHERE id = 'started'",
        "UPDATE game_sessions SET current_round_index = 0.5 WHERE id = 'started'",
        "UPDATE game_sessions SET state = 'QUESTION' WHERE id = 'started'",
      ]) assert.throws(() => db.exec(sql), /CHECK/);
      const { startRound } = await import('./game.js');
      assert.equal(startRound(db, 'started').room?.state, 'QUESTION');
      assert.deepEqual(read('started'), { current_round_index: 0, current_question_index: 0 });
    } finally { db.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Phase 3A migration preserves all navigation, snapshots and roster and constrains active timers', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const directory = mkdtempSync(join(tmpdir(), 'quiz-timer-migration-'));
  const path = join(directory, 'quiz.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
    INSERT INTO schema_migrations VALUES (1), (2), (3), (4), (5), (6), (7);
    CREATE TABLE quizzes (id TEXT PRIMARY KEY);
    INSERT INTO quizzes VALUES ('quiz');
    CREATE TABLE game_sessions (id TEXT PRIMARY KEY, code TEXT NOT NULL, quiz_id TEXT REFERENCES quizzes(id) ON DELETE SET NULL,
      state TEXT NOT NULL, created_at TEXT NOT NULL, closed_at TEXT, snapshot_json TEXT, roster_locked_at TEXT,
      current_round_index INTEGER, current_question_index INTEGER);
    CREATE UNIQUE INDEX game_sessions_active_code ON game_sessions(code) WHERE closed_at IS NULL;
    CREATE TRIGGER delete_quiz_lobbies BEFORE DELETE ON quizzes BEGIN
      DELETE FROM game_sessions WHERE quiz_id = OLD.id AND state = 'LOBBY'; END;
    INSERT INTO game_sessions VALUES ('lobby', 'ABCDE', 'quiz', 'LOBBY', 'now', NULL, NULL, NULL, NULL, NULL),
      ('intro', 'FGHJK', 'quiz', 'ROUND_INTRO', 'now', NULL, '{"frozen":true}', 'locked', 1, NULL),
      ('question', 'MNPQR', 'quiz', 'QUESTION', 'now', NULL, '{"frozen":true}', 'locked', 1, 2);
    CREATE TABLE session_players (id TEXT PRIMARY KEY, session_id TEXT REFERENCES game_sessions(id) ON DELETE CASCADE, token_hash TEXT, in_roster INTEGER);
    INSERT INTO session_players VALUES ('player', 'question', 'same-hash', 1);`);
  const sessions = old.prepare('SELECT * FROM game_sessions ORDER BY id').all();
  old.exec(legacyEditorSchema);
  old.close();
  try {
    const db = initializeDatabase(path);
    try {
      for (const [i, row] of db.prepare('SELECT * FROM game_sessions ORDER BY id').all().entries()) {
        const { answer_started_at, answer_deadline_at, paused_from_state, paused_at, paused_remaining_ms, pause_reason, paused_player_id, pre_timer_media_id, is_test, ...rest } = row;
        assert.equal(is_test, 0); assert.equal(pre_timer_media_id, null); assert.equal(pause_reason, null); assert.equal(paused_player_id, null);
        assert.equal(paused_from_state, null); assert.equal(paused_at, null); assert.equal(paused_remaining_ms, null);
        assert.deepEqual(rest, { ...sessions[i] });
        assert.equal(answer_started_at, null); assert.equal(answer_deadline_at, null);
      }
      assert.deepEqual({ ...db.prepare('SELECT * FROM session_players').get() }, { id: 'player', session_id: 'question', token_hash: 'same-hash', in_roster: 1 });
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      for (const sql of [
        "UPDATE game_sessions SET state = 'ANSWERING' WHERE id = 'question'",
        "UPDATE game_sessions SET answer_deadline_at = '2026-09-26T12:00:12.000Z' WHERE id = 'question'",
        "UPDATE game_sessions SET state = 'ANSWERING', answer_started_at = 'bad', answer_deadline_at = 'bad' WHERE id = 'question'",
        "UPDATE game_sessions SET state = 'ANSWERING', answer_started_at = '2026-09-26T12:00:12.000Z', answer_deadline_at = '2026-09-26T12:00:00.000Z' WHERE id = 'question'",
      ]) assert.throws(() => db.exec(sql), /CHECK/);
      db.exec("UPDATE game_sessions SET state = 'ANSWERING', answer_started_at = '2026-09-26T12:00:00.000Z', answer_deadline_at = '2026-09-26T12:00:12.000Z' WHERE id = 'question'");
      assert.throws(() => db.exec("UPDATE game_sessions SET current_question_index = NULL WHERE id = 'question'"), /CHECK/);
      assert.throws(() => db.exec("UPDATE game_sessions SET state = 'QUESTION' WHERE id = 'question'"), /CHECK/);
    } finally { db.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
