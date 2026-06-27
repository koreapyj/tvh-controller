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

import type {
  TvhDvrEntry,
  TvhEpgEvent,
  TvhInputStatus,
  TvhSubscription,
  DvrState,
} from './tvh-types.js';
import type { DriftItem, MasterRulePayload, RuleInstances, SyncState } from './master-rule.js';
import type { UploadJob, UploadStatus } from './rclone-rc.js';

export interface InstanceSummary {
  id: string;
  name: string;
  url: string;
  reachable: boolean;
  version: string | null;
  lastPollAt: string | null;
  error: string | null;
  /**
   * the tvheadend SERVER's UTC offset in minutes (autorec times are
   * interpreted in this zone) — from config or auto-detected via the
   * co-located rclone rcd; null = unknown
   */
  serverOffsetMinutes: number | null;
}

export interface ConflictWindow {
  start: number;
  stop: number;
  level: 'conflict' | 'low-margin';
  /** dvr entry uuids active in this window */
  entryUuids: string[];
  /** network short on capacity (name) */
  network: string;
  detail: string;
}

export interface InstanceOverview {
  instance: InstanceSummary;
  counts: { upcoming: number; finished: number; failed: number };
  inputs: TvhInputStatus[];
  subscriptions: TvhSubscription[];
  nextRecordings: TvhDvrEntry[];
  conflicts: ConflictWindow[];
}

export interface RecordingItem extends TvhDvrEntry {
  state: DvrState;
  /** upload ledger info when a matching upload exists (any instance) */
  upload?: {
    uploadId: string;
    status: string;
    byInstanceId: string;
    possibleDuplicate: boolean;
  };
  /** conflict level if this upcoming entry is part of a warning window */
  conflictLevel?: 'conflict' | 'low-margin';
}

export interface RecordingGroup {
  /** master rule id when the rule is bound, else null */
  masterRuleId: string | null;
  /** autorec caption (rule name) or 'Manual / other' */
  label: string;
  entries: RecordingItem[];
}

export interface RuleWithStatus {
  id: string;
  name: string;
  enabled: boolean;
  updatedAt: string;
  /** raw stored payload (placeholder for linked clones) */
  payload: unknown;
  /** payload after applying the parent + overlay (equals payload for plain rules) */
  effectivePayload: MasterRulePayload;
  parentId: string | null;
  parentName: string | null;
  overlay: Partial<MasterRulePayload> | null;
  instances: RuleInstances;
  /** in-scope instances only */
  perInstance: Record<
    string,
    {
      state: SyncState;
      tvhUuid?: string;
      blockedReason?: string;
      /** upcoming entries spawned by this rule on the instance (from the cached grid — no extra tvh requests) */
      upcomingMatches: number;
    }
  >;
  /** total upcoming entries across in-scope instances; 0 on an enabled rule deserves a warning */
  upcomingMatches: number;
}

/** one instance's copy of a broadcast in the unified recordings view */
export interface UnifiedCopy {
  instanceId: string;
  uuid: string;
  schedStatus?: string;
  status?: string;
  filesize: number | null;
  filename: string | null;
  errors: number;
  dataErrors: number;
  conflictLevel?: 'conflict' | 'low-margin';
}

/** a broadcast, deduplicated across instances by channel + time overlap */
export interface UnifiedItem {
  title: string;
  subtitle?: string;
  channelname: string;
  start: number;
  stop: number;
  copies: UnifiedCopy[];
  upload?: { uploadId: string; status: UploadStatus; byInstanceId: string };
}

export interface UnifiedGroup {
  /** autorec rule NAME (display captions append the comment — keep them separate) */
  label: string;
  comment: string;
  items: UnifiedItem[];
}

/** channel known to one or more instances, merged by name */
export interface ChannelOption {
  name: string;
  number: number | null;
  /** instance ids where a channel with this name exists */
  instances: string[];
  /**
   * EIT zone offset of the channel's network in minutes, resolved from
   * tvheadend (network "EIT time offset", channel→service→mux→network);
   * null = unknown
   */
  eitOffsetMinutes: number | null;
}

/** one instance's copy of an EPG broadcast in the unified EPG view */
export interface UnifiedEpgCopy {
  instanceId: string;
  eventId: number;
  /** present when this broadcast is already scheduled/recording on the instance */
  dvrUuid?: string;
  dvrState?: string;
}

/** an EPG broadcast, deduplicated across instances by channel + time overlap */
export interface UnifiedEpgEvent {
  channelName: string;
  /** tvheadend channel number, e.g. "5.1" — part of the channel identity */
  channelNumber: string | null;
  title: string;
  subtitle?: string;
  start: number;
  stop: number;
  /** representative full event for the Broadcast Details modal */
  details: TvhEpgEvent;
  copies: UnifiedEpgCopy[];
  /** instance auto-picked to record (capacity-aware); null when none reachable */
  recommendedInstanceId: string | null;
}

export interface EpgRecordRequest {
  instanceId: string;
  eventId: number;
}

/** a distinct EPG channel (name + number), for the EPG channel filter */
export interface EpgChannel {
  name: string;
  number: string | null;
}

export type SseEvent =
  | { type: 'instance-status'; data: InstanceSummary }
  | {
      type: 'status';
      data: { instanceId: string; inputs: TvhInputStatus[]; subscriptions: TvhSubscription[] };
    }
  | { type: 'recordings'; data: { instanceId: string; state: DvrState } }
  | { type: 'epg'; data: { instanceId: string } }
  | { type: 'drift'; data: { items: DriftItem[] } }
  | { type: 'conflicts'; data: { instanceId: string; windows: ConflictWindow[] } }
  | { type: 'upload-progress'; data: UploadJob };
