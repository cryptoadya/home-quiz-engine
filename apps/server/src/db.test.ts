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
      db.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
