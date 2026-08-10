import type Database from 'better-sqlite3';

interface SqliteChangeTokenRow {
  readonly local_changes: number;
  readonly external_data_version: number;
}

/**
 * Cheap, opaque change detection for a long-lived SQLite connection.
 *
 * SQLite's total_changes() covers writes made through the owning connection,
 * while PRAGMA data_version changes after commits from other connections.
 * The combination is only a scheduling hint: callers must still perform an
 * initial read and honor any time-based wake-up deadline their domain needs.
 */
export class SqliteChangeTokenReader {
  readonly #statement: Database.Statement<[], SqliteChangeTokenRow>;

  constructor(database: Database.Database) {
    this.#statement = database.prepare<[], SqliteChangeTokenRow>(
      `SELECT total_changes() AS local_changes,
              data_version AS external_data_version
         FROM pragma_data_version`,
    );
  }

  read(): string {
    const row = this.#statement.get();
    if (
      row === undefined ||
      !Number.isSafeInteger(row.local_changes) ||
      row.local_changes < 0 ||
      !Number.isSafeInteger(row.external_data_version) ||
      row.external_data_version < 1
    ) {
      throw new Error('SQLite returned an invalid change token');
    }
    return `${String(row.local_changes)}:${String(row.external_data_version)}`;
  }
}
