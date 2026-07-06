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
 * Active delivery probing for restreamer `serveUrl` origins.
 *
 * Viewers and the HLS switcher fetch a node's HLS through its `serveUrl`,
 * which for some regions is a CACHE SERVER rather than the origin restreamer
 * itself. A slow cache upstream (the segment path) is invisible to
 * playlist-only health checks: playlists are tiny and keep refreshing fast
 * even through a struggling cache. This module actively probes each
 * `serveUrl` ORIGIN (scheme+host+port — the unit of failure is the cache, not
 * any one channel): fetch one active slug's media playlist through the
 * cache, then download its NEWEST segment, and measure TTFB plus whether the
 * download sustains realtime. Results feed a cold-backup failover loop as
 * per-origin slow/healthy streaks.
 */

/** parsed from controller config `restreamer.deliveryProbe` (all optional with these defaults) */
export interface DeliveryProbeConfig {
  /** probe cadence */
  intervalSec: number;
  /** TTFB above this on playlist OR segment fetch = slow */
  ttfbMs: number;
  /** segment must download in < segmentSeconds / minSpeedFactor, else slow */
  minSpeedFactor: number;
}

export const DELIVERY_PROBE_DEFAULTS: DeliveryProbeConfig = {
  intervalSec: 45,
  ttfbMs: 3000,
  minSpeedFactor: 1.5,
};

export interface ProbeMeasurement {
  /** fetches succeeded (HTTP 2xx, no timeout/network error) */
  ok: boolean;
  /** worst TTFB observed across playlist+segment fetches */
  ttfbMs: number | null;
  /** EXTINF duration of the probed segment */
  segmentSeconds: number | null;
  /** wall time to fully download the segment body */
  downloadMs: number | null;
  /** human-readable, e.g. "segment 2.1MB in 5200ms (4.0s segment)" */
  detail: string;
}

/**
 * PURE: classify one measurement. `ok:false` is always slow. Missing
 * measurements (nulls) with `ok:true` and a fine TTFB are 'ok' — a playlist
 * that legitimately couldn't be measured further is not punished.
 */
export function evaluateProbe(m: ProbeMeasurement, cfg: DeliveryProbeConfig): 'slow' | 'ok' {
  if (!m.ok) return 'slow';
  if (m.ttfbMs != null && m.ttfbMs > cfg.ttfbMs) return 'slow';
  if (m.segmentSeconds != null && m.downloadMs != null) {
    const budgetMs = (m.segmentSeconds * 1000) / cfg.minSpeedFactor;
    if (m.downloadMs > budgetMs) return 'slow';
  }
  return 'ok';
}

export interface DeliveryOriginHealth {
  slowStreak: number;
  healthyStreak: number;
  /** ISO 8601, null before the first probe */
  lastProbeAt: string | null;
  lastDetail: string;
}

/** `urls` = candidate media-playlist URLs on that origin (absolute) */
export type ProbeTarget = { origin: string; urls: string[] };

interface ParsedSegment {
  /** raw URI as it appeared in the playlist (may be relative) */
  uri: string;
  durationSec: number | null;
}

/**
 * First variant URI of a MASTER playlist (the line after `#EXT-X-STREAM-INF`);
 * null when the text is not a master playlist. arib-hls nodes serve a master
 * at `<slug>/playlist.m3u8` with media playlists per variant underneath, so
 * the probe follows one hop before looking for segments.
 */
function parseMasterVariant(text: string): string | null {
  let afterStreamInf = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      afterStreamInf = true;
      continue;
    }
    if (line.startsWith('#')) continue;
    if (afterStreamInf) return line;
  }
  return null;
}

/**
 * Find the LAST segment URI in a media playlist and its EXTINF duration
 * (falling back to `#EXT-X-TARGETDURATION` when the segment's own EXTINF is
 * missing or unparsable). Returns null when the playlist has no segments.
 */
function parseMediaPlaylist(text: string): ParsedSegment | null {
  let lastUri: string | null = null;
  let lastDuration: number | null = null;
  let pendingDuration: number | null = null;
  let targetDuration: number | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      const v = Number(line.slice('#EXT-X-TARGETDURATION:'.length));
      if (Number.isFinite(v)) targetDuration = v;
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      const m = /^#EXTINF:([\d.]+)/.exec(line);
      pendingDuration = m ? Number(m[1]) : null;
      continue;
    }
    if (line.startsWith('#')) continue;
    // a bare (non-comment) line is a segment URI
    lastUri = line;
    lastDuration = pendingDuration ?? targetDuration;
    pendingDuration = null;
  }

  if (lastUri == null) return null;
  return { uri: lastUri, durationSec: lastDuration };
}

/**
 * Probes each configured serveUrl origin on an interval, actively exercising
 * the cache/segment path (not just the playlist) and tracking per-origin
 * slow/healthy streaks for a cold-backup failover loop to consume.
 */
export class DeliveryProbe {
  private readonly health = new Map<string, DeliveryOriginHealth>();
  /** round-robin cursor per origin across `urls` */
  private readonly rrIndex = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly cfg: DeliveryProbeConfig,
    private readonly getTargets: () => Promise<ProbeTarget[]> | ProbeTarget[],
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  start(): void {
    void this.runOnce().catch(() => {});
    this.timer = setInterval(() => {
      void this.runOnce().catch(() => {});
    }, this.cfg.intervalSec * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** current per-origin health, keyed by origin */
  snapshot(): Map<string, DeliveryOriginHealth> {
    return new Map(this.health);
  }

  /** one probe round over all targets; exported for tests (no timers needed) */
  async runOnce(now: Date = new Date()): Promise<void> {
    const targets = await this.getTargets();
    const seenOrigins = new Set<string>();
    for (const target of targets) {
      seenOrigins.add(target.origin);
      try {
        const measurement = await this.measure(target);
        this.applyResult(target.origin, measurement, now);
      } catch (err) {
        // a throwing target must never break the round for the others
        this.applyResult(
          target.origin,
          {
            ok: false,
            ttfbMs: null,
            segmentSeconds: null,
            downloadMs: null,
            detail: `probe threw: ${err instanceof Error ? err.message : String(err)}`,
          },
          now,
        );
      }
    }
    for (const origin of [...this.health.keys()]) {
      if (!seenOrigins.has(origin)) this.health.delete(origin);
    }
  }

  private applyResult(origin: string, measurement: ProbeMeasurement, now: Date): void {
    const outcome = evaluateProbe(measurement, this.cfg);
    const prev = this.health.get(origin) ?? {
      slowStreak: 0,
      healthyStreak: 0,
      lastProbeAt: null,
      lastDetail: '',
    };
    const next: DeliveryOriginHealth =
      outcome === 'slow'
        ? { ...prev, slowStreak: prev.slowStreak + 1, healthyStreak: 0 }
        : { ...prev, healthyStreak: prev.healthyStreak + 1, slowStreak: 0 };
    next.lastProbeAt = now.toISOString();
    next.lastDetail = measurement.detail;
    this.health.set(origin, next);
  }

  /** round-robin the next candidate playlist URL for this origin */
  private nextUrl(target: ProbeTarget): string | null {
    if (target.urls.length === 0) return null;
    const idx = (this.rrIndex.get(target.origin) ?? 0) % target.urls.length;
    this.rrIndex.set(target.origin, idx + 1);
    return target.urls[idx]!;
  }

  /** fetch playlist + newest segment through this origin and measure it */
  private async measure(target: ProbeTarget): Promise<ProbeMeasurement> {
    const playlistUrl = this.nextUrl(target);
    if (playlistUrl == null) {
      return {
        ok: false,
        ttfbMs: null,
        segmentSeconds: null,
        downloadMs: null,
        detail: 'no candidate playlist urls',
      };
    }

    const timeoutMs = this.cfg.ttfbMs + 30_000;
    try {
      const plStart = performance.now();
      const plRes = await this.fetchImpl(playlistUrl, { signal: AbortSignal.timeout(timeoutMs) });
      const plTtfb = performance.now() - plStart;
      if (!plRes.ok) {
        return {
          ok: false,
          ttfbMs: plTtfb,
          segmentSeconds: null,
          downloadMs: null,
          detail: `playlist HTTP ${plRes.status}`,
        };
      }

      const text = await plRes.text();

      // master playlist → follow the first variant to a media playlist
      let mediaText = text;
      let mediaUrl = playlistUrl;
      let ttfbSoFar = plTtfb;
      const variantUri = parseMasterVariant(text);
      if (variantUri != null) {
        const varUrl = new URL(variantUri, playlistUrl).toString();
        const varStart = performance.now();
        const varRes = await this.fetchImpl(varUrl, { signal: AbortSignal.timeout(timeoutMs) });
        const varTtfb = performance.now() - varStart;
        ttfbSoFar = Math.max(ttfbSoFar, varTtfb);
        if (!varRes.ok) {
          return {
            ok: false,
            ttfbMs: ttfbSoFar,
            segmentSeconds: null,
            downloadMs: null,
            detail: `variant playlist HTTP ${varRes.status}`,
          };
        }
        mediaText = await varRes.text();
        mediaUrl = varUrl;
      }

      const parsed = parseMediaPlaylist(mediaText);
      if (!parsed) {
        return {
          ok: false,
          ttfbMs: ttfbSoFar,
          segmentSeconds: null,
          downloadMs: null,
          detail: 'playlist has no segments',
        };
      }

      const segmentUrl = new URL(parsed.uri, mediaUrl).toString();
      const segStart = performance.now();
      const segRes = await this.fetchImpl(segmentUrl, { signal: AbortSignal.timeout(timeoutMs) });
      const segTtfb = performance.now() - segStart;
      if (!segRes.ok) {
        return {
          ok: false,
          ttfbMs: Math.max(ttfbSoFar, segTtfb),
          segmentSeconds: parsed.durationSec,
          downloadMs: null,
          detail: `segment HTTP ${segRes.status}`,
        };
      }

      const buf = await segRes.arrayBuffer();
      const downloadMs = performance.now() - segStart;
      const worstTtfb = Math.max(ttfbSoFar, segTtfb);
      const kb = buf.byteLength / 1024;
      return {
        ok: true,
        ttfbMs: worstTtfb,
        segmentSeconds: parsed.durationSec,
        downloadMs,
        detail: `segment ${kb.toFixed(1)}KB in ${downloadMs.toFixed(0)}ms (${parsed.durationSec ?? '?'}s segment)`,
      };
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        return {
          ok: false,
          ttfbMs: null,
          segmentSeconds: null,
          downloadMs: null,
          detail: `probe timed out after ${timeoutMs}ms`,
        };
      }
      return {
        ok: false,
        ttfbMs: null,
        segmentSeconds: null,
        downloadMs: null,
        detail: `probe error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
