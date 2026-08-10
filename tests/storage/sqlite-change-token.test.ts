import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { SqliteChangeTokenReader } from '../../src/storage/sqlite-change-token.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('SqliteChangeTokenReader', () => {
  it('detects writes from both the owning and an external connection', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sqlite-change-token-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'state.sqlite');
    const owner = new Database(path);
    const external = new Database(path);
    try {
      owner.exec(
        'PRAGMA journal_mode = WAL; CREATE TABLE events (id INTEGER PRIMARY KEY)',
      );
      const reader = new SqliteChangeTokenReader(owner);
      const initial = reader.read();

      owner.prepare('INSERT INTO events DEFAULT VALUES').run();
      const afterOwnedWrite = reader.read();
      expect(afterOwnedWrite).not.toBe(initial);

      external.prepare('INSERT INTO events DEFAULT VALUES').run();
      expect(reader.read()).not.toBe(afterOwnedWrite);
    } finally {
      external.close();
      owner.close();
    }
  });
});
