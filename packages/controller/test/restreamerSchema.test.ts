/*
 * Migration 008_restreamer smoke test: every new table accepts an insert and
 * reads back, and the declared FKs behave (placements/playlist members
 * cascade, profiles referenced by channels restrict). Hermetic — in-memory
 * SQLite via createTestDb().
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { Kysely, SqliteDialect, sql } from 'kysely';
import type { Database } from '../src/db/schema.js';
import { migrateTo, migrateToLatest, runMigrationUp } from '../src/db/migrations.js';
import { SqliteCompatPlugin } from './support/sqliteCompatPlugin.js';
import { createTestDb, type TestDb } from './support/testDb.js';

const NOW = '2026-07-06 00:00:00';

describe('migration 008_restreamer', () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await createTestDb();
  });

  afterEach(async () => {
    await t.destroy();
  });

  async function seed() {
    await t.db
      .insertInto('restream_profiles')
      .values({
        id: 'prof-1',
        name: 'default-3M',
        payload: JSON.stringify({ template: 'arib-hls', templateVersion: 1 }),
        updated_at: NOW,
      })
      .execute();
    await t.db
      .insertInto('restream_channels')
      .values({
        id: 'chan-1',
        slug: 'at-x',
        channel_name: 'AT-X',
        channel_number: '9.1',
        profile_id: 'prof-1',
        enabled: 1,
        comment: null,
        updated_at: NOW,
      })
      .execute();
    await t.db
      .insertInto('restream_placements')
      .values({
        id: 'plc-1',
        channel_id: 'chan-1',
        instance_id: 'tyo1',
        node_id: 'node1',
        priority: 0,
        enabled: 1,
        profile_id: null,
        program_number: null,
        updated_at: NOW,
      })
      .execute();
    await t.db
      .insertInto('restream_playlists')
      .values({ id: 'pl-1', slug: 'anime', title: 'Anime', updated_at: NOW })
      .execute();
    await t.db
      .insertInto('restream_playlist_members')
      .values({ playlist_id: 'pl-1', channel_id: 'chan-1' })
      .execute();
    await t.db
      .insertInto('restream_node_state')
      .values({ instance_id: 'tyo1', node_id: 'node1', pushed_hash: 'abc', pushed_at: NOW })
      .execute();
  }

  it('inserts and reads back one row per table', async () => {
    await seed();

    const profile = await t.db
      .selectFrom('restream_profiles')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(profile.name).toBe('default-3M');
    expect(JSON.parse(profile.payload)).toEqual({ template: 'arib-hls', templateVersion: 1 });
    expect(profile.updated_at).toBeInstanceOf(Date);

    const channel = await t.db
      .selectFrom('restream_channels')
      .selectAll()
      .executeTakeFirstOrThrow();
    // channel number is a STRING identity, exactly as stored
    expect(channel.channel_number).toBe('9.1');
    expect(channel.profile_id).toBe('prof-1');
    expect(channel.enabled).toBe(1);

    const placement = await t.db
      .selectFrom('restream_placements')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(placement).toMatchObject({
      channel_id: 'chan-1',
      instance_id: 'tyo1',
      node_id: 'node1',
      priority: 0,
      profile_id: null,
      program_number: null,
    });

    const playlist = await t.db
      .selectFrom('restream_playlists')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(playlist).toMatchObject({ slug: 'anime', title: 'Anime' });
    expect(playlist).not.toHaveProperty('epg_url');

    const member = await t.db
      .selectFrom('restream_playlist_members')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(member).toEqual({ playlist_id: 'pl-1', channel_id: 'chan-1' });

    const nodeState = await t.db
      .selectFrom('restream_node_state')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(nodeState.pushed_hash).toBe('abc');
    expect(nodeState.pushed_at).toBeInstanceOf(Date);
  });

  it('cascades channel deletion to placements and playlist members', async () => {
    await seed();
    await t.db.deleteFrom('restream_channels').where('id', '=', 'chan-1').execute();
    expect(await t.db.selectFrom('restream_placements').selectAll().execute()).toHaveLength(0);
    expect(
      await t.db.selectFrom('restream_playlist_members').selectAll().execute(),
    ).toHaveLength(0);
    // playlist itself survives
    expect(await t.db.selectFrom('restream_playlists').selectAll().execute()).toHaveLength(1);
  });

  it('restricts deleting a profile still referenced by a channel', async () => {
    await seed();
    await expect(
      t.db.deleteFrom('restream_profiles').where('id', '=', 'prof-1').execute(),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  describe('010_drop_external_source_columns', () => {
    it('a plain channel row no longer carries source_type/source_key', async () => {
      await seed();
      const channel = await t.db
        .selectFrom('restream_channels')
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(channel).not.toHaveProperty('source_type');
      expect(channel).not.toHaveProperty('source_key');
    });

    it('inserting a channel row works with just (channel_name, channel_number)', async () => {
      await seed();
      await t.db
        .insertInto('restream_channels')
        .values({
          id: 'chan-2',
          slug: 'bs11',
          channel_name: 'BS11',
          channel_number: '11',
          profile_id: 'prof-1',
          enabled: 1,
          comment: null,
          updated_at: NOW,
        })
        .execute();
      const row = await t.db
        .selectFrom('restream_channels')
        .selectAll()
        .where('id', '=', 'chan-2')
        .executeTakeFirstOrThrow();
      expect(row).toMatchObject({ channel_name: 'BS11', channel_number: '11' });
    });
  });

  describe('012_cold_backup_placements', () => {
    it('a pre-existing placement row reads back mode "hot" by default', async () => {
      await seed();
      const placement = await t.db
        .selectFrom('restream_placements')
        .selectAll()
        .where('id', '=', 'plc-1')
        .executeTakeFirstOrThrow();
      expect(placement.mode).toBe('hot');
    });
  });

  describe('014_failover_state', () => {
    /** a second placement to serve as the "to" target (plc-1 from seed() is "from") */
    async function seedSecondPlacement(): Promise<string> {
      const id = 'plc-2';
      await t.db
        .insertInto('restream_placements')
        .values({
          id,
          channel_id: 'chan-1',
          instance_id: 'tyo1',
          node_id: 'node2',
          priority: 1,
          enabled: 1,
          profile_id: null,
          program_number: null,
          updated_at: NOW,
        })
        .execute();
      return id;
    }

    async function seedRow(toId: string): Promise<void> {
      await t.db
        .insertInto('restream_failover_state')
        .values({
          channel_id: 'chan-1',
          from_placement_id: 'plc-1',
          to_placement_id: toId,
          phase: 'complete',
          trigger_reason: 'manual',
          trigger_node_id: null,
          trigger_detail: null,
          suppress_from: 0,
          drain_until: null,
          started_at: NOW,
          updated_at: NOW,
        })
        .execute();
    }

    it('inserts and reads back a row, including drain_until null', async () => {
      await seed();
      const toId = await seedSecondPlacement();
      await seedRow(toId);
      const row = await t.db.selectFrom('restream_failover_state').selectAll().executeTakeFirstOrThrow();
      expect(row).toMatchObject({
        channel_id: 'chan-1',
        from_placement_id: 'plc-1',
        to_placement_id: toId,
        phase: 'complete',
        trigger_reason: 'manual',
        trigger_node_id: null,
        trigger_detail: null,
        suppress_from: 0,
      });
      expect(row.drain_until).toBeNull();
      expect(row.started_at).toBeInstanceOf(Date);
      expect(row.updated_at).toBeInstanceOf(Date);
    });

    it('cascades on channel delete', async () => {
      await seed();
      const toId = await seedSecondPlacement();
      await seedRow(toId);
      await t.db.deleteFrom('restream_channels').where('id', '=', 'chan-1').execute();
      expect(await t.db.selectFrom('restream_failover_state').selectAll().execute()).toHaveLength(0);
    });

    it('cascades on to_placement delete', async () => {
      await seed();
      const toId = await seedSecondPlacement();
      await seedRow(toId);
      await t.db.deleteFrom('restream_placements').where('id', '=', toId).execute();
      expect(await t.db.selectFrom('restream_failover_state').selectAll().execute()).toHaveLength(0);
      // the channel and its other placement survive
      expect(await t.db.selectFrom('restream_channels').selectAll().execute()).toHaveLength(1);
    });

    it('nulls from_placement_id on from_placement delete (row itself survives)', async () => {
      await seed();
      const toId = await seedSecondPlacement();
      await seedRow(toId);
      await t.db.deleteFrom('restream_placements').where('id', '=', 'plc-1').execute();
      const row = await t.db.selectFrom('restream_failover_state').selectAll().executeTakeFirstOrThrow();
      expect(row.from_placement_id).toBeNull();
      expect(row.to_placement_id).toBe(toId);
    });
  });

  describe('013_probe_settings (015_drop_underrun already dropped the underrun_* columns)', () => {
    function probeRow(overrides: Partial<Record<string, unknown>> = {}) {
      return {
        instance_id: 'tyo1',
        node_id: 'node1',
        liveness_timeout_seconds: 5,
        liveness_period_seconds: 10,
        liveness_success_threshold: 2,
        liveness_failure_threshold: 3,
        underspeed_timeout_seconds: 20,
        underspeed_period_seconds: 45,
        underspeed_success_threshold: 2,
        underspeed_failure_threshold: 3,
        lag_timeout_seconds: 30,
        lag_period_seconds: 10,
        lag_success_threshold: 3,
        lag_failure_threshold: 3,
        updated_at: NOW,
        ...overrides,
      };
    }

    it('inserts and reads back a row', async () => {
      await t.db.insertInto('restream_node_probes').values(probeRow()).execute();
      const row = await t.db.selectFrom('restream_node_probes').selectAll().executeTakeFirstOrThrow();
      expect(row).toMatchObject({
        instance_id: 'tyo1',
        node_id: 'node1',
        liveness_timeout_seconds: 5,
      });
      expect(row.updated_at).toBeInstanceOf(Date);
    });

    it('PK (instance_id, node_id) upsert via onDuplicateKeyUpdate works under the sqlite compat plugin', async () => {
      const row = probeRow();
      await t.db
        .insertInto('restream_node_probes')
        .values(row)
        .onDuplicateKeyUpdate(row)
        .execute();
      const changed = probeRow({ liveness_timeout_seconds: 9 });
      await t.db
        .insertInto('restream_node_probes')
        .values(changed)
        .onDuplicateKeyUpdate(changed)
        .execute();
      const rows = await t.db.selectFrom('restream_node_probes').selectAll().execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.liveness_timeout_seconds).toBe(9);
    });
  });

  describe('migration carry-over: restream_cold_activations -> restream_failover_state', () => {
    it('migrating stepwise to 013 then to latest carries a cold activation row forward and drops the old table', async () => {
      const sqlite = new BetterSqlite3(':memory:');
      sqlite.pragma('foreign_keys = ON');
      const db = new Kysely<Database>({
        dialect: new SqliteDialect({ database: sqlite }),
        plugins: [new SqliteCompatPlugin()],
      });
      try {
        await migrateTo(db, '013_probe_settings');

        await db
          .insertInto('restream_profiles')
          .values({ id: 'prof-1', name: 'p', payload: '{}', updated_at: NOW })
          .execute();
        await db
          .insertInto('restream_channels')
          .values({
            id: 'chan-1',
            slug: 'at-x',
            channel_name: 'AT-X',
            channel_number: '9.1',
            profile_id: 'prof-1',
            enabled: 1,
            comment: null,
            updated_at: NOW,
          })
          .execute();
        // 013-era placements row shape: `weight` still exists, `profile_id`
        // is not added until 017 (the migrateToLatest below runs it)
        interface OldPlacementRow013 {
          id: string;
          channel_id: string;
          instance_id: string;
          node_id: string;
          priority: number;
          enabled: number;
          weight: number | null;
          program_number: number | null;
          mode: string;
          updated_at: string;
        }
        const oldPlacementsDb = db as unknown as Kysely<{ restream_placements: OldPlacementRow013 }>;
        await oldPlacementsDb
          .insertInto('restream_placements')
          .values({
            id: 'hot-1',
            channel_id: 'chan-1',
            instance_id: 'tyo1',
            node_id: 'hot',
            priority: 1,
            enabled: 1,
            weight: null,
            program_number: null,
            mode: 'hot',
            updated_at: NOW,
          })
          .execute();
        await oldPlacementsDb
          .insertInto('restream_placements')
          .values({
            id: 'cold-1',
            channel_id: 'chan-1',
            instance_id: 'tyo1',
            node_id: 'cold',
            priority: 2,
            enabled: 1,
            weight: null,
            program_number: null,
            mode: 'cold',
            updated_at: NOW,
          })
          .execute();

        // restream_cold_activations exists at 013 but is not in the current
        // Database type — the migration-under-test's own down()/up() casts
        // through Kysely<unknown> the same way; mirror that here.
        interface OldColdRow {
          channel_id: string;
          placement_id: string;
          preferred_placement_id: string | null;
          reason: string;
          activated_at: string;
          updated_at: string;
        }
        const oldDb = db as unknown as Kysely<{ restream_cold_activations: OldColdRow }>;
        await oldDb
          .insertInto('restream_cold_activations')
          .values({
            channel_id: 'chan-1',
            placement_id: 'cold-1',
            preferred_placement_id: 'hot-1',
            reason: 'delivery-slow',
            activated_at: NOW,
            updated_at: NOW,
          })
          .execute();

        await migrateToLatest(db);

        const rows = await db.selectFrom('restream_failover_state').selectAll().execute();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          channel_id: 'chan-1',
          from_placement_id: 'hot-1',
          to_placement_id: 'cold-1',
          phase: 'complete',
          suppress_from: 0,
          trigger_reason: 'underspeed',
        });

        await expect(
          oldDb.selectFrom('restream_cold_activations').selectAll().execute(),
        ).rejects.toThrow(/no such table/i);
      } finally {
        await db.destroy();
      }
    });
  });

  describe('015_drop_underrun', () => {
    it('after migrateToLatest, a row inserted without underrun_* columns succeeds and reads back none of them', async () => {
      await t.db
        .insertInto('restream_node_probes')
        .values({
          instance_id: 'tyo1',
          node_id: 'node1',
          liveness_timeout_seconds: 5,
          liveness_period_seconds: 10,
          liveness_success_threshold: 2,
          liveness_failure_threshold: 3,
          underspeed_timeout_seconds: 20,
          underspeed_period_seconds: 45,
          underspeed_success_threshold: 2,
          underspeed_failure_threshold: 3,
          lag_timeout_seconds: 30,
          lag_period_seconds: 10,
          lag_success_threshold: 3,
          lag_failure_threshold: 3,
          updated_at: NOW,
        })
        .execute();
      const row = await t.db.selectFrom('restream_node_probes').selectAll().executeTakeFirstOrThrow();
      expect(row).not.toHaveProperty('underrun_min_speed');
      expect(row).not.toHaveProperty('underrun_period_seconds');
      expect(row).not.toHaveProperty('underrun_success_threshold');
      expect(row).not.toHaveProperty('underrun_failure_threshold');
    });

    it('migrating stepwise to 013 (with underrun_* columns) then to latest drops them while preserving the rest', async () => {
      const sqlite = new BetterSqlite3(':memory:');
      sqlite.pragma('foreign_keys = ON');
      const db = new Kysely<Database>({
        dialect: new SqliteDialect({ database: sqlite }),
        plugins: [new SqliteCompatPlugin()],
      });
      try {
        await migrateTo(db, '013_probe_settings');

        // 013-era row shape: underrun_* columns still exist at this point
        interface OldProbeRow {
          instance_id: string;
          node_id: string;
          liveness_timeout_seconds: number;
          liveness_period_seconds: number;
          liveness_success_threshold: number;
          liveness_failure_threshold: number;
          underspeed_timeout_seconds: number;
          underspeed_period_seconds: number;
          underspeed_success_threshold: number;
          underspeed_failure_threshold: number;
          lag_timeout_seconds: number;
          lag_period_seconds: number;
          lag_success_threshold: number;
          lag_failure_threshold: number;
          underrun_min_speed: number;
          underrun_period_seconds: number;
          underrun_success_threshold: number;
          underrun_failure_threshold: number;
          updated_at: string;
        }
        const oldDb = db as unknown as Kysely<{ restream_node_probes: OldProbeRow }>;
        await oldDb
          .insertInto('restream_node_probes')
          .values({
            instance_id: 'tyo1',
            node_id: 'node1',
            liveness_timeout_seconds: 9,
            liveness_period_seconds: 11,
            liveness_success_threshold: 2,
            liveness_failure_threshold: 3,
            underspeed_timeout_seconds: 20,
            underspeed_period_seconds: 45,
            underspeed_success_threshold: 2,
            underspeed_failure_threshold: 3,
            lag_timeout_seconds: 30,
            lag_period_seconds: 10,
            lag_success_threshold: 3,
            lag_failure_threshold: 3,
            underrun_min_speed: 0.98,
            underrun_period_seconds: 15,
            underrun_success_threshold: 2,
            underrun_failure_threshold: 3,
            updated_at: NOW,
          })
          .execute();

        await migrateToLatest(db);

        const rows = await db.selectFrom('restream_node_probes').selectAll().execute();
        expect(rows).toHaveLength(1);
        // the pre-existing columns survive with their seeded values
        expect(rows[0]).toMatchObject({
          instance_id: 'tyo1',
          node_id: 'node1',
          liveness_timeout_seconds: 9,
          liveness_period_seconds: 11,
          underspeed_timeout_seconds: 20,
          lag_timeout_seconds: 30,
        });
        expect(rows[0]).not.toHaveProperty('underrun_min_speed');
        expect(rows[0]).not.toHaveProperty('underrun_period_seconds');
        expect(rows[0]).not.toHaveProperty('underrun_success_threshold');
        expect(rows[0]).not.toHaveProperty('underrun_failure_threshold');
      } finally {
        await db.destroy();
      }
    });
  });

  describe('017_placement_profile_drop_weight', () => {
    it('a placement row with a non-null profile_id round-trips', async () => {
      await seed();
      await t.db
        .insertInto('restream_profiles')
        .values({
          id: 'prof-2',
          name: 'override-profile',
          payload: JSON.stringify({ template: 'arib-hls', templateVersion: 1 }),
          updated_at: NOW,
        })
        .execute();
      await t.db
        .updateTable('restream_placements')
        .set({ profile_id: 'prof-2' })
        .where('id', '=', 'plc-1')
        .execute();
      const row = await t.db
        .selectFrom('restream_placements')
        .selectAll()
        .where('id', '=', 'plc-1')
        .executeTakeFirstOrThrow();
      expect(row.profile_id).toBe('prof-2');
      expect(row).not.toHaveProperty('weight');
    });

    it('a plain placement row no longer carries the weight column', async () => {
      await seed();
      const row = await t.db
        .selectFrom('restream_placements')
        .selectAll()
        .where('id', '=', 'plc-1')
        .executeTakeFirstOrThrow();
      expect(row).not.toHaveProperty('weight');
      expect(row).toHaveProperty('profile_id');
      expect(row.profile_id).toBeNull();
    });

    it('migrating stepwise to 013 (weight, no profile_id) then to latest converts the column', async () => {
      const sqlite = new BetterSqlite3(':memory:');
      sqlite.pragma('foreign_keys = ON');
      const db = new Kysely<Database>({
        dialect: new SqliteDialect({ database: sqlite }),
        plugins: [new SqliteCompatPlugin()],
      });
      try {
        await migrateTo(db, '013_probe_settings');

        await db
          .insertInto('restream_profiles')
          .values({ id: 'prof-1', name: 'p', payload: '{}', updated_at: NOW })
          .execute();
        await db
          .insertInto('restream_channels')
          .values({
            id: 'chan-1',
            slug: 'at-x',
            channel_name: 'AT-X',
            channel_number: '9.1',
            profile_id: 'prof-1',
            enabled: 1,
            comment: null,
            updated_at: NOW,
          })
          .execute();

        interface OldPlacementRow013 {
          id: string;
          channel_id: string;
          instance_id: string;
          node_id: string;
          priority: number;
          enabled: number;
          weight: number | null;
          program_number: number | null;
          mode: string;
          updated_at: string;
        }
        const oldPlacementsDb = db as unknown as Kysely<{ restream_placements: OldPlacementRow013 }>;
        await oldPlacementsDb
          .insertInto('restream_placements')
          .values({
            id: 'plc-1',
            channel_id: 'chan-1',
            instance_id: 'tyo1',
            node_id: 'node1',
            priority: 1,
            enabled: 1,
            weight: 300,
            program_number: null,
            mode: 'hot',
            updated_at: NOW,
          })
          .execute();

        await migrateToLatest(db);

        const row = await db
          .selectFrom('restream_placements')
          .selectAll()
          .where('id', '=', 'plc-1')
          .executeTakeFirstOrThrow();
        expect(row).not.toHaveProperty('weight');
        expect(row.profile_id).toBeNull();
      } finally {
        await db.destroy();
      }
    });
  });

  describe('018_restream_node_state_raw_argv', () => {
    // the sticky flag this migration added was dropped again by 019 (see
    // below) — current-schema behavior is no longer testable here; this test
    // only exercises 018's OWN up() at the 018 checkpoint, stepping stopwise
    // rather than all the way to latest.
    it('adding the column at the 018 checkpoint defaults pre-existing rows to 0', async () => {
      const sqlite = new BetterSqlite3(':memory:');
      sqlite.pragma('foreign_keys = ON');
      const db = new Kysely<Database>({
        dialect: new SqliteDialect({ database: sqlite }),
        plugins: [new SqliteCompatPlugin()],
      });
      try {
        await migrateTo(db, '017_placement_profile_drop_weight');

        interface OldNodeStateRow017 {
          instance_id: string;
          node_id: string;
          pushed_hash: string;
          pushed_at: string;
        }
        const oldDb = db as unknown as Kysely<{ restream_node_state: OldNodeStateRow017 }>;
        await oldDb
          .insertInto('restream_node_state')
          .values({ instance_id: 'tyo1', node_id: 'node1', pushed_hash: 'abc', pushed_at: NOW })
          .execute();

        await migrateTo(db, '018_restream_node_state_raw_argv');

        interface NodeStateRow018 extends OldNodeStateRow017 {
          advertised_raw_argv: number;
        }
        const newDb = db as unknown as Kysely<{ restream_node_state: NodeStateRow018 }>;
        const row = await newDb
          .selectFrom('restream_node_state')
          .selectAll()
          .where('instance_id', '=', 'tyo1')
          .where('node_id', '=', 'node1')
          .executeTakeFirstOrThrow();
        expect(row).toMatchObject({ pushed_hash: 'abc', advertised_raw_argv: 0 });
      } finally {
        await db.destroy();
      }
    });
  });

  describe('019_drop_advertised_raw_argv', () => {
    it('a plain node_state row on the latest schema no longer carries the advertised_raw_argv column', async () => {
      await seed();
      const row = await t.db
        .selectFrom('restream_node_state')
        .selectAll()
        .where('instance_id', '=', 'tyo1')
        .where('node_id', '=', 'node1')
        .executeTakeFirstOrThrow();
      expect(row).not.toHaveProperty('advertised_raw_argv');
    });

    it('up drops the column; migrating back down to 018 restores it defaulted to 0', async () => {
      const sqlite = new BetterSqlite3(':memory:');
      sqlite.pragma('foreign_keys = ON');
      const db = new Kysely<Database>({
        dialect: new SqliteDialect({ database: sqlite }),
        plugins: [new SqliteCompatPlugin()],
      });
      try {
        await migrateTo(db, '018_restream_node_state_raw_argv');

        interface NodeStateRow018 {
          instance_id: string;
          node_id: string;
          pushed_hash: string;
          pushed_at: string;
          advertised_raw_argv: number;
        }
        const oldDb = db as unknown as Kysely<{ restream_node_state: NodeStateRow018 }>;
        await oldDb
          .insertInto('restream_node_state')
          .values({
            instance_id: 'tyo1',
            node_id: 'node1',
            pushed_hash: 'abc',
            pushed_at: NOW,
            advertised_raw_argv: 1,
          })
          .execute();

        await migrateTo(db, '019_drop_advertised_raw_argv');

        const afterUp = await db
          .selectFrom('restream_node_state')
          .selectAll()
          .where('instance_id', '=', 'tyo1')
          .where('node_id', '=', 'node1')
          .executeTakeFirstOrThrow();
        expect(afterUp).not.toHaveProperty('advertised_raw_argv');
        expect(afterUp).toMatchObject({ pushed_hash: 'abc' });

        // migrate back down past 019 to restore the column (down() re-adds it
        // defaulted to 0 — the sticky value at drop time is not preserved)
        await migrateTo(db, '018_restream_node_state_raw_argv');

        const afterDown = await oldDb
          .selectFrom('restream_node_state')
          .selectAll()
          .where('instance_id', '=', 'tyo1')
          .where('node_id', '=', 'node1')
          .executeTakeFirstOrThrow();
        expect(afterDown).toMatchObject({ pushed_hash: 'abc', advertised_raw_argv: 0 });
      } finally {
        await db.destroy();
      }
    });
  });

  describe('020_placement_transient', () => {
    it('a transient=1 clone coexists with the transient=0 original on the same (channel,instance,node); a second transient=0 row on that triple still collides', async () => {
      await seed();
      await t.db
        .insertInto('restream_placements')
        .values({
          id: 'plc-clone',
          channel_id: 'chan-1',
          instance_id: 'tyo1',
          node_id: 'node1',
          priority: 1,
          enabled: 1,
          profile_id: null,
          program_number: null,
          transient: 1,
          updated_at: NOW,
        })
        .execute();
      const rows = await t.db
        .selectFrom('restream_placements')
        .select('transient')
        .where('channel_id', '=', 'chan-1')
        .execute();
      expect(rows.map((r) => r.transient).sort()).toEqual([0, 1]);

      await expect(
        t.db
          .insertInto('restream_placements')
          .values({
            id: 'plc-dup',
            channel_id: 'chan-1',
            instance_id: 'tyo1',
            node_id: 'node1',
            priority: 2,
            enabled: 1,
            profile_id: null,
            program_number: null,
            updated_at: NOW,
          })
          .execute(),
      ).rejects.toThrow(/UNIQUE/i);
    });

    it('restream_profiles rows default transient to 0', async () => {
      await seed();
      const row = await t.db
        .selectFrom('restream_profiles')
        .selectAll()
        .where('id', '=', 'prof-1')
        .executeTakeFirstOrThrow();
      expect(row.transient).toBe(0);
    });

    it('up defaults pre-existing rows to transient=0 and widens the unique index; down narrows it back and drops the column', async () => {
      const sqlite = new BetterSqlite3(':memory:');
      sqlite.pragma('foreign_keys = ON');
      const db = new Kysely<Database>({
        dialect: new SqliteDialect({ database: sqlite }),
        plugins: [new SqliteCompatPlugin()],
      });
      try {
        await migrateTo(db, '019_drop_advertised_raw_argv');

        interface OldProfileRow019 {
          id: string;
          name: string;
          payload: string;
          updated_at: string;
        }
        interface OldChannelRow019 {
          id: string;
          slug: string;
          channel_name: string;
          channel_number: string | null;
          profile_id: string;
          enabled: number;
          comment: string | null;
          updated_at: string;
        }
        interface OldPlacementRow019 {
          id: string;
          channel_id: string;
          instance_id: string;
          node_id: string;
          priority: number;
          enabled: number;
          profile_id: string | null;
          program_number: number | null;
          mode: string;
          updated_at: string;
        }
        const oldDb = db as unknown as Kysely<{
          restream_profiles: OldProfileRow019;
          restream_channels: OldChannelRow019;
          restream_placements: OldPlacementRow019;
        }>;
        await oldDb
          .insertInto('restream_profiles')
          .values({ id: 'prof-1', name: 'p', payload: '{}', updated_at: NOW })
          .execute();
        await oldDb
          .insertInto('restream_channels')
          .values({
            id: 'chan-1',
            slug: 'at-x',
            channel_name: 'AT-X',
            channel_number: '9.1',
            profile_id: 'prof-1',
            enabled: 1,
            comment: null,
            updated_at: NOW,
          })
          .execute();
        await oldDb
          .insertInto('restream_placements')
          .values({
            id: 'plc-1',
            channel_id: 'chan-1',
            instance_id: 'tyo1',
            node_id: 'node1',
            priority: 1,
            enabled: 1,
            profile_id: null,
            program_number: null,
            mode: 'hot',
            updated_at: NOW,
          })
          .execute();

        await migrateTo(db, '020_placement_transient');

        const placementAfterUp = await db
          .selectFrom('restream_placements')
          .selectAll()
          .where('id', '=', 'plc-1')
          .executeTakeFirstOrThrow();
        expect(placementAfterUp).toMatchObject({ transient: 0 });
        const profileAfterUp = await db
          .selectFrom('restream_profiles')
          .selectAll()
          .where('id', '=', 'prof-1')
          .executeTakeFirstOrThrow();
        expect(profileAfterUp).toMatchObject({ transient: 0 });

        // widened index: a transient=1 clone on the same triple no longer collides
        await db
          .insertInto('restream_placements')
          .values({
            id: 'plc-clone',
            channel_id: 'chan-1',
            instance_id: 'tyo1',
            node_id: 'node1',
            priority: 2,
            enabled: 1,
            profile_id: null,
            program_number: null,
            mode: 'hot',
            transient: 1,
            updated_at: NOW,
          })
          .execute();
        // remove it before narrowing back down -- the narrower 3-col index
        // cannot hold both a transient=0 and transient=1 row on one triple
        await db.deleteFrom('restream_placements').where('id', '=', 'plc-clone').execute();

        await migrateTo(db, '019_drop_advertised_raw_argv');

        const placementAfterDown = await oldDb
          .selectFrom('restream_placements')
          .selectAll()
          .where('id', '=', 'plc-1')
          .executeTakeFirstOrThrow();
        expect(placementAfterDown).not.toHaveProperty('transient');
        const profileAfterDown = await oldDb
          .selectFrom('restream_profiles')
          .selectAll()
          .where('id', '=', 'prof-1')
          .executeTakeFirstOrThrow();
        expect(profileAfterDown).not.toHaveProperty('transient');
      } finally {
        await db.destroy();
      }
    });
  });

  describe('020_placement_transient resumability (interrupted-boot recovery)', () => {
    /*
     * MySQL/MariaDB DDL auto-commits per statement, so a process that dies
     * partway through 020's up() can leave a subset of its steps already
     * applied with no migration-history row recorded (the migrator only
     * writes that row after up() returns). The next boot re-runs up() from
     * the top. These tests simulate each partial-application point directly
     * with raw SQL against a db parked at 019 (the same state a half-applied
     * MySQL run would leave behind) and assert migrateToLatest() still
     * completes and lands on the correct final schema.
     */

    async function freshDbAt019WithSeedRow(): Promise<Kysely<Database>> {
      const sqlite = new BetterSqlite3(':memory:');
      sqlite.pragma('foreign_keys = ON');
      const db = new Kysely<Database>({
        dialect: new SqliteDialect({ database: sqlite }),
        plugins: [new SqliteCompatPlugin()],
      });
      await migrateTo(db, '019_drop_advertised_raw_argv');

      interface OldProfileRow019 {
        id: string;
        name: string;
        payload: string;
        updated_at: string;
      }
      interface OldChannelRow019 {
        id: string;
        slug: string;
        channel_name: string;
        channel_number: string | null;
        profile_id: string;
        enabled: number;
        comment: string | null;
        updated_at: string;
      }
      interface OldPlacementRow019 {
        id: string;
        channel_id: string;
        instance_id: string;
        node_id: string;
        priority: number;
        enabled: number;
        profile_id: string | null;
        program_number: number | null;
        mode: string;
        updated_at: string;
      }
      const oldDb = db as unknown as Kysely<{
        restream_profiles: OldProfileRow019;
        restream_channels: OldChannelRow019;
        restream_placements: OldPlacementRow019;
      }>;
      await oldDb
        .insertInto('restream_profiles')
        .values({ id: 'prof-1', name: 'p', payload: '{}', updated_at: NOW })
        .execute();
      await oldDb
        .insertInto('restream_channels')
        .values({
          id: 'chan-1',
          slug: 'at-x',
          channel_name: 'AT-X',
          channel_number: '9.1',
          profile_id: 'prof-1',
          enabled: 1,
          comment: null,
          updated_at: NOW,
        })
        .execute();
      // seeded BEFORE the simulated partial state, to prove the resumed
      // rebuild in step 3 preserves pre-existing rows
      await oldDb
        .insertInto('restream_placements')
        .values({
          id: 'plc-1',
          channel_id: 'chan-1',
          instance_id: 'tyo1',
          node_id: 'node1',
          priority: 1,
          enabled: 1,
          profile_id: null,
          program_number: null,
          mode: 'hot',
          updated_at: NOW,
        })
        .execute();
      return db;
    }

    /** asserts migrateToLatest() reached the correct, fully-widened end state */
    async function assertResumedToCorrectSchema(db: Kysely<Database>): Promise<void> {
      // the pre-seeded row survived the resumed rebuild with its data intact
      const placement = await db
        .selectFrom('restream_placements')
        .selectAll()
        .where('id', '=', 'plc-1')
        .executeTakeFirstOrThrow();
      expect(placement).toMatchObject({
        channel_id: 'chan-1',
        instance_id: 'tyo1',
        node_id: 'node1',
        priority: 1,
        mode: 'hot',
        transient: 0,
      });

      const profile = await db
        .selectFrom('restream_profiles')
        .selectAll()
        .where('id', '=', 'prof-1')
        .executeTakeFirstOrThrow();
      expect(profile).toMatchObject({ transient: 0 });

      // unique index is the widened 4-col shape: a transient=1 clone on the
      // same (channel, instance, node) triple now coexists with plc-1
      await db
        .insertInto('restream_placements')
        .values({
          id: 'plc-clone',
          channel_id: 'chan-1',
          instance_id: 'tyo1',
          node_id: 'node1',
          priority: 2,
          enabled: 1,
          profile_id: null,
          program_number: null,
          mode: 'hot',
          transient: 1,
          updated_at: NOW,
        })
        .execute();
      const rows = await db
        .selectFrom('restream_placements')
        .select('transient')
        .where('channel_id', '=', 'chan-1')
        .execute();
      expect(rows.map((r) => r.transient).sort()).toEqual([0, 1]);
      await db.deleteFrom('restream_placements').where('id', '=', 'plc-clone').execute();

      // no rebuild scratch table left behind
      const leftover = await sql<{ name: string }>`
        select name from sqlite_master where type = 'table' and name = 'restream_placements_new'
      `.execute(db);
      expect(leftover.rows).toHaveLength(0);
    }

    it('(a) resumes and completes when only step 1 (restream_placements.transient) landed before the interrupt', async () => {
      const db = await freshDbAt019WithSeedRow();
      try {
        // simulates the crash point in the bug report: step 1 committed, then
        // the process died before step 2 or step 3
        await sql`alter table restream_placements add column transient boolean not null default 0`.execute(
          db,
        );

        await expect(migrateToLatest(db)).resolves.toBeUndefined();
        await assertResumedToCorrectSchema(db);
      } finally {
        await db.destroy();
      }
    });

    it('(b) resumes and completes when steps 1+2 (both transient columns) landed before the interrupt', async () => {
      const db = await freshDbAt019WithSeedRow();
      try {
        await sql`alter table restream_placements add column transient boolean not null default 0`.execute(
          db,
        );
        await sql`alter table restream_profiles add column transient boolean not null default 0`.execute(
          db,
        );

        await expect(migrateToLatest(db)).resolves.toBeUndefined();
        await assertResumedToCorrectSchema(db);
      } finally {
        await db.destroy();
      }
    });

    it('(c) resumes and completes when steps 1+2 landed and a leftover restream_placements_new table survives a death mid-rebuild', async () => {
      const db = await freshDbAt019WithSeedRow();
      try {
        await sql`alter table restream_placements add column transient boolean not null default 0`.execute(
          db,
        );
        await sql`alter table restream_profiles add column transient boolean not null default 0`.execute(
          db,
        );
        // simulates dying between rebuildPlacementsUniqueConstraint()
        // creating its scratch table and the final drop+rename
        await sql`create table restream_placements_new (id varchar(36) primary key, leftover_marker varchar(8))`.execute(
          db,
        );

        await expect(migrateToLatest(db)).resolves.toBeUndefined();
        await assertResumedToCorrectSchema(db);
      } finally {
        await db.destroy();
      }
    });

    it('(d) re-running 020 up() directly on an already-fully-migrated db is a no-op', async () => {
      const db = await freshDbAt019WithSeedRow();
      try {
        await migrateToLatest(db);
        const before = await db
          .selectFrom('restream_placements')
          .selectAll()
          .where('id', '=', 'plc-1')
          .executeTakeFirstOrThrow();

        // bypasses the migrator's history bookkeeping entirely — exercises
        // up()'s own idempotence, not just "the migrator won't re-run it"
        await expect(runMigrationUp(db, '020_placement_transient')).resolves.toBeUndefined();

        const after = await db
          .selectFrom('restream_placements')
          .selectAll()
          .where('id', '=', 'plc-1')
          .executeTakeFirstOrThrow();
        expect(after).toEqual(before);
        expect(await db.selectFrom('restream_placements').selectAll().execute()).toHaveLength(1);
        await assertResumedToCorrectSchema(db);
      } finally {
        await db.destroy();
      }
    });
  });

  describe('023_drop_switcher_state', () => {
    it('the table is gone on the latest schema', async () => {
      const leftover = await sql<{ name: string }>`
        select name from sqlite_master where type = 'table' and name = 'restream_switcher_state'
      `.execute(t.db);
      expect(leftover.rows).toHaveLength(0);
    });

    it('up drops a populated table; migrating back down recreates it empty', async () => {
      const sqlite = new BetterSqlite3(':memory:');
      sqlite.pragma('foreign_keys = ON');
      const db = new Kysely<Database>({
        dialect: new SqliteDialect({ database: sqlite }),
        plugins: [new SqliteCompatPlugin()],
      });
      try {
        await migrateTo(db, '022_on_demand_delay');

        interface SwitcherStateRow022 {
          switcher_id: string;
          pushed_hash: string;
          pushed_at: string;
        }
        const oldDb = db as unknown as Kysely<{ restream_switcher_state: SwitcherStateRow022 }>;
        await oldDb
          .insertInto('restream_switcher_state')
          .values({ switcher_id: 'main', pushed_hash: 'def', pushed_at: NOW })
          .execute();

        await migrateToLatest(db);

        await expect(
          oldDb.selectFrom('restream_switcher_state').selectAll().execute(),
        ).rejects.toThrow(/no such table/i);

        await migrateTo(db, '022_on_demand_delay');

        expect(await oldDb.selectFrom('restream_switcher_state').selectAll().execute()).toEqual([]);
      } finally {
        await db.destroy();
      }
    });
  });

  describe('024_activation_uuid', () => {
    it('up adds a nullable activation_uuid column; migrating back down drops it', async () => {
      const sqlite = new BetterSqlite3(':memory:');
      sqlite.pragma('foreign_keys = ON');
      const db = new Kysely<Database>({
        dialect: new SqliteDialect({ database: sqlite }),
        plugins: [new SqliteCompatPlugin()],
      });
      try {
        await migrateTo(db, '023_drop_switcher_state');

        await db
          .insertInto('restream_profiles')
          .values({
            id: 'prof-1',
            name: 'default-3M',
            payload: JSON.stringify({ template: 'arib-hls', templateVersion: 1 }),
            updated_at: NOW,
          })
          .execute();
        await db
          .insertInto('restream_channels')
          .values({
            id: 'chan-1',
            slug: 'at-x',
            channel_name: 'AT-X',
            channel_number: '9.1',
            profile_id: 'prof-1',
            enabled: 1,
            comment: null,
            updated_at: NOW,
          })
          .execute();
        await db
          .insertInto('restream_placements')
          .values({
            id: 'plc-1',
            channel_id: 'chan-1',
            instance_id: 'tyo1',
            node_id: 'node1',
            priority: 0,
            enabled: 1,
            profile_id: null,
            program_number: null,
            updated_at: NOW,
          })
          .execute();

        interface FailoverStateRow023 {
          channel_id: string;
          from_placement_id: string | null;
          to_placement_id: string;
          phase: string;
          trigger_reason: string;
          trigger_node_id: string | null;
          trigger_detail: string | null;
          suppress_from: number;
          drain_until: string | null;
          started_at: string;
          updated_at: string;
        }
        const oldDb = db as unknown as Kysely<{ restream_failover_state: FailoverStateRow023 }>;
        await oldDb
          .insertInto('restream_failover_state')
          .values({
            channel_id: 'chan-1',
            from_placement_id: null,
            to_placement_id: 'plc-1',
            phase: 'complete',
            trigger_reason: 'on-demand',
            trigger_node_id: null,
            trigger_detail: null,
            suppress_from: 1,
            drain_until: null,
            started_at: NOW,
            updated_at: NOW,
          })
          .execute();

        await migrateToLatest(db);

        const row = await db
          .selectFrom('restream_failover_state')
          .selectAll()
          .where('channel_id', '=', 'chan-1')
          .executeTakeFirstOrThrow();
        expect(row.activation_uuid).toBeNull();

        await db
          .updateTable('restream_failover_state')
          .set({ activation_uuid: 'aaaaaaaa-0000-0000-0000-000000000000' })
          .where('channel_id', '=', 'chan-1')
          .execute();
        expect(
          (
            await db
              .selectFrom('restream_failover_state')
              .selectAll()
              .where('channel_id', '=', 'chan-1')
              .executeTakeFirstOrThrow()
          ).activation_uuid,
        ).toBe('aaaaaaaa-0000-0000-0000-000000000000');

        await migrateTo(db, '023_drop_switcher_state');

        const reverted = await oldDb
          .selectFrom('restream_failover_state')
          .selectAll()
          .where('channel_id', '=', 'chan-1')
          .executeTakeFirstOrThrow();
        expect(reverted).not.toHaveProperty('activation_uuid');
      } finally {
        await db.destroy();
      }
    });
  });

  it('enforces UNIQUE(channel_id, instance_id, node_id) on placements', async () => {
    await seed();
    await expect(
      t.db
        .insertInto('restream_placements')
        .values({
          id: 'plc-2',
          channel_id: 'chan-1',
          instance_id: 'tyo1',
          node_id: 'node1',
          priority: 1,
          enabled: 1,
          profile_id: null,
          program_number: null,
          updated_at: NOW,
        })
        .execute(),
    ).rejects.toThrow(/UNIQUE/i);
  });
});
