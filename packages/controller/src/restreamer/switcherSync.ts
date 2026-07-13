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
 * channel → upstream lists from placements × node serveUrls), pushes it with
 * the same hash-skip/upsert/error semantics as node pushes
 * (`restream_switcher_state` parallel to `restream_node_state`), and runs the
 * slow rebalance driver over the pure policy in ./rebalance.ts.
 *
 * NOT serialized itself — RestreamerService owns the op chain and calls the
 * *Inner methods from inside it, so switcher pushes interleave correctly with
 * mutations and node pushes.
 */

import { RESTREAMER_API_VERSION } from '@tvhc/shared';
import type {
  PipelineParams,
  SwitcherChannel,
  SwitcherChannelStatus,
  SwitcherDesiredState,
  SwitcherNodeStatus,
  SwitcherUpstream,
} from '@tvhc/shared';
import type { AppConfig, RestreamerNodeConfig } from '../config.js';
import type { Db } from '../db/db.js';
import type { EventLog } from '../state/eventLog.js';
import type { EventBus } from '../state/events.js';
import type { InstanceCache } from '../state/instanceCache.js';
import type { SwitcherClient } from './client.js';
import {
  expectedChannelMbps,
  planRebalance,
  type RebalanceChannelInput,
  type RebalanceNodeInput,
} from './rebalance.js';
import { sessionsHash } from './service.js';

/** the client surface the sync actually uses (fakes implement exactly this) */
export type SwitcherNodeClient = Pick<SwitcherClient, 'putDesired' | 'switchChannel'>;

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
  switcherId: string;
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
  }>;
}

function now(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

export class SwitcherSync {
  /**
   * Site #11 (switcher push failed/healed) transition state, keyed by
   * switcherId. NOT read from cache.switchers.get(id)?.error — the
   * SwitcherPoller overwrites that field every tick with its own reachability
   * error, independent of push outcomes, so reading it here would spam or
   * suppress the transition log depending on unrelated poll timing.
   */
  private readonly pushProblems = new Map<string, string | null>();

  constructor(
    private readonly db: Db,
    private readonly cache: InstanceCache,
    private readonly bus: EventBus,
    private readonly config: AppConfig,
    /** keyed by switcherId */
    private readonly clients: Map<string, SwitcherNodeClient>,
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
   */
  private async channelGroups(): Promise<ChannelGroup[]> {
    // NOTE the deliberate divergence from computeNodeDoc: a suppressed
    // outgoing placement (failover from_placement) leaves its NODE doc (the
    // encode stops) but stays a switcher upstream for the failover row's
    // whole lifetime — the switcher 404s segments of upstreams absent from
    // its doc while viewers' playlists still hold retained seg/<old-id>/ URIs
    // (the drain horizon is ~segmentSeconds × listSize). An extra unhealthy
    // upstream costs one probe fetch and is never self-selected (the switcher
    // has no autonomous failover).
    const rows = await this.db
      .selectFrom('restream_placements as p')
      .innerJoin('restream_channels as c', 'c.id', 'p.channel_id')
      .innerJoin('restream_profiles as pr', 'pr.id', 'c.profile_id')
      .leftJoin('restream_failover_state as fs', 'fs.to_placement_id', 'p.id')
      .leftJoin('restream_failover_state as fsFrom', 'fsFrom.from_placement_id', 'p.id')
      .select([
        'p.id as placement_id',
        'p.instance_id',
        'p.node_id',
        'p.priority',
        'c.id as channel_id',
        'c.slug',
        'pr.payload as profile_payload',
      ])
      .where('p.enabled', '=', 1)
      .where('c.enabled', '=', 1)
      // hot, or a failover target (cold activation), or a retained outgoing
      .where((eb) =>
        eb.or([
          eb('p.mode', '=', 'hot'),
          eb('fs.to_placement_id', 'is not', null),
          eb('fsFrom.from_placement_id', 'is not', null),
        ]),
      )
      .orderBy('c.slug')
      .orderBy('p.priority')
      .orderBy('p.id')
      .execute();

    const byChannel = new Map<string, ChannelGroup>();
    for (const r of rows) {
      let group = byChannel.get(r.channel_id);
      if (!group) {
        group = {
          channelId: r.channel_id,
          slug: r.slug,
          profilePayload: r.profile_payload,
          placements: [],
        };
        byChannel.set(r.channel_id, group);
      }
      group.placements.push({
        placementId: r.placement_id,
        instanceId: r.instance_id,
        nodeId: r.node_id,
        priority: r.priority,
      });
    }
    return [...byChannel.values()];
  }

  /**
   * Global switcher desired doc (one doc, pushed to every configured
   * switcher). Channels = enabled channels with ≥1 enabled placement;
   * upstreams = placements in priority order at `<node serveUrl>/<slug>`.
   * Placements on unknown or serveUrl-less nodes are skipped with a reason; a
   * channel needs ≥1 usable upstream or it is skipped with a reason too.
   * Unlike node docs this never defers — no topology resolution is involved.
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
          url: `${nodeCfg.serveUrl}/${g.slug}`,
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
      const payload = JSON.parse(g.profilePayload) as PipelineParams;
      channels.push({
        slug: g.slug,
        segmentSeconds: payload.hls?.segmentSeconds ?? 5,
        upstreams,
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

  private state(switcherId: string): Promise<{ pushed_hash: string } | undefined> {
    return this.db
      .selectFrom('restream_switcher_state')
      .select('pushed_hash')
      .where('switcher_id', '=', switcherId)
      .executeTakeFirst();
  }

  /** push one switcher; semantics mirror RestreamerService.pushNodeInner */
  async pushInner(
    switcherId: string,
    force = false,
    precomputed?: ComputedSwitcherDoc,
  ): Promise<SwitcherPushResult> {
    // site #11: switcher push failed/healed — read the dedicated
    // pushProblems entry BEFORE this attempt overwrites it, mirroring
    // pushNodeInner (site #7)
    const prevError = this.pushProblems.get(switcherId) ?? null;
    try {
      const { doc, blocked } = precomputed ?? (await this.computeDoc());
      const state = await this.state(switcherId);
      if (!force && state?.pushed_hash === doc.revision) {
        this.updateStatus(switcherId, { pendingPush: false });
        return { switcherId, action: 'skipped', detail: 'already up to date', blocked };
      }
      // never-pushed switcher with nothing to serve: leave it alone — pushing
      // an empty doc to an unmanaged switcher would tear down whatever it does
      if (!state && doc.channels.length === 0) {
        return { switcherId, action: 'skipped', detail: 'nothing to manage', blocked };
      }
      const client = this.clients.get(switcherId);
      if (!client) {
        this.updateStatus(switcherId, { pendingPush: true, error: 'no client configured for switcher' });
        this.pushProblems.set(switcherId, 'no client configured for switcher');
        this.logSwitcherPushTransition(switcherId, prevError, 'no client configured for switcher');
        return { switcherId, action: 'error', detail: 'no client configured for switcher', blocked };
      }
      await client.putDesired(doc);
      await this.db
        .insertInto('restream_switcher_state')
        .values({ switcher_id: switcherId, pushed_hash: doc.revision, pushed_at: now() })
        .onDuplicateKeyUpdate({ pushed_hash: doc.revision, pushed_at: now() })
        .execute();
      this.updateStatus(switcherId, { pendingPush: false, error: null });
      this.pushProblems.set(switcherId, null);
      this.logSwitcherPushTransition(switcherId, prevError, null);
      return { switcherId, action: 'pushed', blocked };
    } catch (err) {
      // failed push: the stored hash stays, the switcher stays pending — the
      // 60s sweep (or the poller's revision-mismatch trigger) heals it later
      const detail = err instanceof Error ? err.message : String(err);
      this.updateStatus(switcherId, { pendingPush: true, error: detail });
      this.pushProblems.set(switcherId, detail);
      this.logSwitcherPushTransition(switcherId, prevError, detail);
      return { switcherId, action: 'error', detail, blocked: [] };
    }
  }

  /**
   * Site #11 (switcher push failed/healed): logs only on the null<->non-null
   * transition, mirroring site #7 — a still-failing switcher retried by the
   * 60s sweep must not spam a new warning every cycle.
   */
  private logSwitcherPushTransition(
    switcherId: string,
    prevError: string | null,
    newError: string | null,
  ): void {
    if ((prevError === null) === (newError === null)) return;
    const source = `switcher.${switcherId}`;
    if (newError !== null) {
      this.events.log({ type: 'warning', service: 'restreamer', source, message: `push to ${source} failed: ${newError}` });
    } else {
      this.events.log({ type: 'normal', service: 'restreamer', source, message: `push to ${source} recovered` });
    }
  }

  /** one shared doc computation per pass — every switcher gets the same doc */
  async pushAllInner(force = false): Promise<SwitcherPushResult[]> {
    const switchers = this.config.restreamer?.switchers ?? [];
    if (!switchers.length) return [];
    let computed: ComputedSwitcherDoc | undefined;
    try {
      computed = await this.computeDoc();
    } catch (err) {
      // doc computation failed (database down): every switcher reports error
      const detail = err instanceof Error ? err.message : String(err);
      return switchers.map((sw) => ({
        switcherId: sw.id,
        action: 'error' as const,
        detail,
        blocked: [],
      }));
    }
    const results: SwitcherPushResult[] = [];
    for (const sw of switchers) {
      results.push(await this.pushInner(sw.id, force, computed));
    }
    return results;
  }

  /**
   * True when the computed doc differs from what the controller believes is
   * pushed (twin of RestreamerService.getPendingPush, sans defer states).
   */
  async getPendingPush(switcherId: string): Promise<boolean> {
    const { doc } = await this.computeDoc();
    const state = await this.state(switcherId);
    if (!state) return doc.channels.length > 0;
    return state.pushed_hash !== doc.revision;
  }

  /** revision the switcher is expected to report (its last pushed doc hash) */
  async getExpectedRevision(switcherId: string): Promise<string | null> {
    const state = await this.state(switcherId);
    return state?.pushed_hash ?? null;
  }

  /** patch a switcher's cached status and publish SSE `restreamer-switcher` on change */
  private updateStatus(switcherId: string, patch: Partial<SwitcherNodeStatus>): void {
    const current = this.cache.switchers.get(switcherId);
    if (!current) return; // poller hasn't polled yet — its next tick reflects the state
    const next = { ...current, ...patch };
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    this.cache.switchers.set(switcherId, next);
    this.bus.publish({ type: 'restreamer-switcher', data: next });
  }

  // ---------- rebalance driver ----------

  /** first configured switcher whose polled status reports this slug */
  private switcherForSlug(
    slug: string,
  ): { switcherId: string; channel: SwitcherChannelStatus } | null {
    for (const sw of this.config.restreamer?.switchers ?? []) {
      const channel = this.cache.switchers.get(sw.id)?.channels.find((c) => c.slug === slug);
      if (channel) return { switcherId: sw.id, channel };
    }
    return null;
  }

  /**
   * One rebalance evaluation: build the pure-policy input from the DB
   * (switcher-fronted channels + profile bitrates), the switchers' polled
   * status (active upstream, per-upstream health, last switch) and the config
   * egress budgets, then hand the proposed move (at most one per pass) to
   * `requestMove` — RestreamerService routes it through the serialized
   * failover procedure (reason 'rebalance'), never at the switcher directly,
   * so rebalance moves obey the same one-at-a-time ordering as failovers.
   * Channels the switcher does not report yet are never rebalanced;
   * single-upstream channels contribute load but have no alternative targets.
   * Failures are logged, never thrown.
   */
  async rebalanceTickInner(
    nowDate: Date,
    requestMove: (channelId: string, toPlacementId: string, slug: string) => Promise<void>,
  ): Promise<void> {
    const switchers = this.config.restreamer?.switchers ?? [];
    if (!switchers.length) return;

    const groups = await this.channelGroups();
    const channels: RebalanceChannelInput[] = [];
    const switcherBySlug = new Map<string, string>();
    for (const g of groups) {
      const found = this.switcherForSlug(g.slug);
      if (!found) continue; // never rebalance a channel the switcher doesn't know yet
      switcherBySlug.set(g.slug, found.switcherId);
      const health = new Map(found.channel.upstreams.map((u) => [u.id, u.healthy]));
      const payload = JSON.parse(g.profilePayload) as PipelineParams;
      channels.push({
        slug: g.slug,
        channelId: g.channelId,
        expectedMbps: expectedChannelMbps(payload),
        activePlacementId: found.channel.activeUpstreamId,
        lastSwitchAt: found.channel.lastSwitch?.at ?? null,
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
      // site #11: rebalance move queued/failed — controller-automatic, so
      // always logged (never a user-initiated action)
      const source = `switcher.${switcherBySlug.get(move.slug) ?? 'unknown'}`;
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
