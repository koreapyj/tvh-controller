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
 * Failover orchestration (impure successor to coldFailoverSync.ts): drives
 * the persisted per-channel procedure of failoverPolicy.ts.
 *
 * - Triggers: instance-level (liveness / underspeed probe `failed` on the
 *   node hosting a channel's ACTIVE placement) and channel-level (lag probe
 *   `failed` on the active placement itself), plus manual placement
 *   selection, reset (fail-back) and rebalance moves — ALL enter the same
 *   queue and run the identical procedure.
 * - Strict global FIFO: one procedure (hence at most one ffmpeg bring-up)
 *   in flight at any moment. Latency is recovered inside a procedure: each
 *   tick() advances through every phase whose precondition already holds.
 * - Every action is re-derivable from the persisted restream_failover_state
 *   row, so reconcileOnStartup() resumes mid-procedure safely. Queue order,
 *   probe streak state and timeout anchors are in-memory (reset = only ever
 *   more conservative). Timeout anchors are re-seeded at resume — never
 *   derived from persisted timestamps, or a restart mid-wait would time out
 *   instantly.
 *
 * All entry points are called from inside RestreamerService's op chain
 * (tick / request* wrappers serialize there), mirroring SwitcherSync.
 */

import { randomUUID } from 'node:crypto';
import type {
  AribHlsParams,
  FailoverPhase,
  FailoverTriggerReason,
  NodeProbeSettings,
} from '@tvhc/shared';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/db.js';
import type { RestreamFailoverStateTable } from '../db/schema.js';
import type { EventLog } from '../state/eventLog.js';
import type { InstanceCache } from '../state/instanceCache.js';
import { httpError } from '../util/httpError.js';
import {
  canAdmitSession,
  emptyHistory,
  recordSnapshot,
  type AdmissionHistory,
} from './admission.js';
import {
  LAG_DISCOVERY_TIMEOUT_MS,
  RETRIGGER_BACKOFF_MAX_MS,
  RETRIGGER_BACKOFF_MIN_MS,
  SWITCH_REISSUE_MS,
  STOP_CONFIRM_TIMEOUT_MS,
  midProcedure,
  pastCommitPoint,
  planFailoverStep,
  rejectionSummary,
  selectTarget,
  type FailoverCandidate,
} from './failoverPolicy.js';
import type { ProbeSnapshot } from './probeEngine.js';
import { sessionNameFor } from './sessionName.js';
import { SWITCHER_CACHE_KEY, type SwitcherHubLike } from './switcherHubTypes.js';

export { FAILOVER_TICK_MS } from './failoverPolicy.js';

/** node refs whose desired docs must be re-pushed after a state change */
export interface FailoverNodeRef {
  instanceId: string;
  nodeId: string;
}

/** side-effect hooks (RestreamerService methods, already inside the op chain) */
export interface FailoverSyncHooks {
  pushNodes(nodes: FailoverNodeRef[]): Promise<void>;
  pushSwitchers(): Promise<void>;
  publishChannel(channelId: string): void;
  /** cutover complete: promote the clone (transient=1 -> 0) into a permanent, ordinary placement */
  markCutoverComplete?(placementId: string): Promise<void>;
  /** cutover abort/drain cleanup: delete a placement (+ its orphaned transient profile, if any) */
  deleteCutoverPlacement?(placementId: string): Promise<void>;
}

export type ResetOutcome =
  | { ok: true; aborted?: true; already?: true; queued?: true; cleared?: true }
  | { rejected: 'rejected-mid-procedure' | 'requires-confirm'; message: string };

interface QueueItem {
  channelId: string;
  reason: FailoverTriggerReason;
  detail: string;
  /** instance-level triggers record the failing node for reset's trigger re-check */
  triggerNodeId: string | null;
  /** manual selection / rebalance name their target explicitly */
  explicitTargetId?: string;
  /** skip the admission gate on an explicit target */
  force?: boolean;
}

interface ChannelRow {
  id: string;
  slug: string;
  profile_payload: string;
}

interface PlacementRow {
  id: string;
  channel_id: string;
  instance_id: string;
  node_id: string;
  priority: number;
  enabled: number;
  mode: string;
  /** 1 = a cutover-owned transient clone — machinery-owned, never inferred as "active" */
  transient: number;
}

type FailoverRow = Omit<
  RestreamFailoverStateTable,
  'phase' | 'drain_until' | 'started_at' | 'updated_at'
> & {
  phase: FailoverPhase;
  drain_until: Date | string | null;
  started_at: Date | string;
  updated_at: Date | string;
};

interface TickData {
  channels: Map<string, ChannelRow>;
  /** all placements of enabled channels, (priority, id) ordered */
  placementsByChannel: Map<string, PlacementRow[]>;
  placementById: Map<string, PlacementRow>;
  rows: Map<string, FailoverRow>;
  /** desired-session count per nodeKey (doc inclusion incl. suppression) */
  desiredCounts: Map<string, number>;
  /** per-node session cap from restream_node_settings; absent key = uncapped */
  capacity: Map<string, number | null>;
}

function nk(instanceId: string, nodeId: string): string {
  return `${instanceId}/${nodeId}`;
}

function dbNow(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function asMs(v: Date | string | null): number | null {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  // naive 'YYYY-MM-DD HH:MM:SS' column values are UTC by construction (dbNow);
  // a bare Date.parse would read them in the machine's LOCAL timezone
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v) ? `${v.replace(' ', 'T')}Z` : v;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export class FailoverSync {
  private readonly queue: QueueItem[] = [];
  private readonly queuedIds = new Set<string>();
  private active: string | null = null;
  /** current procedure's timeout anchor (re-seeded at resume) */
  private phaseEnteredAtMs = 0;
  /** targets already tried in the current procedure */
  private tried = new Set<string>();
  private lastSwitchIssueMs = 0;
  /** channel → no-eligible-target reason (drives the ⚠ blocked badge) */
  private readonly blocked = new Map<string, string>();
  /** exhausted-candidates re-trigger backoff */
  private readonly retriggerBackoff = new Map<string, { untilMs: number; delayMs: number }>();
  /** admission ring-buffers keyed by nodeKey; samples deduped by poll timestamp */
  private readonly admissionHistories = new Map<
    string,
    { lastPollAt: string | null; history: AdmissionHistory }
  >();

  constructor(
    private readonly db: Db,
    private readonly cache: InstanceCache,
    private readonly config: AppConfig,
    private readonly hub: SwitcherHubLike,
    private readonly probes: () => ProbeSnapshot,
    private readonly settings: () => Promise<Map<string, NodeProbeSettings>>,
    private readonly hooks: FailoverSyncHooks,
    private readonly now: () => Date = () => new Date(),
    private readonly events: Pick<EventLog, 'log'> = { log: () => {} },
  ) {}

  /** why the last trigger for a channel could not start a failover; null = n/a */
  blockedReason(channelId: string): string | null {
    return this.blocked.get(channelId) ?? null;
  }

  /**
   * Explicit operator dismiss of the ⚠ blocked badge. UI-only: it does not
   * touch the retrigger backoff or attempt a new failover, it just stops
   * showing a message about a past attempt (requestFailover already covers
   * "try again" — a subsequent attempt overwrites the message on its own
   * failure, or clears it on success via beginNext).
   */
  clearBlocked(channelId: string): boolean {
    const had = this.blocked.delete(channelId);
    if (had) this.hooks.publishChannel(channelId);
    return had;
  }

  activeChannelId(): string | null {
    return this.active;
  }

  // -------------------------------------------------------------------------
  // data loading
  // -------------------------------------------------------------------------

  private async loadData(): Promise<TickData> {
    const [channels, placements, rows, settings] = await Promise.all([
      this.db
        .selectFrom('restream_channels as c')
        .innerJoin('restream_profiles as pr', 'pr.id', 'c.profile_id')
        .select(['c.id', 'c.slug', 'pr.payload as profile_payload'])
        .where('c.enabled', '=', 1)
        .execute(),
      this.db
        .selectFrom('restream_placements')
        .select(['id', 'channel_id', 'instance_id', 'node_id', 'priority', 'enabled', 'mode', 'transient'])
        .orderBy('priority')
        .orderBy('id')
        .execute(),
      this.db.selectFrom('restream_failover_state').selectAll().execute(),
      this.db.selectFrom('restream_node_settings').select(['instance_id', 'node_id', 'max_sessions']).execute(),
    ]);
    const channelMap = new Map(channels.map((c) => [c.id, c]));
    const placementsByChannel = new Map<string, PlacementRow[]>();
    const placementById = new Map<string, PlacementRow>();
    for (const p of placements) {
      placementById.set(p.id, p);
      if (!channelMap.has(p.channel_id)) continue;
      let list = placementsByChannel.get(p.channel_id);
      if (!list) placementsByChannel.set(p.channel_id, (list = []));
      list.push(p);
    }
    const rowMap = new Map(rows.map((r) => [r.channel_id, r as FailoverRow]));

    // per-node desired-session counts, mirroring computeNodeDoc's inclusion
    const desiredCounts = new Map<string, number>();
    for (const p of placements) {
      if (!p.enabled || !channelMap.has(p.channel_id)) continue;
      const row = rowMap.get(p.channel_id);
      const isTo = row?.to_placement_id === p.id;
      const isFrom = row?.from_placement_id === p.id;
      const suppressed =
        isFrom &&
        !!row?.suppress_from &&
        ['stopping-old', 'awaiting-stop-confirm', 'complete', 'draining'].includes(row.phase);
      if (((p.mode === 'hot' || isFrom) && !suppressed) || isTo) {
        const key = nk(p.instance_id, p.node_id);
        desiredCounts.set(key, (desiredCounts.get(key) ?? 0) + 1);
      }
    }

    const capacity = new Map(settings.map((s) => [nk(s.instance_id, s.node_id), s.max_sessions]));

    return {
      channels: channelMap,
      placementsByChannel,
      placementById,
      rows: rowMap,
      desiredCounts,
      capacity,
    };
  }

  /**
   * The placement a channel is currently served from: a failover row's target
   * wins (it IS the selection once a procedure exists), else the switcher's
   * reported active upstream, else the preferred (lowest-(priority,id))
   * enabled hot placement.
   *
   * The switcher-report fallback only honors a HOT placement: a cold one is
   * only ever active via a failover row — which the first fallback already
   * covers — so a cold id in the switcher's report is the doc's pre-seeded
   * idle selection (embedded activeUpstreamId), not a running encode.
   * An idle all-cold channel therefore resolves to null (the third fallback
   * requires hot too): scanTriggers skips it, and an on-demand start begins
   * with from=null, leaving every enabled placement a candidate so
   * selectTarget picks the preferred one.
   *
   * The third fallback never returns a transient (cutover-owned) placement —
   * it starts tied with `from` on (priority, mode='hot'), so an unguarded
   * tie-break could pick the clone and make requestFailover treat the
   * cutover's own target as already-active, silently dropping the request.
   */
  private activePlacementOf(data: TickData, channelId: string): PlacementRow | null {
    const row = data.rows.get(channelId);
    if (row) {
      const to = data.placementById.get(row.to_placement_id);
      if (to) return to;
    }
    const slug = data.channels.get(channelId)?.slug;
    if (slug) {
      const chan = this.cache.switchers
        .get(SWITCHER_CACHE_KEY)
        ?.channels.find((c) => c.slug === slug);
      if (chan?.activeUpstreamId) {
        const p = data.placementById.get(chan.activeUpstreamId);
        if (p && p.channel_id === channelId && p.mode === 'hot') return p;
      }
    }
    const list = data.placementsByChannel.get(channelId) ?? [];
    return list.find((p) => !!p.enabled && p.mode === 'hot' && !p.transient) ?? null;
  }

  /**
   * The channel's steady-state ("natural") placement: preferred enabled hot,
   * else the first enabled placement (all-cold channel) — same blind spot as
   * activePlacementOf's third fallback, so transient placements are excluded
   * here too. Used only to decide whether a completed/reset procedure landed
   * back on the channel's real steady state, never as a failover candidate
   * source.
   */
  private naturalPlacementOf(placements: PlacementRow[]): PlacementRow | null {
    const real = placements.filter((p) => !p.transient);
    return real.find((p) => p.mode === 'hot') ?? real[0] ?? null;
  }

  private switcherReport(slug: string): { activeUpstreamId: string | null } | null {
    const chan = this.cache.switchers
      .get(SWITCHER_CACHE_KEY)
      ?.channels.find((c) => c.slug === slug);
    return chan ? { activeUpstreamId: chan.activeUpstreamId } : null;
  }

  /** the switcher's own health/lag view of one upstream (lag-probe-disabled fallback) */
  private switcherUpstreamReport(
    slug: string,
    upstreamId: string,
  ): { healthy: boolean; playlistLagSec?: number } | null {
    const chan = this.cache.switchers
      .get(SWITCHER_CACHE_KEY)
      ?.channels.find((c) => c.slug === slug);
    return chan?.upstreams.find((u) => u.id === upstreamId) ?? null;
  }

  // -------------------------------------------------------------------------
  // admission
  // -------------------------------------------------------------------------

  private refreshAdmissionHistories(data: TickData): void {
    const nodes = new Set<string>();
    for (const list of data.placementsByChannel.values()) {
      for (const p of list) if (p.enabled) nodes.add(nk(p.instance_id, p.node_id));
    }
    for (const key of nodes) {
      const [instanceId, nodeId] = key.split('/') as [string, string];
      const status = this.cache.has(instanceId)
        ? (this.cache.get(instanceId).restreamers.find((r) => r.nodeId === nodeId) ?? null)
        : null;
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
      if (!nodes.has(key)) this.admissionHistories.delete(key);
    }
  }

  private candidateOf(data: TickData, p: PlacementRow): FailoverCandidate {
    const key = nk(p.instance_id, p.node_id);
    const status = this.cache.has(p.instance_id)
      ? (this.cache.get(p.instance_id).restreamers.find((r) => r.nodeId === p.node_id) ?? null)
      : null;
    // a placement already included in the docs costs no extra session slot
    const row = data.rows.get(p.channel_id);
    const isFrom = row?.from_placement_id === p.id;
    const suppressed =
      isFrom &&
      !!row?.suppress_from &&
      ['stopping-old', 'awaiting-stop-confirm', 'complete', 'draining'].includes(row.phase);
    const alreadyDesired =
      row?.to_placement_id === p.id || ((p.mode === 'hot' || isFrom) && !suppressed);
    const desired = data.desiredCounts.get(key) ?? 0;
    const admit = status
      ? canAdmitSession({
          status,
          history: this.admissionHistories.get(key)?.history ?? emptyHistory(),
          desiredSessionCount: desired + (alreadyDesired ? 0 : 1),
          maxSessions: data.capacity.get(key) ?? undefined,
        })
      : ({ ok: false, reason: 'node-unreachable', detail: 'node never polled' } as const);
    return {
      placementId: p.id,
      priority: p.priority,
      mode: p.mode === 'cold' ? 'cold' : 'hot',
      admission: admit.ok
        ? ({ ok: true } as const)
        : ({ ok: false, detail: `${admit.reason}: ${admit.detail}` } as const),
    };
  }

  // -------------------------------------------------------------------------
  // row persistence helpers
  // -------------------------------------------------------------------------

  private async upsertRow(values: {
    channel_id: string;
    from_placement_id: string | null;
    to_placement_id: string;
    phase: string;
    trigger_reason: string;
    trigger_node_id: string | null;
    trigger_detail: string | null;
    suppress_from: number;
    activation_uuid: string | null;
  }): Promise<void> {
    // activation_uuid is excluded from the conflict update: a row is only
    // ever re-created for a channel once its prior row is gone, so a
    // conflict here never legitimately carries a new uuid to apply.
    const { activation_uuid: _activationUuid, ...updateOnConflict } = values;
    await this.db
      .insertInto('restream_failover_state')
      .values({ ...values, drain_until: null, started_at: dbNow(), updated_at: dbNow() })
      .onDuplicateKeyUpdate({ ...updateOnConflict, drain_until: null, started_at: dbNow(), updated_at: dbNow() })
      .execute();
  }

  private async setPhase(channelId: string, phase: string, drainUntil?: string): Promise<void> {
    await this.db
      .updateTable('restream_failover_state')
      .set({ phase, updated_at: dbNow(), ...(drainUntil !== undefined ? { drain_until: drainUntil } : {}) })
      .where('channel_id', '=', channelId)
      .execute();
  }

  private async setTarget(channelId: string, toPlacementId: string): Promise<void> {
    await this.db
      .updateTable('restream_failover_state')
      .set({ to_placement_id: toPlacementId, phase: 'bringing-up', updated_at: dbNow() })
      .where('channel_id', '=', channelId)
      .execute();
  }

  private async deleteRow(channelId: string): Promise<void> {
    await this.db.deleteFrom('restream_failover_state').where('channel_id', '=', channelId).execute();
  }

  private async loadRow(channelId: string): Promise<FailoverRow | null> {
    const r = await this.db
      .selectFrom('restream_failover_state')
      .selectAll()
      .where('channel_id', '=', channelId)
      .executeTakeFirst();
    return (r as FailoverRow | undefined) ?? null;
  }

  /** nodes hosting any placement of this channel (docs to re-push after a change) */
  private channelNodes(data: TickData, channelId: string): FailoverNodeRef[] {
    const seen = new Set<string>();
    const out: FailoverNodeRef[] = [];
    for (const p of data.placementsByChannel.get(channelId) ?? []) {
      const key = nk(p.instance_id, p.node_id);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ instanceId: p.instance_id, nodeId: p.node_id });
    }
    return out;
  }

  /** switcher retained-window drain horizon for this channel's profile */
  private drainGraceMs(data: TickData, channelId: string): number {
    const payloadText = data.channels.get(channelId)?.profile_payload;
    let seg = 5;
    let list = 120;
    if (payloadText) {
      try {
        const payload = JSON.parse(payloadText) as AribHlsParams;
        seg = payload.hls?.segmentSeconds ?? 5;
        list = payload.hls?.listSize ?? 120;
      } catch {
        /* defaults */
      }
    }
    return Math.min(seg * list, 3600) * 1000;
  }

  // -------------------------------------------------------------------------
  // tick
  // -------------------------------------------------------------------------

  async tick(): Promise<void> {
    const data = await this.loadData();
    this.refreshAdmissionHistories(data);
    const changed = new Set<string>();

    await this.rowHygiene(data, changed);
    this.scanTriggers(data);
    if (this.active === null && this.queue.length > 0) {
      await this.beginNext(data, changed);
    }
    if (this.active !== null) {
      await this.advanceActive(data, changed);
    }

    if (changed.size > 0) {
      const nodes: FailoverNodeRef[] = [];
      for (const channelId of changed) nodes.push(...this.channelNodes(data, channelId));
      await this.hooks.pushNodes(nodes).catch(() => {});
      await this.hooks.pushSwitchers().catch(() => {});
      for (const channelId of changed) this.hooks.publishChannel(channelId);
    }
  }

  /** expire draining rows; drop rows whose channel/placements no longer qualify */
  private async rowHygiene(data: TickData, changed: Set<string>): Promise<void> {
    const nowMs = this.now().getTime();
    for (const [channelId, row] of [...data.rows]) {
      const channelOk = data.channels.has(channelId);
      const to = data.placementById.get(row.to_placement_id);
      const toOk = !!to && !!to.enabled && to.channel_id === channelId;
      if (!channelOk || !toOk) {
        // FK cascades cover hard deletes; this covers disable/mode churn.
        // Mid-procedure this is an abort — conservative and loss-minimal.
        if (row.trigger_reason === 'cutover' && to) {
          // `to` is a transient clone whose channel/target got disabled
          // rather than hard-deleted (a hard delete already leaves `to`
          // undefined via FK cascade) — reclaim it now, or it encodes
          // forever until the next controller-restart orphan sweep.
          await this.hooks.deleteCutoverPlacement?.(row.to_placement_id);
        }
        await this.deleteRow(channelId);
        data.rows.delete(channelId);
        if (this.active === channelId) this.clearActive();
        this.queueRemove(channelId);
        changed.add(channelId);
        continue;
      }
      if (row.phase === 'draining') {
        const until = asMs(row.drain_until);
        if (until === null || nowMs >= until) {
          if (row.trigger_reason === 'cutover') {
            // promote only after `from` is gone: the clone shares `from`'s
            // exact (channel_id, instance_id, node_id) triple, and the
            // unique index is scoped over `transient` — promoting while
            // `from`'s transient=0 row still holds that triple would collide.
            if (row.from_placement_id) {
              await this.hooks.deleteCutoverPlacement?.(row.from_placement_id);
            }
            await this.hooks.markCutoverComplete?.(row.to_placement_id);
          }
          await this.deleteRow(channelId);
          data.rows.delete(channelId);
          changed.add(channelId);
        }
      }
    }

    // sweep stale `blocked` entries for channels gone entirely (disabled or
    // hard-deleted): a failed admission rarely creates a failover_state row,
    // so the loop above can't catch these, and scanTriggers only walks
    // enabled channels — this is the only path that reclaims them, keeping
    // listChannels() from showing a permanently stale badge. Published
    // directly (not via `changed`): no node/switcher state actually moved.
    for (const channelId of [...this.blocked.keys()]) {
      if (data.channels.has(channelId)) continue;
      this.blocked.delete(channelId);
      this.retriggerBackoff.delete(channelId);
      this.hooks.publishChannel(channelId);
    }
  }

  /** probe-driven trigger scan → enqueue (instance-level fan-out included) */
  private scanTriggers(data: TickData): void {
    const snap = this.probes();
    const nowMs = this.now().getTime();
    for (const [channelId] of data.channels) {
      if (channelId === this.active || this.queuedIds.has(channelId)) continue;
      const row = data.rows.get(channelId);
      if (row && midProcedure(row.phase)) continue; // owned by the orchestrator
      const backoff = this.retriggerBackoff.get(channelId);
      if (backoff && nowMs < backoff.untilMs) continue;

      const active = this.activePlacementOf(data, channelId);
      if (!active) {
        // no active placement to evaluate a trigger against — nothing is
        // failing right now, so any recorded blocked reason is stale.
        this.clearStaleBlocked(channelId);
        continue;
      }
      const key = nk(active.instance_id, active.node_id);

      let reason: FailoverTriggerReason | null = null;
      let detail = '';
      let triggerNodeId: string | null = null;
      const live = snap.liveness.get(key);
      const speed = snap.underspeed.get(key);
      const lag = snap.lag.get(active.id);
      if (live?.failed) {
        reason = 'liveness';
        detail = live.detail;
        triggerNodeId = active.node_id;
      } else if (speed?.failed) {
        reason = 'underspeed';
        detail = speed.detail;
        triggerNodeId = active.node_id;
      } else if (lag?.failed) {
        reason = 'lag';
        detail = lag.detail;
      }
      if (!reason) {
        // trigger cleared (or never existed) — nothing failing now, so any
        // recorded blocked reason is stale.
        this.clearStaleBlocked(channelId);
        continue;
      }
      this.enqueue({ channelId, reason, detail, triggerNodeId });
    }
  }

  /**
   * Drop a stale blocked reason (+ its retrigger backoff) once no trigger is
   * actively failing for the channel. `blocked` documents why the LAST
   * failover attempt couldn't act; once nothing is failing that record no
   * longer describes anything actionable. Publishes only when an entry
   * actually existed, so a healthy/inactive channel doesn't churn the SSE
   * stream every tick.
   */
  private clearStaleBlocked(channelId: string): void {
    this.retriggerBackoff.delete(channelId);
    if (this.blocked.delete(channelId)) this.hooks.publishChannel(channelId);
  }

  private enqueue(item: QueueItem): void {
    if (this.queuedIds.has(item.channelId) || this.active === item.channelId) return;
    this.queue.push(item);
    this.queuedIds.add(item.channelId);
  }

  private queueRemove(channelId: string): void {
    const idx = this.queue.findIndex((q) => q.channelId === channelId);
    if (idx >= 0) this.queue.splice(idx, 1);
    this.queuedIds.delete(channelId);
  }

  private clearActive(): void {
    this.active = null;
    this.tried = new Set();
    this.phaseEnteredAtMs = 0;
    this.lastSwitchIssueMs = 0;
  }

  private bumpBackoff(channelId: string): void {
    const prev = this.retriggerBackoff.get(channelId);
    const delayMs = Math.min(prev ? prev.delayMs * 2 : RETRIGGER_BACKOFF_MIN_MS, RETRIGGER_BACKOFF_MAX_MS);
    this.retriggerBackoff.set(channelId, { untilMs: this.now().getTime() + delayMs, delayMs });
  }

  // -------------------------------------------------------------------------
  // procedure begin / advance
  // -------------------------------------------------------------------------

  private async beginNext(data: TickData, changed: Set<string>): Promise<void> {
    const item = this.queue.shift();
    if (!item) return;
    this.queuedIds.delete(item.channelId);
    const channel = data.channels.get(item.channelId);
    if (!channel) return; // channel disabled/deleted while queued

    const from = this.activePlacementOf(data, item.channelId);
    const placements = (data.placementsByChannel.get(item.channelId) ?? []).filter((p) => !!p.enabled);

    let targetId: string | null = null;
    if (item.explicitTargetId) {
      const target = placements.find((p) => p.id === item.explicitTargetId);
      if (!target || target.id === from?.id) return; // stale request
      if (!item.force) {
        const cand = this.candidateOf(data, target);
        if (!cand.admission.ok) {
          this.blocked.set(item.channelId, `${target.id}: ${cand.admission.detail}`);
          // bump backoff: this rejection is about the explicit target's own
          // admission, not the active placement's trigger — without it,
          // scanTriggers would clear this message next tick even though
          // nothing about the rejection actually changed.
          this.bumpBackoff(item.channelId);
          this.hooks.publishChannel(item.channelId);
          return;
        }
      }
      targetId = target.id;
    } else {
      const candidates = placements.filter((p) => p.id !== from?.id).map((p) => this.candidateOf(data, p));
      const exclude = new Set<string>();
      const chosen = selectTarget(candidates, exclude);
      if (!chosen) {
        this.blocked.set(item.channelId, rejectionSummary(candidates, exclude));
        this.bumpBackoff(item.channelId);
        this.hooks.publishChannel(item.channelId);
        return;
      }
      targetId = chosen.placementId;
    }

    // stop-the-outgoing semantics: a failover (incl. manual selection) stops
    // the placement it moves away from, even a hot one; a reset stops it only
    // when it is cold or itself failing (healthy hot outgoing keeps running —
    // restores hot-hot steady state); rebalance never stops anything.
    let suppressFrom = 1;
    if (item.reason === 'rebalance') suppressFrom = 0;
    else if (item.reason === 'reset') {
      const snap = this.probes();
      const fromFailing =
        !!from &&
        (snap.lag.get(from.id)?.failed === true ||
          snap.liveness.get(nk(from.instance_id, from.node_id))?.failed === true ||
          snap.underspeed.get(nk(from.instance_id, from.node_id))?.failed === true);
      suppressFrom = from && (from.mode === 'cold' || fromFailing) ? 1 : 0;
    }
    if (!from) suppressFrom = 0;

    await this.upsertRow({
      channel_id: item.channelId,
      from_placement_id: from?.id ?? null,
      to_placement_id: targetId,
      phase: 'bringing-up',
      trigger_reason: item.reason,
      trigger_node_id: item.triggerNodeId,
      trigger_detail: item.detail || null,
      suppress_from: suppressFrom,
      activation_uuid: item.reason === 'on-demand' ? randomUUID() : null,
    });
    // refresh the in-memory view so advanceActive sees the new row this tick
    data.rows.set(item.channelId, (await this.loadRow(item.channelId))!);
    this.active = item.channelId;
    this.tried = new Set([targetId]);
    this.phaseEnteredAtMs = this.now().getTime();
    this.lastSwitchIssueMs = 0;
    this.blocked.delete(item.channelId);
    changed.add(item.channelId);
    console.error(
      `restreamer: failover BEGIN for "${channel.slug}" (${item.reason}) — ${from?.id ?? '(none)'} → ${targetId}`,
    );
    // lifecycle logging is skipped when the initiator owns it: user-initiated
    // procedures (manual/reset) are never event-logged, and on-demand
    // start/stop is logged by the on-demand engine
    if (item.reason !== 'manual' && item.reason !== 'reset' && item.reason !== 'on-demand') {
      this.events.log({
        type: 'warning',
        service: 'restreamer',
        source: 'controller',
        message: `failover BEGIN for "${channel.slug}" (${item.reason}) — ${from?.id ?? '(none)'} → ${targetId}`,
      });
    }

    // bring-up push: the target joins the docs via to_placement_id
    try {
      await this.hooks.pushNodes(this.channelNodes(data, item.channelId));
      await this.hooks.pushSwitchers();
    } catch {
      // push failure is conclusive — retarget immediately (handled next tick
      // via the lag timeout would be slow; do it now)
      await this.retargetOrAbort(data, item.channelId, changed);
    }
    this.hooks.publishChannel(item.channelId);
  }

  private async advanceActive(data: TickData, changed: Set<string>): Promise<void> {
    const channelId = this.active;
    if (!channelId) return;
    // re-read the persisted row each pass — abort if it vanished under us
    let row = await this.loadRow(channelId);
    if (!row || !midProcedure(row.phase)) {
      this.clearActive();
      return;
    }
    const channel = data.channels.get(channelId);
    if (!channel) {
      await this.deleteRow(channelId);
      this.clearActive();
      changed.add(channelId);
      return;
    }

    for (let steps = 0; steps < 10; steps++) {
      const input = await this.stepInput(data, channel, row!);
      const step = planFailoverStep(input);
      if (step.action === 'wait') {
        // re-issue an unconfirmed switch every SWITCH_REISSUE_MS
        if (
          row!.phase === 'awaiting-switch-confirm' &&
          this.now().getTime() - this.lastSwitchIssueMs >= SWITCH_REISSUE_MS
        ) {
          await this.issueSwitch(channel.slug, row!.to_placement_id);
        }
        return;
      }
      if (step.action === 'retarget') {
        await this.retargetOrAbort(data, channelId, changed);
        row = await this.loadRow(channelId);
        if (!row || !midProcedure(row.phase) || this.active !== channelId) return;
        continue;
      }
      if (step.action === 'issue-switch') {
        const issued = await this.issueSwitch(channel.slug, row!.to_placement_id);
        if (!issued) return; // retry next tick
        await this.setPhase(channelId, 'awaiting-switch-confirm');
        row!.phase = 'awaiting-switch-confirm';
        this.phaseEnteredAtMs = this.now().getTime();
        this.hooks.publishChannel(channelId);
        continue;
      }
      if (step.action === 'advance') {
        await this.setPhase(channelId, step.toPhase);
        row!.phase = step.toPhase;
        this.phaseEnteredAtMs = this.now().getTime();
        changed.add(channelId);
        if (step.toPhase === 'stopping-old') {
          // persist first, then re-push: doc computation now excludes `from`
          await this.hooks.pushNodes(this.channelNodes(data, channelId)).catch(() => {});
        }
        if (step.toPhase === 'complete') {
          await this.finishProcedure(data, channelId, row!, changed);
          return;
        }
        this.hooks.publishChannel(channelId);
        continue;
      }
      return;
    }
  }

  private async stepInput(
    data: TickData,
    channel: ChannelRow,
    row: FailoverRow,
  ): Promise<Parameters<typeof planFailoverStep>[0]> {
    const nowMs = this.now().getTime();
    const snap = this.probes();
    const to = data.placementById.get(row.to_placement_id);
    const from = row.from_placement_id ? data.placementById.get(row.from_placement_id) : undefined;

    // lag discovered = measured AND at/below the target node's lag threshold.
    // With the lag probe disabled (periodSeconds 0) fall back to the
    // switcher's own passive probe: the upstream must be reported healthy
    // WITH a real lag measurement (its optimistic never-probed default has
    // none, so it never counts as discovered).
    let lagDiscovered = false;
    if (to) {
      const cfg = (await this.settings()).get(nk(to.instance_id, to.node_id));
      if ((cfg?.lag.periodSeconds ?? 0) <= 0) {
        const up = this.switcherUpstreamReport(channel.slug, to.id);
        lagDiscovered = up?.healthy === true && up.playlistLagSec !== undefined;
      } else {
        const lag = snap.lag.get(to.id);
        const threshold = cfg?.lag.timeoutSeconds ?? 30;
        lagDiscovered =
          lag?.firstMeasuredAt != null && lag.lastLagSec != null && lag.lastLagSec <= threshold;
      }
    }

    const report = this.switcherReport(channel.slug);
    const switchConfirmed = report?.activeUpstreamId === row.to_placement_id;

    let oldSessionGone = true;
    if (from && row.suppress_from) {
      const status = this.cache.has(from.instance_id)
        ? (this.cache.get(from.instance_id).restreamers.find((r) => r.nodeId === from.node_id) ?? null)
        : null;
      // from.id never equals row.to_placement_id (retarget candidates
      // exclude row.from_placement_id), so this always compares against
      // from.id itself — sessionNameFor is only ever a rename for the TO
      // placement, which from can never be.
      oldSessionGone =
        status?.reachable === true &&
        !status.sessions.some((s) => s.name === sessionNameFor(from.id, row));
    }

    return {
      phase: row.phase as Parameters<typeof planFailoverStep>[0]['phase'],
      suppressFrom: !!row.suppress_from,
      lagDiscovered,
      lagTimedOut: nowMs - this.phaseEnteredAtMs > LAG_DISCOVERY_TIMEOUT_MS,
      switchConfirmed,
      oldSessionGone,
      stopConfirmTimedOut: nowMs - this.phaseEnteredAtMs > STOP_CONFIRM_TIMEOUT_MS,
      drainElapsed: false, // draining rows are never the active procedure
    };
  }

  /**
   * Broadcast the switch to every connected replica. Zero connections =
   * not issued — the caller retries next tick, and once confirmation is
   * awaited the SWITCH_REISSUE_MS loop re-broadcasts (a replica that
   * reconnects meanwhile also converges via the doc it receives on connect).
   */
  private async issueSwitch(slug: string, toPlacementId: string): Promise<boolean> {
    const sent = this.hub.broadcastSwitch(slug, toPlacementId);
    if (sent === 0) {
      console.error(`restreamer: failover switch for "${slug}" failed: no switcher replicas connected`);
      return false;
    }
    this.lastSwitchIssueMs = this.now().getTime();
    return true;
  }

  /** pick the next untried candidate, or abort loss-free (nothing switched yet) */
  private async retargetOrAbort(data: TickData, channelId: string, changed: Set<string>): Promise<void> {
    const row = await this.loadRow(channelId);
    if (!row) {
      this.clearActive();
      return;
    }
    if (row.trigger_reason === 'cutover') {
      // the clone is the only acceptable target for a cutover — never
      // retarget onto some other standby placement
      await this.abortCutover(data, channelId, row, changed);
      return;
    }
    const placements = (data.placementsByChannel.get(channelId) ?? []).filter((p) => !!p.enabled);
    const candidates = placements
      .filter((p) => p.id !== row.from_placement_id)
      .map((p) => this.candidateOf(data, p));
    const slug = data.channels.get(channelId)?.slug ?? channelId;
    // automatic failover lifecycle — skip manual/reset (user-initiated)
    const automatic = row.trigger_reason !== 'manual' && row.trigger_reason !== 'reset';
    const chosen = selectTarget(candidates, this.tried);
    if (chosen) {
      this.tried.add(chosen.placementId);
      await this.setTarget(channelId, chosen.placementId);
      this.phaseEnteredAtMs = this.now().getTime();
      changed.add(channelId);
      console.error(`restreamer: failover RETARGET for channel ${channelId} → ${chosen.placementId}`);
      if (automatic) {
        this.events.log({
          type: 'warning',
          service: 'restreamer',
          source: 'controller',
          message: `failover RETARGET for "${slug}" → placement ${chosen.placementId}`,
        });
      }
      await this.hooks.pushNodes(this.channelNodes(data, channelId)).catch(() => {});
      await this.hooks.pushSwitchers().catch(() => {});
      this.hooks.publishChannel(channelId);
      return;
    }
    // exhausted — abort: delete the row, tear down anything brought up
    await this.deleteRow(channelId);
    data.rows.delete(channelId);
    this.blocked.set(channelId, `no eligible failover target: ${rejectionSummary(candidates, this.tried)}`);
    this.bumpBackoff(channelId);
    this.clearActive();
    changed.add(channelId);
    console.error(`restreamer: failover ABORTED for channel ${channelId} — candidates exhausted`);
    if (automatic) {
      this.events.log({
        type: 'warning',
        service: 'restreamer',
        source: 'controller',
        message: `failover ABORTED for "${slug}" — candidates exhausted`,
      });
    }
  }

  /** procedure reached complete: row lifecycle + slot release */
  private async finishProcedure(
    data: TickData,
    channelId: string,
    row: FailoverRow,
    changed: Set<string>,
  ): Promise<void> {
    if (row.trigger_reason === 'cutover') {
      await this.finishCutover(data, channelId, row, changed);
      return;
    }
    // lifecycle logging is skipped when the initiator owns it: user-initiated
    // procedures (manual/reset) are never event-logged, and on-demand
    // start/stop is logged by the on-demand engine (a "failover complete"
    // line for a routine channel-open would be noise)
    if (row.trigger_reason !== 'manual' && row.trigger_reason !== 'reset' && row.trigger_reason !== 'on-demand') {
      const slug = data.channels.get(channelId)?.slug ?? channelId;
      this.events.log({
        type: 'normal',
        service: 'restreamer',
        source: 'controller',
        message: `failover complete for "${slug}" — now on placement ${row.to_placement_id}`,
      });
    }
    // a procedure that ENDS on the channel's natural steady-state placement
    // is a fail-back and must not leave standing failover state behind: an
    // explicit reset always, and a MANUAL switch whose target is the natural
    // hot (the operator failing back by hand — same thing, same cleanup).
    // Automatic failovers and rebalances keep their row: that IS the
    // persisted "failover occurred" state the Reset button keys on.
    const placements = (data.placementsByChannel.get(channelId) ?? []).filter((p) => !!p.enabled);
    const natural = this.naturalPlacementOf(placements);
    const isFailback =
      row.trigger_reason === 'reset' ||
      (row.trigger_reason === 'manual' && natural !== null && row.to_placement_id === natural.id);
    if (isFailback) {
      const to = data.placementById.get(row.to_placement_id);
      if (to?.mode === 'cold') {
        // landed on a cold placement (all-cold channel): the row is its
        // activation and must survive at complete or the encode would stop
      } else {
        const from = row.from_placement_id ? data.placementById.get(row.from_placement_id) : undefined;
        if (from?.mode === 'cold') {
          // a COLD outgoing leaves the switcher doc with the row — keep it
          // resolvable while the retained window drains. (A hot outgoing
          // stays a switcher upstream regardless, so it is deleted
          // immediately and resumes encoding — hot-hot steady state.)
          const until = new Date(this.now().getTime() + this.drainGraceMs(data, channelId))
            .toISOString()
            .slice(0, 19)
            .replace('T', ' ');
          await this.setPhase(channelId, 'draining', until);
        } else {
          await this.deleteRow(channelId);
          data.rows.delete(channelId);
        }
      }
    }
    // non-reset rows stay at complete — that IS the persisted failover state
    this.retriggerBackoff.delete(channelId);
    this.clearActive();
    changed.add(channelId);
    this.hooks.publishChannel(channelId);
  }

  /**
   * The clone is the only acceptable target for a cutover, so if it never
   * becomes healthy the procedure aborts loss-free — `from` was never
   * suppressed, so nothing was lost. No bumpBackoff/blocked: a cutover is a
   * one-shot explicit request, not part of the automatic-retry loop.
   */
  private async abortCutover(
    data: TickData,
    channelId: string,
    row: FailoverRow,
    changed: Set<string>,
  ): Promise<void> {
    const slug = data.channels.get(channelId)?.slug ?? channelId;
    await this.hooks.deleteCutoverPlacement?.(row.to_placement_id);
    await this.deleteRow(channelId);
    data.rows.delete(channelId);
    this.clearActive();
    changed.add(channelId);
    console.error(`restreamer: cutover ABORTED for channel ${channelId} — new encode never became healthy`);
    this.events.log({
      type: 'warning',
      service: 'restreamer',
      source: 'controller',
      message:
        `cutover ABORTED for "${slug}" — new encode ${row.to_placement_id} never became healthy; ` +
        `still serving ${row.from_placement_id ?? '(none)'}`,
    });
  }

  /**
   * Cutover reached complete: move to 'draining', reusing the same
   * drainGraceMs window as a cold-outgoing automatic failover — `from` keeps
   * encoding until the switcher's retained HLS window drains, then
   * rowHygiene retires `from` and promotes the clone together (promoting
   * here would collide with `from`'s still-present unique-index row).
   * Always logs: a cutover is never 'manual'/'reset'.
   */
  private async finishCutover(
    data: TickData,
    channelId: string,
    row: FailoverRow,
    changed: Set<string>,
  ): Promise<void> {
    const slug = data.channels.get(channelId)?.slug ?? channelId;
    const until = new Date(this.now().getTime() + this.drainGraceMs(data, channelId))
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ');
    await this.setPhase(channelId, 'draining', until);
    this.retriggerBackoff.delete(channelId);
    this.clearActive();
    changed.add(channelId);
    console.error(`restreamer: cutover COMPLETE for channel ${channelId} — now serving ${row.to_placement_id}`);
    this.events.log({
      type: 'normal',
      service: 'restreamer',
      source: 'controller',
      message:
        `cutover COMPLETE for "${slug}" — now serving ${row.to_placement_id}; ` +
        `${row.from_placement_id ?? '(none)'} retiring`,
    });
    this.hooks.publishChannel(channelId);
  }

  // -------------------------------------------------------------------------
  // requests (manual / rebalance / reset) — called inside the op chain
  // -------------------------------------------------------------------------

  async requestFailover(
    channelId: string,
    opts: { toPlacementId?: string; reason: FailoverTriggerReason; detail?: string; force?: boolean },
  ): Promise<{ ok: true; queued?: true; already?: true }> {
    const data = await this.loadData();
    const channel = data.channels.get(channelId);
    if (!channel) throw httpError(404, `restream channel ${channelId} not found`);
    if (opts.toPlacementId) {
      const target = data.placementById.get(opts.toPlacementId);
      if (!target || target.channel_id !== channelId) {
        throw httpError(400, `placement ${opts.toPlacementId} does not belong to channel ${channelId}`);
      }
      if (!target.enabled) throw httpError(409, `placement ${opts.toPlacementId} is disabled`);
      const active = this.activePlacementOf(data, channelId);
      if (active?.id === opts.toPlacementId) return { ok: true, already: true };
    }
    const row = data.rows.get(channelId);
    if (this.active === channelId || this.queuedIds.has(channelId) || (row && midProcedure(row.phase))) {
      return { ok: true, queued: true };
    }
    this.enqueue({
      channelId,
      reason: opts.reason,
      detail: opts.detail ?? '',
      triggerNodeId: null,
      ...(opts.toPlacementId !== undefined ? { explicitTargetId: opts.toPlacementId } : {}),
      ...(opts.force !== undefined ? { force: opts.force } : {}),
    });
    return { ok: true, queued: true };
  }

  async requestReset(channelId: string, opts: { force?: boolean } = {}): Promise<ResetOutcome> {
    const data = await this.loadData();
    const channel = data.channels.get(channelId);
    if (!channel) throw httpError(404, `restream channel ${channelId} not found`);
    const row = data.rows.get(channelId);
    if (!row) throw httpError(409, 'no failover state to reset');

    if (!pastCommitPoint(row.phase) && midProcedure(row.phase)) {
      // before the commit point — revert loss-free: viewers were never moved.
      // A cutover row needs the same clone reclaim as abortCutover here, or
      // the transient clone leaks (encoding forever with nothing left to
      // clean it up). No event log: this is a user-initiated reset, not an
      // autonomous action.
      if (row.trigger_reason === 'cutover') {
        await this.hooks.deleteCutoverPlacement?.(row.to_placement_id);
      }
      await this.deleteRow(channelId);
      data.rows.delete(channelId);
      if (this.active === channelId) this.clearActive();
      this.queueRemove(channelId);
      await this.hooks.pushNodes(this.channelNodes(data, channelId)).catch(() => {});
      await this.hooks.pushSwitchers().catch(() => {});
      this.hooks.publishChannel(channelId);
      return { ok: true, aborted: true };
    }
    if (pastCommitPoint(row.phase)) {
      return {
        rejected: 'rejected-mid-procedure',
        message: 'the switcher is already switching to the new placement — wait for the procedure to finish',
      };
    }
    if (row.phase === 'draining') return { ok: true, already: true };

    // phase === 'complete' — fail back in natural order
    if (!opts.force) {
      const failing = this.triggerStillFailing(row);
      if (failing) {
        return {
          rejected: 'requires-confirm',
          message: `the original trigger (${row.trigger_reason}) is still failing: ${failing}`,
        };
      }
    }

    const placements = (data.placementsByChannel.get(channelId) ?? []).filter((p) => !!p.enabled);
    // steady state runs the HOT placements — cold priorities are failover
    // CANDIDATE order, not steady-state preference. Fail back to the first
    // enabled hot; an all-cold channel keeps a cold "activation" instead.
    const natural = this.naturalPlacementOf(placements);
    if (!natural) throw httpError(409, 'channel has no enabled placements');
    if (natural.id === row.to_placement_id) {
      if (natural.mode === 'cold') {
        // all-cold channel: the row IS what keeps this placement encoding
        return { ok: true, already: true };
      }
      // already on the natural placement — just clear the failover state
      // (un-suppresses a stopped hot `from`, which resumes encoding). Drain
      // grace is ONLY needed for a COLD outgoing: a hot one never leaves the
      // switcher doc, so its retained URIs stay resolvable without the row.
      const from = row.from_placement_id ? data.placementById.get(row.from_placement_id) : undefined;
      if (from?.mode === 'cold') {
        const until = new Date(this.now().getTime() + this.drainGraceMs(data, channelId))
          .toISOString()
          .slice(0, 19)
          .replace('T', ' ');
        await this.setPhase(channelId, 'draining', until);
      } else {
        await this.deleteRow(channelId);
      }
      await this.hooks.pushNodes(this.channelNodes(data, channelId)).catch(() => {});
      await this.hooks.pushSwitchers().catch(() => {});
      this.hooks.publishChannel(channelId);
      return { ok: true, cleared: true };
    }
    // name the target explicitly: generic candidate order is (priority, id)
    // over ALL modes, which would fail back onto another cold standby when
    // cold placements sit ahead of the first hot in priority order
    this.enqueue({
      channelId,
      reason: 'reset',
      detail: 'operator reset',
      triggerNodeId: null,
      explicitTargetId: natural.id,
    });
    return { ok: true, queued: true };
  }

  /**
   * Release an on-demand activation row whose viewer demand has expired: the
   * row is deleted and the follow-up node push stops the encode. A channel
   * with a procedure active/queued, or whose row is mid-procedure, is left
   * alone — the release re-evaluates after the procedure settles. No event
   * log here; the caller owns the demand-expiry logging.
   */
  async releaseOnDemand(channelId: string): Promise<void> {
    if (this.active === channelId || this.queuedIds.has(channelId)) return;
    const data = await this.loadData();
    const row = data.rows.get(channelId);
    if (!row || midProcedure(row.phase)) return;
    await this.deleteRow(channelId);
    data.rows.delete(channelId);
    await this.hooks.pushNodes(this.channelNodes(data, channelId)).catch(() => {});
    await this.hooks.pushSwitchers().catch(() => {});
    this.hooks.publishChannel(channelId);
  }

  /** is the ORIGINAL trigger of a completed failover still failing? null = cleared */
  private triggerStillFailing(row: FailoverRow): string | null {
    const snap = this.probes();
    switch (row.trigger_reason) {
      case 'liveness':
      case 'underspeed': {
        if (!row.trigger_node_id) return null;
        // find the failing node's key by scanning known instance ids
        for (const inst of this.config.instances) {
          const key = nk(inst.id, row.trigger_node_id);
          const s = row.trigger_reason === 'liveness' ? snap.liveness.get(key) : snap.underspeed.get(key);
          if (s?.failed) return s.detail;
        }
        return null;
      }
      case 'lag': {
        const s = row.from_placement_id ? snap.lag.get(row.from_placement_id) : undefined;
        return s?.failed ? s.detail : null;
      }
      default:
        return null; // manual / reset / rebalance have no standing trigger
    }
  }

  // -------------------------------------------------------------------------
  // startup
  // -------------------------------------------------------------------------

  /**
   * Resume from persisted state: prune rows that no longer qualify, adopt the
   * (at most one, by serialization) mid-procedure row as the active
   * procedure with fresh timeout anchors. Doc pushes need no special-casing —
   * computation derives from the rows, and startup/sweep pushes follow.
   */
  async reconcileOnStartup(): Promise<string[]> {
    const data = await this.loadData();
    const changed = new Set<string>();
    await this.rowHygiene(data, changed);
    for (const [channelId, row] of data.rows) {
      if (!midProcedure(row.phase)) continue;
      if (this.active === null) {
        this.active = channelId;
        this.tried = new Set([row.to_placement_id]);
        this.phaseEnteredAtMs = this.now().getTime();
        this.lastSwitchIssueMs = 0; // switch-ordered / unconfirmed switches re-issue
      } else {
        // defensive: serialization means at most one, but never strand a row
        this.enqueue({
          channelId,
          reason: (row.trigger_reason as FailoverTriggerReason) ?? 'manual',
          detail: row.trigger_detail ?? '',
          triggerNodeId: row.trigger_node_id,
        });
      }
    }
    return [...changed];
  }
}
