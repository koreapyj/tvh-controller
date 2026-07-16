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
 * On-demand encoding: an all-cold channel's placements only encode while a
 * viewer is actually fetching it. The switcher replicas report playlist
 * fetches as `DemandEvent`s (master = the top-level M3U, media = the
 * per-upstream variant playlist); this engine turns that demand into a
 * delayed start and an idle-timeout stop of the channel's failover
 * procedure, via the exact same `requestFailover`/`releaseOnDemand` path a
 * manual or automatic failover uses (`reason: 'on-demand'`).
 *
 * As the initiator, this engine owns the lifecycle event-logging for its own
 * activations (start/stop, both normal) — FailoverSync stays silent on BEGIN
 * and complete for reason 'on-demand', and only its retarget/abort warnings
 * still fire (those are genuine problems, not routine channel-opens).
 *
 * Not serialized itself — RestreamerService calls `tick()` from inside its
 * op chain, right after `FailoverSync.tick()`, so start/stop requests queue
 * into the same serialized procedure machinery.
 */

import { ON_DEMAND_INITIAL_DELAY_DEFAULT_SEC } from '@tvhc/shared';
import type { EventLog } from '../state/eventLog.js';
import type { DemandEvent } from './switcherHubTypes.js';

interface DemandRecord {
  lastMasterAtMs: number | null;
  lastMediaAtMs: number | null;
}

/** per-channel input for one tick(), sourced from a lean DB query */
export interface OnDemandChannelTick {
  channelId: string;
  slug: string;
  /** the channel's enabled placements contain no `mode='hot'` one */
  allCold: boolean;
  /** a restream_failover_state row exists for this channel */
  hasRow: boolean;
  /** the row's phase, when hasRow — null otherwise */
  rowPhase: string | null;
  segmentSeconds: number;
  /** null = use ON_DEMAND_INITIAL_DELAY_DEFAULT_SEC */
  initialDelaySec: number | null;
}

export interface OnDemandDeps {
  requestFailover: (
    channelId: string,
    opts: { reason: 'on-demand'; detail: string },
  ) => Promise<unknown>;
  releaseOnDemand: (channelId: string) => Promise<void>;
  events: Pick<EventLog, 'log'>;
  now?: () => number;
}

/**
 * Tracks viewer demand per slug and drives on-demand start/stop. Non-allCold
 * channels are ignored entirely — an on-demand channel is one with no hot
 * placement to fall back on; a channel that also has a hot placement is
 * served by ordinary failover, not this engine.
 */
export class OnDemandEngine {
  private readonly demand = new Map<string, DemandRecord>();
  /** channelIds with a requestFailover call in flight, cleared once hasRow observes it landed (or it fails) */
  private readonly starting = new Set<string>();

  constructor(private readonly deps: OnDemandDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** merge viewer demand events, per slug, keeping the max timestamp seen for each kind */
  noteDemand(events: DemandEvent[]): void {
    for (const e of events) {
      const atMs = Date.parse(e.at);
      if (!Number.isFinite(atMs)) continue;
      const rec = this.demand.get(e.slug) ?? { lastMasterAtMs: null, lastMediaAtMs: null };
      if (e.kind === 'master') {
        rec.lastMasterAtMs = rec.lastMasterAtMs === null ? atMs : Math.max(rec.lastMasterAtMs, atMs);
      } else {
        rec.lastMediaAtMs = rec.lastMediaAtMs === null ? atMs : Math.max(rec.lastMediaAtMs, atMs);
      }
      this.demand.set(e.slug, rec);
    }
  }

  /**
   * Arm the initial-delay grace for slugs that already have a live on-demand
   * activation (restart resume) — without this, a controller restart with no
   * demand events replayed yet would see an immediately-expired deadline and
   * stop every active on-demand channel on its first tick.
   */
  seedActive(slugs: string[]): void {
    const nowMs = this.now();
    for (const slug of slugs) {
      const rec = this.demand.get(slug) ?? { lastMasterAtMs: null, lastMediaAtMs: null };
      rec.lastMasterAtMs = nowMs;
      this.demand.set(slug, rec);
    }
  }

  /**
   * One evaluation pass. Per all-cold channel, the keep-alive deadline is the
   * later of: last master fetch + initialDelaySec, and last media fetch + 2×
   * segmentSeconds (a variant-playlist poll cadence — losing that for two
   * segment intervals means the viewer is gone). No demand recorded yet
   * yields an unreachable (-Infinity) deadline for that term.
   *
   * - No row, deadline in the future, no start already in flight: request a
   *   failover (reason 'on-demand'); the guard is cleared once a later tick
   *   observes the row (landed) or the request throws (retry next tick).
   * - Row present and its phase is 'complete' and the deadline has passed:
   *   release it. Mid-procedure rows are left alone — `releaseOnDemand`
   *   itself also guards this, but the phase check avoids calling it
   *   needlessly every tick of a long procedure.
   */
  async tick(channels: OnDemandChannelTick[]): Promise<void> {
    const nowMs = this.now();
    for (const ch of channels) {
      if (!ch.allCold) continue;
      const rec = this.demand.get(ch.slug);
      const initialDelayMs = (ch.initialDelaySec ?? ON_DEMAND_INITIAL_DELAY_DEFAULT_SEC) * 1000;
      const masterDeadline =
        rec?.lastMasterAtMs != null ? rec.lastMasterAtMs + initialDelayMs : -Infinity;
      const mediaDeadline =
        rec?.lastMediaAtMs != null ? rec.lastMediaAtMs + 2 * ch.segmentSeconds * 1000 : -Infinity;
      const deadlineMs = Math.max(masterDeadline, mediaDeadline);

      if (ch.hasRow) {
        this.starting.delete(ch.channelId);
        if (ch.rowPhase === 'complete' && deadlineMs <= nowMs) {
          try {
            await this.deps.releaseOnDemand(ch.channelId);
            this.deps.events.log({
              type: 'normal',
              service: 'restreamer',
              source: 'controller',
              message: `on-demand STOP for "${ch.slug}" — no viewer demand`,
            });
          } catch (err) {
            console.error(`restreamer: on-demand stop for "${ch.slug}" failed:`, err);
          }
        }
        continue;
      }

      if (deadlineMs <= nowMs) continue; // no live demand — stay idle
      if (this.starting.has(ch.channelId)) continue; // start already in flight

      this.starting.add(ch.channelId);
      try {
        await this.deps.requestFailover(ch.channelId, { reason: 'on-demand', detail: 'viewer demand' });
        this.deps.events.log({
          type: 'normal',
          service: 'restreamer',
          source: 'controller',
          message: `on-demand START for "${ch.slug}" — viewer demand`,
        });
      } catch (err) {
        this.starting.delete(ch.channelId);
        console.error(`restreamer: on-demand start for "${ch.slug}" failed:`, err);
        this.deps.events.log({
          type: 'warning',
          service: 'restreamer',
          source: 'controller',
          message: `on-demand start for "${ch.slug}" failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }
}
