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
  RestreamChannelWithStatus,
  RestreamerNodeStatus,
  SwitcherNodeStatus,
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
/** instances that actually run a tvheadend — recording/rule-scope UI must
 *  enumerate this, never the raw fleet (a tvh-less zone can't hold a copy) */
export const tvhInstances = derived(instances, (list) => list.filter((i) => i.hasTvh));
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

/** restreamer node statuses keyed `instanceId/nodeId` — SSE-fed, seeded from /api/restreamer/nodes */
export const restreamerNodes = writable<Record<string, RestreamerNodeStatus>>({});
/** switcher statuses keyed by switcherId — SSE-fed, seeded alongside the nodes */
export const restreamerSwitchers = writable<Record<string, SwitcherNodeStatus>>({});

/** store key for one restreamer node (mirrors the controller's nodeKey) */
export function restreamerNodeKey(n: Pick<RestreamerNodeStatus, 'instanceId' | 'nodeId'>): string {
  return `${n.instanceId}/${n.nodeId}`;
}

/** merge one SSE `restreamer` event into the node map (whole-status replace per node) */
export function applyRestreamerNode(node: RestreamerNodeStatus): void {
  restreamerNodes.update((m) => ({ ...m, [restreamerNodeKey(node)]: node }));
}

/** merge one SSE `restreamer-switcher` event into the switcher map */
export function applyRestreamerSwitcher(sw: SwitcherNodeStatus): void {
  restreamerSwitchers.update((m) => ({ ...m, [sw.switcherId]: sw }));
}

/** full reseed from a GET /api/restreamer/nodes response (page load) */
export function seedRestreamers(
  nodes: RestreamerNodeStatus[],
  switchers: SwitcherNodeStatus[],
): void {
  restreamerNodes.set(Object.fromEntries(nodes.map((n) => [restreamerNodeKey(n), n])));
  restreamerSwitchers.set(Object.fromEntries(switchers.map((s) => [s.switcherId, s])));
}

/**
 * Live restream-channel status keyed by channel id — SSE-fed (`restreamer-
 * channel` events carry the full REST shape, replace-by-id). The Restreamer
 * page seeds channels from the REST fetch and only overlays this map for
 * freshness; clearRestreamChannelLive() drops stale entries once a REST
 * refetch (which is always fresher) lands.
 */
export const restreamChannelLive = writable<Record<string, RestreamChannelWithStatus>>({});

/** merge one SSE `restreamer-channel` event into the live map (replace-by-id) */
export function applyRestreamChannel(ch: RestreamChannelWithStatus): void {
  restreamChannelLive.update((m) => ({ ...m, [ch.id]: ch }));
}

/** drop every live overlay — call right after a REST refetch of the channel list */
export function clearRestreamChannelLive(): void {
  restreamChannelLive.set({});
}
