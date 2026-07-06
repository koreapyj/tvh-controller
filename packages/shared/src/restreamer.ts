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
  PipelineParams,
  SessionStatus,
  SourceCatalogEntry,
  SwitchReason,
  SwitcherChannelStatus,
} from './restreamer-contract.js';

/**
 * Named encoding profile. `payload` is a fully resolved PipelineParams from
 * the wire contract — the daemon never resolves profile names.
 */
export interface RestreamProfile {
  id: string;
  name: string;
  payload: PipelineParams;
  updatedAt: string;
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
  /** tvheadend subscription weight override; null = daemon default */
  weight: number | null;
  /** manual program-number (service SID) override; null = derived channel→service→sid */
  programNumber: number | null;
  updatedAt: string;
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
    }
  >;
  /** placement currently served by the switcher (redundant channels); null = n/a or unknown */
  activePlacementId: string | null;
  lastSwitch: { at: string; from: string | null; to: string; reason: SwitchReason } | null;
  /** viewer-facing URL (node serveUrl or switcher publicUrl); null when not serveable */
  playbackUrl: string | null;
}

/** DB-managed master playlist, served at GET /playlists/<slug>.m3u */
export interface RestreamPlaylist {
  id: string;
  /** URL path segment */
  slug: string;
  title: string;
  updatedAt: string;
}

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
  sessions: SessionStatus[];
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
}
