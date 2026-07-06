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

/**
 * Cold-failover orchestration: the impure sibling of coldFailoverPolicy.ts
 * (mirrors the SwitcherSync/rebalance split). Each tick() builds the policy's
 * input snapshot from DB + InstanceCache + the delivery probe, runs
 * planColdFailover, and applies the actions:
 * - activate/deactivate = INSERT/DELETE on restream_cold_activations — the
 *   caller (RestreamerService) then re-pushes the affected nodes/switchers,
 *   which is what actually starts/stops the cold encode (computeNodeDoc and
 *   the switcher doc join against the activation table).
 * - switch/switch-back = manual SwitcherClient.switchChannel commands
 *   (delivery-slow only — the switcher cannot see segment-path slowness).
 *
 * Debounce streaks, admission ring-buffers and switch dedupe live in memory
 * only; a controller restart resets them, which is only ever MORE
 * conservative (slower to activate, slower to deactivate). The activation
 * row is the single persisted decision.
 */

import type { RestreamerNodeStatus, SwitcherChannelStatus } from '@tvhc/shared';
import type { AppConfig, RestreamerNodeConfig } from '../config.js';
import type { Db } from '../db/db.js';
import type { InstanceCache } from '../state/instanceCache.js';
import {
  canAdmitSession,
  emptyHistory,
  recordSnapshot,
  type AdmissionHistory,
} from './admission.js';
import {
  RECOVERY_DEBOUNCE_TICKS,
  evalPreferredHealth,
  planColdFailover,
  type ColdChannelInput,
  type ColdFailoverBlocked,
  type ColdTriggerReason,
  type SourceKey,
} from './coldFailoverPolicy.js';
import type { SwitcherNodeClient } from './switcherSync.js';

/** re-issue a still-pending manual switch after this many ticks (~1 min) */
const SWITCH_REISSUE_TICKS = 3;

/** resolves one placement's encode-source identity (RestreamerService.resolvePlacement wrapped) */
export type SourceKeyResolver = (
  instanceId: string,
  nodeId: string,
  identity: { channelName: string; channelNumber: string | null },
  programOverride: number | null,
) => SourceKey;

/** per-serveUrl-origin delivery-probe health (DeliveryProbe.snapshot() wrapped; empty map = probe off) */
export type DeliveryHealthSource = () => ReadonlyMap<
  string,
  { slowStreak: number; healthyStreak: number }
>;

export interface ColdFailoverTickResult {
  /** channels whose activation state changed — their nodes/switchers need a push */
  changedChannelIds: string[];
  /** channels where a trigger fired but no cold candidate was eligible */
  blocked: ColdFailoverBlocked[];
}

function nk(instanceId: string, nodeId: string): string {
  return `${instanceId}/${nodeId}`;
}

function dbNow(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/** scheme+host+port of a node's serveUrl; null = no serveUrl / unparseable */
export function serveOrigin(serveUrl: string | undefined): string | null {
  if (!serveUrl) return null;
  try {
    return new URL(serveUrl).origin;
  } catch {
    return null;
  }
}

function coldReason(v: string): ColdTriggerReason {
  return v === 'session-unhealthy' || v === 'delivery-slow' ? v : 'node-unreachable';
}

interface PlacementRow {
  id: string;
  channel_id: string;
  instance_id: string;
  node_id: string;
  priority: number;
  enabled: number;
  mode: string;
  program_number: number | null;
}

export class ColdFailoverSync {
  /** debounce streaks keyed by the PREFERRED placement id (reset when the preferred changes) */
  private readonly unreachableStreaks = new Map<string, number>();
  private readonly unhealthyStreaks = new Map<string, number>();
  private readonly healthyStreaks = new Map<string, number>();
  /** admission ring-buffers keyed by nodeKey; samples deduped by the poll timestamp */
  private readonly admissionHistories = new Map<
    string,
    { lastPollAt: string | null; history: AdmissionHistory }
  >();
  /** manual-switch dedupe: last issued target per channel (delivery-slow only) */
  private readonly switchIssued = new Map<string, { to: string; tick: number }>();
  private tickCount = 0;

  constructor(
    private readonly db: Db,
    private readonly cache: InstanceCache,
    private readonly config: AppConfig,
    private readonly switcherClients: Map<string, SwitcherNodeClient>,
    private readonly resolveSource: SourceKeyResolver,
    private readonly deliveryHealth: DeliveryHealthSource,
  ) {}

  private nodeConfig(instanceId: string, nodeId: string): RestreamerNodeConfig | null {
    const inst = this.config.instances.find((i) => i.id === instanceId);
    return inst?.restreamer?.nodes.find((n) => n.id === nodeId) ?? null;
  }

  private nodeStatus(instanceId: string, nodeId: string): RestreamerNodeStatus | null {
    if (!this.cache.has(instanceId)) return null;
    return this.cache.get(instanceId).restreamers.find((r) => r.nodeId === nodeId) ?? null;
  }

  /** the first configured switcher whose polled status reports this slug */
  private switcherReport(slug: string): { switcherId: string; chan: SwitcherChannelStatus } | null {
    for (const sw of this.config.restreamer?.switchers ?? []) {
      const chan = this.cache.switchers.get(sw.id)?.channels.find((c) => c.slug === slug);
      if (chan) return { switcherId: sw.id, chan };
    }
    return null;
  }

  /**
   * Prune activation rows whose channel/placement no longer qualifies (channel
   * disabled/deleted, placement disabled, deleted or mode-flipped away from
   * 'cold'). FK cascades cover hard deletes; this covers the soft cases.
   * Returns the channel ids whose rows were removed.
   */
  private async pruneStaleActivations(): Promise<string[]> {
    const [activations, placements, channels] = await Promise.all([
      this.db.selectFrom('restream_cold_activations').selectAll().execute(),
      this.db
        .selectFrom('restream_placements')
        .select(['id', 'channel_id', 'enabled', 'mode'])
        .execute(),
      this.db.selectFrom('restream_channels').select(['id', 'enabled']).execute(),
    ]);
    const placementById = new Map(placements.map((p) => [p.id, p]));
    const channelById = new Map(channels.map((c) => [c.id, c]));
    const changed: string[] = [];
    for (const a of activations) {
      const p = placementById.get(a.placement_id);
      const c = channelById.get(a.channel_id);
      const valid =
        !!c && !!c.enabled && !!p && p.channel_id === a.channel_id && !!p.enabled && p.mode === 'cold';
      if (!valid) {
        await this.db
          .deleteFrom('restream_cold_activations')
          .where('channel_id', '=', a.channel_id)
          .execute();
        this.switchIssued.delete(a.channel_id);
        changed.push(a.channel_id);
      }
    }
    return changed;
  }

  /** startup hygiene: prune orphans only — no trigger evaluation, no pushes */
  async reconcileOnStartup(): Promise<string[]> {
    return this.pruneStaleActivations();
  }

  async tick(): Promise<ColdFailoverTickResult> {
    this.tickCount++;
    const changed = new Set<string>(await this.pruneStaleActivations());

    const [channels, placements, activations] = await Promise.all([
      this.db
        .selectFrom('restream_channels')
        .select(['id', 'slug', 'channel_name', 'channel_number'])
        .where('enabled', '=', 1)
        .execute(),
      this.db
        .selectFrom('restream_placements')
        .select([
          'id',
          'channel_id',
          'instance_id',
          'node_id',
          'priority',
          'enabled',
          'mode',
          'program_number',
        ])
        .orderBy('priority')
        .orderBy('id')
        .execute(),
      this.db.selectFrom('restream_cold_activations').selectAll().execute(),
    ]);
    const activationByChannel = new Map(activations.map((a) => [a.channel_id, a]));
    const byChannel = new Map<string, PlacementRow[]>();
    for (const p of placements) {
      let list = byChannel.get(p.channel_id);
      if (!list) byChannel.set(p.channel_id, (list = []));
      list.push(p);
    }
    const enabledChannelIds = new Set(channels.map((c) => c.id));

    // desired-session count per node for the admission cap: what computeNodeDoc
    // would include (enabled placements of enabled channels, hot or activated)
    const activatedPlacementIds = new Set(activations.map((a) => a.placement_id));
    const desiredCounts = new Map<string, number>();
    for (const p of placements) {
      if (!p.enabled || !enabledChannelIds.has(p.channel_id)) continue;
      if (p.mode !== 'hot' && !activatedPlacementIds.has(p.id)) continue;
      const key = nk(p.instance_id, p.node_id);
      desiredCounts.set(key, (desiredCounts.get(key) ?? 0) + 1);
    }

    // refresh admission ring-buffers for every node hosting an enabled cold
    // placement — deduped by lastPollAt so a 20s tick over a 15s poll never
    // double-counts one snapshot
    const coldNodes = new Set(
      placements
        .filter((p) => p.mode === 'cold' && p.enabled && enabledChannelIds.has(p.channel_id))
        .map((p) => nk(p.instance_id, p.node_id)),
    );
    for (const key of coldNodes) {
      const [instanceId, nodeId] = key.split('/') as [string, string];
      const status = this.nodeStatus(instanceId, nodeId);
      if (!status) continue;
      const rec = this.admissionHistories.get(key) ?? { lastPollAt: null, history: emptyHistory() };
      if (status.lastPollAt !== rec.lastPollAt) {
        this.admissionHistories.set(key, {
          lastPollAt: status.lastPollAt,
          history: recordSnapshot(rec.history, status),
        });
      }
    }
    for (const key of [...this.admissionHistories.keys()]) {
      if (!coldNodes.has(key)) this.admissionHistories.delete(key);
    }

    const probeHealth = this.deliveryHealth();
    const seenPreferredIds = new Set<string>();
    const inputs: ColdChannelInput[] = [];

    for (const c of channels) {
      const chanPlacements = byChannel.get(c.id) ?? [];
      const coldPlacements = chanPlacements.filter((p) => p.mode === 'cold' && !!p.enabled);
      const activation = activationByChannel.get(c.id) ?? null;
      if (!coldPlacements.length && !activation) continue;

      const identity = { channelName: c.channel_name, channelNumber: c.channel_number };
      const hots = chanPlacements.filter((p) => p.mode === 'hot' && !!p.enabled);
      const preferredRow = hots[0] ?? null; // rows are already in (priority, id) order

      const report = this.switcherReport(c.slug);

      let preferred: ColdChannelInput['preferred'] = null;
      if (preferredRow) {
        seenPreferredIds.add(preferredRow.id);
        const status = this.nodeStatus(preferredRow.instance_id, preferredRow.node_id);
        const session = status?.sessions.find((s) => s.name === c.slug) ?? null;
        const health = evalPreferredHealth({
          reachable: status?.reachable ?? false,
          session: session
            ? {
                state: session.state,
                consecutiveFailures: session.consecutiveFailures ?? 0,
                playlistLagSec: session.playlistLagSec ?? null,
              }
            : null,
        });
        const origin = serveOrigin(
          this.nodeConfig(preferredRow.instance_id, preferredRow.node_id)?.serveUrl,
        );
        const originSlow = origin ? (probeHealth.get(origin)?.slowStreak ?? 0) > 0 : false;

        const bump = (map: Map<string, number>, on: boolean): number => {
          const next = on ? (map.get(preferredRow.id) ?? 0) + 1 : 0;
          map.set(preferredRow.id, next);
          return next;
        };
        // recovery from a delivery-slow activation additionally requires the
        // probe to be healthy this tick — the encode being fine says nothing
        // about the cache path
        const recoveredThisTick =
          health.sessionHealthy &&
          (activation === null || coldReason(activation.reason) !== 'delivery-slow' || !originSlow);
        preferred = {
          placementId: preferredRow.id,
          sourceKey: this.resolveSource(
            preferredRow.instance_id,
            preferredRow.node_id,
            identity,
            preferredRow.program_number,
          ),
          serveOrigin: origin,
          nodeUnreachableStreak: bump(this.unreachableStreaks, health.nodeUnreachable),
          sessionUnhealthyStreak: bump(this.unhealthyStreaks, health.sessionUnhealthy),
          deliverySlowStreak: origin ? (probeHealth.get(origin)?.slowStreak ?? 0) : 0,
          sessionHealthyStreak: bump(this.healthyStreaks, recoveredThisTick),
        };
      }

      const otherHotHealthy = hots.slice(1).some((p) => {
        const status = this.nodeStatus(p.instance_id, p.node_id);
        const session = status?.sessions.find((s) => s.name === c.slug) ?? null;
        return evalPreferredHealth({
          reachable: status?.reachable ?? false,
          session: session
            ? {
                state: session.state,
                consecutiveFailures: session.consecutiveFailures ?? 0,
                playlistLagSec: session.playlistLagSec ?? null,
              }
            : null,
        }).sessionHealthy;
      });

      const candidates = coldPlacements.map((p) => {
        const nodeCfg = this.nodeConfig(p.instance_id, p.node_id);
        const status = this.nodeStatus(p.instance_id, p.node_id);
        const key = nk(p.instance_id, p.node_id);
        const admit = status
          ? canAdmitSession({
              status,
              history: this.admissionHistories.get(key)?.history ?? emptyHistory(),
              desiredSessionCount: (desiredCounts.get(key) ?? 0) + 1,
              maxSessions: nodeCfg?.maxSessions,
            })
          : ({ ok: false, reason: 'node-unreachable', detail: 'node never polled' } as const);
        return {
          placementId: p.id,
          priority: p.priority,
          sourceKey: this.resolveSource(p.instance_id, p.node_id, identity, p.program_number),
          serveOrigin: serveOrigin(nodeCfg?.serveUrl),
          admission: admit.ok
            ? ({ ok: true } as const)
            : ({ ok: false, detail: `${admit.reason}: ${admit.detail}` } as const),
        };
      });

      let activeColdReady = false;
      if (activation) {
        const coldRow = chanPlacements.find((p) => p.id === activation.placement_id);
        const coldSession = coldRow
          ? (this.nodeStatus(coldRow.instance_id, coldRow.node_id)?.sessions.find(
              (s) => s.name === c.slug,
            ) ?? null)
          : null;
        const upstreamHealthy =
          report?.chan.upstreams.find((u) => u.id === activation.placement_id)?.healthy === true;
        activeColdReady = coldSession?.state === 'running' && upstreamHealthy;
      }

      inputs.push({
        channelId: c.id,
        slug: c.slug,
        switcherReported: report !== null,
        switcherActiveUpstreamId: report?.chan.activeUpstreamId ?? null,
        preferred,
        otherHotHealthy,
        candidates,
        currentActivation: activation
          ? { placementId: activation.placement_id, reason: coldReason(activation.reason) }
          : null,
        activeColdReady,
      });
    }

    // drop streaks for preferred placements that no longer exist (reorder,
    // disable, delete) — the new preferred starts its streaks from zero
    for (const map of [this.unreachableStreaks, this.unhealthyStreaks, this.healthyStreaks]) {
      for (const id of [...map.keys()]) if (!seenPreferredIds.has(id)) map.delete(id);
    }

    const { actions, blocked } = planColdFailover(inputs);
    const slugByChannel = new Map(channels.map((c) => [c.id, c.slug]));

    for (const action of actions) {
      switch (action.type) {
        case 'activate': {
          await this.db
            .insertInto('restream_cold_activations')
            .values({
              channel_id: action.channelId,
              placement_id: action.placementId,
              preferred_placement_id: action.preferredPlacementId,
              reason: action.reason,
              activated_at: dbNow(),
              updated_at: dbNow(),
            })
            .execute();
          changed.add(action.channelId);
          console.error(
            `restreamer: cold backup ACTIVATED for "${slugByChannel.get(action.channelId)}" (${action.reason}) — placement ${action.placementId}`,
          );
          break;
        }
        case 'deactivate': {
          await this.db
            .deleteFrom('restream_cold_activations')
            .where('channel_id', '=', action.channelId)
            .where('placement_id', '=', action.placementId)
            .execute();
          this.switchIssued.delete(action.channelId);
          changed.add(action.channelId);
          console.error(
            `restreamer: cold backup deactivated for "${slugByChannel.get(action.channelId)}" — preferred recovered`,
          );
          break;
        }
        case 'switch':
        case 'switch-back': {
          const last = this.switchIssued.get(action.channelId);
          if (last?.to === action.toPlacementId && this.tickCount - last.tick < SWITCH_REISSUE_TICKS) {
            break; // already asked recently — give the switcher time
          }
          const report = this.switcherReport(action.slug);
          const client = report ? this.switcherClients.get(report.switcherId) : undefined;
          if (!client) break;
          try {
            await client.switchChannel(action.slug, action.toPlacementId);
            this.switchIssued.set(action.channelId, { to: action.toPlacementId, tick: this.tickCount });
          } catch (err) {
            console.error(
              `restreamer: cold-failover manual switch for "${action.slug}" failed:`,
              err,
            );
          }
          break;
        }
      }
    }

    return { changedChannelIds: [...changed], blocked };
  }
}

export { RECOVERY_DEBOUNCE_TICKS };
