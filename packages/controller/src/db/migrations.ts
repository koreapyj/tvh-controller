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

import { Kysely, Migrator, SqliteAdapter, sql, type Migration, type MigrationProvider } from 'kysely';

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

migrations['005_auto_upload'] = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .alterTable('uploads')
      .addColumn('origin', 'varchar(8)', (c) => c.notNull().defaultTo('manual'))
      .execute();
    // pick made while an instance was unreachable — re-evaluated on recovery
    await db.schema
      .alterTable('uploads')
      .addColumn('incomplete_pick', 'boolean', (c) => c.notNull().defaultTo(0))
      .execute();
    // remote object replaced by this upload; deleted after this one verifies
    await db.schema
      .alterTable('uploads')
      .addColumn('supersedes_path', 'varchar(1024)')
      .execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable('uploads').dropColumn('supersedes_path').execute();
    await db.schema.alterTable('uploads').dropColumn('incomplete_pick').execute();
    await db.schema.alterTable('uploads').dropColumn('origin').execute();
  },
};

migrations['006_upload_retry'] = {
  async up(db: Kysely<unknown>): Promise<void> {
    // classify a failed upload so the dispatcher can auto-retry transient
    // failures (rcd unreachable, remote blips) while leaving permanent ones
    // (missing file, wrong path) terminal/manual-only
    await db.schema.alterTable('uploads').addColumn('failure_kind', 'varchar(10)').execute();
    // how many times the transient auto-retry sweep has re-driven this row
    await db.schema
      .alterTable('uploads')
      .addColumn('auto_retries', 'integer', (c) => c.notNull().defaultTo(0))
      .execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable('uploads').dropColumn('auto_retries').execute();
    await db.schema.alterTable('uploads').dropColumn('failure_kind').execute();
  },
};

migrations['007_upload_channel_number'] = {
  async up(db: Kysely<unknown>): Promise<void> {
    // channel number at claim time (e.g. "9.1"), resolved from the instance's
    // channel list via the DVR entry's channel uuid; NULL for rows claimed
    // before this field existed or when the channel couldn't be resolved
    await db.schema.alterTable('uploads').addColumn('channelnumber', 'varchar(32)').execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable('uploads').dropColumn('channelnumber').execute();
  },
};

migrations['008_restreamer'] = {
  async up(db: Kysely<unknown>): Promise<void> {
    // restreamer task allocation: a LOGICAL channel (slug + channel identity +
    // profile) has 1..N placements (which nodes encode it); >1 placement =
    // redundant channel, failover via the standalone switcher

    await db.schema
      .createTable('restream_profiles')
      .addColumn('id', 'varchar(36)', (c) => c.primaryKey())
      .addColumn('name', 'varchar(255)', (c) => c.notNull().unique())
      // fully resolved PipelineParams JSON (wire contract)
      .addColumn('payload', 'json', (c) => c.notNull())
      .addColumn('updated_at', 'timestamp', (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .execute();

    await db.schema
      .createTable('restream_channels')
      .addColumn('id', 'varchar(36)', (c) => c.primaryKey())
      // output dir on every node + public URL segment
      .addColumn('slug', 'varchar(64)', (c) => c.notNull().unique())
      .addColumn('channel_name', 'varchar(255)', (c) => c.notNull())
      // STRING channel-number identity (e.g. "9.1"); NULL = pin lowest-numbered
      .addColumn('channel_number', 'varchar(32)')
      // RESTRICT: profile deletion while referenced is an app-level 409
      .addColumn('profile_id', 'varchar(36)', (c) =>
        c.notNull().references('restream_profiles.id').onDelete('restrict'),
      )
      .addColumn('enabled', 'boolean', (c) => c.notNull().defaultTo(1))
      .addColumn('comment', 'text')
      .addColumn('updated_at', 'timestamp', (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .execute();

    await db.schema
      .createTable('restream_placements')
      .addColumn('id', 'varchar(36)', (c) => c.primaryKey())
      .addColumn('channel_id', 'varchar(36)', (c) =>
        c.notNull().references('restream_channels.id').onDelete('cascade'),
      )
      .addColumn('instance_id', 'varchar(64)', (c) => c.notNull())
      .addColumn('node_id', 'varchar(64)', (c) => c.notNull())
      // failover order — lower is preferred
      .addColumn('priority', 'integer', (c) => c.notNull())
      .addColumn('enabled', 'boolean', (c) => c.notNull().defaultTo(1))
      // tvheadend subscription weight override; NULL = daemon default
      .addColumn('weight', 'integer')
      // manual program-number (service SID) override; NULL = derived
      .addColumn('program_number', 'integer')
      .addColumn('updated_at', 'timestamp', (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addUniqueConstraint('uq_placements_channel_node', ['channel_id', 'instance_id', 'node_id'])
      .execute();

    // one pushed-doc hash per node (the desired doc is atomic — deliberately
    // simpler than rule_bindings)
    await db.schema
      .createTable('restream_node_state')
      .addColumn('instance_id', 'varchar(64)', (c) => c.notNull())
      .addColumn('node_id', 'varchar(64)', (c) => c.notNull())
      .addColumn('pushed_hash', 'varchar(64)', (c) => c.notNull())
      .addColumn('pushed_at', 'timestamp', (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addPrimaryKeyConstraint('pk_restream_node_state', ['instance_id', 'node_id'])
      .execute();

    await db.schema
      .createTable('restream_playlists')
      .addColumn('id', 'varchar(36)', (c) => c.primaryKey())
      // URL path segment: GET /playlists/<slug>.m3u
      .addColumn('slug', 'varchar(64)', (c) => c.notNull().unique())
      .addColumn('title', 'varchar(255)', (c) => c.notNull())
      .addColumn('epg_url', 'varchar(1024)')
      .addColumn('updated_at', 'timestamp', (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .execute();

    await db.schema
      .createTable('restream_playlist_members')
      .addColumn('playlist_id', 'varchar(36)', (c) =>
        c.notNull().references('restream_playlists.id').onDelete('cascade'),
      )
      .addColumn('channel_id', 'varchar(36)', (c) =>
        c.notNull().references('restream_channels.id').onDelete('cascade'),
      )
      .addPrimaryKeyConstraint('pk_restream_playlist_members', ['playlist_id', 'channel_id'])
      .execute();

    // push state for switcher desired docs, parallel to restream_node_state
    // (active upstream selection lives in the switcher's own state file)
    await db.schema
      .createTable('restream_switcher_state')
      .addColumn('switcher_id', 'varchar(64)', (c) => c.primaryKey())
      .addColumn('pushed_hash', 'varchar(64)', (c) => c.notNull())
      .addColumn('pushed_at', 'timestamp', (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('restream_switcher_state').execute();
    await db.schema.dropTable('restream_playlist_members').execute();
    await db.schema.dropTable('restream_playlists').execute();
    await db.schema.dropTable('restream_node_state').execute();
    await db.schema.dropTable('restream_placements').execute();
    await db.schema.dropTable('restream_channels').execute();
    await db.schema.dropTable('restream_profiles').execute();
  },
};

migrations['009_external_sources'] = {
  async up(db: Kysely<unknown>): Promise<void> {
    // non-tvheadend sources: a channel either targets a tvheadend channel
    // ('tvh', name+number identity) or an entry of a restreamer node's local
    // sources.m3u catalog ('external', keyed by the entry id / tvg-id)
    await db.schema
      .alterTable('restream_channels')
      .addColumn('source_type', 'varchar(16)', (c) => c.notNull().defaultTo('tvh'))
      .execute();
    // catalog entry id for external channels; NULL for tvh channels
    await db.schema
      .alterTable('restream_channels')
      .addColumn('source_key', 'varchar(255)')
      .execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable('restream_channels').dropColumn('source_key').execute();
    await db.schema.alterTable('restream_channels').dropColumn('source_type').execute();
  },
};

migrations['010_drop_external_source_columns'] = {
  // unified channel identity (REVISION 2): a channel is source-agnostic
  // (channel_name, channel_number) + profile; each placement resolves
  // independently — tvheadend topology first, then the node's local sources.m3u
  // catalog by the SAME (name, chno) identity rules. The separate 'external'
  // source type is no longer needed.
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable('restream_channels').dropColumn('source_key').execute();
    await db.schema.alterTable('restream_channels').dropColumn('source_type').execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .alterTable('restream_channels')
      .addColumn('source_type', 'varchar(16)', (c) => c.notNull().defaultTo('tvh'))
      .execute();
    await db.schema
      .alterTable('restream_channels')
      .addColumn('source_key', 'varchar(255)')
      .execute();
  },
};

migrations['011_drop_playlist_epg_url'] = {
  // XMLTV is now generated by the controller itself, one document per playlist
  // (GET /xmltv/<slug>.xml) — url-tvg always points there, so the
  // externally-hosted EPG URL column has no reader left.
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable('restream_playlists').dropColumn('epg_url').execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .alterTable('restream_playlists')
      .addColumn('epg_url', 'varchar(1024)')
      .execute();
  },
};

migrations['012_cold_backup_placements'] = {
  async up(db: Kysely<unknown>): Promise<void> {
    // 'hot' = always encodes (pre-existing behavior); 'cold' = standby,
    // excluded from node/switcher docs unless an activation row exists below
    await db.schema
      .alterTable('restream_placements')
      .addColumn('mode', 'varchar(8)', (c) => c.notNull().defaultTo('hot'))
      .execute();

    // at most one active cold backup per channel; persisted so a controller
    // restart never orphans a running cold session or forgets why it started
    await db.schema
      .createTable('restream_cold_activations')
      .addColumn('channel_id', 'varchar(36)', (c) =>
        c.primaryKey().references('restream_channels.id').onDelete('cascade'),
      )
      .addColumn('placement_id', 'varchar(36)', (c) =>
        c.notNull().unique().references('restream_placements.id').onDelete('cascade'),
      )
      // the hot placement whose failure triggered this — diagnostics only
      .addColumn('preferred_placement_id', 'varchar(36)', (c) =>
        c.references('restream_placements.id').onDelete('set null'),
      )
      .addColumn('reason', 'varchar(20)', (c) => c.notNull())
      .addColumn('activated_at', 'timestamp', (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addColumn('updated_at', 'timestamp', (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('restream_cold_activations').execute();
    await db.schema.alterTable('restream_placements').dropColumn('mode').execute();
  },
};

migrations['013_probe_settings'] = {
  async up(db: Kysely<unknown>): Promise<void> {
    // per-node probe thresholds (UI-editable); absent row ⇒ code defaults.
    // Nodes live in config.yaml (no FK target exists) — a row whose
    // (instance_id, node_id) no longer matches config is simply ignored.
    // (this migration originally also added underrun_* columns, a
    // speed-ratio-threshold probe retired by 015_drop_underrun)
    await db.schema
      .createTable('restream_node_probes')
      .addColumn('instance_id', 'varchar(64)', (c) => c.notNull())
      .addColumn('node_id', 'varchar(64)', (c) => c.notNull())
      .addColumn('liveness_timeout_seconds', 'integer', (c) => c.notNull().defaultTo(5))
      .addColumn('liveness_period_seconds', 'integer', (c) => c.notNull().defaultTo(10))
      .addColumn('liveness_success_threshold', 'integer', (c) => c.notNull().defaultTo(2))
      .addColumn('liveness_failure_threshold', 'integer', (c) => c.notNull().defaultTo(3))
      .addColumn('underspeed_timeout_seconds', 'integer', (c) => c.notNull().defaultTo(20))
      .addColumn('underspeed_period_seconds', 'integer', (c) => c.notNull().defaultTo(45))
      .addColumn('underspeed_success_threshold', 'integer', (c) => c.notNull().defaultTo(2))
      .addColumn('underspeed_failure_threshold', 'integer', (c) => c.notNull().defaultTo(3))
      .addColumn('lag_timeout_seconds', 'integer', (c) => c.notNull().defaultTo(30))
      .addColumn('lag_period_seconds', 'integer', (c) => c.notNull().defaultTo(10))
      .addColumn('lag_success_threshold', 'integer', (c) => c.notNull().defaultTo(3))
      .addColumn('lag_failure_threshold', 'integer', (c) => c.notNull().defaultTo(3))
      .addColumn('underrun_min_speed', 'real', (c) => c.notNull().defaultTo(0.98))
      .addColumn('underrun_period_seconds', 'integer', (c) => c.notNull().defaultTo(15))
      .addColumn('underrun_success_threshold', 'integer', (c) => c.notNull().defaultTo(2))
      .addColumn('underrun_failure_threshold', 'integer', (c) => c.notNull().defaultTo(3))
      .addColumn('updated_at', 'timestamp', (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addPrimaryKeyConstraint('pk_restream_node_probes', ['instance_id', 'node_id'])
      .execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('restream_node_probes').execute();
  },
};

migrations['014_failover_state'] = {
  async up(db: Kysely<unknown>): Promise<void> {
    // generalizes restream_cold_activations: one persisted failover procedure
    // (or its completed result) per channel. Node docs EXCLUDE from_placement
    // once suppress_from and phase >= stopping-old; switcher docs KEEP it for
    // the row's whole lifetime so retained seg/<old-id>/ URIs stay resolvable
    // while the served window drains. drain_until bounds the terminal
    // 'draining' phase after a reset completes.
    await db.schema
      .createTable('restream_failover_state')
      .addColumn('channel_id', 'varchar(36)', (c) =>
        c.primaryKey().references('restream_channels.id').onDelete('cascade'),
      )
      .addColumn('from_placement_id', 'varchar(36)', (c) =>
        c.references('restream_placements.id').onDelete('set null'),
      )
      .addColumn('to_placement_id', 'varchar(36)', (c) =>
        c.notNull().references('restream_placements.id').onDelete('cascade'),
      )
      .addColumn('phase', 'varchar(24)', (c) => c.notNull())
      // 'liveness' | 'underspeed' | 'lag' | 'manual' | 'reset' | 'rebalance'
      // (historically also 'underrun', retired in 015_drop_underrun)
      .addColumn('trigger_reason', 'varchar(16)', (c) => c.notNull())
      // set for instance-level triggers (liveness/underspeed) — reset re-checks it
      .addColumn('trigger_node_id', 'varchar(64)')
      .addColumn('trigger_detail', 'text')
      .addColumn('suppress_from', 'boolean', (c) => c.notNull().defaultTo(0))
      .addColumn('drain_until', 'timestamp')
      .addColumn('started_at', 'timestamp', (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addColumn('updated_at', 'timestamp', (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .execute();

    // carry existing cold activations forward as completed failovers with the
    // exact same runtime meaning: cold to_placement stays in the docs
    // (inclusion via to_placement_id), nothing suppressed (suppress_from=0)
    interface OldColdRow {
      channel_id: string;
      placement_id: string;
      preferred_placement_id: string | null;
      reason: string;
      activated_at: Date | string;
    }
    const reasonMap: Record<string, string> = {
      'node-unreachable': 'liveness',
      'session-unhealthy': 'lag',
      'delivery-slow': 'underspeed',
    };
    const toSqlTs = (v: Date | string): string =>
      (v instanceof Date ? v : new Date(v)).toISOString().slice(0, 19).replace('T', ' ');
    const d = db as Kysely<{
      restream_cold_activations: OldColdRow;
      restream_failover_state: Record<string, unknown>;
    }>;
    const old = await d.selectFrom('restream_cold_activations').selectAll().execute();
    for (const row of old) {
      await d
        .insertInto('restream_failover_state')
        .values({
          channel_id: row.channel_id,
          from_placement_id: row.preferred_placement_id,
          to_placement_id: row.placement_id,
          phase: 'complete',
          trigger_reason: reasonMap[row.reason] ?? 'lag',
          trigger_node_id: null,
          trigger_detail: `migrated from cold activation (${row.reason})`,
          suppress_from: 0,
          drain_until: null,
          started_at: toSqlTs(row.activated_at),
          updated_at: toSqlTs(row.activated_at),
        })
        .execute();
    }

    await db.schema.dropTable('restream_cold_activations').execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    // schema-only reconstruction (matching 012); failover rows are not mapped back
    await db.schema
      .createTable('restream_cold_activations')
      .addColumn('channel_id', 'varchar(36)', (c) =>
        c.primaryKey().references('restream_channels.id').onDelete('cascade'),
      )
      .addColumn('placement_id', 'varchar(36)', (c) =>
        c.notNull().unique().references('restream_placements.id').onDelete('cascade'),
      )
      .addColumn('preferred_placement_id', 'varchar(36)', (c) =>
        c.references('restream_placements.id').onDelete('set null'),
      )
      .addColumn('reason', 'varchar(20)', (c) => c.notNull())
      .addColumn('activated_at', 'timestamp', (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addColumn('updated_at', 'timestamp', (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .execute();
    await db.schema.dropTable('restream_failover_state').execute();
  },
};

migrations['015_drop_underrun'] = {
  // the underrun probe (passive, read ffmpeg progress.speed per placement) is
  // retired: ffmpeg's -progress speed/out_time freezes whenever the sparse
  // ARIB subtitle stream stops receiving packets, so the metric reads
  // 0.8x/0x on perfectly healthy encoders. The lag probe covers real encoder
  // stalls/slowdowns. No 'underrun' trigger_reason rows exist in prod (the
  // trigger was never enabled), so dropping the columns is safe.
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable('restream_node_probes').dropColumn('underrun_min_speed').execute();
    await db.schema
      .alterTable('restream_node_probes')
      .dropColumn('underrun_period_seconds')
      .execute();
    await db.schema
      .alterTable('restream_node_probes')
      .dropColumn('underrun_success_threshold')
      .execute();
    await db.schema
      .alterTable('restream_node_probes')
      .dropColumn('underrun_failure_threshold')
      .execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .alterTable('restream_node_probes')
      .addColumn('underrun_min_speed', 'real', (c) => c.notNull().defaultTo(0.98))
      .execute();
    await db.schema
      .alterTable('restream_node_probes')
      .addColumn('underrun_period_seconds', 'integer', (c) => c.notNull().defaultTo(15))
      .execute();
    await db.schema
      .alterTable('restream_node_probes')
      .addColumn('underrun_success_threshold', 'integer', (c) => c.notNull().defaultTo(2))
      .execute();
    await db.schema
      .alterTable('restream_node_probes')
      .addColumn('underrun_failure_threshold', 'integer', (c) => c.notNull().defaultTo(3))
      .execute();
  },
};

migrations['016_event_log'] = {
  // persisted history of failovers/outages/drift/failed pushes etc, normally
  // only visible as live SSE state or scattered console.error lines. First
  // integer-PK table in the codebase (everything else is uuid varchar(36)):
  // deliberate, since a monotonic id is the same-second ordering tiebreaker
  // for bursts of events landing in the same wall-clock second.
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable('event_log')
      .addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement())
      .addColumn('type', 'varchar(16)', (c) => c.notNull())
      .addColumn('service', 'varchar(64)', (c) => c.notNull())
      .addColumn('source', 'varchar(128)', (c) => c.notNull())
      .addColumn('message', 'text', (c) => c.notNull())
      .addColumn('created_at', 'timestamp', (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .execute();

    // every filterable/sortable column is index-backed
    await db.schema
      .createIndex('idx_event_log_created_at')
      .on('event_log')
      .column('created_at')
      .execute();
    await db.schema
      .createIndex('idx_event_log_service_created_at')
      .on('event_log')
      .columns(['service', 'created_at'])
      .execute();
    await db.schema
      .createIndex('idx_event_log_source_created_at')
      .on('event_log')
      .columns(['source', 'created_at'])
      .execute();
    await db.schema
      .createIndex('idx_event_log_type_created_at')
      .on('event_log')
      .columns(['type', 'created_at'])
      .execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('event_log').execute();
  },
};

migrations['017_placement_profile_drop_weight'] = {
  // per-placement subscription weight is retired (never reached tvheadend in
  // a meaningful way — see 015/underrun-style cleanup precedent). Replaced
  // with a per-placement encode-profile override: NULL = inherit the
  // channel's profile, matching how program_number already overrides the
  // channel-derived default. No FK to restream_profiles.id — same app-level
  // integrity as instance_id/node_id above (deletion-in-use is a 409 the
  // service layer enforces before the row is touched).
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .alterTable('restream_placements')
      .addColumn('profile_id', 'varchar(36)')
      .execute();
    await db.schema.alterTable('restream_placements').dropColumn('weight').execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .alterTable('restream_placements')
      .addColumn('weight', 'integer')
      .execute();
    await db.schema.alterTable('restream_placements').dropColumn('profile_id').execute();
  },
};

migrations['018_restream_node_state_raw_argv'] = {
  // sticky per-node capability flag: has this node ever advertised the
  // 'raw-argv' pipeline template? Never cleared on downgrade — see
  // persistAdvertisedRawArgv() in restreamer/service.ts for the rationale.
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .alterTable('restream_node_state')
      .addColumn('advertised_raw_argv', 'boolean', (c) => c.notNull().defaultTo(0))
      .execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable('restream_node_state').dropColumn('advertised_raw_argv').execute();
  },
};

migrations['019_drop_advertised_raw_argv'] = {
  // raw-argv rendering is now unconditional — every node gets a pre-rendered
  // raw-argv doc regardless of advertised capabilities, so the sticky
  // per-node flag added in 018 is moot. Kept as a separate migration (rather
  // than editing 018) because 018 is already applied in production.
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable('restream_node_state').dropColumn('advertised_raw_argv').execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .alterTable('restream_node_state')
      .addColumn('advertised_raw_argv', 'boolean', (c) => c.notNull().defaultTo(0))
      .execute();
  },
};

/**
 * Kysely re-exports both dialect adapters from its top-level package, so a
 * plain `instanceof` check is enough to branch migration DDL by dialect —
 * no probe query needed. (mysql2-backed prod always uses MysqlAdapter; the
 * hermetic test suite always uses SqliteAdapter via better-sqlite3.)
 */
function isSqliteDb(db: Kysely<unknown>): boolean {
  return db.getExecutor().adapter instanceof SqliteAdapter;
}

type PlacementUniqueCol = 'channel_id' | 'instance_id' | 'node_id' | 'transient';

/**
 * True if `table.column` already exists on the live schema. Used to make
 * ALTER TABLE ADD COLUMN steps resumable (see 020_placement_transient):
 * MySQL/MariaDB DDL auto-commits per statement, so a process that dies
 * mid-migration can leave a column already added with no record of it
 * beyond the live schema itself — re-running the plain addColumn() then
 * dies on "Duplicate column name" forever.
 */
async function columnExists(db: Kysely<unknown>, table: string, column: string): Promise<boolean> {
  if (isSqliteDb(db)) {
    const result = await sql<{ name: string }>`
      select name from pragma_table_info(${table}) where name = ${column}
    `.execute(db);
    return result.rows.length > 0;
  }
  const result = await sql<{ one: number }>`
    select 1 as one from information_schema.columns
    where table_schema = database() and table_name = ${table} and column_name = ${column}
  `.execute(db);
  return result.rows.length > 0;
}

function sameColumnOrder(actual: readonly string[], target: readonly string[]): boolean {
  return actual.length === target.length && actual.every((col, i) => col === target[i]);
}

/**
 * True if an index named `indexName` (plain or unique) already exists on
 * `table` — MySQL/MariaDB only (see 020_placement_transient's
 * idx_placements_channel_id below for why one is needed; never called on
 * the sqlite path, which has no equivalent index-by-name lookup — see
 * placementsUniqueIndexColumns' doc comment for why).
 */
async function indexExists(db: Kysely<unknown>, table: string, indexName: string): Promise<boolean> {
  const result = await sql<{ one: number }>`
    select 1 as one from information_schema.statistics
    where table_schema = database() and table_name = ${table} and index_name = ${indexName}
    limit 1
  `.execute(db);
  return result.rows.length > 0;
}

/**
 * Column list (in index order) of uq_placements_channel_node on
 * restream_placements — [] if the index doesn't currently exist.
 *
 * MySQL/MariaDB: the constraint is implemented as a plain index, queryable
 * straight from information_schema.
 *
 * SQLite: a named `CONSTRAINT ... UNIQUE (...)` on a CREATE TABLE does NOT
 * carry its name onto the resulting index — SQLite always names it
 * `sqlite_autoindex_<table>_<n>` regardless (verified empirically), so
 * PRAGMA index_list/index_info can't be looked up by our constraint name.
 * The constraint's column list is read back from the CREATE TABLE DDL text
 * in sqlite_master instead.
 */
async function placementsUniqueIndexColumns(db: Kysely<unknown>): Promise<string[]> {
  if (isSqliteDb(db)) {
    const result = await sql<{ sql: string | null }>`
      select sql from sqlite_master where type = 'table' and name = 'restream_placements'
    `.execute(db);
    const ddl = result.rows[0]?.sql ?? '';
    const match = /constraint\s+"?uq_placements_channel_node"?\s+unique\s*\(([^)]*)\)/i.exec(ddl);
    if (!match) return [];
    return match[1]!.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
  }
  const result = await sql<{ column_name: string }>`
    select column_name from information_schema.statistics
    where table_schema = database()
      and table_name = 'restream_placements'
      and index_name = 'uq_placements_channel_node'
    order by seq_in_index
  `.execute(db);
  return result.rows.map((r) => r.column_name);
}

/**
 * SQLite has supported native ALTER TABLE ADD/DROP COLUMN since 3.35, but
 * has never supported dropping or altering a named table constraint — the
 * only way to change one is the standard 12-step rebuild (new table, copy
 * rows, drop old, rename). restream_failover_state holds FKs into this
 * table (from_placement_id/to_placement_id), so foreign key enforcement is
 * suspended for the duration; verified empirically that FK rows and their
 * CASCADE/SET NULL behavior survive the rebuild intact.
 *
 * `restream_placements_new` is dropped first in case a previous run of this
 * rebuild died between creating it and the final rename — see
 * 020_placement_transient for why a partial run is a real possibility.
 */
async function rebuildPlacementsUniqueConstraint(
  db: Kysely<unknown>,
  uniqueCols: PlacementUniqueCol[],
): Promise<void> {
  await sql`PRAGMA foreign_keys = OFF`.execute(db);
  try {
    await sql`drop table if exists restream_placements_new`.execute(db);
    await db.schema
      .createTable('restream_placements_new')
      .addColumn('id', 'varchar(36)', (c) => c.primaryKey())
      .addColumn('channel_id', 'varchar(36)', (c) =>
        c.notNull().references('restream_channels.id').onDelete('cascade'),
      )
      .addColumn('instance_id', 'varchar(64)', (c) => c.notNull())
      .addColumn('node_id', 'varchar(64)', (c) => c.notNull())
      .addColumn('priority', 'integer', (c) => c.notNull())
      .addColumn('enabled', 'boolean', (c) => c.notNull().defaultTo(1))
      .addColumn('program_number', 'integer')
      .addColumn('updated_at', 'timestamp', (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addColumn('mode', 'varchar(8)', (c) => c.notNull().defaultTo('hot'))
      .addColumn('profile_id', 'varchar(36)')
      .addColumn('transient', 'boolean', (c) => c.notNull().defaultTo(0))
      .addUniqueConstraint('uq_placements_channel_node', uniqueCols)
      .execute();

    await sql`
      insert into restream_placements_new
        (id, channel_id, instance_id, node_id, priority, enabled, program_number, updated_at, mode, profile_id, transient)
      select id, channel_id, instance_id, node_id, priority, enabled, program_number, updated_at, mode, profile_id, transient
      from restream_placements
    `.execute(db);

    await db.schema.dropTable('restream_placements').execute();
    await sql`alter table restream_placements_new rename to restream_placements`.execute(db);
  } finally {
    await sql`PRAGMA foreign_keys = ON`.execute(db);
  }
}

migrations['020_placement_transient'] = {
  // Zero-downtime "cutover" (profile change without a visible drop): a
  // transient CLONE placement is inserted on the exact same
  // (channel_id, instance_id, node_id) as the placement it is replacing,
  // briefly coexisting with it while the new profile's encode spins up and
  // proves itself healthy. `transient` marks rows OWNED by this lifecycle
  // (never user-created, never surfaced in the profile picker) so the apply
  // sweep and listProfiles() can exclude them.
  /*
   * Resumable by design. MySQL/MariaDB DDL auto-commits per statement, so a
   * crash partway through up() can leave some DDL already landed with no
   * record of it beyond the live schema — a naive re-run would then die on
   * "Duplicate column name" forever. Each step below checks the live schema
   * first and no-ops if its effect is already present, so a fresh run and a
   * resumed run take the identical path.
   */
  async up(db: Kysely<unknown>): Promise<void> {
    if (!(await columnExists(db, 'restream_placements', 'transient'))) {
      await db.schema
        .alterTable('restream_placements')
        .addColumn('transient', 'boolean', (c) => c.notNull().defaultTo(0))
        .execute();
    }
    if (!(await columnExists(db, 'restream_profiles', 'transient'))) {
      await db.schema
        .alterTable('restream_profiles')
        .addColumn('transient', 'boolean', (c) => c.notNull().defaultTo(0))
        .execute();
    }

    // uq_placements_channel_node (008) would otherwise reject the transient
    // clone's same-node insert outright. Widen it to include `transient`
    // rather than dropping it: this still lets the DB itself enforce the
    // pre-existing transient=0 invariant (see
    // restreamerSchema.test.ts::'enforces UNIQUE(...) on placements'), while
    // admitting exactly one transient=1 row alongside it per node. The
    // transient=0 (public-CRUD) uniqueness check itself continues to live at
    // the app level in addPlacementInner/applyChannelChangesInner — this is
    // pure defense in depth plus the carve-out cutover needs.
    const widenedCols: PlacementUniqueCol[] = ['channel_id', 'instance_id', 'node_id', 'transient'];
    if (isSqliteDb(db)) {
      if (!sameColumnOrder(await placementsUniqueIndexColumns(db), widenedCols)) {
        await rebuildPlacementsUniqueConstraint(db, widenedCols);
      }
    } else {
      // MySQL: a UNIQUE constraint is implemented as an index, and generic
      // `DROP CONSTRAINT` for non-CHECK/FK constraints only works on
      // 8.0.19+ — DROP INDEX / ADD UNIQUE INDEX is the portable form back
      // to MySQL 4.x, so raw SQL is used here instead of the schema
      // builder's dropConstraint()/addUniqueConstraint() (which compile to
      // `DROP CONSTRAINT` / `ADD CONSTRAINT ... UNIQUE`).
      //
      // MySQL vs MariaDB divergence this index papers over: channel_id's
      // column-level `.references('restream_channels.id')` (008_restreamer)
      // compiles to an inline `REFERENCES` clause. MySQL silently ignores it
      // (no FK is created); MariaDB 10.2.1+ honors it and creates a real FK.
      // Prod runs MariaDB, so InnoDB refuses to drop uq_placements_channel_node
      // once it's the FK's sole anchor. Ensuring this plain, permanent
      // stand-in index exists FIRST gives the FK somewhere else to anchor to,
      // so the drop always succeeds; on FK-less MySQL it's just an extra
      // harmless index. It is never dropped again — not even in down() below
      // — so every future migration that touches
      // uq_placements_channel_node inherits the same protection for free.
      if (!(await indexExists(db, 'restream_placements', 'idx_placements_channel_id'))) {
        await sql`create index idx_placements_channel_id on restream_placements (channel_id)`.execute(
          db,
        );
      }

      if (!sameColumnOrder(await placementsUniqueIndexColumns(db), widenedCols)) {
        // A previous partial run may have already dropped the 3-column
        // index without getting to re-add the widened one — only drop it if
        // it's still there, otherwise ADD UNIQUE INDEX would be adding it on
        // top of nothing and that's the whole story.
        const existing = await placementsUniqueIndexColumns(db);
        if (existing.length > 0) {
          await sql`alter table restream_placements drop index uq_placements_channel_node`.execute(db);
        }
        await sql`alter table restream_placements add unique index uq_placements_channel_node (channel_id, instance_id, node_id, transient)`.execute(
          db,
        );
      }
    }
  },
  async down(db: Kysely<unknown>): Promise<void> {
    // symmetric resumability with up() — cheap given the helpers already
    // exist, even though down() is not part of the normal boot path.
    const narrowCols: PlacementUniqueCol[] = ['channel_id', 'instance_id', 'node_id'];
    if (isSqliteDb(db)) {
      if (!sameColumnOrder(await placementsUniqueIndexColumns(db), narrowCols)) {
        await rebuildPlacementsUniqueConstraint(db, narrowCols);
      }
    } else {
      // Same MySQL-vs-MariaDB inline-REFERENCES trap as up() above: ensure
      // idx_placements_channel_id exists before dropping
      // uq_placements_channel_node, so MariaDB's real FK always has
      // somewhere else to anchor to.
      if (!(await indexExists(db, 'restream_placements', 'idx_placements_channel_id'))) {
        await sql`create index idx_placements_channel_id on restream_placements (channel_id)`.execute(
          db,
        );
      }

      if (!sameColumnOrder(await placementsUniqueIndexColumns(db), narrowCols)) {
        const existing = await placementsUniqueIndexColumns(db);
        if (existing.length > 0) {
          await sql`alter table restream_placements drop index uq_placements_channel_node`.execute(db);
        }
        await sql`alter table restream_placements add unique index uq_placements_channel_node (channel_id, instance_id, node_id)`.execute(
          db,
        );
      }
    }
    if (await columnExists(db, 'restream_profiles', 'transient')) {
      await db.schema.alterTable('restream_profiles').dropColumn('transient').execute();
    }
    if (await columnExists(db, 'restream_placements', 'transient')) {
      await db.schema.alterTable('restream_placements').dropColumn('transient').execute();
    }
  },
};

migrations['021_node_settings'] = {
  async up(db: Kysely<unknown>): Promise<void> {
    // per-node session cap (UI-editable); absent row or NULL max_sessions ⇒
    // uncapped. Nodes live in config.yaml (no FK target exists) — a row
    // whose (instance_id, node_id) no longer matches config is ignored.
    await db.schema
      .createTable('restream_node_settings')
      .addColumn('instance_id', 'varchar(64)', (c) => c.notNull())
      .addColumn('node_id', 'varchar(64)', (c) => c.notNull())
      .addColumn('max_sessions', 'integer')
      .addColumn('updated_at', 'timestamp', (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addPrimaryKeyConstraint('pk_restream_node_settings', ['instance_id', 'node_id'])
      .execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('restream_node_settings').execute();
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

/**
 * Test-only stepwise migration: migrate a fresh db up to (and including) a
 * named migration, no further. Lets tests seed rows under an older schema
 * revision before migrating the rest of the way forward (migration
 * carry-over coverage) without duplicating the migration table above.
 */
export async function migrateTo<T>(db: Kysely<T>, targetMigrationName: string): Promise<void> {
  const migrator = new Migrator({ db: db as Kysely<unknown>, provider });
  const { error, results } = await migrator.migrateTo(targetMigrationName);
  if (error) {
    const failed = results?.find((r) => r.status === 'Error');
    throw new Error(`migration ${failed?.migrationName ?? ''} failed: ${String(error)}`);
  }
}

/**
 * Test-only: run a single migration's up() directly against a db, bypassing
 * the migrator's bookkeeping (its migration-history table). Lets a test
 * replay up() a second time on an already-migrated db — or against a db
 * mutated with raw SQL to simulate a partially-applied prior run — without
 * needing a real interrupted MySQL boot to reproduce it.
 */
export async function runMigrationUp<T>(db: Kysely<T>, migrationName: string): Promise<void> {
  const migration = migrations[migrationName];
  if (!migration) throw new Error(`unknown migration: ${migrationName}`);
  await migration.up(db as Kysely<unknown>);
}
