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

export interface Database {
  master_rules: MasterRulesTable;
  rule_bindings: RuleBindingsTable;
  uploads: UploadsTable;
  ignored_orphans: IgnoredOrphansTable;
}
