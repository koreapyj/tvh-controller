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
 * The probe engine: three independently-paced probe kinds over the delivery
 * path (successor to deliveryProbe.ts, which it retires).
 *
 * Instance-level (per restreamer node, via its serveUrl — the path viewers
 * and the switcher actually consume; for some regions a CACHE server):
 * - liveness:   fetch one hosted playlist; network error / abort-timeout /
 *               4xx / 5xx = fail. "Upstream down."
 * - underspeed: download the NEWEST segment of one hosted playlist; slower
 *               than realtime = fail, and a download that OPENED a connection
 *               but did not finish within timeoutSeconds = fail (the observed
 *               cache failure mode: segments hang while playlists stay fast).
 *               Connection-level errors defer to liveness as success.
 *
 * Channel-level (per placement):
 * - lag:      playlist PDT lag > timeoutSeconds = fail; a playlist fetch
 *             error is a SKIP (no fail count, no discovery) — a just-brought-
 *             up placement has no playlist yet, while a crashed session is
 *             still caught because its retained playlist goes stale.
 *
 * (A fourth probe, underrun, passively read the polled daemon
 * `progress.speed` sample per session. It was retired: ffmpeg's -progress
 * speed/out_time freezes whenever the sparse ARIB subtitle stream stops
 * receiving packets, so the metric read 0.8x/0x on perfectly healthy
 * encoders. The lag probe above covers real encoder stalls/slowdowns.)
 *
 * Counters use k8s-style sticky semantics (probeState.ts). Probe state is
 * PULLED by RestreamerPoller when building node status (single source of
 * truth — never patched into the cache), and placement-level changes notify
 * the service so it can publish `restreamer-channel` events.
 *
 * One coarse base tick; every target self-gates on its own periodSeconds via
 * nextDueAt, so per-node cadences vary without N timers.
 */

import type { LagProbeStatus, NodeProbeSettings, NodeProbeStatus } from '@tvhc/shared';
import { parseLastPdtEndMs, parseMasterVariant, parseNewestSegment } from './hlsParse.js';
import { applyProbeResult, toProbeStatus, type ProbeCounterState } from './probeState.js';

export const PROBE_BASE_TICK_MS = 5_000;
/** fetch budget for the playlist hops of the lag round (the lag threshold itself is config) */
const LAG_FETCH_TIMEOUT_MS = 10_000;

/** one node's probeable surface: its serveUrl + the slugs desired on it */
export interface NodeProbeTarget {
  instanceId: string;
  nodeId: string;
  /** null = node not directly serveable — instance probes are skipped ("n/a") */
  serveUrl: string | null;
  /** slugs of sessions currently desired on this node (docs' inclusion rules) */
  slugs: string[];
}

/** one placement's channel-level probe surface */
export interface PlacementProbeTarget {
  channelId: string;
  placementId: string;
  instanceId: string;
  nodeId: string;
  slug: string;
  /** master playlist URL through the node's serveUrl; null = not probeable */
  playlistUrl: string | null;
}

export interface ProbeTargets {
  nodes: NodeProbeTarget[];
  placements: PlacementProbeTarget[];
}

interface UnderspeedCounter extends ProbeCounterState {
  lastSpeedRatio: number | null;
}
interface LagCounter extends ProbeCounterState {
  lastLagSec: number | null;
  firstMeasuredAt: string | null;
}

export interface ProbeSnapshot {
  /** keyed by `${instanceId}/${nodeId}` */
  liveness: ReadonlyMap<string, ProbeCounterState>;
  underspeed: ReadonlyMap<string, UnderspeedCounter>;
  /** keyed by placementId */
  lag: ReadonlyMap<string, LagCounter>;
}

function nk(instanceId: string, nodeId: string): string {
  return `${instanceId}/${nodeId}`;
}

export class ProbeEngine {
  private readonly liveness = new Map<string, ProbeCounterState>();
  private readonly underspeed = new Map<string, UnderspeedCounter>();
  private readonly lag = new Map<string, LagCounter>();
  /** nextDueAt (ms) per probe kind+target key */
  private readonly due = new Map<string, number>();
  /** round-robin slug cursor per node */
  private readonly rr = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly getTargets: () => Promise<ProbeTargets>,
    private readonly getSettings: () => Promise<Map<string, NodeProbeSettings>>,
    /** placement-level probe state changed meaningfully — publish channel status */
    private readonly onPlacementChange: (channelId: string) => void = () => {},
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(): void {
    if (this.timer) return;
    void this.tick().catch(() => {});
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, PROBE_BASE_TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot(): ProbeSnapshot {
    return {
      liveness: this.liveness,
      underspeed: this.underspeed,
      lag: this.lag,
    };
  }

  /** instance-level state for one node; null = nothing probeable / never probed */
  nodeProbeStatus(instanceId: string, nodeId: string): NodeProbeStatus | null {
    const key = nk(instanceId, nodeId);
    const live = this.liveness.get(key);
    const speed = this.underspeed.get(key);
    if (!live && !speed) return null;
    return {
      liveness: toProbeStatus(live),
      underspeed: { ...toProbeStatus(speed), lastSpeedRatio: speed?.lastSpeedRatio ?? null },
    };
  }

  lagStatus(placementId: string): LagProbeStatus | null {
    const s = this.lag.get(placementId);
    if (!s) return null;
    return { ...toProbeStatus(s), lastLagSec: s.lastLagSec, firstMeasuredAt: s.firstMeasuredAt };
  }

  /** one round; runs only the targets whose period elapsed. Exported for tests. */
  async tick(): Promise<void> {
    if (this.running) return; // a slow round must not overlap the next
    this.running = true;
    try {
      const [targets, settings] = await Promise.all([this.getTargets(), this.getSettings()]);
      this.prune(targets);
      const nowMs = this.now().getTime();

      const work: Array<Promise<void>> = [];
      for (const node of targets.nodes) {
        const key = nk(node.instanceId, node.nodeId);
        const cfg = settings.get(key);
        if (!cfg) continue;
        // periodSeconds 0 = probe disabled: never scheduled, and any prior
        // state is dropped so stale badges/triggers vanish immediately
        if (cfg.liveness.periodSeconds <= 0) {
          this.liveness.delete(key);
          this.due.delete(`live:${key}`);
        } else if (this.isDue(`live:${key}`, cfg.liveness.periodSeconds, nowMs)) {
          work.push(this.runLiveness(node, cfg));
        }
        if (cfg.underspeed.periodSeconds <= 0) {
          this.underspeed.delete(key);
          this.due.delete(`speed:${key}`);
        } else if (this.isDue(`speed:${key}`, cfg.underspeed.periodSeconds, nowMs)) {
          work.push(this.runUnderspeed(node, cfg));
        }
      }
      for (const p of targets.placements) {
        const cfg = settings.get(nk(p.instanceId, p.nodeId));
        if (!cfg) continue;
        if (cfg.lag.periodSeconds <= 0) {
          this.lag.delete(p.placementId);
          this.due.delete(`lag:${p.placementId}`);
        } else if (this.isDue(`lag:${p.placementId}`, cfg.lag.periodSeconds, nowMs)) {
          work.push(this.runLag(p, cfg));
        }
      }
      await Promise.all(work.map((w) => w.catch(() => {})));
    } finally {
      this.running = false;
    }
  }

  private isDue(key: string, periodSeconds: number, nowMs: number): boolean {
    const at = this.due.get(key) ?? 0;
    if (nowMs < at) return false;
    this.due.set(key, nowMs + periodSeconds * 1000);
    return true;
  }

  /** drop state for nodes/placements that left the target set */
  private prune(targets: ProbeTargets): void {
    const nodeKeys = new Set(targets.nodes.map((n) => nk(n.instanceId, n.nodeId)));
    const placementIds = new Set(targets.placements.map((p) => p.placementId));
    for (const key of [...this.liveness.keys()]) if (!nodeKeys.has(key)) this.liveness.delete(key);
    for (const key of [...this.underspeed.keys()]) if (!nodeKeys.has(key)) this.underspeed.delete(key);
    for (const key of [...this.lag.keys()]) if (!placementIds.has(key)) this.lag.delete(key);
    for (const key of [...this.rr.keys()]) if (!nodeKeys.has(key)) this.rr.delete(key);
  }

  /** next hosted playlist URL for a node's instance-level probes (round-robin) */
  private nextPlaylistUrl(node: NodeProbeTarget): string | null {
    if (!node.serveUrl || node.slugs.length === 0) return null;
    const key = nk(node.instanceId, node.nodeId);
    const idx = (this.rr.get(key) ?? 0) % node.slugs.length;
    this.rr.set(key, idx + 1);
    return `${node.serveUrl}/${node.slugs[idx]}/playlist.m3u8`;
  }

  // ---------- liveness ----------

  private async runLiveness(node: NodeProbeTarget, cfg: NodeProbeSettings): Promise<void> {
    const key = nk(node.instanceId, node.nodeId);
    const url = this.nextPlaylistUrl(node);
    if (url == null) {
      // nothing probeable (no serveUrl / no sessions) — "n/a", never a badge
      this.liveness.delete(key);
      return;
    }
    let result: 'ok' | 'fail';
    let detail: string;
    try {
      const res = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(cfg.liveness.timeoutSeconds * 1000),
      });
      // drain the (tiny) body so sockets are reusable
      await res.text().catch(() => '');
      if (res.ok) {
        result = 'ok';
        detail = `playlist HTTP ${res.status}`;
      } else {
        result = 'fail';
        detail = `playlist HTTP ${res.status}`;
      }
    } catch (err) {
      result = 'fail';
      detail =
        err instanceof Error && err.name === 'TimeoutError'
          ? `no response within ${cfg.liveness.timeoutSeconds}s`
          : `fetch error: ${err instanceof Error ? err.message : String(err)}`;
    }
    this.liveness.set(key, applyProbeResult(this.liveness.get(key), result, cfg.liveness, this.now(), detail));
  }

  // ---------- underspeed (network/delivery) ----------

  private async runUnderspeed(node: NodeProbeTarget, cfg: NodeProbeSettings): Promise<void> {
    const key = nk(node.instanceId, node.nodeId);
    const url = this.nextPlaylistUrl(node);
    if (url == null) {
      this.underspeed.delete(key);
      return;
    }
    const m = await this.measureSegment(url, cfg.underspeed.timeoutSeconds);
    const prev = this.underspeed.get(key);
    const next = applyProbeResult(prev, m.result, cfg.underspeed, this.now(), m.detail);
    this.underspeed.set(key, {
      ...next,
      lastSpeedRatio: m.speedRatio ?? prev?.lastSpeedRatio ?? null,
    });
  }

  /**
   * Fetch playlist → variant → NEWEST segment, timing the segment download.
   * - segment slower than realtime → fail
   * - segment connection OPENED but download incomplete within
   *   timeoutSeconds → fail (cache-hang: bytes/elapsed recorded)
   * - connection-level errors / HTTP errors / no segments → ok (liveness owns those)
   */
  private async measureSegment(
    playlistUrl: string,
    timeoutSeconds: number,
  ): Promise<{ result: 'ok' | 'fail'; detail: string; speedRatio: number | null }> {
    const budgetMs = timeoutSeconds * 1000;
    const defer = (why: string): { result: 'ok'; detail: string; speedRatio: null } => ({
      result: 'ok',
      detail: `not measured (${why}) — deferred to liveness`,
      speedRatio: null,
    });

    let mediaText: string;
    let mediaUrl = playlistUrl;
    try {
      const plRes = await this.fetchImpl(playlistUrl, { signal: AbortSignal.timeout(budgetMs) });
      if (!plRes.ok) return defer(`playlist HTTP ${plRes.status}`);
      const text = await plRes.text();
      const variantUri = parseMasterVariant(text);
      if (variantUri != null) {
        mediaUrl = new URL(variantUri, playlistUrl).toString();
        const varRes = await this.fetchImpl(mediaUrl, { signal: AbortSignal.timeout(budgetMs) });
        if (!varRes.ok) return defer(`variant HTTP ${varRes.status}`);
        mediaText = await varRes.text();
      } else {
        mediaText = text;
      }
    } catch (err) {
      return defer(err instanceof Error ? err.message : String(err));
    }

    const seg = parseNewestSegment(mediaText);
    if (!seg) return defer('playlist has no segments');
    const segmentSeconds = seg.durationSec ?? 5;
    const segmentUrl = new URL(seg.uri, mediaUrl).toString();

    const started = performance.now();
    let res: Response;
    try {
      res = await this.fetchImpl(segmentUrl, { signal: AbortSignal.timeout(budgetMs) });
    } catch (err) {
      // no response at all — connection-level; liveness owns it
      return defer(err instanceof Error ? err.message : String(err));
    }
    if (!res.ok) return defer(`segment HTTP ${res.status}`);

    // connection OPENED: from here on, an unfinished download is a measured hang
    let bytes = 0;
    let completed = true;
    try {
      const reader = res.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value?.byteLength ?? 0;
        }
      }
    } catch {
      completed = false;
    }
    const elapsedMs = performance.now() - started;
    const kb = (bytes / 1024).toFixed(1);

    if (!completed) {
      return {
        result: 'fail',
        detail: `segment download hung: ${kb}KB in ${elapsedMs.toFixed(0)}ms (budget ${timeoutSeconds}s)`,
        speedRatio: null,
      };
    }
    const speedRatio = elapsedMs > 0 ? (segmentSeconds * 1000) / elapsedMs : null;
    const rounded = speedRatio != null ? Math.round(speedRatio * 100) / 100 : null;
    if (elapsedMs > segmentSeconds * 1000) {
      return {
        result: 'fail',
        detail: `segment ${kb}KB in ${elapsedMs.toFixed(0)}ms — slower than realtime (${segmentSeconds}s segment)`,
        speedRatio: rounded,
      };
    }
    return {
      result: 'ok',
      detail: `segment ${kb}KB in ${elapsedMs.toFixed(0)}ms (${segmentSeconds}s segment)`,
      speedRatio: rounded,
    };
  }

  // ---------- lag (channel-level, delivery path) ----------

  private async runLag(p: PlacementProbeTarget, cfg: NodeProbeSettings): Promise<void> {
    if (p.playlistUrl == null) return; // not probeable — leave any prior state as-is
    let pdtEndMs: number | null = null;
    try {
      const res = await this.fetchImpl(p.playlistUrl, {
        signal: AbortSignal.timeout(LAG_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return; // SKIP — bring-up window / delivery failure is liveness territory
      const text = await res.text();
      const variantUri = parseMasterVariant(text);
      if (variantUri != null) {
        const varUrl = new URL(variantUri, p.playlistUrl).toString();
        const varRes = await this.fetchImpl(varUrl, {
          signal: AbortSignal.timeout(LAG_FETCH_TIMEOUT_MS),
        });
        if (!varRes.ok) return; // SKIP
        pdtEndMs = parseLastPdtEndMs(await varRes.text());
      } else {
        pdtEndMs = parseLastPdtEndMs(text);
      }
    } catch {
      return; // SKIP — fetch error is not a lag measurement
    }
    if (pdtEndMs == null) return; // SKIP — no PDT to measure against

    const now = this.now();
    const lagSec = Math.max(0, Math.round(((now.getTime() - pdtEndMs) / 1000) * 10) / 10);
    const result: 'ok' | 'fail' = lagSec > cfg.lag.timeoutSeconds ? 'fail' : 'ok';
    const prev = this.lag.get(p.placementId);
    const next = applyProbeResult(
      prev,
      result,
      cfg.lag,
      now,
      `lag ${lagSec.toFixed(1)}s (threshold ${cfg.lag.timeoutSeconds}s)`,
    );
    const merged: LagCounter = {
      ...next,
      lastLagSec: lagSec,
      firstMeasuredAt: prev?.firstMeasuredAt ?? now.toISOString(),
    };
    this.lag.set(p.placementId, merged);
    if (this.meaningfulChange(prev, merged)) this.onPlacementChange(p.channelId);
  }

  /** counts/failed changed — not just lastCheckedAt/measurement noise */
  private meaningfulChange(prev: ProbeCounterState | undefined, next: ProbeCounterState): boolean {
    return (
      prev?.failed !== next.failed ||
      prev?.consecutiveFailures !== next.consecutiveFailures ||
      (prev.consecutiveSuccesses > 0) !== (next.consecutiveSuccesses > 0)
    );
  }
}
