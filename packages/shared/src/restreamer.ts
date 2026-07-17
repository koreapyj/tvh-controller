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
 * Controller-side restreamer DTOs (API/SSE shapes). The wire contract the
 * daemon and switcher actually speak lives in ./restreamer-contract.ts
 * (vendored from the restreamer repo).
 */

import type {
  PendingRemoval,
  SessionStatus,
  SourceCatalogEntry,
  SwitchReason,
  SwitcherChannelStatus,
} from './restreamer-contract.js';
import type { AribHlsParams } from './restreamProfile.js';

/**
 * Named encoding profile. `payload` is a fully resolved AribHlsParams — the
 * controller-owned profile schema (formerly the wire contract's 'arib-hls'
 * template; see ./restreamProfile.ts). The controller renders this into a
 * raw ffmpeg argv before pushing it to a node; the daemon never resolves
 * profile names or sees the semantic shape.
 */
export interface RestreamProfile {
  id: string;
  name: string;
  payload: AribHlsParams;
  updatedAt: string;
  /** true = a cutover-owned snapshot of a base profile's pre-edit payload; never listed for manual selection */
  transient: boolean;
}

// ---------------------------------------------------------------------------
// Probes (per restreamer node, UI-configurable; k8s-style sticky counters)
// ---------------------------------------------------------------------------

export interface ProbeThresholds {
  timeoutSeconds: number;
  periodSeconds: number;
  successThreshold: number;
  failureThreshold: number;
}

export type ProbeName = 'liveness' | 'underspeed' | 'lag';

export interface NodeProbeSettings {
  liveness: ProbeThresholds;
  underspeed: ProbeThresholds;
  lag: ProbeThresholds;
}

export interface NodeSettings {
  /** null = uncapped; 0 = admit no new sessions */
  maxSessions: number | null;
  /**
   * On-demand start grace for encodes launched on this node — how long a
   * master-playlist fetch keeps the wake-up armed before the first
   * media-playlist fetch must arrive; null = default.
   */
  initialDelaySec: number | null;
}

export const ON_DEMAND_INITIAL_DELAY_DEFAULT_SEC = 30;

/**
 * Live probe counters. `failed` trips after failureThreshold consecutive
 * failures and clears only after successThreshold consecutive successes;
 * the raw counters drive the UI's below-threshold warning badges.
 */
export interface ProbeStatus {
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  failed: boolean;
  lastResult: 'ok' | 'fail' | null;
  lastCheckedAt: string | null;
  detail: string | null;
}

export interface UnderspeedProbeStatus extends ProbeStatus {
  /** measured segment download speed as a multiple of realtime; null = never measured */
  lastSpeedRatio: number | null;
}

export interface LagProbeStatus extends ProbeStatus {
  /** last measured playlist PDT lag; null = never measured */
  lastLagSec: number | null;
  /** first successful lag measurement — gates the failover "lag discovered" wait */
  firstMeasuredAt: string | null;
}

/** instance-level probe state carried on RestreamerNodeStatus */
export interface NodeProbeStatus {
  liveness: ProbeStatus;
  underspeed: UnderspeedProbeStatus;
}

// ---------------------------------------------------------------------------
// Failover orchestration (controller-driven, serialized)
// ---------------------------------------------------------------------------

export type FailoverPhase =
  | 'bringing-up'
  | 'awaiting-lag'
  | 'switch-ordered'
  | 'awaiting-switch-confirm'
  | 'stopping-old'
  | 'awaiting-stop-confirm'
  | 'complete'
  /** terminal grace after a completed reset while the switcher window drains */
  | 'draining';

export type FailoverTriggerReason =
  | 'liveness'
  | 'underspeed'
  | 'lag'
  | 'manual'
  | 'reset'
  | 'rebalance'
  | 'cutover'
  | 'on-demand';

/**
 * UI indicator for one placement badge: yellow transitions
 * (starting / awaiting-lag / switching / stopping), green active,
 * gray stopped; 'idle' = not involved — fall back to session-state coloring.
 */
export type PlacementIndicator =
  | 'active'
  | 'starting'
  | 'awaiting-lag'
  | 'switching'
  | 'stopping'
  | 'stopped'
  | 'idle';

export interface ChannelFailoverStatus {
  fromPlacementId: string | null;
  toPlacementId: string;
  phase: FailoverPhase;
  triggerReason: FailoverTriggerReason;
  triggerDetail: string | null;
  startedAt: string;
  /** single-use id the TO placement is served/named under instead of its own
   * id, for as long as this row targets it; null outside an on-demand row */
  activationUuid: string | null;
}

/** one encode of a logical channel on one restreamer node */
export interface RestreamPlacement {
  id: string;
  channelId: string;
  instanceId: string;
  nodeId: string;
  /** failover order — lower is preferred */
  priority: number;
  enabled: boolean;
  /**
   * 'hot' = always encodes; 'cold' = standby that only encodes while the
   * failover loop has it activated (preferred placement not ready)
   */
  mode: 'hot' | 'cold';
  /** per-placement profile override; null = inherit the channel's profile */
  profileId: string | null;
  /** manual program-number (service SID) override; null = derived channel→service→sid */
  programNumber: number | null;
  updatedAt: string;
  /** true = a cutover-owned transient clone of another placement; never user-created */
  transient: boolean;
}

/** logical restream channel: one slug, one channel identity, one profile, 1..N placements */
export interface RestreamChannel {
  id: string;
  /** output dir on every node + public URL segment */
  slug: string;
  channelName: string;
  /**
   * channel NUMBER paired with `channelName` — a STRING, exactly as tvheadend
   * reports it (e.g. "9.1"); identity is exact string match, never numeric.
   * null = the LOWEST-numbered channel with that name on each instance.
   */
  channelNumber: string | null;
  profileId: string;
  enabled: boolean;
  comment: string | null;
  /** playlists this channel belongs to (many-to-many) */
  playlistIds: string[];
  updatedAt: string;
}

export interface RestreamChannelWithStatus extends RestreamChannel {
  profileName: string;
  placements: Array<
    RestreamPlacement & {
      /** why this placement is excluded from the node's desired doc; null = ok */
      blockedReason: string | null;
      /**
       * which source resolved this placement's channel identity right now:
       * 'tvh' = tvheadend topology, 'catalog' = the node's sources.m3u catalog,
       * null = blocked/unknown (see blockedReason)
       */
      resolvedVia: 'tvh' | 'catalog' | null;
      /** live session status from the node's last poll; null = unknown/absent */
      session: SessionStatus | null;
      /** failover-procedure indicator driving the badge color; 'idle' = session-state fallback */
      indicator: PlacementIndicator;
      /** channel-level lag probe state for this placement; null = not probed */
      lagProbe: LagProbeStatus | null;
    }
  >;
  /** persisted failover procedure/result for this channel; null = none (Reset hidden) */
  failover: ChannelFailoverStatus | null;
  /** why the last trigger could not start a failover (no eligible target); null = n/a */
  failoverBlocked: string | null;
  /** placement currently served by the switcher (redundant channels); null = n/a or unknown */
  activePlacementId: string | null;
  lastSwitch: { at: string; from: string | null; to: string; reason: SwitchReason } | null;
  /** viewer-facing URL (node serveUrl or switcher publicUrl); null when not serveable */
  playbackUrl: string | null;
  /** ISO deadline when the on-demand activation stops absent further demand; null = not an active on-demand channel */
  onDemandStopAt: string | null;
}

/** DB-managed master playlist, served at GET /playlists/<slug>.m3u */
export interface RestreamPlaylist {
  id: string;
  /** URL path segment */
  slug: string;
  title: string;
  updatedAt: string;
}

/** SessionStatus enriched with the controller's channel-level probe state */
export type EnrichedSessionStatus = SessionStatus & {
  lagProbe?: LagProbeStatus;
  /**
   * Channel slug for display — the session `name` is a bare UUID (a
   * placement id, or an on-demand row's activation_uuid while it targets
   * that placement), so this is what the UI shows a human. null = the
   * session name doesn't resolve to a known placement (e.g. an orphan
   * awaiting cleanup, or enrichment ran with no resolver available).
   */
  channelSlug: string | null;
};

/** PendingRemoval enriched with the controller's channel-level resolution */
export type EnrichedPendingRemoval = PendingRemoval & {
  /**
   * Channel slug for display, resolved the same way as a session's
   * `channelSlug` (live placement lookup, else a bounded name→slug capture
   * cache since the placement row is usually already deleted by the time a
   * removal is pending). null = unresolvable (e.g. after a controller
   * restart, for a drain already in flight).
   */
  channelSlug: string | null;
};

/** one restreamer node's polled status (SSE `restreamer` events) */
export interface RestreamerNodeStatus {
  instanceId: string;
  nodeId: string;
  url: string;
  /** public HLS base for viewer-facing links; null = node not directly serveable */
  serveUrl: string | null;
  reachable: boolean;
  error: string | null;
  lastPollAt: string | null;
  version: string | null;
  uptimeSec: number | null;
  /** false when the node reports an apiVersion the controller doesn't speak */
  apiVersionSupported: boolean;
  /** revision of the node's persisted desired doc; null = never pushed / unknown */
  desiredRevision: string | null;
  /** the controller has a desired doc for this node that isn't confirmed pushed */
  pendingPush: boolean;
  /** instance-level probe state; null = nothing probeable yet (no desired sessions) */
  probes: NodeProbeStatus | null;
  sessions: EnrichedSessionStatus[];
  /**
   * fingerprint of the node's local sources.m3u catalog; null = the node has
   * no catalog (no `sourcesM3u` configured / old daemon) or it is unknown yet
   */
  sourcesHash: string | null;
  /**
   * the node's sources catalog entries; null = never fetched / unknown,
   * [] = known-empty (no catalog configured or an empty file)
   */
  sources: SourceCatalogEntry[] | null;
  /** the daemon's configured hardware/feature capabilities (e.g. ['qsv','opencl']); null = unreachable / unknown */
  capabilities: string[] | null;
  /** pipeline templates the daemon can build (from `/v1/status.templates`); null = unreachable / unknown */
  templates: { id: string; version: number }[] | null;
  /** per-node session cap from DB settings; null = uncapped */
  maxSessions: number | null;
  /** deferred outDir removals still draining (or retrying after a failed rm); [] = old daemon or none pending */
  pendingRemovals: EnrichedPendingRemoval[];
  /** ISO 8601 — when the node last applied a desired doc (PUT or boot-time disk load); undefined = never / old daemon */
  lastAppliedAt?: string;
  /** true while the node's persisted doc found at boot fails schema validation; undefined = old daemon */
  persistedStateCorrupt?: boolean;
}

/** one switcher's polled status (SSE `restreamer-switcher` events) */
export interface SwitcherNodeStatus {
  switcherId: string;
  url: string;
  /** viewer-facing base used for redundant-channel links in the M3U output */
  publicUrl: string;
  reachable: boolean;
  error: string | null;
  lastPollAt: string | null;
  version: string | null;
  /** the controller has a desired doc for this switcher that isn't confirmed pushed */
  pendingPush: boolean;
  channels: SwitcherChannelStatus[];
  /** number of connected switcher replicas backing this aggregate status entry */
  replicaCount?: number;
}
