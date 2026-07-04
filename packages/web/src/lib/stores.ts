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

import { derived, writable } from 'svelte/store';
import type {
  ChannelOption,
  ConflictWindow,
  DriftItem,
  InstanceSummary,
  TvhInputStatus,
  TvhSubscription,
  UploadJob,
} from '@tvhc/shared';

export const instances = writable<InstanceSummary[]>([]);
/** reactive instance-name lookup: `$instName(id)` falls back to the raw id */
export const instName = derived(
  instances,
  (list) => (id: string) => list.find((i) => i.id === id)?.name ?? id,
);
/** channels merged across instances, incl. per-channel EIT offsets from tvheadend */
export const channelOptions = writable<ChannelOption[]>([]);
export const conflictsByInstance = writable<Record<string, ConflictWindow[]>>({});
/** live inputs/subscriptions per instance, pushed via SSE */
export const statusByInstance = writable<
  Record<string, { inputs: TvhInputStatus[]; subscriptions: TvhSubscription[] }>
>({});
export const driftItems = writable<DriftItem[] | null>(null);
/** bumped when a recordings grid changed on some instance — pages refetch */
export const recordingsTick = writable<{ instanceId: string; n: number }>({ instanceId: '', n: 0 });
/** bumped when EPG changed on some instance (comet `epg` push) — the EPG page refetches */
export const epgTick = writable<number>(0);
/** last upload progress event — Uploads page merges it in */
export const uploadEvent = writable<UploadJob | null>(null);
export const sseConnected = writable(false);
