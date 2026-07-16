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
 * Switcher-side sync: computes the global switcher desired doc (every enabled
 * channel → upstream lists from placements × node serveUrls), broadcasts it
 * over the switcher WebSocket hub with revision-skip semantics, and runs the
 * slow rebalance driver over the pure policy in ./rebalance.ts.
 *
 * NOT serialized itself — RestreamerService owns the op chain and calls the
 * *Inner methods from inside it, so switcher pushes interleave correctly with
 * mutations and node pushes.
 */

import { RESTREAMER_API_VERSION } from '@tvhc/shared';
import type {
  AribHlsParams,
  SwitcherChannel,
  SwitcherChannelStatus,
  SwitcherDesiredState,
  SwitcherUpstream,
} from '@tvhc/shared';
import type { AppConfig, RestreamerNodeConfig } from '../config.js';
import type { Db } from '../db/db.js';
import type { EventLog } from '../state/eventLog.js';
import type { InstanceCache } from '../state/instanceCache.js';
import {
  expectedChannelMbps,
  planRebalance,
  type RebalanceChannelInput,
  type RebalanceNodeInput,
} from './rebalance.js';
import { SWITCHER_CACHE_KEY, type SwitcherHubLike } from './switcherHubTypes.js';
import { sessionsHash } from './service.js';

export interface SwitcherBlockedEntry {
  channelId: string;
  slug: string;
  /** null = whole-channel reason (no usable upstreams) */
  placementId: string | null;
  reason: string;
}

export interface ComputedSwitcherDoc {
  doc: SwitcherDesiredState;
  blocked: SwitcherBlockedEntry[];
}

export interface SwitcherPushResult {
  action: 'pushed' | 'skipped' | 'error';
  detail?: string;
  blocked: SwitcherBlockedEntry[];
}

interface ChannelGroup {
  channelId: string;
  slug: string;
  profilePayload: string;
  placements: Array<{
    placementId: string;
    instanceId: string;
    nodeId: string;
    priority: number;
    mode: string;
  }>;
  /** true iff the channel's enabled placements contain no `mode='hot'` one — an idle on-demand channel */
  allCold: boolean;
  /** the failover row's to_placement_id, when a row exists (any phase); null = no row */
  rowTarget: string | null;
}

export class SwitcherSync {
  /**
   * Push fail/heal transition state: the last doc-computation error, or null
   * when the last pass succeeded. Only the null<->non-null transition is
   * event-logged.
   */
  private pushProblem: string | null = null;
  /**
   * Revision of the last doc handed to the hub; null = nothing broadcast
   * yet. In-memory only — the replicas persist the doc themselves and echo
   * its revision back in every status frame, so there is nothing durable for
   * the controller to track.
   */
  private lastBroadcastRevision: string | null = null;

  constructor(
    private readonly db: Db,
    private readonly cache: InstanceCache,
    private readonly config: AppConfig,
    private readonly hub: SwitcherHubLike,
    private readonly events: Pick<EventLog, 'log'> = { log: () => {} },
  ) {}

  private nodeConfig(instanceId: string, nodeId: string): RestreamerNodeConfig | null {
    const inst = this.config.instances.find((i) => i.id === instanceId);
    return inst?.restreamer?.nodes.find((n) => n.id === nodeId) ?? null;
  }

  /**
   * Enabled channels with ≥1 enabled placement, with placements in
   * (priority, id) order — the switcher's failover order. With a switcher
   * configured EVERY channel is fronted by it (uniform viewer URLs), so
   * single-placement channels are included too — they simply mirror their one
   * node.
   *
   * Inclusion per channel: every hot placement, plus a failover row's target
   * and its retained outgoing (NOTE the deliberate divergence from
   * computeNodeDoc: a suppressed outgoing placement — failover from_placement
   * — leaves its NODE doc, the encode stops, but stays a switcher upstream
   * for the row's whole lifetime; the switcher 404s segments of upstreams
   * absent from its doc while viewers' playlists still hold retained
   * seg/<old-id>/ URIs, the drain horizon being ~segmentSeconds × listSize;
   * an extra unhealthy upstream costs one probe fetch and is never
   * self-selected — the switcher has no autonomous failover). An ALL-COLD
   * channel (no enabled hot placement) additionally includes every enabled
   * cold placement even absent a row: an idle on-demand channel still needs
   * its upstreams resolvable so its M3U URL works and master-playlist
   * fetches are observable while the encode is down.
   */
  private async channelGroups(): Promise<ChannelGroup[]> {
    const [channelRows, placementRows, failoverRows] = await Promise.all([
      this.db
        .selectFrom('restream_channels as c')
        .innerJoin('restream_profiles as pr', 'pr.id', 'c.profile_id')
        .select(['c.id as channel_id', 'c.slug', 'pr.payload as profile_payload'])
        .where('c.enabled', '=', 1)
        .orderBy('c.slug')
        .execute(),
      this.db
        .selectFrom('restream_placements')
        .select(['id', 'channel_id', 'instance_id', 'node_id', 'priority', 'mode'])
        .where('enabled', '=', 1)
        .orderBy('channel_id')
        .orderBy('priority')
        .orderBy('id')
        .execute(),
      this.db
        .selectFrom('restream_failover_state')
        .select(['channel_id', 'from_placement_id', 'to_placement_id'])
        .execute(),
    ]);

    const rowByChannel = new Map(failoverRows.map((r) => [r.channel_id, r]));
    const placementsByChannel = new Map<string, typeof placementRows>();
    for (const p of placementRows) {
      let list = placementsByChannel.get(p.channel_id);
      if (!list) placementsByChannel.set(p.channel_id, (list = []));
      list.push(p);
    }

    return channelRows.map((c) => {
      const all = placementsByChannel.get(c.channel_id) ?? [];
      const hasHot = all.some((p) => p.mode === 'hot');
      const row = rowByChannel.get(c.channel_id) ?? null;
      const included = hasHot
        ? all.filter(
            (p) =>
              p.mode === 'hot' || p.id === row?.to_placement_id || p.id === row?.from_placement_id,
          )
        : all;
      return {
        channelId: c.channel_id,
        slug: c.slug,
        profilePayload: c.profile_payload,
        placements: included.map((p) => ({
          placementId: p.id,
          instanceId: p.instance_id,
          nodeId: p.node_id,
          priority: p.priority,
          mode: p.mode,
        })),
        allCold: !hasHot,
        rowTarget: row?.to_placement_id ?? null,
      };
    });
  }

  /**
   * Global switcher desired doc (one doc, pushed to every configured
   * switcher). Channels = enabled channels with ≥1 enabled placement;
   * upstreams = placements in priority order at `<node serveUrl>/<placement id>`.
   * Placements on unknown or serveUrl-less nodes are skipped with a reason; a
   * channel needs ≥1 usable upstream or it is skipped with a reason too.
   * Unlike node docs this never defers — no topology resolution is involved.
   *
   * `activeUpstreamId` is the controller's selection, in cascade order: a
   * failover row's target when it resolved to an emitted upstream, else the
   * preferred (lowest priority, id) emitted hot upstream, else — an idle
   * all-cold channel with no row — the lowest emitted upstream overall;
   * omitted only when the channel has no emitted upstream at all (impossible
   * once past the ≥1-upstream check below). `onDemandIdle` is set exactly on
   * an all-cold channel with no failover row — the switcher must not
   * health-probe those upstreams (the encode is down by design) and answers
   * playlist fetches with 503 until the controller wakes it; it is omitted
   * (not `false`) otherwise, keeping hot-channel doc hashes stable.
   *
   * NOTE: the ≥2→≥1 rule change (single-placement channels now included)
   * changes the doc hash on upgrade — harmless: the hash-skip push notices the
   * drift and re-pushes once, and the switcher's reconcile keeps running
   * channels untouched while adding the new ones.
   */
  async computeDoc(): Promise<ComputedSwitcherDoc> {
    const groups = await this.channelGroups();
    const channels: SwitcherChannel[] = [];
    const blocked: SwitcherBlockedEntry[] = [];

    for (const g of groups) {
      const upstreams: SwitcherUpstream[] = [];
      for (const p of g.placements) {
        const nodeCfg = this.nodeConfig(p.instanceId, p.nodeId);
        if (!nodeCfg) {
          blocked.push({
            channelId: g.channelId,
            slug: g.slug,
            placementId: p.placementId,
            reason: `restreamer node "${p.nodeId}" is not configured on instance ${p.instanceId}`,
          });
          continue;
        }
        if (!nodeCfg.serveUrl) {
          blocked.push({
            channelId: g.channelId,
            slug: g.slug,
            placementId: p.placementId,
            reason: `node ${p.instanceId}/${p.nodeId} has no serveUrl — unusable as a switcher upstream`,
          });
          continue;
        }
        upstreams.push({
          id: p.placementId,
          url: `${nodeCfg.serveUrl}/${p.placementId}`,
          priority: p.priority,
        });
      }
      if (upstreams.length < 1) {
        blocked.push({
          channelId: g.channelId,
          slug: g.slug,
          placementId: null,
          reason: 'no usable upstreams — channel left out of the switcher doc',
        });
        continue;
      }

      const emitted = new Set(upstreams.map((u) => u.id));
      let activeUpstreamId: string | undefined;
      if (g.rowTarget && emitted.has(g.rowTarget)) {
        activeUpstreamId = g.rowTarget;
      } else {
        const preferredHot = g.placements.find((p) => p.mode === 'hot' && emitted.has(p.placementId));
        const fallback = preferredHot ?? g.placements.find((p) => emitted.has(p.placementId));
        activeUpstreamId = fallback?.placementId;
      }
      const onDemandIdle = g.allCold && g.rowTarget === null ? true : undefined;

      const payload = JSON.parse(g.profilePayload) as AribHlsParams;
      channels.push({
        slug: g.slug,
        segmentSeconds: payload.hls?.segmentSeconds ?? 5,
        upstreams,
        ...(activeUpstreamId !== undefined ? { activeUpstreamId } : {}),
        ...(onDemandIdle !== undefined ? { onDemandIdle } : {}),
      });
    }

    channels.sort((a, b) => a.slug.localeCompare(b.slug));
    const doc: SwitcherDesiredState = {
      apiVersion: RESTREAMER_API_VERSION,
      revision: sessionsHash(channels),
      channels,
    };
    return { doc, blocked };
  }

  /**
   * Broadcast the desired doc to every connected replica, skipping when the
   * revision matches the last broadcast (`force` bypasses the skip). A doc
   * that fails to compute logs the fail/heal transition; the broadcast
   * itself cannot fail — replicas that are offline simply receive the doc on
   * reconnect (the hub pushes it as its first frame).
   */
  async pushAllInner(force = false): Promise<SwitcherPushResult> {
    if (!this.config.restreamer?.switcher) return { action: 'skipped', detail: 'no switcher configured', blocked: [] };
    const prevError = this.pushProblem;
    let computed: ComputedSwitcherDoc;
    try {
      computed = await this.computeDoc();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.pushProblem = detail;
      this.logSwitcherPushTransition(prevError, detail);
      return { action: 'error', detail, blocked: [] };
    }
    this.pushProblem = null;
    this.logSwitcherPushTransition(prevError, null);
    const { doc, blocked } = computed;
    if (!force && doc.revision === this.lastBroadcastRevision) {
      return { action: 'skipped', detail: 'already up to date', blocked };
    }
    // nothing broadcast yet and nothing to serve: broadcasting an empty doc
    // would tear down whatever the replicas are still serving from their
    // persisted doc before the DB-backed channels have been recreated
    if (this.lastBroadcastRevision === null && doc.channels.length === 0) {
      return { action: 'skipped', detail: 'nothing to manage', blocked };
    }
    this.hub.broadcastDoc(doc);
    this.lastBroadcastRevision = doc.revision;
    return { action: 'pushed', blocked };
  }

  /**
   * Switcher push failed/healed: logs only on the null<->non-null transition
   * — a still-failing doc computation retried by the 60s sweep must not spam
   * a new warning every cycle.
   */
  private logSwitcherPushTransition(prevError: string | null, newError: string | null): void {
    if ((prevError === null) === (newError === null)) return;
    if (newError !== null) {
      this.events.log({ type: 'warning', service: 'restreamer', source: 'switcher', message: `switcher doc push failed: ${newError}` });
    } else {
      this.events.log({ type: 'normal', service: 'restreamer', source: 'switcher', message: 'switcher doc push recovered' });
    }
  }

  /** revision the replicas are expected to report (the last broadcast doc's) */
  getExpectedRevision(): string | null {
    return this.lastBroadcastRevision;
  }

  // ---------- rebalance driver ----------

  /** the hub's aggregate status entry for this slug */
  private switcherForSlug(slug: string): SwitcherChannelStatus | null {
    return (
      this.cache.switchers.get(SWITCHER_CACHE_KEY)?.channels.find((c) => c.slug === slug) ?? null
    );
  }

  /**
   * One rebalance evaluation: build the pure-policy input from the DB
   * (switcher-fronted channels + profile bitrates), the hub's aggregate
   * switcher status (active upstream, per-upstream health, last switch) and
   * the config egress budgets, then hand the proposed move (at most one per
   * pass) to `requestMove` — RestreamerService routes it through the
   * serialized failover procedure (reason 'rebalance'), never at the
   * switcher directly, so rebalance moves obey the same one-at-a-time
   * ordering as failovers. Channels the switcher does not report yet are
   * never rebalanced; single-upstream channels contribute load but have no
   * alternative targets. Failures are logged, never thrown.
   */
  async rebalanceTickInner(
    nowDate: Date,
    requestMove: (channelId: string, toPlacementId: string, slug: string) => Promise<void>,
  ): Promise<void> {
    if (!this.config.restreamer?.switcher) return;

    const groups = await this.channelGroups();
    const channels: RebalanceChannelInput[] = [];
    for (const g of groups) {
      const found = this.switcherForSlug(g.slug);
      if (!found) continue; // never rebalance a channel the switcher doesn't know yet
      const health = new Map(found.upstreams.map((u) => [u.id, u.healthy]));
      const payload = JSON.parse(g.profilePayload) as AribHlsParams;
      channels.push({
        slug: g.slug,
        channelId: g.channelId,
        expectedMbps: expectedChannelMbps(payload),
        activePlacementId: found.activeUpstreamId,
        lastSwitchAt: found.lastSwitch?.at ?? null,
        upstreams: g.placements.map((p) => ({
          placementId: p.placementId,
          instanceId: p.instanceId,
          nodeId: p.nodeId,
          priority: p.priority,
          // an upstream the switcher doesn't report is never a move target
          healthy: health.get(p.placementId) ?? false,
        })),
      });
    }

    const nodes: RebalanceNodeInput[] = [];
    for (const inst of this.config.instances) {
      for (const n of inst.restreamer?.nodes ?? []) {
        nodes.push({ instanceId: inst.id, nodeId: n.id, egressMbps: n.egressMbps ?? null });
      }
    }

    const moves = planRebalance({ channels, nodes, now: nowDate });
    const channelIdBySlug = new Map(channels.map((c) => [c.slug, c.channelId]));
    for (const move of moves) {
      const channelId = channelIdBySlug.get(move.slug);
      if (!channelId) continue;
      // controller-automatic, so always logged (never a user-initiated action)
      const source = 'switcher';
      try {
        await requestMove(channelId, move.toPlacementId, move.slug);
        console.log(
          `restreamer: rebalance queued "${move.slug}" → placement ${move.toPlacementId} (via failover procedure)`,
        );
        this.events.log({
          type: 'normal',
          service: 'restreamer',
          source,
          message: `rebalance queued "${move.slug}" → placement ${move.toPlacementId}`,
        });
      } catch (err) {
        console.error(`restreamer: rebalance move of "${move.slug}" failed:`, err);
        this.events.log({
          type: 'warning',
          service: 'restreamer',
          source,
          message: `rebalance move of "${move.slug}" failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }
}
