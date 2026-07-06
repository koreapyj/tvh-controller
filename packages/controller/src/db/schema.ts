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

import type { ColumnType, Generated } from 'kysely';

export interface MasterRulesTable {
  id: string;
  name: string;
  /** canonical MasterRulePayload JSON (names, not uuids); '{}' for linked clones */
  payload: string;
  enabled: number;
  updated_at: ColumnType<Date, string, string>;
  /** linked clone parent (app-enforced, depth 1) */
  parent_id: string | null;
  /** JSON Partial<MasterRulePayload> — overridden fields only */
  overlay: string | null;
  /** JSON string[] of instance ids; NULL = all instances */
  instances: string | null;
  /** soft delete: rule is hidden and removed from instances, restorable */
  deleted_at: ColumnType<Date | null, string | null, string | null>;
}

export interface RuleBindingsTable {
  master_rule_id: string;
  instance_id: string;
  tvh_uuid: string;
  /** sha256 of the MASTER payload at push time — "pending push" detection */
  master_hash: string;
  /**
   * sha256 of the rule as read back from the instance after push (normalized)
   * — instance-drift baseline that absorbs tvheadend value coercion
   */
  pushed_hash: string;
  pushed_at: ColumnType<Date, string, string>;
}

export interface UploadsTable {
  id: string;
  instance_id: string;
  dvr_uuid: string;
  title: string | null;
  channelname: string;
  channelnumber: string | null;
  start: number;
  stop: number;
  filesize: number | null;
  local_path: string;
  remote_path: string;
  status: string;
  progress: Generated<number>;
  rclone_job_id: number | null;
  attempts: Generated<number>;
  error: string | null;
  possible_duplicate: Generated<number>;
  origin: Generated<string>;
  /** pick made while an instance was unreachable; re-evaluated on recovery */
  incomplete_pick: Generated<number>;
  /** remote object this upload replaces; deleted after this one verifies */
  supersedes_path: string | null;
  /** 'transient' (auto-retryable) | 'permanent' (manual-only); NULL until failed */
  failure_kind: string | null;
  /** times the transient auto-retry sweep has re-driven this row */
  auto_retries: Generated<number>;
  created_at: ColumnType<Date, string, never>;
  updated_at: ColumnType<Date, string, string>;
  completed_at: ColumnType<Date | null, string | null, string | null>;
}

export interface IgnoredOrphansTable {
  instance_id: string;
  tvh_uuid: string;
  name: string;
  ignored_at: ColumnType<Date, string | undefined, never>;
}

/** named encoding profile; payload is a fully resolved PipelineParams */
export interface RestreamProfilesTable {
  id: string;
  name: string;
  /** PipelineParams JSON (wire contract) — pushed to daemons verbatim */
  payload: string;
  updated_at: ColumnType<Date, string, string>;
}

/** logical restream channel: one slug, one channel identity, one profile */
export interface RestreamChannelsTable {
  id: string;
  /** output dir on every node + public URL segment */
  slug: string;
  channel_name: string;
  /** STRING channel-number identity (e.g. "9.1", exact match); NULL = pin lowest-numbered */
  channel_number: string | null;
  /** 'tvh' (tvheadend channel, name+number identity) | 'external' (node-local sources.m3u entry) */
  source_type: Generated<string>;
  /** catalog entry id (tvg-id) for external channels; NULL for tvh channels */
  source_key: string | null;
  /** one profile per logical channel — redundant encodes keep matching variant sets */
  profile_id: string;
  enabled: number;
  comment: string | null;
  updated_at: ColumnType<Date, string, string>;
}

/** one encode of a logical channel on one restreamer node (>1 per channel = redundant) */
export interface RestreamPlacementsTable {
  id: string;
  channel_id: string;
  instance_id: string;
  node_id: string;
  /** failover order — lower is preferred */
  priority: number;
  enabled: number;
  /** tvheadend subscription weight override; NULL = daemon default */
  weight: number | null;
  /** manual program-number (service SID) override; NULL = derived channel→service→sid */
  program_number: number | null;
  updated_at: ColumnType<Date, string, string>;
}

/** last successfully pushed desired-doc hash per node (doc is atomic — one hash) */
export interface RestreamNodeStateTable {
  instance_id: string;
  node_id: string;
  pushed_hash: string;
  pushed_at: ColumnType<Date, string, string>;
}

/** DB-managed master playlist, served at GET /playlists/<slug>.m3u */
export interface RestreamPlaylistsTable {
  id: string;
  /** URL path segment */
  slug: string;
  title: string;
  /** url-tvg for the generated M3U */
  epg_url: string | null;
  updated_at: ColumnType<Date, string, string>;
}

export interface RestreamPlaylistMembersTable {
  playlist_id: string;
  channel_id: string;
}

/**
 * push state for switcher desired docs, parallel to restream_node_state.
 * Active upstream selection is NOT stored here — the switcher's own state
 * file is authoritative; the controller mirrors it via status poll.
 */
export interface RestreamSwitcherStateTable {
  switcher_id: string;
  pushed_hash: string;
  pushed_at: ColumnType<Date, string, string>;
}

export interface Database {
  master_rules: MasterRulesTable;
  rule_bindings: RuleBindingsTable;
  uploads: UploadsTable;
  ignored_orphans: IgnoredOrphansTable;
  restream_profiles: RestreamProfilesTable;
  restream_channels: RestreamChannelsTable;
  restream_placements: RestreamPlacementsTable;
  restream_node_state: RestreamNodeStateTable;
  restream_playlists: RestreamPlaylistsTable;
  restream_playlist_members: RestreamPlaylistMembersTable;
  restream_switcher_state: RestreamSwitcherStateTable;
}
