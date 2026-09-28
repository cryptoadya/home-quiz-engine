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
  {
    version: 7,
    rebuildForeignKeys: true,
    sql: `CREATE TABLE game_sessions_new (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL CHECK (length(code) = 5 AND code NOT GLOB '*[^ABCDEFGHJKMNPQRSTUVWXYZ23456789]*'),
      quiz_id TEXT REFERENCES quizzes(id) ON DELETE SET NULL,
      state TEXT NOT NULL CHECK (state IN ('LOBBY', 'ROUND_INTRO', 'QUESTION')),
      created_at TEXT NOT NULL,
      closed_at TEXT,
      snapshot_json TEXT CHECK (snapshot_json IS NULL OR json_valid(snapshot_json)),
      roster_locked_at TEXT,
      current_round_index INTEGER CHECK (current_round_index IS NULL OR (typeof(current_round_index) = 'integer' AND current_round_index >= 0)),
      current_question_index INTEGER CHECK (current_question_index IS NULL OR (typeof(current_question_index) = 'integer' AND current_question_index >= 0)),
      CHECK ((state = 'LOBBY' AND current_round_index IS NULL AND current_question_index IS NULL)
        OR (state = 'ROUND_INTRO' AND current_round_index IS NOT NULL AND current_question_index IS NULL)
        OR (state = 'QUESTION' AND current_round_index IS NOT NULL AND current_question_index IS NOT NULL)),
      CHECK ((state = 'LOBBY' AND quiz_id IS NOT NULL AND snapshot_json IS NULL AND roster_locked_at IS NULL)
        OR (state IN ('ROUND_INTRO', 'QUESTION') AND snapshot_json IS NOT NULL AND roster_locked_at IS NOT NULL))
    );
    INSERT INTO game_sessions_new
      SELECT id, code, quiz_id, state, created_at, closed_at, snapshot_json, roster_locked_at,
        CASE WHEN state = 'ROUND_INTRO' THEN 0 ELSE NULL END, NULL FROM game_sessions;
    DROP TRIGGER delete_quiz_lobbies;
    DROP TABLE game_sessions;
    ALTER TABLE game_sessions_new RENAME TO game_sessions;
    CREATE UNIQUE INDEX game_sessions_active_code ON game_sessions(code) WHERE closed_at IS NULL;
    CREATE TRIGGER delete_quiz_lobbies BEFORE DELETE ON quizzes BEGIN
      DELETE FROM game_sessions WHERE quiz_id = OLD.id AND state = 'LOBBY';
    END`,
  },
  {
    version: 8,
    rebuildForeignKeys: true,
    sql: `CREATE TABLE game_sessions_new (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL CHECK (length(code) = 5 AND code NOT GLOB '*[^ABCDEFGHJKMNPQRSTUVWXYZ23456789]*'),
      quiz_id TEXT REFERENCES quizzes(id) ON DELETE SET NULL,
      state TEXT NOT NULL CHECK (state IN ('LOBBY', 'ROUND_INTRO', 'QUESTION', 'ANSWERING')),
      created_at TEXT NOT NULL,
      closed_at TEXT,
      snapshot_json TEXT CHECK (snapshot_json IS NULL OR json_valid(snapshot_json)),
      roster_locked_at TEXT,
      current_round_index INTEGER CHECK (current_round_index IS NULL OR (typeof(current_round_index) = 'integer' AND current_round_index >= 0)),
      current_question_index INTEGER CHECK (current_question_index IS NULL OR (typeof(current_question_index) = 'integer' AND current_question_index >= 0)),
      answer_started_at TEXT,
      answer_deadline_at TEXT,
      CHECK ((state = 'ANSWERING' AND answer_started_at IS NOT NULL AND answer_deadline_at IS NOT NULL
        AND julianday(answer_started_at) IS NOT NULL AND julianday(answer_deadline_at) IS NOT NULL
        AND substr(answer_started_at, -1) = 'Z' AND substr(answer_deadline_at, -1) = 'Z'
        AND julianday(answer_deadline_at) > julianday(answer_started_at))
        OR (state <> 'ANSWERING' AND answer_started_at IS NULL AND answer_deadline_at IS NULL)),
      CHECK ((state = 'LOBBY' AND current_round_index IS NULL AND current_question_index IS NULL)
        OR (state = 'ROUND_INTRO' AND current_round_index IS NOT NULL AND current_question_index IS NULL)
        OR (state IN ('QUESTION', 'ANSWERING') AND current_round_index IS NOT NULL AND current_question_index IS NOT NULL)),
      CHECK ((state = 'LOBBY' AND quiz_id IS NOT NULL AND snapshot_json IS NULL AND roster_locked_at IS NULL)
        OR (state IN ('ROUND_INTRO', 'QUESTION', 'ANSWERING') AND snapshot_json IS NOT NULL AND roster_locked_at IS NOT NULL))
    );
    INSERT INTO game_sessions_new
      SELECT id, code, quiz_id, state, created_at, closed_at, snapshot_json, roster_locked_at,
        current_round_index, current_question_index, NULL, NULL FROM game_sessions;
    DROP TRIGGER delete_quiz_lobbies;
    DROP TABLE game_sessions;
    ALTER TABLE game_sessions_new RENAME TO game_sessions;
    CREATE UNIQUE INDEX game_sessions_active_code ON game_sessions(code) WHERE closed_at IS NULL;
    CREATE TRIGGER delete_quiz_lobbies BEFORE DELETE ON quizzes BEGIN
      DELETE FROM game_sessions WHERE quiz_id = OLD.id AND state = 'LOBBY';
    END`,
  },
  {
    version: 9,
    sql: `CREATE TABLE player_answers (
      session_id TEXT NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
      player_id TEXT NOT NULL REFERENCES session_players(id) ON DELETE CASCADE,
      question_id TEXT NOT NULL,
      option_id TEXT NOT NULL,
      submitted_at TEXT NOT NULL,
      PRIMARY KEY (session_id, question_id, player_id)
    )`,
  },
  {
    version: 10,
    rebuildForeignKeys: true,
    sql: `CREATE TABLE game_sessions_new (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL CHECK (length(code) = 5 AND code NOT GLOB '*[^ABCDEFGHJKMNPQRSTUVWXYZ23456789]*'),
      quiz_id TEXT REFERENCES quizzes(id) ON DELETE SET NULL,
      state TEXT NOT NULL CHECK (state IN ('LOBBY', 'ROUND_INTRO', 'QUESTION', 'ANSWERING', 'ANSWER_REVEAL')),
      created_at TEXT NOT NULL,
      closed_at TEXT,
      snapshot_json TEXT CHECK (snapshot_json IS NULL OR json_valid(snapshot_json)),
      roster_locked_at TEXT,
      current_round_index INTEGER CHECK (current_round_index IS NULL OR (typeof(current_round_index) = 'integer' AND current_round_index >= 0)),
      current_question_index INTEGER CHECK (current_question_index IS NULL OR (typeof(current_question_index) = 'integer' AND current_question_index >= 0)),
      answer_started_at TEXT,
      answer_deadline_at TEXT,
      CHECK ((state IN ('ANSWERING', 'ANSWER_REVEAL') AND answer_started_at IS NOT NULL AND answer_deadline_at IS NOT NULL
        AND julianday(answer_started_at) IS NOT NULL AND julianday(answer_deadline_at) IS NOT NULL
        AND substr(answer_started_at, -1) = 'Z' AND substr(answer_deadline_at, -1) = 'Z'
        AND julianday(answer_deadline_at) > julianday(answer_started_at))
        OR (state NOT IN ('ANSWERING', 'ANSWER_REVEAL') AND answer_started_at IS NULL AND answer_deadline_at IS NULL)),
      CHECK ((state = 'LOBBY' AND current_round_index IS NULL AND current_question_index IS NULL)
        OR (state = 'ROUND_INTRO' AND current_round_index IS NOT NULL AND current_question_index IS NULL)
        OR (state IN ('QUESTION', 'ANSWERING', 'ANSWER_REVEAL') AND current_round_index IS NOT NULL AND current_question_index IS NOT NULL)),
      CHECK ((state = 'LOBBY' AND quiz_id IS NOT NULL AND snapshot_json IS NULL AND roster_locked_at IS NULL)
        OR (state IN ('ROUND_INTRO', 'QUESTION', 'ANSWERING', 'ANSWER_REVEAL') AND snapshot_json IS NOT NULL AND roster_locked_at IS NOT NULL))
    );
    INSERT INTO game_sessions_new
      SELECT id, code, quiz_id, state, created_at, closed_at, snapshot_json, roster_locked_at,
        current_round_index, current_question_index, answer_started_at, answer_deadline_at FROM game_sessions;
    DROP TRIGGER delete_quiz_lobbies;
    DROP TABLE game_sessions;
    ALTER TABLE game_sessions_new RENAME TO game_sessions;
    CREATE UNIQUE INDEX game_sessions_active_code ON game_sessions(code) WHERE closed_at IS NULL;
    CREATE TRIGGER delete_quiz_lobbies BEFORE DELETE ON quizzes BEGIN
      DELETE FROM game_sessions WHERE quiz_id = OLD.id AND state = 'LOBBY';
    END;
    CREATE TABLE question_scores (
      session_id TEXT NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
      question_id TEXT NOT NULL,
      player_id TEXT NOT NULL REFERENCES session_players(id) ON DELETE CASCADE,
      result TEXT NOT NULL CHECK (result IN ('correct', 'wrong', 'unanswered')),
      awarded_points INTEGER NOT NULL CHECK (typeof(awarded_points) = 'integer' AND awarded_points >= 0),
      PRIMARY KEY (session_id, question_id, player_id)
    )`,
  },
  {
    version: 11,
    rebuildForeignKeys: true,
    sql: `CREATE TABLE game_sessions_new (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL CHECK (length(code) = 5 AND code NOT GLOB '*[^ABCDEFGHJKMNPQRSTUVWXYZ23456789]*'),
      quiz_id TEXT REFERENCES quizzes(id) ON DELETE SET NULL,
      state TEXT NOT NULL CHECK (state IN ('LOBBY', 'ROUND_INTRO', 'QUESTION', 'ANSWERING', 'ANSWER_REVEAL', 'ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS', 'WINNER_SCREEN')),
      created_at TEXT NOT NULL,
      closed_at TEXT,
      snapshot_json TEXT CHECK (snapshot_json IS NULL OR json_valid(snapshot_json)),
      roster_locked_at TEXT,
      current_round_index INTEGER CHECK (current_round_index IS NULL OR (typeof(current_round_index) = 'integer' AND current_round_index >= 0)),
      current_question_index INTEGER CHECK (current_question_index IS NULL OR (typeof(current_question_index) = 'integer' AND current_question_index >= 0)),
      answer_started_at TEXT,
      answer_deadline_at TEXT,
      CHECK ((state IN ('ANSWERING', 'ANSWER_REVEAL') AND answer_started_at IS NOT NULL AND answer_deadline_at IS NOT NULL
        AND julianday(answer_started_at) IS NOT NULL AND julianday(answer_deadline_at) IS NOT NULL
        AND substr(answer_started_at, -1) = 'Z' AND substr(answer_deadline_at, -1) = 'Z'
        AND julianday(answer_deadline_at) > julianday(answer_started_at))
        OR (state NOT IN ('ANSWERING', 'ANSWER_REVEAL') AND answer_started_at IS NULL AND answer_deadline_at IS NULL)),
      CHECK ((state = 'LOBBY' AND current_round_index IS NULL AND current_question_index IS NULL)
        OR (state = 'ROUND_INTRO' AND current_round_index IS NOT NULL AND current_question_index IS NULL)
        OR (state IN ('QUESTION', 'ANSWERING', 'ANSWER_REVEAL', 'ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS', 'WINNER_SCREEN') AND current_round_index IS NOT NULL AND current_question_index IS NOT NULL)),
      CHECK ((state = 'LOBBY' AND quiz_id IS NOT NULL AND snapshot_json IS NULL AND roster_locked_at IS NULL)
        OR (state IN ('ROUND_INTRO', 'QUESTION', 'ANSWERING', 'ANSWER_REVEAL', 'ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS', 'WINNER_SCREEN') AND snapshot_json IS NOT NULL AND roster_locked_at IS NOT NULL))
    );
    INSERT INTO game_sessions_new
      SELECT id, code, quiz_id, state, created_at, closed_at, snapshot_json, roster_locked_at,
        current_round_index, current_question_index, answer_started_at, answer_deadline_at FROM game_sessions;
    DROP TRIGGER delete_quiz_lobbies;
    DROP TABLE game_sessions;
    ALTER TABLE game_sessions_new RENAME TO game_sessions;
    CREATE UNIQUE INDEX game_sessions_active_code ON game_sessions(code) WHERE closed_at IS NULL;
    CREATE TRIGGER delete_quiz_lobbies BEFORE DELETE ON quizzes BEGIN
      DELETE FROM game_sessions WHERE quiz_id = OLD.id AND state = 'LOBBY';
    END;
`,
  },
  {
    version: 12,
    rebuildForeignKeys: true,
    sql: `CREATE TABLE game_sessions_new (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL CHECK (length(code) = 5 AND code NOT GLOB '*[^ABCDEFGHJKMNPQRSTUVWXYZ23456789]*'),
      quiz_id TEXT REFERENCES quizzes(id) ON DELETE SET NULL,
      state TEXT NOT NULL CHECK (state IN ('LOBBY', 'ROUND_INTRO', 'QUESTION', 'ANSWERING', 'ANSWER_REVEAL', 'ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS', 'WINNER_SCREEN', 'PAUSED')),
      created_at TEXT NOT NULL,
      closed_at TEXT,
      snapshot_json TEXT CHECK (snapshot_json IS NULL OR json_valid(snapshot_json)),
      roster_locked_at TEXT,
      current_round_index INTEGER CHECK (current_round_index IS NULL OR (typeof(current_round_index) = 'integer' AND current_round_index >= 0)),
      current_question_index INTEGER CHECK (current_question_index IS NULL OR (typeof(current_question_index) = 'integer' AND current_question_index >= 0)),
      answer_started_at TEXT,
      answer_deadline_at TEXT,
      paused_from_state TEXT,
      paused_at TEXT,
      paused_remaining_ms INTEGER,
      CHECK ((state = 'PAUSED' AND paused_from_state IS NOT NULL
        AND paused_from_state IN ('ROUND_INTRO', 'QUESTION', 'ANSWERING', 'ANSWER_REVEAL', 'ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS')
        AND paused_at IS NOT NULL AND julianday(paused_at) IS NOT NULL AND substr(paused_at, -1) = 'Z'
        AND ((paused_from_state = 'ANSWERING' AND paused_remaining_ms IS NOT NULL
          AND typeof(paused_remaining_ms) = 'integer' AND paused_remaining_ms > 0)
          OR (paused_from_state <> 'ANSWERING' AND paused_remaining_ms IS NULL)))
        OR (state <> 'PAUSED' AND paused_from_state IS NULL AND paused_at IS NULL AND paused_remaining_ms IS NULL)),
      CHECK (((state IN ('ANSWERING', 'ANSWER_REVEAL') OR (state = 'PAUSED' AND paused_from_state = 'ANSWER_REVEAL')) AND answer_started_at IS NOT NULL AND answer_deadline_at IS NOT NULL
        AND julianday(answer_started_at) IS NOT NULL AND julianday(answer_deadline_at) IS NOT NULL
        AND substr(answer_started_at, -1) = 'Z' AND substr(answer_deadline_at, -1) = 'Z'
        AND julianday(answer_deadline_at) > julianday(answer_started_at))
        OR (NOT (state IN ('ANSWERING', 'ANSWER_REVEAL') OR (state = 'PAUSED' AND paused_from_state = 'ANSWER_REVEAL')) AND answer_started_at IS NULL AND answer_deadline_at IS NULL)),
      CHECK ((state = 'LOBBY' AND current_round_index IS NULL AND current_question_index IS NULL)
        OR ((state = 'ROUND_INTRO' OR (state = 'PAUSED' AND paused_from_state = 'ROUND_INTRO')) AND current_round_index IS NOT NULL AND current_question_index IS NULL)
        OR ((CASE WHEN state = 'PAUSED' THEN paused_from_state ELSE state END) IN ('QUESTION', 'ANSWERING', 'ANSWER_REVEAL', 'ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS', 'WINNER_SCREEN') AND current_round_index IS NOT NULL AND current_question_index IS NOT NULL)),
      CHECK ((state = 'LOBBY' AND quiz_id IS NOT NULL AND snapshot_json IS NULL AND roster_locked_at IS NULL)
        OR (state IN ('ROUND_INTRO', 'QUESTION', 'ANSWERING', 'ANSWER_REVEAL', 'ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS', 'WINNER_SCREEN', 'PAUSED') AND snapshot_json IS NOT NULL AND roster_locked_at IS NOT NULL))
    );
    INSERT INTO game_sessions_new
      SELECT id, code, quiz_id, state, created_at, closed_at, snapshot_json, roster_locked_at,
        current_round_index, current_question_index, answer_started_at, answer_deadline_at, NULL, NULL, NULL FROM game_sessions;
    DROP TRIGGER delete_quiz_lobbies;
    DROP TABLE game_sessions;
    ALTER TABLE game_sessions_new RENAME TO game_sessions;
    CREATE UNIQUE INDEX game_sessions_active_code ON game_sessions(code) WHERE closed_at IS NULL;
    CREATE TRIGGER delete_quiz_lobbies BEFORE DELETE ON quizzes BEGIN
      DELETE FROM game_sessions WHERE quiz_id = OLD.id AND state = 'LOBBY';
    END;
`,
  },
  {
    version: 13,
    rebuildForeignKeys: true,
    sql: `CREATE TABLE game_sessions_new (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL CHECK (length(code) = 5 AND code NOT GLOB '*[^ABCDEFGHJKMNPQRSTUVWXYZ23456789]*'),
      quiz_id TEXT REFERENCES quizzes(id) ON DELETE SET NULL,
      state TEXT NOT NULL CHECK (state IN ('LOBBY', 'ROUND_INTRO', 'QUESTION', 'ANSWERING', 'ANSWER_REVEAL', 'ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS', 'WINNER_SCREEN', 'PAUSED')),
      created_at TEXT NOT NULL,
      closed_at TEXT,
      snapshot_json TEXT CHECK (snapshot_json IS NULL OR json_valid(snapshot_json)),
      roster_locked_at TEXT,
      current_round_index INTEGER CHECK (current_round_index IS NULL OR (typeof(current_round_index) = 'integer' AND current_round_index >= 0)),
      current_question_index INTEGER CHECK (current_question_index IS NULL OR (typeof(current_question_index) = 'integer' AND current_question_index >= 0)),
      answer_started_at TEXT,
      answer_deadline_at TEXT,
      paused_from_state TEXT,
      paused_at TEXT,
      paused_remaining_ms INTEGER,
      pause_reason TEXT,
      paused_player_id TEXT,
      CHECK ((state = 'PAUSED' AND pause_reason IS NOT NULL
        AND ((pause_reason = 'manual' AND paused_player_id IS NULL)
          OR (pause_reason = 'player_disconnect' AND paused_player_id IS NOT NULL AND paused_from_state = 'ANSWERING')))
        OR (state <> 'PAUSED' AND pause_reason IS NULL AND paused_player_id IS NULL)),
      CHECK ((state = 'PAUSED' AND paused_from_state IS NOT NULL
        AND paused_from_state IN ('ROUND_INTRO', 'QUESTION', 'ANSWERING', 'ANSWER_REVEAL', 'ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS')
        AND paused_at IS NOT NULL AND julianday(paused_at) IS NOT NULL AND substr(paused_at, -1) = 'Z'
        AND ((paused_from_state = 'ANSWERING' AND paused_remaining_ms IS NOT NULL
          AND typeof(paused_remaining_ms) = 'integer' AND paused_remaining_ms > 0)
          OR (paused_from_state <> 'ANSWERING' AND paused_remaining_ms IS NULL)))
        OR (state <> 'PAUSED' AND paused_from_state IS NULL AND paused_at IS NULL AND paused_remaining_ms IS NULL)),
      CHECK (((state IN ('ANSWERING', 'ANSWER_REVEAL') OR (state = 'PAUSED' AND paused_from_state = 'ANSWER_REVEAL')) AND answer_started_at IS NOT NULL AND answer_deadline_at IS NOT NULL
        AND julianday(answer_started_at) IS NOT NULL AND julianday(answer_deadline_at) IS NOT NULL
        AND substr(answer_started_at, -1) = 'Z' AND substr(answer_deadline_at, -1) = 'Z'
        AND julianday(answer_deadline_at) > julianday(answer_started_at))
        OR (NOT (state IN ('ANSWERING', 'ANSWER_REVEAL') OR (state = 'PAUSED' AND paused_from_state = 'ANSWER_REVEAL')) AND answer_started_at IS NULL AND answer_deadline_at IS NULL)),
      CHECK ((state = 'LOBBY' AND current_round_index IS NULL AND current_question_index IS NULL)
        OR ((state = 'ROUND_INTRO' OR (state = 'PAUSED' AND paused_from_state = 'ROUND_INTRO')) AND current_round_index IS NOT NULL AND current_question_index IS NULL)
        OR ((CASE WHEN state = 'PAUSED' THEN paused_from_state ELSE state END) IN ('QUESTION', 'ANSWERING', 'ANSWER_REVEAL', 'ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS', 'WINNER_SCREEN') AND current_round_index IS NOT NULL AND current_question_index IS NOT NULL)),
      CHECK ((state = 'LOBBY' AND quiz_id IS NOT NULL AND snapshot_json IS NULL AND roster_locked_at IS NULL)
        OR (state IN ('ROUND_INTRO', 'QUESTION', 'ANSWERING', 'ANSWER_REVEAL', 'ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS', 'WINNER_SCREEN', 'PAUSED') AND snapshot_json IS NOT NULL AND roster_locked_at IS NOT NULL))
    );
    INSERT INTO game_sessions_new
      SELECT id, code, quiz_id, state, created_at, closed_at, snapshot_json, roster_locked_at,
        current_round_index, current_question_index, answer_started_at, answer_deadline_at, paused_from_state, paused_at, paused_remaining_ms,
        CASE WHEN state = 'PAUSED' THEN 'manual' ELSE NULL END, NULL FROM game_sessions;
    DROP TRIGGER delete_quiz_lobbies;
    DROP TABLE game_sessions;
    ALTER TABLE game_sessions_new RENAME TO game_sessions;
    CREATE UNIQUE INDEX game_sessions_active_code ON game_sessions(code) WHERE closed_at IS NULL;
    CREATE TRIGGER delete_quiz_lobbies BEFORE DELETE ON quizzes BEGIN
      DELETE FROM game_sessions WHERE quiz_id = OLD.id AND state = 'LOBBY';
    END;
`,
  },
  {
    version: 14,
    rebuildForeignKeys: true,
    sql: `CREATE TABLE game_sessions_new (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL CHECK (length(code) = 5 AND code NOT GLOB '*[^ABCDEFGHJKMNPQRSTUVWXYZ23456789]*'),
      quiz_id TEXT REFERENCES quizzes(id) ON DELETE SET NULL,
      state TEXT NOT NULL CHECK (state IN ('LOBBY', 'ROUND_INTRO', 'QUESTION', 'ANSWERING', 'ANSWER_REVEAL', 'ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS', 'WINNER_SCREEN', 'PAUSED')),
      created_at TEXT NOT NULL,
      closed_at TEXT,
      snapshot_json TEXT CHECK (snapshot_json IS NULL OR json_valid(snapshot_json)),
      roster_locked_at TEXT,
      current_round_index INTEGER CHECK (current_round_index IS NULL OR (typeof(current_round_index) = 'integer' AND current_round_index >= 0)),
      current_question_index INTEGER CHECK (current_question_index IS NULL OR (typeof(current_question_index) = 'integer' AND current_question_index >= 0)),
      answer_started_at TEXT,
      answer_deadline_at TEXT,
      paused_from_state TEXT,
      paused_at TEXT,
      paused_remaining_ms INTEGER,
      pause_reason TEXT,
      paused_player_id TEXT,
      CHECK ((state = 'PAUSED' AND pause_reason IS NOT NULL
        AND ((pause_reason = 'manual' AND paused_player_id IS NULL)
          OR (pause_reason = 'player_disconnect' AND paused_player_id IS NOT NULL AND paused_from_state = 'ANSWERING')))
        OR (state <> 'PAUSED' AND pause_reason IS NULL AND paused_player_id IS NULL)),
      CHECK ((state = 'PAUSED' AND paused_from_state IS NOT NULL
        AND paused_from_state IN ('ROUND_INTRO', 'QUESTION', 'ANSWERING', 'ANSWER_REVEAL', 'ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS')
        AND paused_at IS NOT NULL AND julianday(paused_at) IS NOT NULL AND substr(paused_at, -1) = 'Z'
        AND ((paused_from_state = 'ANSWERING' AND paused_remaining_ms IS NOT NULL
          AND typeof(paused_remaining_ms) = 'integer' AND paused_remaining_ms > 0)
          OR (paused_from_state <> 'ANSWERING' AND paused_remaining_ms IS NULL)))
        OR (state <> 'PAUSED' AND paused_from_state IS NULL AND paused_at IS NULL AND paused_remaining_ms IS NULL)),
      CHECK (((state IN ('ANSWERING', 'ANSWER_REVEAL') OR (state = 'PAUSED' AND paused_from_state = 'ANSWER_REVEAL')) AND answer_started_at IS NOT NULL AND answer_deadline_at IS NOT NULL
        AND julianday(answer_started_at) IS NOT NULL AND julianday(answer_deadline_at) IS NOT NULL
        AND substr(answer_started_at, -1) = 'Z' AND substr(answer_deadline_at, -1) = 'Z'
        AND julianday(answer_deadline_at) > julianday(answer_started_at))
        OR ((state = 'ANSWER_REVEAL' OR (state = 'PAUSED' AND paused_from_state = 'ANSWER_REVEAL')) AND answer_started_at IS NULL AND answer_deadline_at IS NULL)
        OR (NOT (state IN ('ANSWERING', 'ANSWER_REVEAL') OR (state = 'PAUSED' AND paused_from_state = 'ANSWER_REVEAL')) AND answer_started_at IS NULL AND answer_deadline_at IS NULL)),
      CHECK ((state = 'LOBBY' AND current_round_index IS NULL AND current_question_index IS NULL)
        OR ((state = 'ROUND_INTRO' OR (state = 'PAUSED' AND paused_from_state = 'ROUND_INTRO')) AND current_round_index IS NOT NULL AND current_question_index IS NULL)
        OR ((CASE WHEN state = 'PAUSED' THEN paused_from_state ELSE state END) IN ('QUESTION', 'ANSWERING', 'ANSWER_REVEAL', 'ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS', 'WINNER_SCREEN') AND current_round_index IS NOT NULL AND current_question_index IS NOT NULL)),
      CHECK ((state = 'LOBBY' AND quiz_id IS NOT NULL AND snapshot_json IS NULL AND roster_locked_at IS NULL)
        OR (state IN ('ROUND_INTRO', 'QUESTION', 'ANSWERING', 'ANSWER_REVEAL', 'ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS', 'WINNER_SCREEN', 'PAUSED') AND snapshot_json IS NOT NULL AND roster_locked_at IS NOT NULL))
    );
    INSERT INTO game_sessions_new SELECT * FROM game_sessions;
    DROP TRIGGER delete_quiz_lobbies;
    DROP TABLE game_sessions;
    ALTER TABLE game_sessions_new RENAME TO game_sessions;
    CREATE UNIQUE INDEX game_sessions_active_code ON game_sessions(code) WHERE closed_at IS NULL;
    CREATE TRIGGER delete_quiz_lobbies BEFORE DELETE ON quizzes BEGIN
      DELETE FROM game_sessions WHERE quiz_id = OLD.id AND state = 'LOBBY';
    END;
    CREATE TABLE question_exclusions (
      session_id TEXT NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
      question_id TEXT NOT NULL,
      player_id TEXT NOT NULL REFERENCES session_players(id) ON DELETE CASCADE,
      PRIMARY KEY (session_id, question_id, player_id)
    );`,
  },
  {
    version: 15,
    rebuildForeignKeys: true,
    sql: `CREATE TABLE questions_new (
      id TEXT PRIMARY KEY,
      round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('single_choice', 'yes_no')),
      text_ru TEXT NOT NULL, text_en TEXT NOT NULL,
      points INTEGER NOT NULL CHECK (points > 0),
      answer_time_seconds INTEGER CHECK (answer_time_seconds IS NULL OR answer_time_seconds BETWEEN 1 AND 3600),
      show_options_on_screen INTEGER NOT NULL CHECK (show_options_on_screen IN (0, 1)),
      position INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO questions_new SELECT * FROM questions;
    DROP TABLE questions;
    ALTER TABLE questions_new RENAME TO questions;
    CREATE INDEX questions_round_position ON questions(round_id, position);`,
  },
  {
    version: 16,
    rebuildForeignKeys: true,
    sql: `CREATE TABLE questions_new (
      id TEXT PRIMARY KEY,
      round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('single_choice', 'yes_no', 'multiple_choice')),
      text_ru TEXT NOT NULL, text_en TEXT NOT NULL,
      points INTEGER NOT NULL CHECK (points > 0),
      answer_time_seconds INTEGER CHECK (answer_time_seconds IS NULL OR answer_time_seconds BETWEEN 1 AND 3600),
      show_options_on_screen INTEGER NOT NULL CHECK (show_options_on_screen IN (0, 1)),
      position INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO questions_new SELECT * FROM questions;
    DROP TABLE questions;
    ALTER TABLE questions_new RENAME TO questions;
    CREATE INDEX questions_round_position ON questions(round_id, position);`,
  },
  {
    version: 17,
    sql: `CREATE TABLE player_answers_new (
      session_id TEXT NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
      player_id TEXT NOT NULL REFERENCES session_players(id) ON DELETE CASCADE,
      question_id TEXT NOT NULL,
      option_ids_json TEXT NOT NULL CHECK (json_valid(option_ids_json) AND json_type(option_ids_json) = 'array' AND json_array_length(option_ids_json) BETWEEN 1 AND 10),
      submitted_at TEXT NOT NULL,
      PRIMARY KEY (session_id, question_id, player_id)
    );
    INSERT INTO player_answers_new SELECT session_id, player_id, question_id, json_array(option_id), submitted_at FROM player_answers;
    DROP TABLE player_answers;
    ALTER TABLE player_answers_new RENAME TO player_answers;`,
  },
  {
    version: 18,
    rebuildForeignKeys: true,
    sql: `CREATE TABLE questions_new (
      id TEXT PRIMARY KEY,
      round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('single_choice', 'yes_no', 'multiple_choice', 'matching')),
      text_ru TEXT NOT NULL, text_en TEXT NOT NULL,
      points INTEGER NOT NULL CHECK (points > 0),
      answer_time_seconds INTEGER CHECK (answer_time_seconds IS NULL OR answer_time_seconds BETWEEN 1 AND 3600),
      show_options_on_screen INTEGER NOT NULL CHECK (show_options_on_screen IN (0, 1)),
      position INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO questions_new SELECT * FROM questions;
    DROP TABLE questions;
    ALTER TABLE questions_new RENAME TO questions;
    CREATE INDEX questions_round_position ON questions(round_id, position);
    CREATE TABLE matching_pairs (
      id TEXT PRIMARY KEY,
      question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      left_json TEXT NOT NULL CHECK (json_valid(left_json)),
      right_json TEXT NOT NULL CHECK (json_valid(right_json)),
      position INTEGER NOT NULL CHECK (position >= 0),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX matching_pairs_question_position ON matching_pairs(question_id, position);`,
  },
  {
    version: 19,
    sql: `CREATE TABLE player_answers_new (
      session_id TEXT NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
      player_id TEXT NOT NULL REFERENCES session_players(id) ON DELETE CASCADE,
      question_id TEXT NOT NULL,
      answer_json TEXT NOT NULL CHECK (json_valid(answer_json) AND json_type(answer_json) = 'object' AND coalesce(json_extract(answer_json, '$.kind') IN ('options', 'matching'), 0)),
      submitted_at TEXT NOT NULL,
      PRIMARY KEY (session_id, question_id, player_id)
    );
    INSERT INTO player_answers_new SELECT session_id, player_id, question_id,
      json_object('kind', 'options', 'optionIds', json(option_ids_json)), submitted_at FROM player_answers;
    DROP TABLE player_answers;
    ALTER TABLE player_answers_new RENAME TO player_answers;`,
  },
  {
    version: 20,
    sql: `ALTER TABLE questions ADD COLUMN show_correct_count INTEGER NOT NULL DEFAULT 1 CHECK (show_correct_count IN (0, 1));`,
  },
  { version: 21, sql: `CREATE TABLE media (
    id TEXT PRIMARY KEY,
    quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('image', 'audio', 'video')),
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
    created_at TEXT NOT NULL
  );
  CREATE INDEX media_quiz ON media(quiz_id);
  ALTER TABLE questions ADD COLUMN media_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(media_json));` },
  { version: 22, sql: `CREATE TABLE media_playback (
    session_id TEXT NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL,
    media_id TEXT NOT NULL,
    playing INTEGER NOT NULL CHECK (playing IN (0, 1)),
    position_seconds REAL NOT NULL CHECK (position_seconds >= 0),
    updated_at INTEGER NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    PRIMARY KEY (session_id, question_id, media_id)
  );` },
  { version: 23, rebuildForeignKeys: true, sql: `CREATE TABLE game_sessions_new (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL CHECK (length(code) = 5 AND code NOT GLOB '*[^ABCDEFGHJKMNPQRSTUVWXYZ23456789]*'),
      quiz_id TEXT REFERENCES quizzes(id) ON DELETE SET NULL,
      state TEXT NOT NULL CHECK (state IN ('LOBBY', 'ROUND_INTRO', 'QUESTION', 'ANSWERING', 'ANSWER_REVEAL', 'ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS', 'WINNER_SCREEN', 'PAUSED')),
      created_at TEXT NOT NULL,
      closed_at TEXT,
      snapshot_json TEXT CHECK (snapshot_json IS NULL OR json_valid(snapshot_json)),
      roster_locked_at TEXT,
      current_round_index INTEGER CHECK (current_round_index IS NULL OR (typeof(current_round_index) = 'integer' AND current_round_index >= 0)),
      current_question_index INTEGER CHECK (current_question_index IS NULL OR (typeof(current_question_index) = 'integer' AND current_question_index >= 0)),
      answer_started_at TEXT,
      answer_deadline_at TEXT,
      paused_from_state TEXT,
      paused_at TEXT,
      paused_remaining_ms INTEGER,
      pause_reason TEXT,
      paused_player_id TEXT,
      CHECK ((state = 'PAUSED' AND pause_reason IS NOT NULL
        AND ((pause_reason = 'manual' AND paused_player_id IS NULL)
          OR (pause_reason = 'player_disconnect' AND paused_player_id IS NOT NULL AND paused_from_state IN ('QUESTION', 'ANSWERING'))))
        OR (state <> 'PAUSED' AND pause_reason IS NULL AND paused_player_id IS NULL)),
      CHECK ((state = 'PAUSED' AND paused_from_state IS NOT NULL
        AND paused_from_state IN ('ROUND_INTRO', 'QUESTION', 'ANSWERING', 'ANSWER_REVEAL', 'ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS')
        AND paused_at IS NOT NULL AND julianday(paused_at) IS NOT NULL AND substr(paused_at, -1) = 'Z'
        AND ((paused_from_state = 'ANSWERING' AND paused_remaining_ms IS NOT NULL
          AND typeof(paused_remaining_ms) = 'integer' AND paused_remaining_ms > 0)
          OR (paused_from_state <> 'ANSWERING' AND paused_remaining_ms IS NULL)))
        OR (state <> 'PAUSED' AND paused_from_state IS NULL AND paused_at IS NULL AND paused_remaining_ms IS NULL)),
      CHECK (((state IN ('ANSWERING', 'ANSWER_REVEAL') OR (state = 'PAUSED' AND paused_from_state = 'ANSWER_REVEAL')) AND answer_started_at IS NOT NULL AND answer_deadline_at IS NOT NULL
        AND julianday(answer_started_at) IS NOT NULL AND julianday(answer_deadline_at) IS NOT NULL
        AND substr(answer_started_at, -1) = 'Z' AND substr(answer_deadline_at, -1) = 'Z'
        AND julianday(answer_deadline_at) > julianday(answer_started_at))
        OR ((state = 'ANSWER_REVEAL' OR (state = 'PAUSED' AND paused_from_state = 'ANSWER_REVEAL')) AND answer_started_at IS NULL AND answer_deadline_at IS NULL)
        OR (NOT (state IN ('ANSWERING', 'ANSWER_REVEAL') OR (state = 'PAUSED' AND paused_from_state = 'ANSWER_REVEAL')) AND answer_started_at IS NULL AND answer_deadline_at IS NULL)),
      CHECK ((state = 'LOBBY' AND current_round_index IS NULL AND current_question_index IS NULL)
        OR ((state = 'ROUND_INTRO' OR (state = 'PAUSED' AND paused_from_state = 'ROUND_INTRO')) AND current_round_index IS NOT NULL AND current_question_index IS NULL)
        OR ((CASE WHEN state = 'PAUSED' THEN paused_from_state ELSE state END) IN ('QUESTION', 'ANSWERING', 'ANSWER_REVEAL', 'ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS', 'WINNER_SCREEN') AND current_round_index IS NOT NULL AND current_question_index IS NOT NULL)),
      CHECK ((state = 'LOBBY' AND quiz_id IS NOT NULL AND snapshot_json IS NULL AND roster_locked_at IS NULL)
        OR (state IN ('ROUND_INTRO', 'QUESTION', 'ANSWERING', 'ANSWER_REVEAL', 'ROUND_END', 'LEADERBOARD', 'FINAL_RESULTS', 'WINNER_SCREEN', 'PAUSED') AND snapshot_json IS NOT NULL AND roster_locked_at IS NOT NULL))
    );
    INSERT INTO game_sessions_new SELECT * FROM game_sessions;
    DROP TRIGGER delete_quiz_lobbies;
    DROP TABLE game_sessions;
    ALTER TABLE game_sessions_new RENAME TO game_sessions;
    CREATE UNIQUE INDEX game_sessions_active_code ON game_sessions(code) WHERE closed_at IS NULL;
    CREATE TRIGGER delete_quiz_lobbies BEFORE DELETE ON quizzes BEGIN
      DELETE FROM game_sessions WHERE quiz_id = OLD.id AND state = 'LOBBY';
    END;
    ALTER TABLE game_sessions ADD COLUMN pre_timer_media_id TEXT;
    ALTER TABLE media_playback ADD COLUMN resume_on_game_resume INTEGER NOT NULL DEFAULT 0 CHECK (resume_on_game_resume IN (0, 1));` },
  { version: 24, sql: `ALTER TABLE game_sessions ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1));` },
  { version: 25, sql: `CREATE TABLE game_history (
    session_id TEXT PRIMARY KEY REFERENCES game_sessions(id) ON DELETE CASCADE,
    quiz_id TEXT,
    quiz_title TEXT NOT NULL,
    completed_at TEXT CHECK (completed_at IS NULL OR (julianday(completed_at) IS NOT NULL AND substr(completed_at, -1) = 'Z')),
    players_json TEXT CHECK (players_json IS NULL OR (json_valid(players_json) AND json_type(players_json) = 'array')),
    CHECK ((completed_at IS NULL AND players_json IS NULL) OR (completed_at IS NOT NULL AND players_json IS NOT NULL))
  );
  CREATE INDEX game_history_completed ON game_history(completed_at DESC) WHERE completed_at IS NOT NULL;
  INSERT INTO game_history (session_id, quiz_id, quiz_title)
    SELECT id, quiz_id, json_extract(snapshot_json, '$.title') FROM game_sessions
    WHERE snapshot_json IS NOT NULL AND json_type(snapshot_json, '$.title') = 'text';` },
  { version: 26, sql: `ALTER TABLE questions ADD COLUMN explanation_ru TEXT NOT NULL DEFAULT '';
    ALTER TABLE questions ADD COLUMN explanation_en TEXT NOT NULL DEFAULT '';
    ALTER TABLE rounds ADD COLUMN art_media_id TEXT;` },
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
