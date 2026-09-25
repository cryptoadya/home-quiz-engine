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
      const migration = db.prepare('SELECT version FROM schema_migrations').all();
      assert.deepEqual(migration.map((row) => row.version), [1]);
      db.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
