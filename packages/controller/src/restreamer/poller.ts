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

import { RESTREAMER_API_VERSION } from '@tvhc/shared';
import type {
  EnrichedPendingRemoval,
  EnrichedSessionStatus,
  NodeProbeStatus,
  PendingRemoval,
  RestreamerNodeStatus,
  SessionStatus,
  SourceCatalogEntry,
} from '@tvhc/shared';
import type { RestreamerNodeConfig } from '../config.js';
import type { EventLog } from '../state/eventLog.js';
import type { EventBus } from '../state/events.js';
import type { InstanceCache } from '../state/instanceCache.js';
import type { RestreamerClient } from './client.js';

/**
 * Push-state hooks the pollers consume; RestreamerService provides real
 * implementations backed by `restream_node_state`. All hooks are optional and
 * error-safe: a throwing hook never fails a poll tick.
 */
export interface RestreamerPollerHooks {
  /**
   * True when the controller holds a desired doc for this node that is not
   * confirmed pushed — surfaced as `pendingPush` in the polled status.
   * Default: false.
   */
  getPendingPush?: (instanceId: string, nodeId: string) => Promise<boolean> | boolean;
  /**
   * Revision the controller expects the node to hold (its last pushed doc
   * hash). Return null/undefined when there is no expectation (nothing pushed
   * yet / no DB) — mismatch detection is skipped then.
   */
  getExpectedRevision?: (
    instanceId: string,
    nodeId: string,
  ) => Promise<string | null> | string | null;
  /**
   * Fired (not awaited, errors swallowed) when a reachable node reports a
   * `desiredRevision` different from the expected one — e.g. a node that lost
   * its state file. Wired to an immediate push instead of waiting for the
   * heal sweep.
   */
  onRevisionMismatch?: (
    instanceId: string,
    nodeId: string,
    seenRevision: string | null,
  ) => void | Promise<void>;
  /**
   * Fired (not awaited, errors swallowed) when the node's sources-catalog
   * hash actually changed — after a successful `/v1/sources` re-fetch or when
   * a catalog disappeared. Wired to a debounced push.
   */
  onSourcesChanged?: (instanceId: string, nodeId: string) => void | Promise<void>;
  /**
   * Instance-level probe state, PULLED at status-build time (the probe engine
   * is the single source of truth — patching state into the cache after the
   * fact would be wiped by the next poll). Default: null (no probes).
   */
  getProbes?: (instanceId: string, nodeId: string) => NodeProbeStatus | null;
  /** per-node session cap from DB settings; null/undefined hook = uncapped */
  getMaxSessions?: (instanceId: string, nodeId: string) => Promise<number | null> | number | null;
  /** fold channel-level probe state (lag) into the polled sessions */
  enrichSessions?: (
    instanceId: string,
    nodeId: string,
    sessions: SessionStatus[],
  ) => Promise<EnrichedSessionStatus[]> | EnrichedSessionStatus[];
  /** resolve a channel slug for each pending removal, where possible */
  enrichPendingRemovals?: (
    instanceId: string,
    nodeId: string,
    removals: PendingRemoval[],
  ) => Promise<EnrichedPendingRemoval[]> | EnrichedPendingRemoval[];
}

/**
 * JSON key of the meaningful fields — lastPollAt alone must not re-publish,
 * and neither must a probe round that only refreshed its lastCheckedAt.
 */
function statusKey(status: RestreamerNodeStatus): string {
  const { lastPollAt: _lastPollAt, ...meaningful } = status;
  return JSON.stringify(meaningful, (key, value: unknown) =>
    key === 'lastCheckedAt' ? undefined : value,
  );
}

/** no enrichSessions hook (or it threw): pass sessions through with channelSlug unknown */
function bareEnrich(sessions: SessionStatus[]): EnrichedSessionStatus[] {
  return sessions.map((s) => ({ ...s, channelSlug: null }));
}

/** no enrichPendingRemovals hook (or it threw): pass removals through with channelSlug unknown */
function bareEnrichPendingRemovals(removals: PendingRemoval[]): EnrichedPendingRemoval[] {
  return removals.map((r) => ({ ...r, channelSlug: null }));
}

/**
 * Polls one restreamer daemon node's `/v1/status`, keeps its entry in
 * `snap.restreamers` fresh, and publishes an SSE `restreamer` event when
 * something meaningful changed. Same self-rescheduling setTimeout + initial
 * jitter approach as tvh/poller.ts.
 */
export class RestreamerPoller {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private lastStatusKey = '';
  /** last-known sources catalog; null = never fetched, [] = known-empty */
  private lastSources: SourceCatalogEntry[] | null = null;
  /** fingerprint matching lastSources; null = no catalog / unknown */
  private lastSourcesHash: string | null = null;
  /** per-session ffmpeg restart counts across polls */
  private readonly sessionRestarts = new Map<string, number>();
  /** first-poll baseline guard: seeds sessionRestarts without logging on the first pass */
  private sessionBaselineSeeded = false;

  constructor(
    private readonly instanceId: string,
    private readonly node: RestreamerNodeConfig,
    private readonly client: Pick<RestreamerClient, 'status' | 'sources'>,
    private readonly cache: InstanceCache,
    private readonly bus: EventBus,
    private readonly intervalMs: number,
    private readonly hooks: RestreamerPollerHooks = {},
    private readonly events: Pick<EventLog, 'log'> = { log: () => {} },
  ) {}

  start(): void {
    this.schedule(Math.random() * 2000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      void (async () => {
        if (this.stopped) return;
        await this.pollOnce();
        if (!this.stopped) this.schedule(this.intervalMs);
      })();
    }, delay);
  }

  /** one poll tick; never throws (errors become reachable:false status) */
  async pollOnce(): Promise<void> {
    const pendingPush = await this.getPendingPushSafe();
    // probe state persists across unreachable polls — a dead node's liveness
    // probe failing is exactly the signal that must stay visible
    const probes = this.getProbesSafe();
    const maxSessions = await this.getMaxSessionsSafe();
    let status: RestreamerNodeStatus;
    try {
      const res = await this.client.status();
      // absent (old daemon) and null (no sourcesM3u configured) mean the same
      // thing to the controller: this node has no catalog
      await this.updateSources(res.sourcesHash ?? null);
      status = {
        instanceId: this.instanceId,
        nodeId: this.node.id,
        url: this.node.url,
        serveUrl: this.node.serveUrl ?? null,
        reachable: true,
        error: null,
        lastPollAt: new Date().toISOString(),
        version: res.daemonVersion,
        uptimeSec: res.uptimeSec,
        apiVersionSupported: (res.apiVersion as number) === RESTREAMER_API_VERSION,
        desiredRevision: res.desiredRevision,
        pendingPush,
        probes,
        sessions: await this.enrichSessionsSafe(res.sessions),
        sourcesHash: this.lastSourcesHash,
        sources: this.lastSources,
        capabilities: res.capabilities,
        templates: res.templates,
        maxSessions,
        pendingRemovals: await this.enrichPendingRemovalsSafe(res.pendingRemovals ?? []),
        lastAppliedAt: res.lastAppliedAt,
        persistedStateCorrupt: res.persistedStateCorrupt,
      };
      await this.checkRevision(res.desiredRevision);
    } catch (err) {
      status = {
        instanceId: this.instanceId,
        nodeId: this.node.id,
        url: this.node.url,
        serveUrl: this.node.serveUrl ?? null,
        reachable: false,
        error: err instanceof Error ? err.message : String(err),
        lastPollAt: new Date().toISOString(),
        version: null,
        uptimeSec: null,
        // unknown while unreachable — don't flag a version problem
        apiVersionSupported: true,
        desiredRevision: null,
        pendingPush,
        probes,
        sessions: [],
        // last-known catalog carried across unreachable polls (like topology)
        sourcesHash: this.lastSourcesHash,
        sources: this.lastSources,
        capabilities: null,
        templates: null,
        maxSessions,
        // no fresh /v1/status to read — same treatment as sessions above
        pendingRemovals: [],
      };
    }

    const snap = this.cache.get(this.instanceId);
    const idx = snap.restreamers.findIndex((r) => r.nodeId === this.node.id);
    // read prev reachable before overwriting: main.ts pre-seeds a
    // reachable:false placeholder (lastPollAt: null) before
    // this poller's first real tick — a prior entry with lastPollAt === null is
    // that placeholder, not a real prior observation, so it must not count as
    // a transition either (same "undefined" treatment as idx === -1).
    const prev = idx === -1 ? undefined : snap.restreamers[idx]!;
    const prevReachable = prev === undefined || prev.lastPollAt === null ? undefined : prev.reachable;
    if (idx === -1) snap.restreamers = [...snap.restreamers, status];
    else snap.restreamers = snap.restreamers.map((r, x) => (x === idx ? status : r));
    this.logReachabilityTransition(prevReachable, status);
    if (status.reachable) this.trackSessionRestarts(status.sessions);

    const key = statusKey(status);
    if (key !== this.lastStatusKey) {
      this.lastStatusKey = key;
      this.bus.publish({ type: 'restreamer', data: status });
    }
  }

  /** restreamer node up/down — transition-based only */
  private logReachabilityTransition(
    prevReachable: boolean | undefined,
    status: RestreamerNodeStatus,
  ): void {
    if (prevReachable === undefined || prevReachable === status.reachable) return;
    const source = `node.${this.instanceId}.${this.node.id}`;
    if (status.reachable) {
      this.events.log({
        type: 'normal',
        service: 'restreamer',
        source,
        message: `restreamer ${source} came online`,
      });
    } else {
      this.events.log({
        type: 'warning',
        service: 'restreamer',
        source,
        message: `restreamer ${source} is unreachable: ${status.error}`,
      });
    }
  }

  /**
   * Per-session diff of SessionStatus.restarts across polls. First-poll
   * baseline guard (sessionBaselineSeeded): the initial pass only seeds
   * sessionRestarts, never logs — otherwise every controller restart would
   * flood the log with pre-existing restart counts. Sessions that disappear
   * are evicted so a later same-named session starts fresh instead of
   * comparing against a stale count.
   */
  private trackSessionRestarts(sessions: EnrichedSessionStatus[]): void {
    const seen = new Set<string>();
    for (const s of sessions) {
      seen.add(s.name);
      const prev = this.sessionRestarts.get(s.name);
      if (this.sessionBaselineSeeded && prev !== undefined && s.restarts > prev) {
        const exitClass = s.lastExit?.class;
        this.events.log({
          type: 'warning',
          service: 'restreamer',
          source: `node.${this.instanceId}.${this.node.id}`,
          message: `session "${s.name}"${s.channelSlug ? ` ("${s.channelSlug}")` : ''} restarted (restarts=${s.restarts}${
            exitClass ? `, last exit: ${exitClass}` : ''
          })`,
        });
      }
      this.sessionRestarts.set(s.name, s.restarts);
    }
    for (const name of [...this.sessionRestarts.keys()]) {
      if (!seen.has(name)) this.sessionRestarts.delete(name);
    }
    this.sessionBaselineSeeded = true;
  }

  private async getPendingPushSafe(): Promise<boolean> {
    try {
      return (await this.hooks.getPendingPush?.(this.instanceId, this.node.id)) ?? false;
    } catch {
      return false;
    }
  }

  private getProbesSafe(): NodeProbeStatus | null {
    try {
      return this.hooks.getProbes?.(this.instanceId, this.node.id) ?? null;
    } catch {
      return null;
    }
  }

  private async getMaxSessionsSafe(): Promise<number | null> {
    try {
      return (await this.hooks.getMaxSessions?.(this.instanceId, this.node.id)) ?? null;
    } catch {
      return null;
    }
  }

  private async enrichSessionsSafe(sessions: SessionStatus[]): Promise<EnrichedSessionStatus[]> {
    try {
      return (
        (await this.hooks.enrichSessions?.(this.instanceId, this.node.id, sessions)) ??
        bareEnrich(sessions)
      );
    } catch {
      return bareEnrich(sessions);
    }
  }

  private async enrichPendingRemovalsSafe(
    removals: PendingRemoval[],
  ): Promise<EnrichedPendingRemoval[]> {
    try {
      return (
        (await this.hooks.enrichPendingRemovals?.(this.instanceId, this.node.id, removals)) ??
        bareEnrichPendingRemovals(removals)
      );
    } catch {
      return bareEnrichPendingRemovals(removals);
    }
  }

  /**
   * Track the node's sources catalog from the status fingerprint. A string
   * hash differing from the last-known one triggers ONE `/v1/sources`
   * re-fetch (a fetch failure keeps the last-known catalog; the unchanged
   * lastSourcesHash retries on the next tick). A null hash = known-no-catalog
   * (no `sourcesM3u` configured / old daemon) → sources become known-empty.
   */
  private async updateSources(reportedHash: string | null): Promise<void> {
    const prevHash = this.lastSourcesHash;
    if (typeof reportedHash === 'string') {
      if (reportedHash !== this.lastSourcesHash) {
        try {
          const res = await this.client.sources();
          this.lastSources = res.entries;
          this.lastSourcesHash = reportedHash;
        } catch (err) {
          console.error(
            `restreamer ${this.instanceId}/${this.node.id}: sources fetch failed, keeping last-known catalog:`,
            err,
          );
        }
      }
    } else {
      this.lastSources = [];
      this.lastSourcesHash = null;
    }
    if (this.lastSourcesHash === prevHash || !this.hooks.onSourcesChanged) return;
    try {
      void Promise.resolve(this.hooks.onSourcesChanged(this.instanceId, this.node.id)).catch(
        () => {},
      );
    } catch {
      // fire-and-forget: a failing push trigger must not fail the poll
    }
  }

  /** fire the revision-mismatch trigger when the node's persisted doc drifted */
  private async checkRevision(seenRevision: string | null): Promise<void> {
    if (!this.hooks.onRevisionMismatch || !this.hooks.getExpectedRevision) return;
    let expected: string | null | undefined;
    try {
      expected = await this.hooks.getExpectedRevision(this.instanceId, this.node.id);
    } catch {
      return;
    }
    if (expected == null || expected === seenRevision) return;
    try {
      void Promise.resolve(
        this.hooks.onRevisionMismatch(this.instanceId, this.node.id, seenRevision),
      ).catch(() => {});
    } catch {
      // fire-and-forget: a failing push trigger must not fail the poll
    }
  }

}
