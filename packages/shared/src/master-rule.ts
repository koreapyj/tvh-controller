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

import { Type, type Static } from '@sinclair/typebox';

/**
 * Canonical autorec rule owned by the controller. All instance-local uuid
 * references (channel, tag, dvr profile) are stored as NAMES so the same
 * payload can be pushed to any instance; tvheadend's setters accept names.
 */
export const MasterRulePayload = Type.Object({
  enabled: Type.Boolean({ default: true }),
  name: Type.String({ minLength: 1 }),
  title: Type.String({ default: '' }),
  fulltext: Type.Boolean({ default: false }),
  mergetext: Type.Boolean({ default: false }),
  /** channel NAME, '' = any channel */
  channel: Type.String({ default: '' }),
  /** channel tag NAME, '' = none */
  tag: Type.String({ default: '' }),
  btype: Type.Number({ default: 0 }),
  content_type: Type.Number({ default: 0 }),
  star_rating: Type.Number({ default: 0 }),
  start: Type.String({ default: '' }),
  start_window: Type.String({ default: '' }),
  start_extra: Type.Number({ default: 0 }),
  stop_extra: Type.Number({ default: 0 }),
  weekdays: Type.Array(Type.Number(), { default: [] }),
  minduration: Type.Number({ default: 0 }),
  maxduration: Type.Number({ default: 0 }),
  minyear: Type.Number({ default: 0 }),
  maxyear: Type.Number({ default: 0 }),
  minseason: Type.Number({ default: 0 }),
  maxseason: Type.Number({ default: 0 }),
  pri: Type.Number({ default: 6 }),
  record: Type.Number({ default: 0 }),
  retention: Type.Number({ default: 0 }),
  removal: Type.Number({ default: 0 }),
  maxcount: Type.Number({ default: 0 }),
  maxsched: Type.Number({ default: 0 }),
  /** DVR profile NAME, '' = default */
  config_name: Type.String({ default: '' }),
  directory: Type.String({ default: '' }),
  comment: Type.String({ default: '' }),
});

export type MasterRulePayload = Static<typeof MasterRulePayload>;

/** which instances a rule applies to; 'all' tracks later-added instances automatically */
export type RuleInstances = 'all' | string[];

export interface MasterRule {
  id: string;
  name: string;
  /** raw stored payload; for linked clones this is a placeholder — use the effective payload */
  payload: MasterRulePayload;
  enabled: boolean;
  updatedAt: string;
  /** linked clone: parent rule id (depth 1 — a parent is never itself a clone) */
  parentId: string | null;
  /** linked clone: ONLY the overridden fields (never name) */
  overlay: Partial<MasterRulePayload> | null;
  instances: RuleInstances;
  /** soft-deleted rules are removed from the instances but restorable */
  deletedAt: string | null;
}

export type SyncState = 'in-sync' | 'pending' | 'drift' | 'blocked' | 'unpushed' | 'unknown';

export type DriftKind = 'modified-on-instance' | 'deleted-on-instance' | 'orphan';

export interface FieldDiff {
  field: string;
  master: unknown;
  instance: unknown;
}

export interface DriftItem {
  /** stable id for reconcile actions: `${kind}:${instanceId}:${uuidOrRuleId}` */
  id: string;
  kind: DriftKind;
  instanceId: string;
  masterRuleId?: string;
  masterRuleName?: string;
  tvhUuid?: string;
  instanceRuleName?: string;
  diffs?: FieldDiff[];
  /** normalized instance payload (for orphan adoption / import) */
  instancePayload?: MasterRulePayload;
  /** current master payload (for bound drift kinds) */
  masterPayload?: MasterRulePayload;
}

export type ReconcileAction =
  | 'overwrite-from-master'
  | 'import-into-master'
  | 'split-into-clone'
  | 'adopt-orphan'
  | 'ignore-orphan'
  | 'delete-from-instance'
  | 'recreate-on-instance'
  | 'delete-master';

export interface IgnoredOrphan {
  instanceId: string;
  tvhUuid: string;
  name: string;
  ignoredAt: string;
}

/**
 * Result of the manual integrity check: a direct, baseline-free comparison
 * of the controller's effective rules against fresh instance state. Catches
 * desync the drift view can miss (drift compares against the last-push
 * baseline, which tolerates known differences such as un-pushed renames).
 */
export interface IntegrityIssue {
  kind:
    | 'content-mismatch'
    | 'missing-on-instance'
    | 'orphan-rule'
    | 'missing-parent'
    | 'out-of-scope-binding'
    | 'unpushed';
  instanceId?: string;
  masterRuleId?: string;
  masterRuleName?: string;
  tvhUuid?: string;
  instanceRuleName?: string;
  /** field-level differences, INCLUDING the name */
  diffs?: FieldDiff[];
  detail: string;
}
