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
 * Inbound WebSocket hub for switcher replicas: replicas dial the controller
 * at `/ws/switcher` and keep one persistent socket open (wire contract v1 in
 * @tvhc/shared restreamer-ws-contract). The hub pushes the desired doc and
 * switch commands down every socket, and folds the replicas' status frames
 * into ONE aggregate `cache.switchers` entry (SWITCHER_CACHE_KEY) that the
 * rest of the controller reads exactly like a polled switcher status.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import {
  WS_CLOSE_UNSUPPORTED_VERSION,
  WS_PROTOCOL_VERSION,
  type EraAnchor,
  type SwitchReason,
  type SwitcherChannelStatus,
  type SwitcherDesiredState,
  type SwitcherNodeStatus,
} from '@tvhc/shared';
import type { EventLog } from '../state/eventLog.js';
import type { EventBus } from '../state/events.js';
import type { InstanceCache } from '../state/instanceCache.js';
import { SWITCHER_CACHE_KEY, type DemandEvent, type SwitcherHubLike } from './switcherHubTypes.js';

export const SWITCHER_WS_PATH = '/ws/switcher';

const PING_INTERVAL_MS = 30_000;

export interface SwitcherHubOptions {
  cache: InstanceCache;
  bus: EventBus;
  events: Pick<EventLog, 'log'>;
  /** desired doc for the on-connect push (read-only computation, no state writes) */
  getDoc: () => Promise<SwitcherDesiredState>;
  /** viewer playlist-fetch events, forwarded to the on-demand engine */
  onDemand: (events: DemandEvent[]) => void;
  /** status frames carrying eraOffsets, forwarded to eraStore.recordOffsets — optional for schema additivity */
  onEraOffsets?: (channels: SwitcherChannelStatus[]) => void;
  /** revision the replicas are expected to report; null = nothing broadcast yet */
  getExpectedRevision: () => string | null;
  /** viewer-facing base for the aggregate status entry; null = not configured */
  publicUrl: string | null;
  serverVersion: string;
}

interface Connection {
  socket: WebSocket;
  hello: { switcherVersion: string; startedAt: string } | null;
  lastStatus: {
    desiredRevision: string | null;
    channels: SwitcherChannelStatus[];
    at: string;
  } | null;
  isAlive: boolean;
}

/**
 * JSON key of the meaningful aggregate fields — a status frame that only
 * refreshed lastPollAt must not re-publish SSE.
 */
function statusKey(status: SwitcherNodeStatus): string {
  const { lastPollAt: _lastPollAt, ...meaningful } = status;
  return JSON.stringify(meaningful);
}

export class SwitcherHub implements SwitcherHubLike {
  private wss: WebSocketServer | null = null;
  private readonly connections = new Map<string, Connection>();
  private pingTimer: NodeJS.Timeout | null = null;
  private lastStatusKey = '';

  constructor(private readonly opts: SwitcherHubOptions) {}

  /**
   * Hook the WS endpoint onto the HTTP server. `noServer` + a manual
   * 'upgrade' listener so only SWITCHER_WS_PATH upgrades are accepted —
   * anything else destroys the socket (an unanswered upgrade leaks the FD).
   */
  attach(server: HttpServer): void {
    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (pathname !== SWITCHER_WS_PATH) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.handleConnection(ws));
    });
    this.pingTimer = setInterval(() => this.pingRound(), PING_INTERVAL_MS);
    this.pingTimer.unref();
    // seed the aggregate entry so the UI shows the switcher exists (and
    // pendingPush) before the first replica ever connects
    this.rebuildAggregate();
  }

  broadcastDoc(doc: SwitcherDesiredState): void {
    const frame = JSON.stringify({ v: WS_PROTOCOL_VERSION, type: 'doc', doc });
    for (const conn of this.connections.values()) this.send(conn.socket, frame);
  }

  broadcastSwitch(
    slug: string,
    upstreamId: string,
    opts?: { era?: EraAnchor; reason?: SwitchReason },
  ): number {
    // JSON.stringify drops undefined-valued keys, so an omitted opts leaves
    // the frame shape unchanged for callers that don't carry an anchor/reason.
    const frame = JSON.stringify({
      v: WS_PROTOCOL_VERSION,
      type: 'switch',
      slug,
      upstreamId,
      era: opts?.era,
      reason: opts?.reason,
    });
    let sent = 0;
    for (const conn of this.connections.values()) {
      if (this.send(conn.socket, frame)) sent++;
    }
    return sent;
  }

  connectedCount(): number {
    return this.connections.size;
  }

  close(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const conn of this.connections.values()) conn.socket.terminate();
    this.connections.clear();
    this.wss?.close();
    this.wss = null;
  }

  // ---------------------------------------------------------------------------
  // connection lifecycle
  // ---------------------------------------------------------------------------

  private handleConnection(socket: WebSocket): void {
    const id = randomUUID();
    const conn: Connection = { socket, hello: null, lastStatus: null, isAlive: true };
    this.connections.set(id, conn);
    if (this.connections.size === 1) {
      this.opts.events.log({
        type: 'normal',
        service: 'restreamer',
        source: 'switcher',
        message: 'switcher connected',
      });
    }

    socket.on('pong', () => {
      conn.isAlive = true;
    });
    socket.on('message', (data: RawData) => this.handleMessage(conn, data));
    socket.on('error', (err: Error) => {
      console.error('restreamer: switcher socket error:', err.message);
    });
    socket.on('close', () => {
      this.connections.delete(id);
      if (this.connections.size === 0) {
        this.opts.events.log({
          type: 'warning',
          service: 'restreamer',
          source: 'switcher',
          message: 'all switcher replicas disconnected',
        });
      }
      this.rebuildAggregate();
    });

    this.send(
      socket,
      JSON.stringify({
        v: WS_PROTOCOL_VERSION,
        type: 'hello',
        serverVersion: this.opts.serverVersion,
      }),
    );
    // on-connect doc push; a computation failure sends nothing — the
    // steady-state broadcast (sweep / next mutation) heals the replica
    void this.opts
      .getDoc()
      .then((doc) => {
        this.send(socket, JSON.stringify({ v: WS_PROTOCOL_VERSION, type: 'doc', doc }));
      })
      .catch((err) => {
        console.error('restreamer: switcher on-connect doc computation failed:', err);
      });
    this.rebuildAggregate();
  }

  private handleMessage(conn: Connection, data: RawData): void {
    let msg: unknown;
    try {
      msg = JSON.parse(String(data));
    } catch {
      console.error('restreamer: switcher sent a non-JSON frame — ignored');
      return;
    }
    if (typeof msg !== 'object' || msg === null) return;
    const frame = msg as { v?: unknown; type?: unknown } & Record<string, unknown>;
    if (frame.v !== WS_PROTOCOL_VERSION) {
      conn.socket.close(WS_CLOSE_UNSUPPORTED_VERSION, 'unsupported protocol version');
      return;
    }
    switch (frame.type) {
      case 'hello': {
        if (typeof frame.switcherVersion === 'string' && typeof frame.startedAt === 'string') {
          conn.hello = { switcherVersion: frame.switcherVersion, startedAt: frame.startedAt };
          this.rebuildAggregate();
        }
        return;
      }
      case 'status': {
        const desiredRevision = typeof frame.desiredRevision === 'string' ? frame.desiredRevision : null;
        const channels = Array.isArray(frame.channels)
          ? (frame.channels as SwitcherChannelStatus[])
          : [];
        conn.lastStatus = { desiredRevision, channels, at: new Date().toISOString() };
        this.rebuildAggregate();
        if (channels.some((c) => c.eraOffsets !== undefined)) this.opts.onEraOffsets?.(channels);
        return;
      }
      case 'demand': {
        const events = Array.isArray(frame.events)
          ? (frame.events as unknown[]).filter(
              (e): e is DemandEvent =>
                typeof e === 'object' &&
                e !== null &&
                typeof (e as DemandEvent).slug === 'string' &&
                ((e as DemandEvent).kind === 'master' || (e as DemandEvent).kind === 'media') &&
                typeof (e as DemandEvent).at === 'string',
            )
          : [];
        if (events.length > 0) this.opts.onDemand(events);
        return;
      }
      default:
        // unknown type: ignored for forward compatibility
        return;
    }
  }

  private pingRound(): void {
    for (const conn of this.connections.values()) {
      if (!conn.isAlive) {
        conn.socket.terminate(); // the 'close' handler cleans up + republishes
        continue;
      }
      conn.isAlive = false;
      conn.socket.ping();
    }
  }

  /** send when the socket is open; false = frame not delivered */
  private send(socket: WebSocket, frame: string): boolean {
    if (socket.readyState !== socket.OPEN) return false;
    socket.send(frame);
    return true;
  }

  // ---------------------------------------------------------------------------
  // aggregate status
  // ---------------------------------------------------------------------------

  /**
   * Merge every replica's last status frame into the single
   * SWITCHER_CACHE_KEY entry and publish SSE on meaningful change.
   *
   * Conservative merge per slug across the replicas that report it:
   * activeUpstreamId only when ALL agree (a mid-propagation disagreement must
   * not confirm a switch), upstream healthy = AND, playlistLagSec = max of
   * the measured values, lastSwitch = newest by `at`, upstream set = union
   * (identical in steady state — every replica holds the same doc).
   */
  private rebuildAggregate(): void {
    const replicaCount = this.connections.size;
    const expected = this.opts.getExpectedRevision();
    const reporting = [...this.connections.values()].filter((c) => c.lastStatus !== null);

    let pendingPush = false;
    if (replicaCount === 0) {
      pendingPush = expected !== null;
    } else if (expected !== null) {
      pendingPush = reporting.some((c) => c.lastStatus!.desiredRevision !== expected);
    }

    const bySlug = new Map<string, SwitcherChannelStatus[]>();
    for (const c of reporting) {
      for (const chan of c.lastStatus!.channels) {
        let list = bySlug.get(chan.slug);
        if (!list) bySlug.set(chan.slug, (list = []));
        list.push(chan);
      }
    }
    const channels: SwitcherChannelStatus[] = [];
    for (const [slug, reports] of bySlug) {
      const first = reports[0]!;
      const allAgree = reports.every((r) => r.activeUpstreamId === first.activeUpstreamId);
      const upstreamIds = [...new Set(reports.flatMap((r) => r.upstreams.map((u) => u.id)))];
      const upstreams = upstreamIds.map((id) => {
        const seen = reports
          .map((r) => r.upstreams.find((u) => u.id === id))
          .filter((u) => u !== undefined);
        const lags = seen.map((u) => u.playlistLagSec).filter((l): l is number => l !== undefined);
        return {
          id,
          healthy: seen.every((u) => u.healthy),
          ...(lags.length > 0 ? { playlistLagSec: Math.max(...lags) } : {}),
        };
      });
      const lastSwitch = reports
        .map((r) => r.lastSwitch)
        .filter((s) => s !== null)
        .sort((a, b) => b.at.localeCompare(a.at))[0];
      channels.push({
        slug,
        activeUpstreamId: allAgree ? first.activeUpstreamId : null,
        upstreams,
        lastSwitch: lastSwitch ?? null,
      });
    }
    channels.sort((a, b) => a.slug.localeCompare(b.slug));

    const lastPollAt =
      reporting.map((c) => c.lastStatus!.at).sort((a, b) => b.localeCompare(a))[0] ?? null;
    const version =
      [...this.connections.values()].find((c) => c.hello !== null)?.hello?.switcherVersion ?? null;

    const status: SwitcherNodeStatus = {
      switcherId: SWITCHER_CACHE_KEY,
      url: 'ws',
      publicUrl: this.opts.publicUrl ?? '',
      reachable: replicaCount > 0,
      error: replicaCount > 0 ? null : 'no switcher replicas connected',
      lastPollAt,
      version,
      pendingPush,
      channels,
      replicaCount,
    };
    this.opts.cache.switchers.set(SWITCHER_CACHE_KEY, status);

    const key = statusKey(status);
    if (key !== this.lastStatusKey) {
      this.lastStatusKey = key;
      this.opts.bus.publish({ type: 'restreamer-switcher', data: status });
    }
  }
}
