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

import { Kysely, Migrator, sql, type Migration, type MigrationProvider } from 'kysely';

const migrations: Record<string, Migration> = {
  '001_initial': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .createTable('master_rules')
        .addColumn('id', 'varchar(36)', (c) => c.primaryKey())
        .addColumn('name', 'varchar(255)', (c) => c.notNull().unique())
        .addColumn('payload', 'json', (c) => c.notNull())
        .addColumn('enabled', 'boolean', (c) => c.notNull().defaultTo(1))
        .addColumn('updated_at', 'timestamp', (c) =>
          c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
        )
        .execute();

      await db.schema
        .createTable('rule_bindings')
        .addColumn('master_rule_id', 'varchar(36)', (c) =>
          c.notNull().references('master_rules.id').onDelete('cascade'),
        )
        .addColumn('instance_id', 'varchar(64)', (c) => c.notNull())
        .addColumn('tvh_uuid', 'varchar(36)', (c) => c.notNull())
        .addColumn('master_hash', 'varchar(64)', (c) => c.notNull())
        .addColumn('pushed_hash', 'varchar(64)', (c) => c.notNull())
        .addColumn('pushed_at', 'timestamp', (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
        .addPrimaryKeyConstraint('pk_rule_bindings', ['master_rule_id', 'instance_id'])
        .addUniqueConstraint('uq_bindings_instance_uuid', ['instance_id', 'tvh_uuid'])
        .execute();

      await db.schema
        .createTable('uploads')
        .addColumn('id', 'varchar(36)', (c) => c.primaryKey())
        .addColumn('instance_id', 'varchar(64)', (c) => c.notNull())
        .addColumn('dvr_uuid', 'varchar(36)', (c) => c.notNull())
        .addColumn('title', 'varchar(512)')
        .addColumn('channelname', 'varchar(255)', (c) => c.notNull())
        .addColumn('start', 'bigint', (c) => c.notNull())
        .addColumn('stop', 'bigint', (c) => c.notNull())
        .addColumn('filesize', 'bigint')
        .addColumn('local_path', 'varchar(1024)', (c) => c.notNull())
        .addColumn('remote_path', 'varchar(1024)', (c) => c.notNull())
        .addColumn('status', 'varchar(16)', (c) => c.notNull())
        .addColumn('progress', 'bigint', (c) => c.notNull().defaultTo(0))
        .addColumn('rclone_job_id', 'integer')
        .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('error', 'text')
        .addColumn('possible_duplicate', 'boolean', (c) => c.notNull().defaultTo(0))
        .addColumn('created_at', 'timestamp', (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
        .addColumn('updated_at', 'timestamp', (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
        .addColumn('completed_at', 'timestamp')
        .execute();

      await db.schema
        .createIndex('idx_uploads_channel_start')
        .on('uploads')
        .columns(['channelname', 'start'])
        .execute();
      await db.schema.createIndex('idx_uploads_status').on('uploads').column('status').execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('uploads').execute();
      await db.schema.dropTable('rule_bindings').execute();
      await db.schema.dropTable('master_rules').execute();
    },
  },
};

migrations['002_ignored_orphans'] = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable('ignored_orphans')
      .addColumn('instance_id', 'varchar(64)', (c) => c.notNull())
      .addColumn('tvh_uuid', 'varchar(36)', (c) => c.notNull())
      .addColumn('name', 'varchar(255)', (c) => c.notNull())
      .addColumn('ignored_at', 'timestamp', (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addPrimaryKeyConstraint('pk_ignored_orphans', ['instance_id', 'tvh_uuid'])
      .execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('ignored_orphans').execute();
  },
};

migrations['003_linked_clones'] = {
  async up(db: Kysely<unknown>): Promise<void> {
    // linked clones (parent + sparse overlay) and per-rule instance scoping;
    // referential integrity is enforced at the application layer
    await db.schema
      .alterTable('master_rules')
      .addColumn('parent_id', 'varchar(36)')
      .execute();
    await db.schema.alterTable('master_rules').addColumn('overlay', 'json').execute();
    // NULL = 'all' (tracks later-added instances automatically)
    await db.schema.alterTable('master_rules').addColumn('instances', 'json').execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable('master_rules').dropColumn('instances').execute();
    await db.schema.alterTable('master_rules').dropColumn('overlay').execute();
    await db.schema.alterTable('master_rules').dropColumn('parent_id').execute();
  },
};

migrations['004_soft_delete_rules'] = {
  async up(db: Kysely<unknown>): Promise<void> {
    // deleting a rule removes it from the instances but only marks the
    // master row, so it can be restored from the Deleted tab
    await db.schema.alterTable('master_rules').addColumn('deleted_at', 'timestamp').execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable('master_rules').dropColumn('deleted_at').execute();
  },
};

const provider: MigrationProvider = {
  async getMigrations() {
    return migrations;
  },
};

export async function migrateToLatest<T>(db: Kysely<T>): Promise<void> {
  const migrator = new Migrator({ db: db as Kysely<unknown>, provider });
  const { error, results } = await migrator.migrateToLatest();
  if (error) {
    const failed = results?.find((r) => r.status === 'Error');
    throw new Error(`migration ${failed?.migrationName ?? ''} failed: ${String(error)}`);
  }
}
