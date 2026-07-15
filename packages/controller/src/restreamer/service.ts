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

import { createHash, randomUUID } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import {
  AribHlsParams,
  RESTREAMER_API_VERSION,
  chanNumberOrder,
  type ChannelFailoverStatus,
  type DesiredSession,
  type DesiredState,
  type FailoverPhase,
  type FailoverTriggerReason,
  type NodeProbeSettings,
  type NodeSettings,
  type RestreamChannel,
  type RestreamChannelWithStatus,
  type RestreamPlacement,
  type RestreamPlaylist,
  type RestreamProfile,
  type RestreamerNodeStatus,
  type SessionSource,
  type SourceCatalogEntry,
  type SwitchReason,
  type SwitcherChannelStatus,
  type TvhChannel,
} from '@tvhc/shared';
import type { AppConfig, RestreamerNodeConfig } from '../config.js';
import type { Db } from '../db/db.js';
import type { EventLog } from '../state/eventLog.js';
import type { EventBus } from '../state/events.js';
import type { InstanceCache } from '../state/instanceCache.js';
import type { InstancePoller } from '../tvh/poller.js';
import { httpError } from '../util/httpError.js';
import { buildRawArgvParams } from './argv/index.js';
import type { RestreamerClient } from './client.js';
import { FAILOVER_TICK_MS, FailoverSync, type ResetOutcome } from './failoverSync.js';
import { midProcedure, placementIndicators } from './failoverPolicy.js';
import { ProbeEngine, type ProbeTargets } from './probeEngine.js';
import { NODE_PROBE_DEFAULTS, probeSettingsToRow, rowToProbeSettings } from './probeSettings.js';
import type { RestreamerPollerHooks, SwitcherPollerHooks } from './poller.js';
import {
  SwitcherSync,
  type ComputedSwitcherDoc,
  type SwitcherNodeClient,
  type SwitcherPushResult,
} from './switcherSync.js';

export type { ResetOutcome } from './failoverSync.js';

export type { ComputedSwitcherDoc, SwitcherNodeClient, SwitcherPushResult } from './switcherSync.js';

/** the client surface the service actually uses (the fake node implements exactly this) */
export type RestreamerNodeClient = Pick<RestreamerClient, 'putDesired' | 'getDesired'>;

/** clients map key: one restreamer daemon node */
export function nodeKey(instanceId: string, nodeId: string): string {
  return `${instanceId}/${nodeId}`;
}

/** session-name / slug rule from the wire contract (also caps playlist slugs) */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Default slug for a channel name: lowercase, every run of characters outside
 * [a-z0-9-] collapsed to '-', edge dashes trimmed, capped at 64 chars. Never
 * empty ('channel' fallback) so the SLUG_PATTERN always holds.
 */
export function deriveSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return slug || 'channel';
}

/**
 * Deterministic, key-ordered JSON — the doc-hash input. Unlike
 * sync/normalize.ts#payloadHash (flat payloads, top-level sort only) the
 * desired doc nests objects, so keys are sorted RECURSIVELY and undefined
 * members dropped, exactly like JSON.stringify would.
 */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x)).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${canonicalJson(val)}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/**
 * Doc hash over an already-sorted array (node sessions or switcher channels).
 * This IS the doc's `revision`: the daemon/switcher echoes it back as
 * `desiredRevision`, so the stored pushed_hash doubles as the expected
 * revision.
 */
export function sessionsHash(sessions: readonly unknown[]): string {
  return createHash('sha256').update(canonicalJson(sessions)).digest('hex');
}

/**
 * Validate + default-complete a stored profile payload against the
 * controller-owned profile schema (formerly the wire contract's 'arib-hls'
 * template — see restreamProfile.ts). Throws a 400-flavored error naming the
 * first offending path.
 */
export function completeProfileParams(raw: unknown): AribHlsParams {
  const completed = Value.Default(AribHlsParams, Value.Clone(raw));
  if (!Value.Check(AribHlsParams, completed)) {
    const first = Value.Errors(AribHlsParams, completed).First();
    throw httpError(
      400,
      `invalid pipeline params${first ? ` at ${first.path || '/'}: ${first.message}` : ''}`,
    );
  }
  return completed as AribHlsParams;
}

/**
 * Resolve a controller channel identity against one instance's channel grid.
 * Identity is (name, number) with the number compared as an EXACT STRING
 * ("9.1" never matches "9.10"); a null number picks the LOWEST-numbered
 * same-name channel (numberless last, grid order breaks ties) — mirrors
 * sync/resolve.ts#channelSetterValue.
 */
export function resolveTvhChannel(
  channels: TvhChannel[],
  name: string,
  number: string | null,
): TvhChannel | null {
  if (number != null) {
    return channels.find((c) => c.name === name && (c.number ?? null) === number) ?? null;
  }
  const matches = channels.filter((c) => c.name === name);
  if (matches.length === 0) return null;
  return matches.reduce((a, b) => (chanNumberOrder(b.number) < chanNumberOrder(a.number) ? b : a));
}

/**
 * Resolve a channel identity against one node's polled sources.m3u catalog —
 * the SAME identity rules as resolveTvhChannel (exact-string pinned match,
 * lowest-numbered same-name entry when unpinned), keyed by `chno` instead of
 * tvheadend's `number`. `chno` is a required field of the wire contract, so
 * every entry always counts as numbered.
 */
export function resolveCatalogEntry(
  entries: SourceCatalogEntry[],
  name: string,
  number: string | null,
): SourceCatalogEntry | null {
  if (number != null) {
    return entries.find((e) => e.name === name && e.chno === number) ?? null;
  }
  const matches = entries.filter((e) => e.name === name);
  if (matches.length === 0) return null;
  return matches.reduce((a, b) => (chanNumberOrder(b.chno) < chanNumberOrder(a.chno) ? b : a));
}

export interface PlacementInput {
  instanceId: string;
  nodeId: string;
  /** failover order; default = current max + 1 */
  priority?: number;
  enabled?: boolean;
  /** 'hot' (default) = always encodes; 'cold' = standby for the failover loop */
  mode?: 'hot' | 'cold';
  /** per-placement encode-profile override; null/absent = inherit the channel's profile */
  profileId?: string | null;
  programNumber?: number | null;
  /** skip the write-time availability check (pre-provisioning) */
  force?: boolean;
}

export interface CreateChannelInput {
  channelName: string;
  /** STRING identity ("9.1" ≠ "9.10"); absent/null = pin-lowest at write time */
  channelNumber?: string | null;
  profileId: string;
  /** derived from channelName when absent */
  slug?: string;
  enabled?: boolean;
  comment?: string | null;
  playlistIds?: string[];
  placements?: PlacementInput[];
  /** skip the write-time availability check (pre-provisioning) */
  force?: boolean;
}

export interface ChannelPatch {
  channelName?: string;
  /** explicit null = unpin (re-pinned to the lowest same-name number when resolvable) */
  channelNumber?: string | null;
  profileId?: string;
  slug?: string;
  enabled?: boolean;
  comment?: string | null;
  /** full replacement of playlist memberships */
  playlistIds?: string[];
  /** skip the write-time availability re-check on identity changes */
  force?: boolean;
}

export interface PlacementPatch {
  instanceId?: string;
  nodeId?: string;
  priority?: number;
  enabled?: boolean;
  /** 'hot' = always encodes; 'cold' = standby for the failover loop */
  mode?: 'hot' | 'cold';
  /** per-placement encode-profile override; undefined = keep, null = clear (inherit channel) */
  profileId?: string | null;
  programNumber?: number | null;
  /** skip the write-time availability check when moving to another node */
  force?: boolean;
}

/**
 * A channel is source-agnostic: just (name, number). Each placement resolves
 * this identity independently in its own zone — tvheadend topology first,
 * then the node's local sources.m3u catalog by the same identity rules.
 */
export interface ChannelIdentity {
  channelName: string;
  channelNumber: string | null;
}

export interface UnavailablePlacement {
  instanceId: string;
  nodeId: string;
  reason: string;
}

/**
 * Write-time availability rejection (409): the channel identity does not
 * resolve on one or more target nodes RIGHT NOW. `force` on the offending
 * input bypasses it (pre-provisioning — the placement stays blocked until the
 * channel/catalog entry appears).
 */
export class AvailabilityError extends Error {
  readonly statusCode = 409;
  constructor(
    message: string,
    readonly unavailable: UnavailablePlacement[],
  ) {
    super(message);
    this.name = 'AvailabilityError';
  }
}

export type ChannelBatchAction =
  | 'edit'
  | 'delete'
  | 'enable'
  | 'disable'
  | 'add-playlist'
  | 'remove-playlist';

/** per-channel outcome of a batch operation (mirrors SyncEngine's RuleBatchResult) */
export interface ChannelBatchResult {
  id: string;
  ok: boolean;
  error?: string;
}

export interface BlockedPlacement {
  placementId: string;
  channelId: string;
  slug: string;
  reason: string;
}

export interface ComputedNodeDoc {
  /** null when deferred */
  doc: DesiredState | null;
  blocked: BlockedPlacement[];
  /**
   * true = do NOT push: topology is not loaded yet (a refresh was triggered),
   * or a blocked placement's session is in the currently-pushed doc — a
   * full-doc replace would silently tear down a running stream on what may be
   * a topology flap.
   */
  deferred: boolean;
}

export interface NodePushResult {
  instanceId: string;
  nodeId: string;
  action: 'pushed' | 'skipped' | 'deferred' | 'error';
  detail?: string;
  blocked: BlockedPlacement[];
}

interface NodeRef {
  instanceId: string;
  nodeId: string;
}

function now(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/** DB channel columns → the identity resolvePlacement consumes */
function rowIdentity(r: { channel_name: string; channel_number: string | null }): ChannelIdentity {
  return {
    channelName: r.channel_name,
    channelNumber: r.channel_number,
  };
}

/** never-hydrated / hydration-failed marker for the last-pushed-doc cache */
const UNKNOWN = Symbol('unknown');

/** failover phases whose suppress_from actually stops the outgoing encode */
const SUPPRESSING_PHASES: FailoverPhase[] = [
  'stopping-old',
  'awaiting-stop-confirm',
  'complete',
  'draining',
];

/** body of POST /channels/:id/apply — the modal's transactional Save */
export interface ApplyChannelInput {
  channel?: ChannelPatch;
  /**
   * FULL desired placement set: array order = priority (1-based), `id` absent
   * = create, existing ids missing from the array = delete.
   */
  placements?: Array<{
    id?: string;
    instanceId: string;
    nodeId: string;
    mode: 'hot' | 'cold';
    /** per-placement encode-profile override; null = inherit the channel's profile */
    profileId: string | null;
    programNumber: number | null;
    enabled: boolean;
  }>;
  force?: boolean;
}

/**
 * Restreamer task allocation: owns the restream_* tables, computes each
 * node's desired doc from placements × topology, and pushes it (hash-skip,
 * 60s heal sweep). All mutations are serialized through the same
 * promise-chain pattern as SyncEngine (public wrappers → private *Inner);
 * every mutation ends by pushing the affected node(s) with errors logged, not
 * thrown — a mutation must succeed while a node is down (the sweep heals).
 */
export class RestreamerService {
  private opChain: Promise<unknown> = Promise.resolve();
  /**
   * Last doc each node is known to hold: set on successful push, hydrated
   * lazily from the node (`getDesired`) when cold and the DB says something
   * was pushed. Drives the blocked-defer decision.
   */
  private readonly lastPushedDocs = new Map<string, DesiredState | null>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private rebalanceTimer: NodeJS.Timeout | null = null;
  private readonly topologyDebounce = new Map<string, NodeJS.Timeout>();
  /** per-node debounce for sources-catalog changes, keyed by nodeKey() */
  private readonly sourcesDebounce = new Map<string, NodeJS.Timeout>();
  /** switcher-side sync (desired doc, pushes, rebalance driver) — shares this op chain */
  private readonly switcherSync: SwitcherSync;
  /** four-probe engine over the delivery path; probe state is pulled by the pollers */
  readonly probeEngine: ProbeEngine;
  /** serialized failover orchestrator — shares this op chain via failoverTick */
  private readonly failoverSync: FailoverSync;
  private failoverTimer: NodeJS.Timeout | null = null;
  /** dedup keys for `restreamer-channel` SSE publishes, by channel id */
  private readonly lastChannelPublishKey = new Map<string, string>();
  /**
   * Push fail/heal transition state, keyed by nodeKey(). NOT read from
   * cache.restreamers[].error — the RestreamerPoller overwrites that field
   * every tick with its own reachability error, independent of push outcomes,
   * so reading it here would spam or suppress the transition log depending on
   * unrelated poll timing.
   */
  private readonly pushProblems = new Map<string, string | null>();
  /** brief cache for the per-node probe settings map (probe base tick is 5s) */
  private probeSettingsCache: { at: number; map: Map<string, NodeProbeSettings> } | null = null;
  /** brief cache for the per-node session-cap map, keyed by nodeKey() */
  private nodeCapacityCache: { at: number; map: Map<string, number | null> } | null = null;
  /**
   * brief cache for placementId -> channel slug (session display enrichment,
   * event messages + web). Populated on demand from a single query shared
   * across every node's poll tick rather than a per-tick/per-session lookup;
   * a few seconds of staleness after a channel/placement CRUD is fine — the
   * next poll tick heals it.
   */
  private placementSlugCache: { at: number; map: Map<string, string> } | null = null;
  /** a switch was just ordered — main.ts wires this to SwitcherPoller.pollOnce */
  onSwitchIssued: (() => void) | null = null;

  constructor(
    private readonly db: Db,
    private readonly cache: InstanceCache,
    private readonly pollers: Map<string, InstancePoller>,
    private readonly bus: EventBus,
    private readonly config: AppConfig,
    /** keyed by nodeKey(instanceId, nodeId) */
    private readonly clients: Map<string, RestreamerNodeClient>,
    /** keyed by switcherId; empty = no switchers configured */
    private readonly switcherClients: Map<string, SwitcherNodeClient> = new Map(),
    private readonly events: Pick<EventLog, 'log'> = { log: () => {} },
  ) {
    this.switcherSync = new SwitcherSync(db, cache, bus, config, switcherClients, events);
    this.probeEngine = new ProbeEngine(
      () => this.probeTargets(),
      () => this.allProbeSettings(),
      (channelId) => {
        void this.publishChannelStatus(channelId).catch(() => {});
      },
      undefined,
      undefined,
      events,
    );
    this.failoverSync = new FailoverSync(
      db,
      cache,
      config,
      switcherClients,
      () => this.probeEngine.snapshot(),
      () => this.allProbeSettings(),
      {
        pushNodes: (nodes) => this.pushNodesInner(nodes).then(() => undefined),
        pushSwitchers: () => this.pushAllSwitchersSafe(),
        publishChannel: (channelId) => {
          void this.publishChannelStatus(channelId).catch(() => {});
        },
        onSwitchIssued: () => this.onSwitchIssued?.(),
        markCutoverComplete: (placementId) => this.markCutoverCompleteInner(placementId),
        deleteCutoverPlacement: (placementId) => this.deleteCutoverPlacementInner(placementId),
      },
      undefined,
      events,
    );
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.opChain.then(fn, fn);
    this.opChain = next.catch(() => {});
    return next;
  }

  // ---------- config helpers ----------

  private nodeConfig(instanceId: string, nodeId: string): RestreamerNodeConfig | null {
    const inst = this.config.instances.find((i) => i.id === instanceId);
    return inst?.restreamer?.nodes.find((n) => n.id === nodeId) ?? null;
  }

  private configuredNodes(): Array<NodeRef & { config: RestreamerNodeConfig }> {
    const out: Array<NodeRef & { config: RestreamerNodeConfig }> = [];
    for (const inst of this.config.instances) {
      for (const node of inst.restreamer?.nodes ?? []) {
        out.push({ instanceId: inst.id, nodeId: node.id, config: node });
      }
    }
    return out;
  }

  // ---------- profile CRUD ----------

  private rowToProfile(r: {
    id: string;
    name: string;
    payload: string;
    updated_at: Date;
    transient: number;
  }): RestreamProfile {
    return {
      id: r.id,
      name: r.name,
      payload: JSON.parse(r.payload) as AribHlsParams,
      updatedAt: new Date(r.updated_at).toISOString(),
      transient: !!r.transient,
    };
  }

  /** excludes cutover-owned transient snapshots — never surfaced for manual selection */
  async listProfiles(): Promise<RestreamProfile[]> {
    const rows = await this.db
      .selectFrom('restream_profiles')
      .selectAll()
      .where('transient', '=', 0)
      .orderBy('name')
      .execute();
    return rows.map((r) => this.rowToProfile(r));
  }

  async getProfile(id: string): Promise<RestreamProfile | null> {
    const r = await this.db
      .selectFrom('restream_profiles')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return r ? this.rowToProfile(r) : null;
  }

  /** shared validation for channel-level and placement-level profileId writes */
  private async assertProfileExists(id: string): Promise<void> {
    const profile = await this.getProfile(id);
    if (!profile) throw httpError(400, `profile ${id} not found`);
  }

  createProfile(name: string, payload: unknown): Promise<RestreamProfile> {
    return this.serialize(() => this.createProfileInner(name, payload));
  }

  private async createProfileInner(name: string, payload: unknown): Promise<RestreamProfile> {
    if (!name.trim()) throw httpError(400, 'profile name must not be empty');
    const completed = completeProfileParams(payload);
    await this.assertProfileNameFree(name);
    const id = randomUUID();
    await this.db
      .insertInto('restream_profiles')
      .values({ id, name, payload: JSON.stringify(completed), updated_at: now() })
      .execute();
    return (await this.getProfile(id))!;
  }

  private async assertProfileNameFree(name: string, excludeId?: string): Promise<void> {
    const clash = await this.db
      .selectFrom('restream_profiles')
      .select('id')
      .where('name', '=', name)
      .executeTakeFirst();
    if (clash && clash.id !== excludeId) {
      throw httpError(409, `a profile named "${name}" already exists`);
    }
  }

  updateProfile(id: string, patch: { name?: string; payload?: unknown }): Promise<RestreamProfile> {
    return this.serialize(() => this.updateProfileInner(id, patch));
  }

  private async updateProfileInner(
    id: string,
    patch: { name?: string; payload?: unknown },
  ): Promise<RestreamProfile> {
    const existing = await this.getProfile(id);
    if (!existing) throw httpError(404, `profile ${id} not found`);
    const name = patch.name ?? existing.name;
    if (patch.name !== undefined) {
      if (!name.trim()) throw httpError(400, 'profile name must not be empty');
      await this.assertProfileNameFree(name, id);
    }
    const payload =
      patch.payload !== undefined ? completeProfileParams(patch.payload) : existing.payload;

    // A payload edit rewrites this profile row IN PLACE (same id), so every
    // placement currently rendering it (explicit override or inherited
    // default) is about to see new bytes. Route each such `from` through a
    // same-node cutover clone when eligible, snapshotting the OLD payload
    // onto `from` first. This MUST run before the UPDATE below, or a push
    // racing this call could observe `from` already reflecting the new
    // payload while still unfrozen.
    if (patch.payload !== undefined) {
      const affected = await this.placementsUsingProfile(id);
      for (const p of affected) {
        await this.routeProfileChange({
          from: {
            id: p.id,
            channel_id: p.channel_id,
            instance_id: p.instance_id,
            node_id: p.node_id,
            priority: p.priority,
            program_number: p.program_number,
            enabled: p.enabled,
            mode: p.mode,
          },
          channelSlug: p.slug,
          cloneProfileId: p.profile_id,
          freeze: { kind: 'snapshot', payload: existing.payload },
        });
      }
    }

    await this.db
      .updateTable('restream_profiles')
      .set({ name, payload: JSON.stringify(payload), updated_at: now() })
      .where('id', '=', id)
      .execute();
    // re-push every node hosting a placement of a channel using this profile;
    // the switcher doc depends on the payload too (hls.segmentSeconds). This
    // also covers cutover clones: a clone's cloneProfileId mirrors `from`'s
    // pre-freeze effective override, so it still matches the query below even
    // though `from` itself is now pinned to the snapshot.
    if (patch.payload !== undefined) {
      await this.pushAffectedByProfileInner(id).catch((err) =>
        console.error('restreamer: profile re-push failed:', err),
      );
      await this.pushAllSwitchersSafe();
    }
    return (await this.getProfile(id))!;
  }

  deleteProfile(id: string): Promise<void> {
    return this.serialize(() => this.deleteProfileInner(id));
  }

  private async deleteProfileInner(id: string): Promise<void> {
    const existing = await this.getProfile(id);
    if (!existing) throw httpError(404, `profile ${id} not found`);
    // app-level check first — the FK RESTRICT is only the backstop
    const refs = await this.db
      .selectFrom('restream_channels')
      .select('slug')
      .where('profile_id', '=', id)
      .execute();
    if (refs.length) {
      const names = refs
        .slice(0, 5)
        .map((r) => `"${r.slug}"`)
        .join(', ');
      throw httpError(
        409,
        `profile "${existing.name}" is used by ${refs.length} channel(s) (${names}${refs.length > 5 ? ', …' : ''}) — reassign them first`,
      );
    }
    // per-placement overrides have no FK backstop — this app-level check IS
    // the only enforcement
    const placementRefs = await this.db
      .selectFrom('restream_placements as p')
      .innerJoin('restream_channels as c', 'c.id', 'p.channel_id')
      .select('c.slug')
      .where('p.profile_id', '=', id)
      .execute();
    if (placementRefs.length) {
      const names = placementRefs
        .slice(0, 5)
        .map((r) => `"${r.slug}"`)
        .join(', ');
      throw httpError(
        409,
        `profile "${existing.name}" is used by ${placementRefs.length} placement(s) on channel(s) (${names}${placementRefs.length > 5 ? ', …' : ''}) — reassign them first`,
      );
    }
    await this.db.deleteFrom('restream_profiles').where('id', '=', id).execute();
  }

  // ---------- channel CRUD ----------

  /** duplicate a profile under a new name (payload copied verbatim) */
  cloneProfile(id: string, name: string): Promise<RestreamProfile> {
    return this.serialize(async () => {
      const source = await this.getProfile(id);
      if (!source) throw httpError(404, `restream profile ${id} not found`);
      const trimmed = name.trim();
      if (!trimmed) throw httpError(400, 'name must not be empty');
      await this.assertProfileNameFree(trimmed);
      const newId = randomUUID();
      await this.db
        .insertInto('restream_profiles')
        .values({
          id: newId,
          name: trimmed,
          payload: JSON.stringify(source.payload),
          updated_at: now(),
        })
        .execute();
      return (await this.getProfile(newId))!;
    });
  }

  private rowToChannel(
    r: {
      id: string;
      slug: string;
      channel_name: string;
      channel_number: string | null;
      profile_id: string;
      enabled: number;
      comment: string | null;
      updated_at: Date;
    },
    playlistIds: string[],
  ): RestreamChannel {
    return {
      id: r.id,
      slug: r.slug,
      channelName: r.channel_name,
      channelNumber: r.channel_number,
      profileId: r.profile_id,
      enabled: !!r.enabled,
      comment: r.comment,
      playlistIds,
      updatedAt: new Date(r.updated_at).toISOString(),
    };
  }

  private rowToPlacement(r: {
    id: string;
    channel_id: string;
    instance_id: string;
    node_id: string;
    priority: number;
    enabled: number;
    mode: string;
    profile_id: string | null;
    program_number: number | null;
    updated_at: Date;
    transient: number;
  }): RestreamPlacement {
    return {
      id: r.id,
      channelId: r.channel_id,
      instanceId: r.instance_id,
      nodeId: r.node_id,
      priority: r.priority,
      enabled: !!r.enabled,
      // unknown values read as 'hot' — the pre-migration behavior
      mode: r.mode === 'cold' ? 'cold' : 'hot',
      profileId: r.profile_id,
      programNumber: r.program_number,
      updatedAt: new Date(r.updated_at).toISOString(),
      transient: !!r.transient,
    };
  }

  private async channelPlaylistIds(channelId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('restream_playlist_members')
      .select('playlist_id')
      .where('channel_id', '=', channelId)
      .execute();
    return rows.map((r) => r.playlist_id);
  }

  async getChannel(id: string): Promise<RestreamChannel | null> {
    const r = await this.db
      .selectFrom('restream_channels')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return r ? this.rowToChannel(r, await this.channelPlaylistIds(id)) : null;
  }

  /**
   * Every logical channel with live status folded in: profile name,
   * placements (blockedReason from the same resolution rules the desired doc
   * uses + live session from the node's last poll), switcher-side active
   * placement, and the viewer-facing playback URL.
   */
  async listChannels(): Promise<RestreamChannelWithStatus[]> {
    const [channels, profiles, placements, members, failoverRows] = await Promise.all([
      this.db.selectFrom('restream_channels').selectAll().orderBy('slug').execute(),
      this.db.selectFrom('restream_profiles').selectAll().execute(),
      this.db
        .selectFrom('restream_placements')
        .selectAll()
        .orderBy('priority')
        .orderBy('id')
        .execute(),
      this.db.selectFrom('restream_playlist_members').selectAll().execute(),
      this.db.selectFrom('restream_failover_state').selectAll().execute(),
    ]);
    const profileNames = new Map(profiles.map((p) => [p.id, p.name]));
    const rowByChannel = new Map(failoverRows.map((r) => [r.channel_id, r]));

    return channels.map((c) => {
      const chanPlacements = placements.filter((p) => p.channel_id === c.id);
      const playlistIds = members.filter((m) => m.channel_id === c.id).map((m) => m.playlist_id);
      const fo = rowByChannel.get(c.id) ?? null;
      const indicators = fo
        ? placementIndicators({
            phase: fo.phase as FailoverPhase,
            fromPlacementId: fo.from_placement_id,
            toPlacementId: fo.to_placement_id,
            suppressFrom: !!fo.suppress_from,
          })
        : new Map<string, never>();
      const withStatus = chanPlacements.map((p) => {
        const resolution = this.resolvePlacement(
          p.instance_id,
          p.node_id,
          rowIdentity(c),
          p.program_number,
        );
        const nodeStatus = this.cachedNodeStatus(p.instance_id, p.node_id);
        return {
          ...this.rowToPlacement(p),
          blockedReason: resolution.ok ? null : resolution.reason,
          resolvedVia: resolution.ok ? resolution.via : null,
          session: nodeStatus?.sessions.find((s) => s.name === p.id) ?? null,
          indicator: indicators.get(p.id) ?? ('idle' as const),
          lagProbe: this.probeEngine.lagStatus(p.id),
        };
      });
      const { activePlacementId, lastSwitch } = this.switcherView(c.slug);
      const failover: ChannelFailoverStatus | null = fo
        ? {
            fromPlacementId: fo.from_placement_id,
            toPlacementId: fo.to_placement_id,
            phase: fo.phase as FailoverPhase,
            triggerReason: fo.trigger_reason as FailoverTriggerReason,
            triggerDetail: fo.trigger_detail,
            startedAt: new Date(fo.started_at).toISOString(),
          }
        : null;
      return {
        ...this.rowToChannel(c, playlistIds),
        profileName: profileNames.get(c.profile_id) ?? c.profile_id,
        placements: withStatus,
        failover,
        failoverBlocked: this.failoverSync.blockedReason(c.id),
        activePlacementId,
        lastSwitch,
        playbackUrl: this.playbackUrl(
          c.slug,
          chanPlacements.filter((p) => !!p.enabled),
        ),
      };
    });
  }

  /**
   * Single-channel variant of listChannels() — the shape the web edit modal
   * re-fetches after placement mutations (a bare RestreamChannel would crash
   * its placement rendering). Tables are small; reusing listChannels keeps
   * the status/resolution semantics identical by construction.
   */
  async channelWithStatus(id: string): Promise<RestreamChannelWithStatus | null> {
    return (await this.listChannels()).find((c) => c.id === id) ?? null;
  }

  private cachedNodeStatus(instanceId: string, nodeId: string): RestreamerNodeStatus | null {
    if (!this.cache.has(instanceId)) return null;
    return this.cache.get(instanceId).restreamers.find((r) => r.nodeId === nodeId) ?? null;
  }

  private switcherView(slug: string): {
    activePlacementId: string | null;
    lastSwitch: { at: string; from: string | null; to: string; reason: SwitchReason } | null;
  } {
    for (const sw of this.config.restreamer?.switchers ?? []) {
      const status = this.cache.switchers.get(sw.id);
      const chan = status?.channels.find((ch) => ch.slug === slug);
      if (chan) return { activePlacementId: chan.activeUpstreamId, lastSwitch: chan.lastSwitch };
    }
    return { activePlacementId: null, lastSwitch: null };
  }

  /**
   * Viewer-facing URL: with a switcher configured EVERY channel with ≥1
   * enabled placement is fronted by the first switcher's public base (uniform
   * viewer URLs — adding a second placement later never changes the URL).
   * Without a switcher: one enabled placement → straight at that node's
   * serveUrl; several → null (no single node is authoritative); none
   * serveable → null.
   */
  private playbackUrl(
    slug: string,
    enabledPlacements: Array<{ id: string; instance_id: string; node_id: string }>,
  ): string | null {
    if (enabledPlacements.length === 0) return null;
    const sw = this.config.restreamer?.switchers[0];
    if (sw) return `${sw.publicUrl}/hls/${slug}/playlist.m3u8`;
    if (enabledPlacements.length === 1) {
      const p = enabledPlacements[0]!;
      const serveUrl = this.nodeConfig(p.instance_id, p.node_id)?.serveUrl;
      return serveUrl ? `${serveUrl}/${p.id}/playlist.m3u8` : null;
    }
    return null;
  }

  createChannel(input: CreateChannelInput): Promise<RestreamChannel> {
    return this.serialize(() => this.createChannelInner(input));
  }

  private async createChannelInner(input: CreateChannelInput): Promise<RestreamChannel> {
    if (!input.channelName) throw httpError(400, 'channelName must not be empty');
    const profile = await this.getProfile(input.profileId);
    if (!profile) throw httpError(400, `profile ${input.profileId} not found`);

    const placements = input.placements ?? [];
    const placementKeys = new Set<string>();
    for (const p of placements) {
      this.assertNodeConfigured(p.instanceId, p.nodeId);
      const key = nodeKey(p.instanceId, p.nodeId);
      if (placementKeys.has(key)) {
        throw httpError(409, `duplicate placement on node "${key}"`);
      }
      placementKeys.add(key);
      if (p.profileId != null) await this.assertProfileExists(p.profileId);
    }

    // channel number identity: given → stored verbatim as a STRING; absent →
    // write-time pin to the lowest-numbered same-name channel/catalog entry
    // across the instances+nodes that will host placements (unresolvable
    // stays null)
    let channelNumber = input.channelNumber == null ? null : String(input.channelNumber);
    if (channelNumber == null) {
      channelNumber = this.pinChannelNumber(
        input.channelName,
        placements.map((p) => ({ instanceId: p.instanceId, nodeId: p.nodeId })),
      );
    }

    // write-time availability over ALL requested placements (409 lists every
    // failing node); config errors above stay 400 and win
    if (!input.force) {
      this.assertPlacementsAvailable(
        placements.map((p) => ({
          instanceId: p.instanceId,
          nodeId: p.nodeId,
          programOverride: p.programNumber ?? null,
        })),
        { channelName: input.channelName, channelNumber },
        'create',
      );
    }

    const slug = input.slug
      ? await this.validateExplicitSlug(input.slug)
      : await this.uniqueChannelSlug(deriveSlug(input.channelName));

    const playlistIds = [...new Set(input.playlistIds ?? [])];
    await this.assertPlaylistsExist(playlistIds);

    const id = randomUUID();
    await this.db
      .insertInto('restream_channels')
      .values({
        id,
        slug,
        channel_name: input.channelName,
        channel_number: channelNumber,
        profile_id: input.profileId,
        enabled: input.enabled === false ? 0 : 1,
        comment: input.comment ?? null,
        updated_at: now(),
      })
      .execute();

    let priority = 0;
    for (const p of placements) {
      priority = p.priority ?? priority + 1;
      await this.db
        .insertInto('restream_placements')
        .values({
          id: randomUUID(),
          channel_id: id,
          instance_id: p.instanceId,
          node_id: p.nodeId,
          priority,
          enabled: p.enabled === false ? 0 : 1,
          mode: p.mode ?? 'hot',
          profile_id: p.profileId ?? null,
          program_number: p.programNumber ?? null,
          updated_at: now(),
        })
        .execute();
    }

    for (const playlistId of playlistIds) {
      await this.db
        .insertInto('restream_playlist_members')
        .values({ playlist_id: playlistId, channel_id: id })
        .execute();
    }

    await this.pushAffectedByChannelSafe(id);
    return (await this.getChannel(id))!;
  }

  updateChannel(id: string, patch: ChannelPatch): Promise<RestreamChannel> {
    return this.serialize(() => this.updateChannelInner(id, patch));
  }

  private async updateChannelInner(id: string, patch: ChannelPatch): Promise<RestreamChannel> {
    await this.updateChannelRows(id, patch);
    await this.pushAffectedByChannelSafe(id);
    return (await this.getChannel(id))!;
  }

  /** channel-field mutation only — no push (shared by update and apply) */
  private async updateChannelRows(id: string, patch: ChannelPatch): Promise<void> {
    const existing = await this.db
      .selectFrom('restream_channels')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!existing) throw httpError(404, `restream channel ${id} not found`);

    const nameSet = patch.channelName !== undefined;
    const numberSet = patch.channelNumber !== undefined;
    const channelName = nameSet ? patch.channelName! : existing.channel_name;
    if (nameSet && !channelName) throw httpError(400, 'channelName must not be empty');

    const placementRows = await this.db
      .selectFrom('restream_placements')
      .select(['instance_id', 'node_id', 'program_number'])
      .where('channel_id', '=', id)
      .execute();

    // channel identity is a (name, number) pair: a patch that sets the name
    // WITHOUT an explicit number must never inherit the previous pin.
    let channelNumber: string | null;
    if (numberSet) channelNumber = patch.channelNumber == null ? null : String(patch.channelNumber);
    else if (nameSet) channelNumber = null;
    else channelNumber = existing.channel_number;

    // write-time pin-lowest across the instances+nodes hosting this channel
    if (channelNumber == null && (nameSet || numberSet)) {
      channelNumber = this.pinChannelNumber(
        channelName,
        placementRows.map((p) => ({ instanceId: p.instance_id, nodeId: p.node_id })),
      );
    }

    // an identity change must re-validate EVERY existing placement against
    // the new identity (409 lists all failures); non-identity patches never check
    const identityChanged =
      channelName !== existing.channel_name || channelNumber !== existing.channel_number;
    if (identityChanged && !patch.force) {
      this.assertPlacementsAvailable(
        placementRows.map((p) => ({
          instanceId: p.instance_id,
          nodeId: p.node_id,
          programOverride: p.program_number,
        })),
        { channelName, channelNumber },
        'update',
      );
    }

    let slug = existing.slug;
    if (patch.slug !== undefined && patch.slug !== existing.slug) {
      slug = await this.validateExplicitSlug(patch.slug, id);
    }

    let profileId = existing.profile_id;
    if (patch.profileId !== undefined && patch.profileId !== existing.profile_id) {
      const profile = await this.getProfile(patch.profileId);
      if (!profile) throw httpError(400, `profile ${patch.profileId} not found`);
      profileId = patch.profileId;

      // Every placement that inherits the channel's default (no per-placement
      // override) is about to flip to the new profile once the UPDATE below
      // commits. Pin each one to the OLD profile id (and try a same-node
      // cutover clone) BEFORE that UPDATE runs, or there's a window where
      // `from` is still unfrozen but the channel row already resolves to the
      // new profile. Placement-level overrides are untouched — they don't
      // inherit the channel default.
      const inheriting = await this.db
        .selectFrom('restream_placements')
        .selectAll()
        .where('channel_id', '=', id)
        .where('profile_id', 'is', null)
        .where('transient', '=', 0)
        .execute();
      for (const p of inheriting) {
        await this.routeProfileChange({
          from: {
            id: p.id,
            channel_id: id,
            instance_id: p.instance_id,
            node_id: p.node_id,
            priority: p.priority,
            program_number: p.program_number,
            enabled: p.enabled,
            mode: p.mode,
          },
          channelSlug: existing.slug,
          cloneProfileId: patch.profileId,
          freeze: { kind: 'pin', profileId: existing.profile_id },
        });
      }
    }

    await this.db
      .updateTable('restream_channels')
      .set({
        channel_name: channelName,
        channel_number: channelNumber,
        slug,
        profile_id: profileId,
        enabled: patch.enabled === undefined ? existing.enabled : patch.enabled ? 1 : 0,
        comment: patch.comment === undefined ? existing.comment : patch.comment,
        updated_at: now(),
      })
      .where('id', '=', id)
      .execute();

    if (patch.playlistIds !== undefined) {
      await this.setChannelPlaylistsInner(id, patch.playlistIds);
    }
  }

  /**
   * Transactional Save for the channel edit modal: channel-field patch + the
   * FULL desired placement set (array order = priority, missing ids = delete,
   * id-less entries = create) applied together with ONE availability pass and
   * ONE push pass. All-or-nothing: any validation failure writes nothing.
   */
  applyChannelChanges(id: string, input: ApplyChannelInput): Promise<RestreamChannelWithStatus> {
    return this.serialize(() => this.applyChannelChangesInner(id, input));
  }

  private async applyChannelChangesInner(
    id: string,
    input: ApplyChannelInput,
  ): Promise<RestreamChannelWithStatus> {
    const existing = await this.db
      .selectFrom('restream_channels')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!existing) throw httpError(404, `restream channel ${id} not found`);
    const existingPlacements = await this.db
      .selectFrom('restream_placements')
      .selectAll()
      .where('channel_id', '=', id)
      .execute();
    const patch = input.channel ?? {};
    const desired = input.placements;

    // validate the desired placement set before touching anything
    if (desired) {
      const byId = new Map(existingPlacements.map((p) => [p.id, p]));
      const nodeKeys = new Set<string>();
      for (const p of desired) {
        this.assertNodeConfigured(p.instanceId, p.nodeId);
        const key = nodeKey(p.instanceId, p.nodeId);
        if (nodeKeys.has(key)) throw httpError(409, `duplicate placement on node "${key}"`);
        nodeKeys.add(key);
        if (p.id !== undefined && !byId.has(p.id)) {
          throw httpError(400, `placement ${p.id} does not belong to channel ${id}`);
        }
        if (p.profileId != null) await this.assertProfileExists(p.profileId);
      }
      // kept placements are about to be rewritten in place — reject if any is
      // pinned by an in-flight failover procedure (force bypasses)
      await this.assertNotMidProcedure(
        desired.filter((p) => p.id !== undefined).map((p) => p.id!),
        input.force,
      );
    }

    // final identity (same rules as updateChannelRows, but pinned across the
    // DESIRED placement set rather than the pre-apply one)
    const nameSet = patch.channelName !== undefined;
    const numberSet = patch.channelNumber !== undefined;
    const channelName = nameSet ? patch.channelName! : existing.channel_name;
    if (nameSet && !channelName) throw httpError(400, 'channelName must not be empty');
    let channelNumber: string | null;
    if (numberSet) channelNumber = patch.channelNumber == null ? null : String(patch.channelNumber);
    else if (nameSet) channelNumber = null;
    else channelNumber = existing.channel_number;
    const pinTargets = (desired ?? existingPlacements).map((p) => ({
      instanceId: 'instanceId' in p ? p.instanceId : p.instance_id,
      nodeId: 'nodeId' in p ? p.nodeId : p.node_id,
    }));
    if (channelNumber == null && (nameSet || numberSet)) {
      channelNumber = this.pinChannelNumber(channelName, pinTargets);
    }

    // one availability pass over the whole desired set with the final identity
    if (!input.force) {
      const targets = (desired ?? []).map((p) => ({
        instanceId: p.instanceId,
        nodeId: p.nodeId,
        programOverride: p.programNumber,
      }));
      const identityChanged =
        channelName !== existing.channel_name || channelNumber !== existing.channel_number;
      if (identityChanged && !desired) {
        targets.push(
          ...existingPlacements.map((p) => ({
            instanceId: p.instance_id,
            nodeId: p.node_id,
            programOverride: p.program_number,
          })),
        );
      }
      if (targets.length) {
        this.assertPlacementsAvailable(targets, { channelName, channelNumber }, 'apply');
      }
    }

    // capture push targets BEFORE deletions so leaving nodes get re-pushed
    const nodesBefore = await this.affectedNodesByChannel(id);

    await this.updateChannelRows(id, {
      ...patch,
      channelName,
      channelNumber,
      force: true, // availability already asserted above
    });

    if (desired) {
      const keptIds = new Set(desired.filter((p) => p.id !== undefined).map((p) => p.id!));
      const sweepIds = existingPlacements.filter((p) => !keptIds.has(p.id)).map((p) => p.id);
      // never sweep a placement an in-flight failover depends on (even with force)
      const protectedIds = new Set(
        (await this.midProcedurePlacements(sweepIds)).map((b) => b.placementId),
      );
      // transient=1 rows are owned by the cutover lifecycle (createCutoverClone
      // / deleteCutoverPlacement) — the apply sweep never touches them, even
      // once the failover row that spawned them has completed and stopped
      // being "mid-procedure"
      const transientIds = new Set(existingPlacements.filter((p) => p.transient).map((p) => p.id));
      for (const pid of sweepIds) {
        if (protectedIds.has(pid) || transientIds.has(pid)) continue;
        await this.db.deleteFrom('restream_placements').where('id', '=', pid).execute();
      }
      // An existing-placement UPDATE where ONLY profileId differs from what's
      // already on the row is a cutover candidate; anything else changing
      // alongside it (a move, priority/enabled/mode/program) is a combined
      // edit and always goes direct, to keep the scoping conservative.
      const byId = new Map(existingPlacements.map((p) => [p.id, p]));
      for (const [index, p] of desired.entries()) {
        if (p.id !== undefined) {
          const prev = byId.get(p.id);
          let routed = false;
          if (
            prev &&
            !prev.transient &&
            p.profileId !== prev.profile_id &&
            p.instanceId === prev.instance_id &&
            p.nodeId === prev.node_id &&
            index + 1 === prev.priority &&
            (p.enabled ? 1 : 0) === prev.enabled &&
            p.mode === prev.mode &&
            (p.programNumber ?? null) === prev.program_number
          ) {
            const result = await this.routeProfileChange({
              from: {
                id: prev.id,
                channel_id: prev.channel_id,
                instance_id: prev.instance_id,
                node_id: prev.node_id,
                priority: prev.priority,
                program_number: prev.program_number,
                enabled: prev.enabled,
                mode: prev.mode,
              },
              channelSlug: existing.slug,
              cloneProfileId: p.profileId,
              freeze: { kind: 'none' },
            });
            routed = result.cutover;
          }
          if (routed) continue;
          await this.db
            .updateTable('restream_placements')
            .set({
              instance_id: p.instanceId,
              node_id: p.nodeId,
              priority: index + 1,
              enabled: p.enabled ? 1 : 0,
              mode: p.mode,
              profile_id: p.profileId,
              program_number: p.programNumber,
              updated_at: now(),
            })
            .where('id', '=', p.id)
            .execute();
        } else {
          await this.db
            .insertInto('restream_placements')
            .values({
              id: randomUUID(),
              channel_id: id,
              instance_id: p.instanceId,
              node_id: p.nodeId,
              priority: index + 1,
              enabled: p.enabled ? 1 : 0,
              mode: p.mode,
              profile_id: p.profileId,
              program_number: p.programNumber,
              updated_at: now(),
            })
            .execute();
        }
      }
    }

    const nodesAfter = await this.affectedNodesByChannel(id);
    await this.pushNodesSafe([...nodesBefore, ...nodesAfter]);
    await this.pushAllSwitchersSafe();
    void this.publishChannelStatus(id).catch(() => {});
    return (await this.channelWithStatus(id))!;
  }

  deleteChannel(id: string): Promise<void> {
    return this.serialize(() => this.deleteChannelInner(id));
  }

  private async deleteChannelInner(id: string): Promise<void> {
    const existing = await this.getChannel(id);
    if (!existing) throw httpError(404, `restream channel ${id} not found`);
    // affected nodes must be captured BEFORE the cascade removes the placements
    const nodes = await this.affectedNodesByChannel(id);
    await this.db.deleteFrom('restream_channels').where('id', '=', id).execute();
    await this.pushNodesSafe(nodes);
  }

  /**
   * Batch channel operation with per-id outcomes: one failing channel never
   * aborts the rest (mirrors SyncEngine's batch results).
   */
  batchChannels(
    action: ChannelBatchAction,
    ids: string[],
    opts: { patch?: ChannelPatch; playlistId?: string } = {},
  ): Promise<ChannelBatchResult[]> {
    return this.serialize(async () => {
      const out: ChannelBatchResult[] = [];
      for (const id of ids) {
        try {
          await this.applyBatchAction(action, id, opts);
          out.push({ id, ok: true });
        } catch (err) {
          out.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return out;
    });
  }

  private async applyBatchAction(
    action: ChannelBatchAction,
    id: string,
    opts: { patch?: ChannelPatch; playlistId?: string },
  ): Promise<void> {
    switch (action) {
      case 'edit': {
        const patch = { ...(opts.patch ?? {}) };
        delete patch.slug; // slugs stay per-channel unique — never batch-assigned
        await this.updateChannelInner(id, patch);
        break;
      }
      case 'delete':
        await this.deleteChannelInner(id);
        break;
      case 'enable':
        await this.updateChannelInner(id, { enabled: true });
        break;
      case 'disable':
        await this.updateChannelInner(id, { enabled: false });
        break;
      case 'add-playlist': {
        if (!opts.playlistId) throw httpError(400, 'playlistId is required');
        await this.assertPlaylistsExist([opts.playlistId]);
        const channel = await this.getChannel(id);
        if (!channel) throw httpError(404, `restream channel ${id} not found`);
        if (!channel.playlistIds.includes(opts.playlistId)) {
          await this.db
            .insertInto('restream_playlist_members')
            .values({ playlist_id: opts.playlistId, channel_id: id })
            .execute();
        }
        break;
      }
      case 'remove-playlist': {
        if (!opts.playlistId) throw httpError(400, 'playlistId is required');
        const channel = await this.getChannel(id);
        if (!channel) throw httpError(404, `restream channel ${id} not found`);
        await this.db
          .deleteFrom('restream_playlist_members')
          .where('playlist_id', '=', opts.playlistId)
          .where('channel_id', '=', id)
          .execute();
        break;
      }
    }
  }

  // ---------- channel identity / slug helpers ----------

  /**
   * Write-time pin: lowest-numbered channel/catalog-entry with this name
   * (chanNumberOrder, ordering only — identity stays exact-string) across the
   * UNION of the placements' instance topologies AND their nodes' sources
   * catalogs. Null when nothing resolves anywhere — push-time resolution then
   * falls back to lowest-at-compute per placement.
   */
  private pinChannelNumber(
    channelName: string,
    placements: Array<{ instanceId: string; nodeId: string }>,
  ): string | null {
    let lowest: string | null = null;
    const consider = (candidate: string): void => {
      if (lowest == null || chanNumberOrder(candidate) < chanNumberOrder(lowest)) lowest = candidate;
    };

    const instanceIds = new Set(placements.map((p) => p.instanceId));
    for (const id of instanceIds) {
      if (!this.cache.has(id)) continue;
      const topo = this.cache.get(id).topology;
      if (!topo) continue;
      for (const c of topo.channels) {
        if (c.name === channelName && c.number != null) consider(c.number);
      }
    }

    const seenNodes = new Set<string>();
    for (const p of placements) {
      const key = nodeKey(p.instanceId, p.nodeId);
      if (seenNodes.has(key)) continue;
      seenNodes.add(key);
      const sources = this.cachedNodeStatus(p.instanceId, p.nodeId)?.sources;
      if (!sources) continue;
      for (const e of sources) {
        if (e.name === channelName) consider(e.chno);
      }
    }

    return lowest;
  }

  private async takenChannelSlugs(excludeId?: string): Promise<Set<string>> {
    const rows = await this.db.selectFrom('restream_channels').select(['id', 'slug']).execute();
    return new Set(rows.filter((r) => r.id !== excludeId).map((r) => r.slug));
  }

  private async uniqueChannelSlug(base: string, excludeId?: string): Promise<string> {
    const taken = await this.takenChannelSlugs(excludeId);
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
      const suffix = `-${n}`;
      const candidate = `${base.slice(0, 64 - suffix.length).replace(/-+$/, '')}${suffix}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  private async validateExplicitSlug(slug: string, excludeId?: string): Promise<string> {
    if (!SLUG_PATTERN.test(slug)) {
      throw httpError(
        400,
        `invalid slug "${slug}" — must match ${SLUG_PATTERN.source} (lowercase alphanumerics and dashes, starting alphanumeric, max 64 chars)`,
      );
    }
    const taken = await this.takenChannelSlugs(excludeId);
    if (taken.has(slug)) throw httpError(409, `slug "${slug}" is already in use`);
    return slug;
  }

  private assertNodeConfigured(instanceId: string, nodeId: string): void {
    const inst = this.config.instances.find((i) => i.id === instanceId);
    if (!inst) throw httpError(400, `unknown instance "${instanceId}"`);
    if (!inst.restreamer?.nodes.some((n) => n.id === nodeId)) {
      throw httpError(400, `instance "${instanceId}" has no restreamer node "${nodeId}"`);
    }
  }

  /**
   * Placements referenced (as from/to) by an IN-FLIGHT failover procedure,
   * with the row's channel slug and phase for error messages. Phase set is
   * failoverPolicy's midProcedure — complete/draining rows never match.
   */
  private async midProcedurePlacements(
    placementIds: string[],
  ): Promise<Array<{ placementId: string; channelSlug: string; phase: FailoverPhase }>> {
    if (placementIds.length === 0) return [];
    const rows = await this.db
      .selectFrom('restream_failover_state as fs')
      .innerJoin('restream_channels as c', 'c.id', 'fs.channel_id')
      .select(['fs.from_placement_id', 'fs.to_placement_id', 'fs.phase', 'c.slug'])
      .where((eb) =>
        eb.or([
          eb('fs.from_placement_id', 'in', placementIds),
          eb('fs.to_placement_id', 'in', placementIds),
        ]),
      )
      .execute();
    const ids = new Set(placementIds);
    const out: Array<{ placementId: string; channelSlug: string; phase: FailoverPhase }> = [];
    for (const r of rows) {
      const phase = r.phase as FailoverPhase;
      if (!midProcedure(phase)) continue;
      for (const pid of [r.from_placement_id, r.to_placement_id]) {
        if (pid !== null && ids.has(pid)) {
          out.push({ placementId: pid, channelSlug: r.slug, phase });
        }
      }
    }
    return out;
  }

  /**
   * Reject (409) mutating a placement that an in-flight failover procedure
   * depends on — deleting/rewriting from/to mid-procedure would strand the
   * orchestrator. `force` bypasses (the caller accepts the consequences).
   */
  private async assertNotMidProcedure(
    placementIds: string[],
    force: boolean | undefined,
  ): Promise<void> {
    if (force) return;
    const busy = await this.midProcedurePlacements(placementIds);
    if (busy.length === 0) return;
    const detail = busy
      .map((b) => `placement ${b.placementId} of channel "${b.channelSlug}" (phase ${b.phase})`)
      .join('; ');
    throw httpError(409, `failover in progress — ${detail} — pass force to mutate anyway`);
  }

  // ---------- placement CRUD ----------

  addPlacement(channelId: string, input: PlacementInput): Promise<RestreamPlacement> {
    return this.serialize(() => this.addPlacementInner(channelId, input));
  }

  private async addPlacementInner(
    channelId: string,
    input: PlacementInput,
  ): Promise<RestreamPlacement> {
    const channel = await this.getChannel(channelId);
    if (!channel) throw httpError(404, `restream channel ${channelId} not found`);
    this.assertNodeConfigured(input.instanceId, input.nodeId);

    const existing = await this.db
      .selectFrom('restream_placements')
      .selectAll()
      .where('channel_id', '=', channelId)
      .execute();
    if (existing.some((p) => p.instance_id === input.instanceId && p.node_id === input.nodeId)) {
      throw httpError(
        409,
        `channel "${channel.slug}" already has a placement on ${nodeKey(input.instanceId, input.nodeId)}`,
      );
    }

    // write-time availability of the channel identity on the TARGET node
    if (!input.force) {
      this.assertPlacementsAvailable(
        [
          {
            instanceId: input.instanceId,
            nodeId: input.nodeId,
            programOverride: input.programNumber ?? null,
          },
        ],
        { channelName: channel.channelName, channelNumber: channel.channelNumber },
        'add',
      );
    }

    if (input.profileId != null) await this.assertProfileExists(input.profileId);

    const priority =
      input.priority ?? (existing.length ? Math.max(...existing.map((p) => p.priority)) + 1 : 1);

    const id = randomUUID();
    await this.db
      .insertInto('restream_placements')
      .values({
        id,
        channel_id: channelId,
        instance_id: input.instanceId,
        node_id: input.nodeId,
        priority,
        enabled: input.enabled === false ? 0 : 1,
        mode: input.mode ?? 'hot',
        profile_id: input.profileId ?? null,
        program_number: input.programNumber ?? null,
        updated_at: now(),
      })
      .execute();

    await this.pushNodesSafe([{ instanceId: input.instanceId, nodeId: input.nodeId }]);
    const row = await this.db
      .selectFrom('restream_placements')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return this.rowToPlacement(row);
  }

  updatePlacement(id: string, patch: PlacementPatch): Promise<RestreamPlacement> {
    return this.serialize(() => this.updatePlacementInner(id, patch));
  }

  private async updatePlacementInner(id: string, patch: PlacementPatch): Promise<RestreamPlacement> {
    const existing = await this.db
      .selectFrom('restream_placements')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!existing) throw httpError(404, `placement ${id} not found`);
    await this.assertNotMidProcedure([id], patch.force);

    const instanceId = patch.instanceId ?? existing.instance_id;
    const nodeId = patch.nodeId ?? existing.node_id;
    const moved = instanceId !== existing.instance_id || nodeId !== existing.node_id;
    if (moved) {
      this.assertNodeConfigured(instanceId, nodeId);
      const clash = await this.db
        .selectFrom('restream_placements')
        .select('id')
        .where('channel_id', '=', existing.channel_id)
        .where('instance_id', '=', instanceId)
        .where('node_id', '=', nodeId)
        .executeTakeFirst();
      if (clash) {
        throw httpError(409, `channel already has a placement on ${nodeKey(instanceId, nodeId)}`);
      }
      // moving to another node re-checks availability THERE (with the
      // placement's effective program-number override)
      if (!patch.force) {
        const chanRow = await this.db
          .selectFrom('restream_channels')
          .select(['channel_name', 'channel_number'])
          .where('id', '=', existing.channel_id)
          .executeTakeFirstOrThrow();
        this.assertPlacementsAvailable(
          [
            {
              instanceId,
              nodeId,
              programOverride:
                patch.programNumber === undefined ? existing.program_number : patch.programNumber,
            },
          ],
          rowIdentity(chanRow),
          'move',
        );
      }
    }

    if (patch.profileId != null) await this.assertProfileExists(patch.profileId);

    // A pure profile-override flip (nothing else in the patch changes the
    // row) is a cutover candidate — try a same-node clone rendering the NEW
    // override; on success, skip writing profile_id onto `from` at all
    // (freeze:'none' — no live profile row is being edited here, so `from`
    // simply keeps its current profile_id for the rest of the cutover).
    let routed = false;
    if (
      !moved &&
      patch.profileId !== undefined &&
      patch.profileId !== existing.profile_id &&
      (patch.priority === undefined || patch.priority === existing.priority) &&
      (patch.enabled === undefined || (patch.enabled ? 1 : 0) === existing.enabled) &&
      (patch.mode === undefined || patch.mode === existing.mode) &&
      (patch.programNumber === undefined || patch.programNumber === existing.program_number) &&
      !existing.transient
    ) {
      const newProfileId = patch.profileId;
      const chan = await this.db
        .selectFrom('restream_channels')
        .select(['slug'])
        .where('id', '=', existing.channel_id)
        .executeTakeFirstOrThrow();
      const result = await this.routeProfileChange({
        from: {
          id: existing.id,
          channel_id: existing.channel_id,
          instance_id: existing.instance_id,
          node_id: existing.node_id,
          priority: existing.priority,
          program_number: existing.program_number,
          enabled: existing.enabled,
          mode: existing.mode,
        },
        channelSlug: chan.slug,
        cloneProfileId: newProfileId,
        freeze: { kind: 'none' },
      });
      routed = result.cutover;
    }

    if (!routed) {
      await this.db
        .updateTable('restream_placements')
        .set({
          instance_id: instanceId,
          node_id: nodeId,
          priority: patch.priority ?? existing.priority,
          enabled: patch.enabled === undefined ? existing.enabled : patch.enabled ? 1 : 0,
          mode: patch.mode ?? existing.mode,
          profile_id: patch.profileId === undefined ? existing.profile_id : patch.profileId,
          program_number:
            patch.programNumber === undefined ? existing.program_number : patch.programNumber,
          updated_at: now(),
        })
        .where('id', '=', id)
        .execute();
    }

    // a moved placement affects the OLD node (session leaves) and the NEW one
    // (a no-op push when unmoved -- pushNodesSafe dedupes); this also carries
    // the cutover clone's first push when `routed`, since it shares `from`'s
    // node.
    await this.pushNodesSafe([
      { instanceId: existing.instance_id, nodeId: existing.node_id },
      { instanceId, nodeId },
    ]);
    const row = await this.db
      .selectFrom('restream_placements')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return this.rowToPlacement(row);
  }

  deletePlacement(id: string, force?: boolean): Promise<void> {
    return this.serialize(() => this.deletePlacementInner(id, force));
  }

  private async deletePlacementInner(id: string, force?: boolean): Promise<void> {
    const existing = await this.db
      .selectFrom('restream_placements')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!existing) throw httpError(404, `placement ${id} not found`);
    await this.assertNotMidProcedure([id], force);
    await this.db.deleteFrom('restream_placements').where('id', '=', id).execute();
    await this.pushNodesSafe([{ instanceId: existing.instance_id, nodeId: existing.node_id }]);
  }

  /** rewrite failover order: orderedPlacementIds must be exactly the channel's placements */
  reorderPlacements(channelId: string, orderedPlacementIds: string[]): Promise<void> {
    return this.serialize(() => this.reorderPlacementsInner(channelId, orderedPlacementIds));
  }

  private async reorderPlacementsInner(
    channelId: string,
    orderedPlacementIds: string[],
  ): Promise<void> {
    const rows = await this.db
      .selectFrom('restream_placements')
      .select('id')
      .where('channel_id', '=', channelId)
      .execute();
    const existing = new Set(rows.map((r) => r.id));
    const unique = new Set(orderedPlacementIds);
    if (
      unique.size !== orderedPlacementIds.length ||
      orderedPlacementIds.length !== rows.length ||
      orderedPlacementIds.some((id) => !existing.has(id))
    ) {
      throw httpError(400, 'orderedPlacementIds must list each of the channel’s placements exactly once');
    }
    for (const [index, id] of orderedPlacementIds.entries()) {
      await this.db
        .updateTable('restream_placements')
        .set({ priority: index + 1, updated_at: now() })
        .where('id', '=', id)
        .execute();
    }
    // priority is not part of the node doc (hash-skip makes this free), but the
    // mutation-ends-with-push invariant keeps future doc fields covered
    await this.pushAffectedByChannelSafe(channelId);
  }

  // ---------- cutover ----------
  //
  // Internal primitives with no public API of their own. Driven by
  // routeProfileChange (below), which (1) freezes `from`'s outgoing profile,
  // (2) creates the clone via createCutoverClone, (3) calls
  // requestFailover({ reason: 'cutover', toPlacementId: clone.id }); also
  // composed by FailoverSync's cutover branches via the
  // markCutoverComplete/deleteCutoverPlacement hooks. None of these
  // primitives call assertNotMidProcedure — they're raw, targeted DB writes,
  // not general placement CRUD, so the mid-procedure CRUD guard does not
  // apply to them.

  /**
   * With a switcher configured, every channel is uniformly fronted by it (see
   * playbackUrl()) — today's condition is global, not actually per-slug, but
   * the parameter is kept for a future per-channel switcher assignment. A
   * same-node dual-encode cutover only makes sense when a switcher is present
   * to keep the viewer-facing URL resolving while `from` and the clone run
   * side by side.
   */
  private isSwitcherFronted(_slug: string): boolean {
    return (this.config.restreamer?.switchers.length ?? 0) > 0;
  }

  /**
   * Direct INSERT of a transient clone placement on the SAME node/instance as
   * `from`, bypassing addPlacementInner's one-placement-per-node uniqueness
   * gate (the DB-level unique index is scoped over (channel_id, instance_id,
   * node_id, transient), so a transient=1 row coexists with `from`'s
   * transient=0 row). Always created with mode:'hot' — computeNodeDoc only
   * includes a 'cold' placement while it's referenced by an in-flight
   * failover row's to/from column, so a cold clone would silently stop
   * encoding forever once markCutoverComplete promotes it and the row is
   * later deleted at drain-expiry.
   */
  private async createCutoverClone(
    from: {
      channel_id: string;
      instance_id: string;
      node_id: string;
      priority: number;
      program_number: number | null;
    },
    profileId: string | null,
  ): Promise<RestreamPlacement> {
    const id = randomUUID();
    await this.db
      .insertInto('restream_placements')
      .values({
        id,
        channel_id: from.channel_id,
        instance_id: from.instance_id,
        node_id: from.node_id,
        priority: from.priority,
        enabled: 1,
        mode: 'hot',
        profile_id: profileId,
        program_number: from.program_number,
        transient: 1,
        updated_at: now(),
      })
      .execute();
    const row = await this.db
      .selectFrom('restream_placements')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return this.rowToPlacement(row);
  }

  /**
   * Freeze `from`'s effective encode profile for the duration of a cutover so
   * an unrelated concurrent edit can never change what it's still encoding.
   * 'pin' just repoints `from` at an already-saved profile id (plain UPDATE,
   * no new row). 'snapshot' captures the CURRENT effective payload bytes into
   * a new transient profile row before pinning to it — needed when the live
   * profile ROW ITSELF is about to be edited in place (same id, new payload).
   * The snapshot's name embeds its OWN freshly-generated id (not `from`'s
   * placement id) so repeated cutovers of the same placement over its
   * lifetime never collide on restream_profiles' unique name constraint.
   */
  private async freezeOutgoingProfile(
    from: { id: string },
    freeze: { kind: 'pin'; profileId: string } | { kind: 'snapshot'; payload: AribHlsParams },
  ): Promise<void> {
    if (freeze.kind === 'pin') {
      await this.db
        .updateTable('restream_placements')
        .set({ profile_id: freeze.profileId, updated_at: now() })
        .where('id', '=', from.id)
        .execute();
      return;
    }
    const snapshotId = randomUUID();
    await this.db
      .insertInto('restream_profiles')
      .values({
        id: snapshotId,
        name: `cutover-snapshot-${snapshotId}`,
        payload: JSON.stringify(freeze.payload),
        transient: 1,
        updated_at: now(),
      })
      .execute();
    await this.db
      .updateTable('restream_placements')
      .set({ profile_id: snapshotId, updated_at: now() })
      .where('id', '=', from.id)
      .execute();
  }

  /** promote a cutover clone from transient (cutover-owned) to a permanent, ordinary placement */
  private async markCutoverCompleteInner(placementId: string): Promise<void> {
    await this.db
      .updateTable('restream_placements')
      .set({ transient: 0, updated_at: now() })
      .where('id', '=', placementId)
      .execute();
  }

  /**
   * Cutover lifecycle cleanup: delete one placement — the clone, on abort; or
   * the retired `from`, once its drain window elapses — plus its profile_id
   * override IF that profile is itself transient (a freeze snapshot owned
   * solely by this placement; restream_placements.profile_id has no FK, so
   * this is app-level cleanup, not a cascade). A pinned, non-transient
   * profile may still be referenced elsewhere and is left untouched. Safe to
   * call on an already-deleted placement (e.g. cascade-deleted along with its
   * failover row via to_placement_id's ON DELETE CASCADE) — idempotent no-op.
   */
  private async deleteCutoverPlacementInner(placementId: string): Promise<void> {
    const row = await this.db
      .selectFrom('restream_placements')
      .select(['profile_id'])
      .where('id', '=', placementId)
      .executeTakeFirst();
    if (!row) return;
    await this.db.deleteFrom('restream_placements').where('id', '=', placementId).execute();
    if (row.profile_id) {
      const profile = await this.db
        .selectFrom('restream_profiles')
        .select(['transient'])
        .where('id', '=', row.profile_id)
        .executeTakeFirst();
      if (profile?.transient) {
        await this.db.deleteFrom('restream_profiles').where('id', '=', row.profile_id).execute();
      }
    }
  }

  /** phase of the channel's in-flight failover row, or null if there is none / it's settled */
  private async channelMidProcedurePhase(channelId: string): Promise<FailoverPhase | null> {
    const row = await this.db
      .selectFrom('restream_failover_state')
      .select(['phase'])
      .where('channel_id', '=', channelId)
      .executeTakeFirst();
    if (!row) return null;
    const phase = row.phase as FailoverPhase;
    return midProcedure(phase) ? phase : null;
  }

  /**
   * Every non-transient placement whose EFFECTIVE profile is `profileId` --
   * either directly (a per-placement override) or by inheriting the
   * channel's default. Used by updateProfileInner to find every `from`
   * candidate for a payload edit before touching the live profile row.
   */
  private async placementsUsingProfile(profileId: string): Promise<
    Array<{
      id: string;
      channel_id: string;
      instance_id: string;
      node_id: string;
      priority: number;
      program_number: number | null;
      enabled: number;
      mode: string;
      profile_id: string | null;
      slug: string;
    }>
  > {
    return this.db
      .selectFrom('restream_placements as p')
      .innerJoin('restream_channels as c', 'c.id', 'p.channel_id')
      .select([
        'p.id',
        'p.channel_id',
        'p.instance_id',
        'p.node_id',
        'p.priority',
        'p.program_number',
        'p.enabled',
        'p.mode',
        'p.profile_id',
        'c.slug',
      ])
      .where('p.transient', '=', 0)
      .where((eb) => eb.or([eb('c.profile_id', '=', profileId), eb('p.profile_id', '=', profileId)]))
      .execute();
  }

  /**
   * Route a profile-only change away from overwriting `from` in place and
   * toward a same-node dual-encode cutover, when eligible: switcher-fronted
   * (needed to keep the viewer-facing URL resolving while both encodes run),
   * `from` is enabled+hot (only a currently-serving placement is worth
   * double-encoding for), and the channel has no other in-flight failover
   * procedure. Ineligible, or a requestFailover that unexpectedly throws,
   * both resolve to `{cutover:false}` — the caller then applies the change
   * directly to `from`. Callers must run this BEFORE writing whatever would
   * otherwise change `from`'s effective profile (the channel-flip UPDATE, the
   * live profile-payload UPDATE, etc.) so no concurrent read can ever observe
   * `from` mid-flight to the new value.
   */
  private async routeProfileChange(input: {
    from: {
      id: string;
      channel_id: string;
      instance_id: string;
      node_id: string;
      priority: number;
      program_number: number | null;
      enabled: number;
      mode: string;
    };
    channelSlug: string;
    /** profile_id the clone is created with -- typically `from`'s pre-change effective override (null or explicit) */
    cloneProfileId: string | null;
    /** how to freeze `from` so the live edit never changes what it's currently encoding; 'none' when the caller never writes to `from` at all (e.g. a placement-level override flip) */
    freeze:
      | { kind: 'pin'; profileId: string }
      | { kind: 'snapshot'; payload: AribHlsParams }
      | { kind: 'none' };
  }): Promise<{ cutover: true; clone: RestreamPlacement } | { cutover: false }> {
    if (!this.isSwitcherFronted(input.channelSlug) || !input.from.enabled || input.from.mode !== 'hot') {
      return { cutover: false };
    }
    const phase = await this.channelMidProcedurePhase(input.from.channel_id);
    if (phase) {
      this.events.log({
        type: 'warning',
        service: 'restreamer',
        source: `channel.${input.channelSlug}`,
        message:
          `profile change for "${input.channelSlug}" applied directly -- a failover procedure ` +
          `is already in progress (phase ${phase})`,
      });
      return { cutover: false };
    }

    const before = await this.db
      .selectFrom('restream_placements')
      .select(['profile_id'])
      .where('id', '=', input.from.id)
      .executeTakeFirstOrThrow();

    let frozenProfileId: string | null = before.profile_id;
    if (input.freeze.kind === 'pin') {
      await this.freezeOutgoingProfile({ id: input.from.id }, { kind: 'pin', profileId: input.freeze.profileId });
      frozenProfileId = input.freeze.profileId;
    } else if (input.freeze.kind === 'snapshot') {
      await this.freezeOutgoingProfile({ id: input.from.id }, { kind: 'snapshot', payload: input.freeze.payload });
      const frozen = await this.db
        .selectFrom('restream_placements')
        .select(['profile_id'])
        .where('id', '=', input.from.id)
        .executeTakeFirstOrThrow();
      frozenProfileId = frozen.profile_id;
    }

    const clone = await this.createCutoverClone(input.from, input.cloneProfileId);

    try {
      await this.failoverSync.requestFailover(input.from.channel_id, {
        reason: 'cutover',
        toPlacementId: clone.id,
      });
    } catch (err) {
      this.events.log({
        type: 'warning',
        service: 'restreamer',
        source: `channel.${input.channelSlug}`,
        message:
          `cutover request failed for "${input.channelSlug}" (${err instanceof Error ? err.message : String(err)}) ` +
          `-- applying the profile change directly instead`,
      });
      await this.deleteCutoverPlacementInner(clone.id);
      if (input.freeze.kind !== 'none') {
        await this.db
          .updateTable('restream_placements')
          .set({ profile_id: before.profile_id, updated_at: now() })
          .where('id', '=', input.from.id)
          .execute();
        if (input.freeze.kind === 'snapshot' && frozenProfileId) {
          await this.db.deleteFrom('restream_profiles').where('id', '=', frozenProfileId).execute();
        }
      }
      return { cutover: false };
    }

    return { cutover: true, clone };
  }

  // ---------- playlist CRUD ----------

  private rowToPlaylist(r: {
    id: string;
    slug: string;
    title: string;
    updated_at: Date;
  }): RestreamPlaylist {
    return {
      id: r.id,
      slug: r.slug,
      title: r.title,
      updatedAt: new Date(r.updated_at).toISOString(),
    };
  }

  async listPlaylists(): Promise<RestreamPlaylist[]> {
    const rows = await this.db.selectFrom('restream_playlists').selectAll().orderBy('slug').execute();
    return rows.map((r) => this.rowToPlaylist(r));
  }

  async getPlaylist(id: string): Promise<RestreamPlaylist | null> {
    const r = await this.db
      .selectFrom('restream_playlists')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return r ? this.rowToPlaylist(r) : null;
  }

  createPlaylist(input: { slug: string; title: string }): Promise<RestreamPlaylist> {
    return this.serialize(() => this.createPlaylistInner(input));
  }

  private async createPlaylistInner(input: {
    slug: string;
    title: string;
  }): Promise<RestreamPlaylist> {
    await this.validatePlaylistSlug(input.slug);
    if (!input.title.trim()) throw httpError(400, 'playlist title must not be empty');
    const id = randomUUID();
    await this.db
      .insertInto('restream_playlists')
      .values({
        id,
        slug: input.slug,
        title: input.title,
        updated_at: now(),
      })
      .execute();
    return (await this.getPlaylist(id))!;
  }

  updatePlaylist(
    id: string,
    patch: { slug?: string; title?: string },
  ): Promise<RestreamPlaylist> {
    return this.serialize(() => this.updatePlaylistInner(id, patch));
  }

  private async updatePlaylistInner(
    id: string,
    patch: { slug?: string; title?: string },
  ): Promise<RestreamPlaylist> {
    const existing = await this.getPlaylist(id);
    if (!existing) throw httpError(404, `playlist ${id} not found`);
    if (patch.slug !== undefined && patch.slug !== existing.slug) {
      await this.validatePlaylistSlug(patch.slug, id);
    }
    if (patch.title !== undefined && !patch.title.trim()) {
      throw httpError(400, 'playlist title must not be empty');
    }
    await this.db
      .updateTable('restream_playlists')
      .set({
        slug: patch.slug ?? existing.slug,
        title: patch.title ?? existing.title,
        updated_at: now(),
      })
      .where('id', '=', id)
      .execute();
    return (await this.getPlaylist(id))!;
  }

  private async validatePlaylistSlug(slug: string, excludeId?: string): Promise<void> {
    if (!SLUG_PATTERN.test(slug)) {
      throw httpError(400, `invalid playlist slug "${slug}" — must match ${SLUG_PATTERN.source}`);
    }
    const clash = await this.db
      .selectFrom('restream_playlists')
      .select('id')
      .where('slug', '=', slug)
      .executeTakeFirst();
    if (clash && clash.id !== excludeId) {
      throw httpError(409, `a playlist with slug "${slug}" already exists`);
    }
  }

  deletePlaylist(id: string): Promise<void> {
    return this.serialize(async () => {
      const existing = await this.getPlaylist(id);
      if (!existing) throw httpError(404, `playlist ${id} not found`);
      // memberships cascade via FK
      await this.db.deleteFrom('restream_playlists').where('id', '=', id).execute();
    });
  }

  /** replace a channel's playlist memberships */
  setChannelPlaylists(channelId: string, playlistIds: string[]): Promise<void> {
    return this.serialize(() => this.setChannelPlaylistsInner(channelId, playlistIds));
  }

  private async setChannelPlaylistsInner(channelId: string, playlistIds: string[]): Promise<void> {
    const channel = await this.db
      .selectFrom('restream_channels')
      .select('id')
      .where('id', '=', channelId)
      .executeTakeFirst();
    if (!channel) throw httpError(404, `restream channel ${channelId} not found`);
    const unique = [...new Set(playlistIds)];
    await this.assertPlaylistsExist(unique);
    await this.db
      .deleteFrom('restream_playlist_members')
      .where('channel_id', '=', channelId)
      .execute();
    for (const playlistId of unique) {
      await this.db
        .insertInto('restream_playlist_members')
        .values({ playlist_id: playlistId, channel_id: channelId })
        .execute();
    }
  }

  private async assertPlaylistsExist(playlistIds: string[]): Promise<void> {
    if (!playlistIds.length) return;
    const rows = await this.db
      .selectFrom('restream_playlists')
      .select('id')
      .where('id', 'in', playlistIds)
      .execute();
    const found = new Set(rows.map((r) => r.id));
    const missing = playlistIds.filter((id) => !found.has(id));
    if (missing.length) throw httpError(400, `unknown playlist(s): ${missing.join(', ')}`);
  }

  // ---------- desired-doc computation ----------

  /**
   * Resolve one placement to a session source + program number. Each
   * placement resolves the (name, number) identity independently in its own
   * zone: tvheadend topology FIRST, then — only on a tvh miss OR when the
   * instance's topology is simply unavailable (tvh-less zone; tvh is UNKNOWN,
   * not a miss) — the node's polled sources.m3u catalog by the SAME identity
   * rules (exact-string pin, lowest-numbered same-name entry when unpinned).
   * - tvh hit: (channel uuid, program number) — override wins, else the
   *   lowest linked-service SID; underivable + no override blocks WITHOUT
   *   trying the catalog (the identity did resolve — the tvh session just
   *   cannot be built).
   * - catalog hit (tvh miss, or topology unavailable): a `{url}` source;
   *   programNumber = placement override, else undefined (the daemon
   *   PAT-probes). computeNodeDoc layers an anti-flap guard on top of a
   *   catalog hit reached via unavailable topology — see its doc comment.
   * - catalog miss/unknown while topology is unavailable blocks with a reason
   *   naming BOTH: topology not loaded, and the catalog state.
   * Every reason is also what listChannels surfaces as blockedReason. An
   * unknown instance/node on an EXISTING row (config shrank) is a reason,
   * never a crash.
   */
  private resolvePlacement(
    instanceId: string,
    nodeId: string,
    ch: ChannelIdentity,
    programOverride: number | null,
  ):
    | { ok: true; source: SessionSource; programNumber: number | undefined; via: 'tvh' | 'catalog' }
    | { ok: false; reason: string } {
    const inst = this.config.instances.find((i) => i.id === instanceId);
    if (!inst) return { ok: false, reason: `instance "${instanceId}" is not configured` };
    if (!inst.restreamer?.nodes.some((n) => n.id === nodeId)) {
      return {
        ok: false,
        reason: `restreamer node "${nodeId}" is not configured on instance ${instanceId}`,
      };
    }

    const topo = this.cache.has(instanceId) ? this.cache.get(instanceId).topology : null;
    const channel = topo ? resolveTvhChannel(topo.channels, ch.channelName, ch.channelNumber) : null;
    if (channel) {
      if (programOverride != null) {
        return {
          ok: true,
          source: { channelUuid: channel.uuid },
          programNumber: programOverride,
          via: 'tvh',
        };
      }
      const svcUuids = new Set(channel.services ?? []);
      const sids = topo!.services
        .filter((s) => svcUuids.has(s.uuid) && typeof s.sid === 'number')
        .map((s) => s.sid as number);
      if (!sids.length) {
        return {
          ok: false,
          reason: `cannot derive program number for channel "${ch.channelName}" on instance ${instanceId} — no linked service reports a SID; set a manual override`,
        };
      }
      return {
        ok: true,
        source: { channelUuid: channel.uuid },
        programNumber: Math.min(...sids),
        via: 'tvh',
      };
    }

    // tvh miss (topology present) OR tvh UNKNOWN (topology unavailable) —
    // fall back to the node's sources catalog by the same identity rules
    const key = nodeKey(instanceId, nodeId);
    const suffix = ch.channelNumber != null ? ` (#${ch.channelNumber})` : '';
    const sources = this.cachedNodeStatus(instanceId, nodeId)?.sources ?? null;
    if (sources === null) {
      const catalogPart = `node ${key}'s sources catalog not loaded`;
      return {
        ok: false,
        reason: topo
          ? `channel "${ch.channelName}"${suffix} not found on instance ${instanceId}; ${catalogPart}`
          : `topology not loaded for instance ${instanceId} and ${catalogPart}`,
      };
    }
    const entry = resolveCatalogEntry(sources, ch.channelName, ch.channelNumber);
    if (!entry) {
      const catalogPart = `channel "${ch.channelName}"${suffix} not in node ${key}'s sources catalog`;
      return {
        ok: false,
        reason: topo
          ? `channel "${ch.channelName}"${suffix} not found on instance ${instanceId} nor in node ${key}'s sources catalog`
          : `topology not loaded for instance ${instanceId} and ${catalogPart}`,
      };
    }
    return {
      ok: true,
      source: { url: entry.url },
      programNumber: programOverride ?? undefined,
      via: 'catalog',
    };
  }

  /**
   * Write-time availability of one placement target for a channel identity:
   * - 'ok'      — resolves right now (session would run), via tvh or catalog.
   * - 'unknown' — cannot be judged yet: topology not loaded (unless the
   *   catalog already has a hit — see below), or a tvh miss whose node
   *   catalog was never fetched → allow the write, lazy blocking covers it.
   * - {reason}  — BOTH sides are known and it still misses (resolve miss on
   *   both, or a tvh hit with a SID underivable without an override).
   * Topology unavailable + a KNOWN catalog hit is 'ok' (not 'unknown') — this
   * is what makes an external-only (tvh-less) zone creatable at all; a
   * catalog miss/unknown while topology is unavailable stays 'unknown'
   * (unchanged), never a hard reject.
   */
  private placementAvailability(
    instanceId: string,
    nodeId: string,
    ch: ChannelIdentity,
    programOverride: number | null,
  ): 'ok' | 'unknown' | { reason: string } {
    const topo = this.cache.has(instanceId) ? this.cache.get(instanceId).topology : null;
    if (!topo) {
      const sources = this.cachedNodeStatus(instanceId, nodeId)?.sources ?? null;
      if (sources === null) return 'unknown';
      const entry = resolveCatalogEntry(sources, ch.channelName, ch.channelNumber);
      return entry ? 'ok' : 'unknown';
    }
    const tvhHit = resolveTvhChannel(topo.channels, ch.channelName, ch.channelNumber) != null;
    if (!tvhHit) {
      const sources = this.cachedNodeStatus(instanceId, nodeId)?.sources ?? null;
      if (sources === null) return 'unknown';
    }
    const resolved = this.resolvePlacement(instanceId, nodeId, ch, programOverride);
    return resolved.ok ? 'ok' : { reason: resolved.reason };
  }

  /**
   * Enforce write-time availability over a set of placement targets; collects
   * ALL failures into one AvailabilityError (409). Callers skip this entirely
   * when the input carries `force: true`.
   */
  private assertPlacementsAvailable(
    targets: Array<{ instanceId: string; nodeId: string; programOverride: number | null }>,
    ch: ChannelIdentity,
    verb: string,
  ): void {
    const unavailable: UnavailablePlacement[] = [];
    for (const t of targets) {
      const avail = this.placementAvailability(t.instanceId, t.nodeId, ch, t.programOverride);
      if (typeof avail === 'object') {
        unavailable.push({ instanceId: t.instanceId, nodeId: t.nodeId, reason: avail.reason });
      }
    }
    if (unavailable.length) {
      const detail = unavailable
        .map((u) => `${nodeKey(u.instanceId, u.nodeId)}: ${u.reason}`)
        .join('; ');
      throw new AvailabilityError(`${detail} — pass force to ${verb} anyway`, unavailable);
    }
  }

  /**
   * Desired doc for one node. Read-only (safe outside the op chain).
   * - No topology yet → fire-and-forget a topology poll (so the zone keeps
   *   trying to recover tvh), but resolution proceeds regardless: a
   *   tvh-less zone (topology permanently null) must still serve its
   *   catalog-only placements — see resolvePlacement.
   * - Sessions = enabled placements of enabled channels on this node.
   * - Anti-flap guard: a placement that resolves via the catalog ONLY
   *   because this instance's topology is currently unavailable, whose
   *   session (named by placement id) the node was last known to run from
   *   tvheadend (`channelUuid` source in lastPushedDoc), is treated as
   *   blocked instead — never silently re-source a live tvh session from the
   *   catalog on what may be a transient topology flap. That blocked entry
   *   then falls into the ordinary pushedNames defer path below (the whole
   *   node defers, the running encode is left untouched). A placement never
   *   pushed, or last pushed with a `{url}` source, proceeds catalog-only as
   *   normal.
   * - Blocked placements whose session is in the node's CURRENT doc defer the
   *   whole push (a full replace must not tear down a running stream on a
   *   topology flap); never-pushed blocked placements just stay out.
   */
  async computeNodeDoc(instanceId: string, nodeId: string): Promise<ComputedNodeDoc> {
    const topo = this.cache.has(instanceId) ? this.cache.get(instanceId).topology : null;
    if (!topo) {
      const poller = this.pollers.get(instanceId);
      if (poller) void poller.pollTopology().catch(() => {});
    }

    // lazily hydrated at most once per call — shared by the anti-flap guard
    // below and the pushedNames defer check at the end
    let lastPushed: DesiredState | null | typeof UNKNOWN | undefined;
    const getLastPushed = async (): Promise<DesiredState | null | typeof UNKNOWN> => {
      if (lastPushed === undefined) lastPushed = await this.lastPushedDoc(instanceId, nodeId);
      return lastPushed;
    };

    const rows = await this.db
      .selectFrom('restream_placements as p')
      .innerJoin('restream_channels as c', 'c.id', 'p.channel_id')
      .innerJoin('restream_profiles as pr', 'pr.id', 'c.profile_id')
      // per-placement profile override; NULL when the placement inherits c.profile_id
      .leftJoin('restream_profiles as ppr', 'ppr.id', 'p.profile_id')
      // a failover target joins the doc regardless of mode (cold activation);
      // a suppressed outgoing placement leaves it once its stop phase begins
      .leftJoin('restream_failover_state as fs', 'fs.to_placement_id', 'p.id')
      .leftJoin('restream_failover_state as fsFrom', 'fsFrom.from_placement_id', 'p.id')
      .select([
        'p.id as placement_id',
        'p.program_number',
        'c.id as channel_id',
        'c.slug',
        'c.channel_name',
        'c.channel_number',
        'pr.payload as profile_payload',
        'ppr.payload as placement_profile_payload',
        'fsFrom.suppress_from as fs_suppress_from',
        'fsFrom.phase as fs_from_phase',
      ])
      .where('p.instance_id', '=', instanceId)
      .where('p.node_id', '=', nodeId)
      .where('p.enabled', '=', 1)
      .where('c.enabled', '=', 1)
      // cold placements encode while they are a failover TARGET, or while
      // they are the OUTGOING placement of an in-flight procedure (a reset /
      // chained failover away from an active cold must keep it encoding
      // until the stop phase — make-before-break; the suppression skip below
      // is what ends it)
      .where((eb) =>
        eb.or([
          eb('p.mode', '=', 'hot'),
          eb('fs.to_placement_id', 'is not', null),
          eb('fsFrom.from_placement_id', 'is not', null),
        ]),
      )
      .execute();

    const sessions: DesiredSession[] = [];
    const blocked: BlockedPlacement[] = [];
    for (const row of rows) {
      // stop the outgoing placement's ENCODE only — it stays a switcher
      // upstream for the row's lifetime so the retained window keeps draining
      if (
        row.fs_suppress_from != null &&
        !!row.fs_suppress_from &&
        SUPPRESSING_PHASES.includes(row.fs_from_phase as FailoverPhase)
      ) {
        continue;
      }
      const resolved = this.resolvePlacement(
        instanceId,
        nodeId,
        rowIdentity(row),
        row.program_number,
      );
      if (!resolved.ok) {
        blocked.push({
          placementId: row.placement_id,
          channelId: row.channel_id,
          slug: row.slug,
          reason: resolved.reason,
        });
        continue;
      }

      // anti-flap guard: this placement only resolved via the catalog
      // because the instance's topology is unavailable right now — if the
      // node was last known to run this placement's session from tvheadend,
      // refuse to silently re-source it from the catalog (UNKNOWN hydration
      // is treated the same conservative way as the pushedNames check below:
      // block it).
      if (!topo && resolved.via === 'catalog') {
        const last = await getLastPushed();
        const prevSession =
          last === UNKNOWN ? null : (last?.sessions.find((s) => s.name === row.placement_id) ?? null);
        if (last === UNKNOWN || (prevSession && 'channelUuid' in prevSession.source)) {
          blocked.push({
            placementId: row.placement_id,
            channelId: row.channel_id,
            slug: row.slug,
            reason: `topology not loaded for instance ${instanceId} — refusing to re-source a tvheadend session from the catalog`,
          });
          continue;
        }
      }
      // stored profiles are already validated; Default-complete again so a doc
      // computed from an older row hashes identically to a fresh one. A
      // per-placement profile override (row.placement_profile_payload) wins
      // over the channel's own profile when set.
      const semantic = Value.Default(
        AribHlsParams,
        JSON.parse(row.placement_profile_payload ?? row.profile_payload),
      ) as AribHlsParams;
      // profiles are stored/edited as semantic 'arib-hls' params; every node
      // now speaks only the wire's 'raw-argv' template, so the controller
      // always pre-renders the equivalent argv here — the daemon never sees
      // the semantic payload or needs arib-hls's requiredCaps (qsv/opencl).
      const pipeline = buildRawArgvParams(semantic);
      sessions.push({
        name: row.placement_id,
        enabled: true,
        source: resolved.source,
        tsreadex:
          resolved.programNumber !== undefined ? { programNumber: resolved.programNumber } : {},
        pipeline,
      });
    }
    sessions.sort((a, b) => a.name.localeCompare(b.name));

    if (blocked.length) {
      const last = await getLastPushed();
      if (last === UNKNOWN) {
        // something was pushed but the node can't confirm what — do not risk
        // tearing down a session we can no longer compute
        return { doc: null, blocked, deferred: true };
      }
      const pushedNames = new Set((last?.sessions ?? []).map((s) => s.name));
      if (blocked.some((b) => pushedNames.has(b.placementId))) {
        return { doc: null, blocked, deferred: true };
      }
    }

    const doc: DesiredState = {
      apiVersion: RESTREAMER_API_VERSION,
      revision: sessionsHash(sessions),
      sessions,
    };
    return { doc, blocked, deferred: false };
  }

  /**
   * Last doc the node is known to hold. Cold cache + a stored pushed_hash →
   * hydrate via getDesired(); UNKNOWN when the read-back fails (node down) so
   * the caller can stay conservative.
   */
  private async lastPushedDoc(
    instanceId: string,
    nodeId: string,
  ): Promise<DesiredState | null | typeof UNKNOWN> {
    const key = nodeKey(instanceId, nodeId);
    const cached = this.lastPushedDocs.get(key);
    if (cached !== undefined) return cached;
    const state = await this.nodeState(instanceId, nodeId);
    if (!state) {
      this.lastPushedDocs.set(key, null);
      return null;
    }
    const client = this.clients.get(key);
    if (!client) return UNKNOWN;
    try {
      const doc = await client.getDesired();
      this.lastPushedDocs.set(key, doc);
      return doc;
    } catch {
      return UNKNOWN; // not cached — retried on the next occasion
    }
  }

  private nodeState(
    instanceId: string,
    nodeId: string,
  ): Promise<{ pushed_hash: string } | undefined> {
    return this.db
      .selectFrom('restream_node_state')
      .select('pushed_hash')
      .where('instance_id', '=', instanceId)
      .where('node_id', '=', nodeId)
      .executeTakeFirst();
  }

  // ---------- push ----------

  pushNode(instanceId: string, nodeId: string, force = false): Promise<NodePushResult> {
    return this.serialize(() => this.pushNodeInner(instanceId, nodeId, force));
  }

  pushAll(): Promise<NodePushResult[]> {
    return this.serialize(() => this.pushAllInner());
  }

  /** push every node hosting a placement of a channel that uses this profile */
  pushAffectedByProfile(profileId: string): Promise<NodePushResult[]> {
    return this.serialize(() => this.pushAffectedByProfileInner(profileId));
  }

  /** push every node hosting a placement of this channel */
  pushAffectedByChannel(channelId: string): Promise<NodePushResult[]> {
    return this.serialize(async () =>
      this.pushNodesInner(await this.affectedNodesByChannel(channelId)),
    );
  }

  private async pushNodeInner(
    instanceId: string,
    nodeId: string,
    force = false,
  ): Promise<NodePushResult> {
    const base = { instanceId, nodeId };
    // read before overwrite: log push fail/heal as a transition, not on
    // every 60s sweep retry of a still-down node
    const key = nodeKey(instanceId, nodeId);
    const prevError = this.pushProblems.get(key) ?? null;
    try {
      const computed = await this.computeNodeDoc(instanceId, nodeId);
      if (computed.deferred || !computed.doc) {
        // a blocked-deferral is a real pending change; a topology-deferral is
        // simply "not yet known" and must not flash a pending badge
        if (computed.blocked.length) {
          this.updateNodeStatus(instanceId, nodeId, { pendingPush: true });
        }
        return {
          ...base,
          action: 'deferred',
          detail: computed.blocked.length
            ? computed.blocked.map((b) => b.reason).join('; ')
            : 'topology not loaded',
          blocked: computed.blocked,
        };
      }
      const doc = computed.doc;
      const state = await this.nodeState(instanceId, nodeId);
      if (!force && state?.pushed_hash === doc.revision) {
        this.updateNodeStatus(instanceId, nodeId, { pendingPush: false });
        return { ...base, action: 'skipped', detail: 'already up to date', blocked: computed.blocked };
      }
      // never-pushed node with nothing to run: leave it alone — pushing an
      // empty doc to an unmanaged node would tear down whatever it is doing
      if (!state && doc.sessions.length === 0) {
        return { ...base, action: 'skipped', detail: 'nothing to manage', blocked: computed.blocked };
      }
      const client = this.clients.get(nodeKey(instanceId, nodeId));
      if (!client) {
        // treated the same as a thrown push error, to keep the cached status consistent
        this.updateNodeStatus(instanceId, nodeId, { pendingPush: true, error: 'no client configured for node' });
        this.pushProblems.set(key, 'no client configured for node');
        this.logPushTransition(instanceId, nodeId, prevError, 'no client configured for node');
        return { ...base, action: 'error', detail: 'no client configured for node', blocked: computed.blocked };
      }
      await client.putDesired(doc);
      await this.db
        .insertInto('restream_node_state')
        .values({
          instance_id: instanceId,
          node_id: nodeId,
          pushed_hash: doc.revision,
          pushed_at: now(),
        })
        .onDuplicateKeyUpdate({ pushed_hash: doc.revision, pushed_at: now() })
        .execute();
      this.lastPushedDocs.set(nodeKey(instanceId, nodeId), doc);
      this.updateNodeStatus(instanceId, nodeId, {
        pendingPush: false,
        desiredRevision: doc.revision,
        error: null,
      });
      this.pushProblems.set(key, null);
      this.logPushTransition(instanceId, nodeId, prevError, null);
      return { ...base, action: 'pushed', blocked: computed.blocked };
    } catch (err) {
      // failed push: the stored hash stays, the node stays pending — the 60s
      // sweep (or the poller's revision-mismatch trigger) heals it later
      const detail = err instanceof Error ? err.message : String(err);
      this.updateNodeStatus(instanceId, nodeId, { pendingPush: true, error: detail });
      this.pushProblems.set(key, detail);
      this.logPushTransition(instanceId, nodeId, prevError, detail);
      return { ...base, action: 'error', detail, blocked: [] };
    }
  }

  /**
   * Push fail/heal events: logs only on the null<->non-null transition of the
   * push outcome — a still-failing node re-attempted by the 60s sweep must
   * not spam a new warning every cycle.
   */
  private logPushTransition(
    instanceId: string,
    nodeId: string,
    prevError: string | null,
    newError: string | null,
  ): void {
    if ((prevError === null) === (newError === null)) return;
    const source = `node.${instanceId}.${nodeId}`;
    if (newError !== null) {
      this.events.log({ type: 'warning', service: 'restreamer', source, message: `push to ${source} failed: ${newError}` });
    } else {
      this.events.log({ type: 'normal', service: 'restreamer', source, message: `push to ${source} recovered` });
    }
  }

  private async pushAllInner(): Promise<NodePushResult[]> {
    const results: NodePushResult[] = [];
    for (const node of this.configuredNodes()) {
      results.push(await this.pushNodeInner(node.instanceId, node.nodeId));
    }
    return results;
  }

  private async pushAffectedByProfileInner(profileId: string): Promise<NodePushResult[]> {
    // a node is affected if the profile is used either via the channel's own
    // profile or via a per-placement override
    const rows = await this.db
      .selectFrom('restream_placements as p')
      .innerJoin('restream_channels as c', 'c.id', 'p.channel_id')
      .select(['p.instance_id', 'p.node_id'])
      .distinct()
      .where((eb) => eb.or([eb('c.profile_id', '=', profileId), eb('p.profile_id', '=', profileId)]))
      .execute();
    return this.pushNodesInner(
      rows.map((r) => ({ instanceId: r.instance_id, nodeId: r.node_id })),
    );
  }

  private async affectedNodesByChannel(channelId: string): Promise<NodeRef[]> {
    const rows = await this.db
      .selectFrom('restream_placements')
      .select(['instance_id', 'node_id'])
      .distinct()
      .where('channel_id', '=', channelId)
      .execute();
    return rows.map((r) => ({ instanceId: r.instance_id, nodeId: r.node_id }));
  }

  private async pushNodesInner(nodes: NodeRef[]): Promise<NodePushResult[]> {
    const seen = new Set<string>();
    const results: NodePushResult[] = [];
    for (const n of nodes) {
      const key = nodeKey(n.instanceId, n.nodeId);
      if (seen.has(key)) continue;
      seen.add(key);
      // rows pointing at nodes the config no longer knows are tolerated (blockedReason on read)
      if (!this.nodeConfig(n.instanceId, n.nodeId)) continue;
      results.push(await this.pushNodeInner(n.instanceId, n.nodeId));
    }
    return results;
  }

  /** mutation tail: push and log — the mutation itself must already have succeeded */
  private async pushAffectedByChannelSafe(channelId: string): Promise<void> {
    try {
      await this.pushNodesInner(await this.affectedNodesByChannel(channelId));
    } catch (err) {
      console.error('restreamer: push after mutation failed:', err);
    }
    await this.pushAllSwitchersSafe();
  }

  private async pushNodesSafe(nodes: NodeRef[]): Promise<void> {
    try {
      await this.pushNodesInner(nodes);
    } catch (err) {
      console.error('restreamer: push after mutation failed:', err);
    }
    await this.pushAllSwitchersSafe();
  }

  /**
   * Switcher tail of every channel/placement/profile mutation: any of them can
   * change redundancy membership, upstream URLs, priorities or segmentSeconds,
   * so simply push all switchers — the hash-skip makes the no-change case
   * cheap, and failures are logged, never thrown (the sweep heals).
   */
  private async pushAllSwitchersSafe(): Promise<void> {
    try {
      await this.switcherSync.pushAllInner();
    } catch (err) {
      console.error('restreamer: switcher push after mutation failed:', err);
    }
  }

  /** patch this node's cached status entry and publish an SSE `restreamer` event on change */
  private updateNodeStatus(
    instanceId: string,
    nodeId: string,
    patch: Partial<RestreamerNodeStatus>,
  ): void {
    if (!this.cache.has(instanceId)) return;
    const snap = this.cache.get(instanceId);
    const idx = snap.restreamers.findIndex((r) => r.nodeId === nodeId);
    if (idx === -1) return; // poller hasn't seeded this node yet — its next tick reflects the state
    const current = snap.restreamers[idx]!;
    const next = { ...current, ...patch };
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    snap.restreamers = snap.restreamers.map((r, x) => (x === idx ? next : r));
    this.bus.publish({ type: 'restreamer', data: next });
  }

  // ---------- sweep + hooks ----------

  /**
   * 60s heal sweep: pushAll (nodes AND switchers) is cheap in steady state
   * (hash-skip) and covers node/switcher-down-at-mutation, controller restart
   * and late topology.
   */
  startSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      void this.pushAll().catch(() => {});
      void this.pushAllSwitchers().catch(() => {});
    }, 60_000);
    this.sweepTimer.unref?.();
  }

  stopSweep(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const t of this.topologyDebounce.values()) clearTimeout(t);
    this.topologyDebounce.clear();
    for (const t of this.sourcesDebounce.values()) clearTimeout(t);
    this.sourcesDebounce.clear();
  }

  /**
   * Slow rebalance cadence: a separate 300s interval (chosen over "every 5th
   * sweep tick" so the heal frequency and the policy frequency stay
   * independently tunable and the sweep stays a pure push loop). Policy
   * stickiness/hysteresis live in rebalance.ts; a tick with nothing to move is
   * a no-op.
   */
  startRebalance(): void {
    if (this.rebalanceTimer) return;
    this.rebalanceTimer = setInterval(() => {
      void this.rebalanceTick().catch(() => {});
    }, 300_000);
    this.rebalanceTimer.unref?.();
  }

  stopRebalance(): void {
    if (this.rebalanceTimer) clearInterval(this.rebalanceTimer);
    this.rebalanceTimer = null;
  }

  /** topology changed on an instance: re-push its nodes, debounced 2s */
  onTopologyChanged(instanceId: string): void {
    const existing = this.topologyDebounce.get(instanceId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.topologyDebounce.delete(instanceId);
      void this.serialize(() =>
        this.pushNodesInner(
          this.configuredNodes()
            .filter((n) => n.instanceId === instanceId)
            .map((n) => ({ instanceId: n.instanceId, nodeId: n.nodeId })),
        ),
      ).catch(() => {});
    }, 2000);
    timer.unref?.();
    this.topologyDebounce.set(instanceId, timer);
  }

  /**
   * A node's sources catalog changed (poller re-fetched it): re-push that one
   * node, debounced 2s — external placements may have become resolvable (or
   * lost their entry, which the blocked/defer rules then handle).
   */
  onSourcesChanged(instanceId: string, nodeId: string): void {
    const key = nodeKey(instanceId, nodeId);
    const existing = this.sourcesDebounce.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.sourcesDebounce.delete(key);
      void this.pushNode(instanceId, nodeId).catch(() => {});
    }, 2000);
    timer.unref?.();
    this.sourcesDebounce.set(key, timer);
  }

  /**
   * True when the controller's computed doc differs from what it believes is
   * pushed. A topology-deferral reads as NOT pending (unknown yet); a
   * blocked-deferral is pending (there is a change we refuse to push).
   */
  async getPendingPush(instanceId: string, nodeId: string): Promise<boolean> {
    const computed = await this.computeNodeDoc(instanceId, nodeId);
    if (computed.deferred || !computed.doc) return computed.blocked.length > 0;
    const state = await this.nodeState(instanceId, nodeId);
    if (!state) return computed.doc.sessions.length > 0;
    return state.pushed_hash !== computed.doc.revision;
  }

  /**
   * Revision the node is expected to report. The doc's `revision` IS the doc
   * hash the controller computes and stores, so `restream_node_state.
   * pushed_hash` and the expected revision are the same string by construction.
   */
  async getExpectedRevision(instanceId: string, nodeId: string): Promise<string | null> {
    const state = await this.nodeState(instanceId, nodeId);
    return state?.pushed_hash ?? null;
  }

  /** RestreamerPollerHooks implementation backed by this service (B2's poller consumes it) */
  pollerHooks(): RestreamerPollerHooks {
    return {
      getPendingPush: (instanceId, nodeId) => this.getPendingPush(instanceId, nodeId),
      getExpectedRevision: (instanceId, nodeId) => this.getExpectedRevision(instanceId, nodeId),
      // a node that lost its state file (or drifted) gets re-pushed immediately,
      // force bypassing the hash-skip; serialized via the public wrapper
      onRevisionMismatch: (instanceId, nodeId) => {
        void this.pushNode(instanceId, nodeId, true).catch(() => {});
      },
      // a changed catalog can unblock (or orphan) external placements
      onSourcesChanged: (instanceId, nodeId) => {
        this.onSourcesChanged(instanceId, nodeId);
      },
      // probe state is pulled at status-build time — the engine is the single
      // source of truth; patching it in afterwards would be wiped every poll
      getProbes: (instanceId, nodeId) => this.probeEngine.nodeProbeStatus(instanceId, nodeId),
      getMaxSessions: async (instanceId, nodeId) =>
        (await this.allNodeCapacity()).get(nodeKey(instanceId, nodeId)) ?? null,
      enrichSessions: async (_instanceId, _nodeId, sessions) => {
        // post-rename the session name IS the placement id — feeds both the
        // probe-engine lookup (no lookup needed there) and the slug map below
        const slugMap = await this.placementSlugMap();
        return sessions.map((s) => {
          const lagProbe = this.probeEngine.lagStatus(s.name);
          return {
            ...s,
            channelSlug: slugMap.get(s.name) ?? null,
            ...(lagProbe ? { lagProbe } : {}),
          };
        });
      },
    };
  }

  // ---------- switcher desired doc + push (B5, delegated to SwitcherSync) ----------

  /** global switcher desired doc (read-only, safe outside the op chain) */
  computeSwitcherDoc(): Promise<ComputedSwitcherDoc> {
    return this.switcherSync.computeDoc();
  }

  pushSwitcher(switcherId: string, force = false): Promise<SwitcherPushResult> {
    return this.serialize(() => this.switcherSync.pushInner(switcherId, force));
  }

  pushAllSwitchers(): Promise<SwitcherPushResult[]> {
    return this.serialize(() => this.switcherSync.pushAllInner());
  }

  /** SwitcherPollerHooks implementation backed by this service (B4's pollers consume it) */
  switcherPollerHooks(): SwitcherPollerHooks {
    return {
      getPendingPush: (switcherId) => this.switcherSync.getPendingPush(switcherId),
      getExpectedRevision: (switcherId) => this.switcherSync.getExpectedRevision(switcherId),
      // a switcher that lost its state file (PVC loss) gets re-pushed
      // immediately, force bypassing the hash-skip; serialized via the wrapper
      onRevisionMismatch: (switcherId) => {
        void this.pushSwitcher(switcherId, true).catch(() => {});
      },
    };
  }

  /** one rebalance evaluation, serialized; moves route through the failover queue */
  rebalanceTick(now = new Date()): Promise<void> {
    return this.serialize(() =>
      this.switcherSync.rebalanceTickInner(now, async (channelId, toPlacementId) => {
        await this.failoverSync.requestFailover(channelId, {
          toPlacementId,
          reason: 'rebalance',
          detail: 'egress rebalance',
        });
      }),
    );
  }

  // ---------- probes ----------

  /** probe surface: desired sessions per node + per-placement delivery URLs */
  private async probeTargets(): Promise<ProbeTargets> {
    const rows = await this.db
      .selectFrom('restream_placements as p')
      .innerJoin('restream_channels as c', 'c.id', 'p.channel_id')
      .leftJoin('restream_failover_state as fs', 'fs.to_placement_id', 'p.id')
      .leftJoin('restream_failover_state as fsFrom', 'fsFrom.from_placement_id', 'p.id')
      .select([
        'p.id as placement_id',
        'p.instance_id',
        'p.node_id',
        'p.mode',
        'c.id as channel_id',
        'c.slug',
        'fs.to_placement_id as fs_to',
        'fsFrom.from_placement_id as fs_from',
        'fsFrom.suppress_from as fs_suppress_from',
        'fsFrom.phase as fs_from_phase',
      ])
      .where('p.enabled', '=', 1)
      .where('c.enabled', '=', 1)
      .execute();

    const nodes = new Map<
      string,
      { instanceId: string; nodeId: string; serveUrl: string | null; sessionNames: string[] }
    >();
    const placements: ProbeTargets['placements'] = [];
    for (const r of rows) {
      // mirror doc inclusion: hot or in-flight outgoing (until suppressed), or a failover target
      const suppressed =
        r.fs_suppress_from != null &&
        !!r.fs_suppress_from &&
        SUPPRESSING_PHASES.includes(r.fs_from_phase as FailoverPhase);
      const included =
        ((r.mode === 'hot' || r.fs_from != null) && !suppressed) || r.fs_to != null;
      if (!included) continue;
      const key = nodeKey(r.instance_id, r.node_id);
      let node = nodes.get(key);
      if (!node) {
        node = {
          instanceId: r.instance_id,
          nodeId: r.node_id,
          serveUrl: this.nodeConfig(r.instance_id, r.node_id)?.serveUrl ?? null,
          sessionNames: [],
        };
        nodes.set(key, node);
      }
      node.sessionNames.push(r.placement_id);
      placements.push({
        channelId: r.channel_id,
        placementId: r.placement_id,
        instanceId: r.instance_id,
        nodeId: r.node_id,
        slug: r.slug,
        playlistUrl: node.serveUrl ? `${node.serveUrl}/${r.placement_id}/playlist.m3u8` : null,
      });
    }
    return { nodes: [...nodes.values()], placements };
  }

  /**
   * placementId -> channel slug, briefly cached. Backs the session
   * `channelSlug` display enrichment (session-restart event messages + the
   * web node-card session table) without a per-tick DB query.
   */
  private async placementSlugMap(): Promise<Map<string, string>> {
    const nowMs = Date.now();
    if (this.placementSlugCache && nowMs - this.placementSlugCache.at < 4_000) {
      return this.placementSlugCache.map;
    }
    const rows = await this.db
      .selectFrom('restream_placements as p')
      .innerJoin('restream_channels as c', 'c.id', 'p.channel_id')
      .select(['p.id', 'c.slug'])
      .execute();
    const map = new Map(rows.map((r) => [r.id, r.slug]));
    this.placementSlugCache = { at: nowMs, map };
    return map;
  }

  /** all nodes' probe settings (stored overrides over defaults), briefly cached */
  private async allProbeSettings(): Promise<Map<string, NodeProbeSettings>> {
    const nowMs = Date.now();
    if (this.probeSettingsCache && nowMs - this.probeSettingsCache.at < 4_000) {
      return this.probeSettingsCache.map;
    }
    const rows = await this.db.selectFrom('restream_node_probes').selectAll().execute();
    const stored = new Map(rows.map((r) => [nodeKey(r.instance_id, r.node_id), rowToProbeSettings(r)]));
    const map = new Map<string, NodeProbeSettings>();
    for (const n of this.configuredNodes()) {
      const key = nodeKey(n.instanceId, n.nodeId);
      map.set(key, stored.get(key) ?? NODE_PROBE_DEFAULTS);
    }
    this.probeSettingsCache = { at: nowMs, map };
    return map;
  }

  async getNodeProbeSettings(instanceId: string, nodeId: string): Promise<NodeProbeSettings> {
    this.assertNodeConfigured(instanceId, nodeId);
    const row = await this.db
      .selectFrom('restream_node_probes')
      .selectAll()
      .where('instance_id', '=', instanceId)
      .where('node_id', '=', nodeId)
      .executeTakeFirst();
    return row ? rowToProbeSettings(row) : NODE_PROBE_DEFAULTS;
  }

  setNodeProbeSettings(
    instanceId: string,
    nodeId: string,
    settings: NodeProbeSettings,
  ): Promise<NodeProbeSettings> {
    return this.serialize(async () => {
      this.assertNodeConfigured(instanceId, nodeId);
      const row = probeSettingsToRow(instanceId, nodeId, settings);
      await this.db
        .insertInto('restream_node_probes')
        .values({ ...row, updated_at: now() })
        .onDuplicateKeyUpdate({ ...row, updated_at: now() })
        .execute();
      this.probeSettingsCache = null;
      return settings;
    });
  }

  /** all nodes' session caps (stored rows only — missing key = uncapped), briefly cached */
  private async allNodeCapacity(): Promise<Map<string, number | null>> {
    const nowMs = Date.now();
    if (this.nodeCapacityCache && nowMs - this.nodeCapacityCache.at < 4_000) {
      return this.nodeCapacityCache.map;
    }
    const rows = await this.db.selectFrom('restream_node_settings').selectAll().execute();
    const map = new Map(rows.map((r) => [nodeKey(r.instance_id, r.node_id), r.max_sessions]));
    this.nodeCapacityCache = { at: nowMs, map };
    return map;
  }

  async getNodeSettings(instanceId: string, nodeId: string): Promise<NodeSettings> {
    this.assertNodeConfigured(instanceId, nodeId);
    const row = await this.db
      .selectFrom('restream_node_settings')
      .selectAll()
      .where('instance_id', '=', instanceId)
      .where('node_id', '=', nodeId)
      .executeTakeFirst();
    return { maxSessions: row?.max_sessions ?? null };
  }

  setNodeSettings(instanceId: string, nodeId: string, settings: NodeSettings): Promise<NodeSettings> {
    return this.serialize(async () => {
      this.assertNodeConfigured(instanceId, nodeId);
      await this.db
        .insertInto('restream_node_settings')
        .values({ instance_id: instanceId, node_id: nodeId, max_sessions: settings.maxSessions, updated_at: now() })
        .onDuplicateKeyUpdate({ max_sessions: settings.maxSessions, updated_at: now() })
        .execute();
      this.nodeCapacityCache = null;
      return settings;
    });
  }

  // ---------- failover orchestration ----------

  /**
   * Start the probe engine + the 3s failover tick (separate from the 60s heal
   * sweep and 300s rebalance: this loop makes decisions and must advance
   * multi-phase procedures snappily; the sweep only re-pushes).
   */
  startFailover(): void {
    if (this.failoverTimer) return;
    this.probeEngine.start();
    this.failoverTimer = setInterval(() => {
      void this.failoverTick().catch(() => {});
    }, FAILOVER_TICK_MS);
    this.failoverTimer.unref?.();
  }

  stopFailover(): void {
    if (this.failoverTimer) clearInterval(this.failoverTimer);
    this.failoverTimer = null;
    this.probeEngine.stop();
  }

  /** one orchestrator evaluation, serialized like every other op */
  failoverTick(): Promise<void> {
    return this.serialize(() => this.failoverSync.tick());
  }

  /** resume persisted procedures + prune orphaned rows on boot */
  reconcileFailoverOnStartup(): Promise<void> {
    return this.serialize(async () => {
      const changed = await this.failoverSync.reconcileOnStartup();
      const reclaimed = await this.sweepOrphanedCutoverArtifacts();
      const nodes: NodeRef[] = [...reclaimed];
      for (const channelId of changed) {
        nodes.push(...(await this.affectedNodesByChannel(channelId)));
      }
      if (nodes.length) {
        await this.pushNodesInner(nodes).catch(() => {});
        await this.pushAllSwitchersSafe();
      }
    });
  }

  /**
   * Startup-only orphan sweep (no periodic equivalent — orphaning only
   * happens mid-procedure-creation, which a running controller never leaves
   * partial). A transient=1 placement is normally driven to completion or
   * cleanup by a restream_failover_state row referencing it. A crash between
   * createCutoverClone and the requestFailover that would create that row
   * leaks a clone with no referencing row: nothing will ever clean it up, and
   * (being enabled+hot) it keeps encoding forever. Reclaim any such orphan,
   * plus any transient profile snapshot left pointing at nothing. Runs BEFORE
   * FailoverSync.reconcileOnStartup's rowHygiene sees the final row set, so a
   * placement it just dropped this boot is caught too. Returns the reclaimed
   * placements' node refs so callers can re-push those nodes' docs.
   */
  private async sweepOrphanedCutoverArtifacts(): Promise<NodeRef[]> {
    const transientPlacements = await this.db
      .selectFrom('restream_placements as p')
      .innerJoin('restream_channels as c', 'c.id', 'p.channel_id')
      .select(['p.id', 'p.instance_id', 'p.node_id', 'c.slug'])
      .where('p.transient', '=', 1)
      .execute();

    const reclaimed: NodeRef[] = [];
    if (transientPlacements.length > 0) {
      const failoverRefs = await this.db
        .selectFrom('restream_failover_state')
        .select(['to_placement_id', 'from_placement_id'])
        .execute();
      const referenced = new Set<string>();
      for (const r of failoverRefs) {
        referenced.add(r.to_placement_id);
        if (r.from_placement_id) referenced.add(r.from_placement_id);
      }
      for (const p of transientPlacements) {
        if (referenced.has(p.id)) continue;
        await this.deleteCutoverPlacementInner(p.id);
        reclaimed.push({ instanceId: p.instance_id, nodeId: p.node_id });
        const message = `reclaimed orphaned cutover clone ${p.id} for channel "${p.slug}" (leaked by an interrupted cutover)`;
        console.error(`restreamer: ${message}`);
        this.events.log({ type: 'warning', service: 'restreamer', source: 'controller', message });
      }
    }

    // transient profile snapshots not (or no longer) referenced by any
    // placement/channel — normally cleaned up alongside their placement by
    // deleteCutoverPlacementInner (above, or on abort/drain-expiry), this
    // catches any left dangling by some other removal path.
    const transientProfiles = await this.db
      .selectFrom('restream_profiles')
      .select(['id'])
      .where('transient', '=', 1)
      .execute();
    if (transientProfiles.length > 0) {
      const [placementRefs, channelRefs] = await Promise.all([
        this.db.selectFrom('restream_placements').select(['profile_id']).execute(),
        this.db.selectFrom('restream_channels').select(['profile_id']).execute(),
      ]);
      const stillReferenced = new Set<string>();
      for (const r of placementRefs) if (r.profile_id) stillReferenced.add(r.profile_id);
      for (const r of channelRefs) stillReferenced.add(r.profile_id);
      for (const p of transientProfiles) {
        if (stillReferenced.has(p.id)) continue;
        await this.db.deleteFrom('restream_profiles').where('id', '=', p.id).execute();
        const message = `reclaimed orphaned cutover profile snapshot ${p.id} (leaked by an interrupted cutover)`;
        console.error(`restreamer: ${message}`);
        this.events.log({ type: 'warning', service: 'restreamer', source: 'controller', message });
      }
    }

    return reclaimed;
  }

  /**
   * Manual placement selection — treated EXACTLY like an automatic failover:
   * enqueued into the same serialized procedure. Progress is observed via the
   * `restreamer-channel` SSE stream, not this response.
   */
  requestManualSwitch(
    channelId: string,
    placementId: string,
  ): Promise<{ ok: true; queued?: true; already?: true }> {
    const result = this.serialize(() =>
      this.failoverSync.requestFailover(channelId, {
        toPlacementId: placementId,
        reason: 'manual',
        detail: 'operator placement selection',
      }),
    );
    // start the procedure now instead of waiting out the tick interval
    void result.then(() => this.failoverTick()).catch(() => {});
    return result;
  }

  /** operator reset / fail-back — see FailoverSync.requestReset for the state table */
  requestReset(channelId: string, force = false): Promise<ResetOutcome> {
    const result = this.serialize(() => this.failoverSync.requestReset(channelId, { force }));
    void result.then(() => this.failoverTick()).catch(() => {});
    return result;
  }

  /**
   * Operator dismiss of the ⚠ blocked badge — see FailoverSync.clearBlocked.
   * User-initiated, so (per the non-interactive-only event-log rule) this
   * never logs an event. Looked up via getChannel (unfiltered by enabled,
   * like listChannels) rather than FailoverSync's own loadData, since a
   * disabled channel can still carry a stale blocked reason worth dismissing.
   */
  clearFailoverBlocked(channelId: string): Promise<boolean> {
    return this.serialize(async () => {
      const existing = await this.getChannel(channelId);
      if (!existing) throw httpError(404, `restream channel ${channelId} not found`);
      return this.failoverSync.clearBlocked(channelId);
    });
  }

  // ---------- channel status publication ----------

  /**
   * Publish a `restreamer-channel` SSE event when a channel's MEANINGFUL
   * status changed (failover state, indicators, probe counters, blocked
   * reasons, session state) — volatile measurement noise (lastCheckedAt,
   * per-poll lag samples) never publishes on its own.
   */
  async publishChannelStatus(channelId: string): Promise<void> {
    const channel = await this.channelWithStatus(channelId);
    if (!channel) {
      this.lastChannelPublishKey.delete(channelId);
      return;
    }
    const key = JSON.stringify({
      failover: channel.failover,
      blocked: channel.failoverBlocked,
      active: channel.activePlacementId,
      placements: channel.placements.map((p) => ({
        id: p.id,
        indicator: p.indicator,
        blockedReason: p.blockedReason,
        state: p.session?.state ?? null,
        lag: [p.lagProbe?.failed ?? false, p.lagProbe?.consecutiveFailures ?? 0],
      })),
    });
    if (this.lastChannelPublishKey.get(channelId) === key) return;
    this.lastChannelPublishKey.set(channelId, key);
    this.bus.publish({ type: 'restreamer-channel', data: channel });
  }
}
