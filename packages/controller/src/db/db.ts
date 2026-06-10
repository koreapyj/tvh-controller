/*
 * tvh-controller - Centralized tvheadend controller
 * Copyright (C) 2026 Yoonji Park
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { Kysely, MysqlDialect, type MysqlPool } from 'kysely';
import { createPool } from 'mysql2';
import type { Database } from './schema.js';
import { migrateToLatest } from './migrations.js';

export type Db = Kysely<Database>;

export function createDb(databaseUrl: string): Db {
  const dialect = new MysqlDialect({
    // mysql2's callback Pool satisfies Kysely's MysqlPool at runtime; the
    // published typings drift between versions, hence the cast
    pool: createPool({ uri: databaseUrl, connectionLimit: 5, timezone: 'Z' }) as unknown as MysqlPool,
  });
  return new Kysely<Database>({ dialect });
}

export async function initDb(databaseUrl: string): Promise<Db> {
  const db = createDb(databaseUrl);
  await migrateToLatest(db);
  return db;
}
