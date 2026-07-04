/*
 * In-memory SQLite test harness for the real Kysely schema/migrations.
 * Hermetic: no network, no file on disk, no mysql2 pool — `:memory:` only.
 */

import BetterSqlite3 from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import type { Database } from '../../src/db/schema.js';
import { migrateToLatest } from '../../src/db/migrations.js';
import { SqliteCompatPlugin } from './sqliteCompatPlugin.js';

export interface TestDb {
  db: Kysely<Database>;
  destroy: () => Promise<void>;
}

/** fresh in-memory DB, migrated to latest via the real migrateToLatest(). */
export async function createTestDb(): Promise<TestDb> {
  const sqlite = new BetterSqlite3(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = new Kysely<Database>({
    dialect: new SqliteDialect({ database: sqlite }),
    plugins: [new SqliteCompatPlugin()],
  });
  await migrateToLatest(db);
  return {
    db,
    destroy: async () => {
      await db.destroy();
    },
  };
}
