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
 * Slow rebalance policy for redundant channels (PURE — no I/O, no clock).
 *
 * Fast failover is the switcher's job; the controller only issues the slow,
 * deliberate moves: after any switch a channel is sticky for `stickyMs`
 * (default 1h), and a move is proposed only when it reduces the utilization
 * spread across egress-budgeted nodes by more than `hysteresis` — one
 * discontinuity per move, never a flap.
 */

import type { PipelineParams } from '@tvhc/shared';

/** sticky window after any switch (manual, failover or rebalance): 1h */
export const DEFAULT_STICKY_MS = 3_600_000;
/** minimum utilization-spread reduction a move must buy (15 percentage points) */
export const DEFAULT_HYSTERESIS = 0.15;
/** container/protocol overhead multiplier on the profile's nominal bitrates */
export const EGRESS_OVERHEAD = 1.1;

export interface RebalanceUpstream {
  placementId: string;
  instanceId: string;
  nodeId: string;
  /** per-upstream health as reported by the switcher; unknown = false */
  healthy: boolean;
  /** failover order — lower is preferred (tie-break only; health decides eligibility) */
  priority: number;
}

export interface RebalanceChannelInput {
  slug: string;
  channelId: string;
  /** expected per-viewer-facing egress of one encode (video + Σaudio + overhead), Mbps */
  expectedMbps: number;
  /** switcher-side active upstream (placement id); null = nothing selected yet */
  activePlacementId: string | null;
  /** ISO 8601 of the last switch; null = never switched (freely movable) */
  lastSwitchAt: string | null;
  upstreams: RebalanceUpstream[];
}

export interface RebalanceNodeInput {
  instanceId: string;
  nodeId: string;
  /** serving bandwidth budget; null = unbudgeted — excluded from balancing entirely */
  egressMbps: number | null;
}

export interface RebalanceMove {
  slug: string;
  toPlacementId: string;
  reason: 'rebalance';
}

export interface RebalanceInput {
  channels: RebalanceChannelInput[];
  nodes: RebalanceNodeInput[];
  now: Date;
  stickyMs?: number;
  hysteresis?: number;
}

/** '3M' / '128k' / plain bits-per-second string → Mbps; unparsable = fallback */
export function parseBitrateMbps(v: string | undefined, fallbackMbps: number): number {
  if (!v) return fallbackMbps;
  const m = /^(\d+(?:\.\d+)?)\s*([kKmM]?)$/.exec(v.trim());
  if (!m) return fallbackMbps;
  const n = Number(m[1]);
  const unit = (m[2] ?? '').toLowerCase();
  if (unit === 'm') return n;
  if (unit === 'k') return n / 1000;
  return n / 1_000_000;
}

/**
 * Expected egress of one encode from its profile payload: video bitrate plus
 * every audio bitrate (contract defaults: video '3M', audio '128k' for the
 * first output and '64k' for the rest), times the overhead factor.
 */
export function expectedChannelMbps(payload: PipelineParams): number {
  if (payload.template !== 'arib-hls') {
    // stored profiles are always the semantic 'arib-hls' shape — 'raw-argv'
    // is a render-time-only transform applied in computeNodeDoc and is
    // never persisted, so this branch is defensive, not expected to run.
    return 3 * EGRESS_OVERHEAD;
  }
  let mbps = parseBitrateMbps(payload.video.bitrate, 3);
  payload.audio.forEach((a, i) => {
    mbps += parseBitrateMbps(a.bitrate, i === 0 ? 0.128 : 0.064);
  });
  return mbps * EGRESS_OVERHEAD;
}

function nodeK(instanceId: string, nodeId: string): string {
  return `${instanceId}/${nodeId}`;
}

/**
 * Propose at most ONE move per pass — the greedy move that most reduces the
 * max−min utilization spread across budgeted nodes.
 *
 * Rules:
 * - utilization(node) = Σ expectedMbps of channels ACTIVE on it ÷ egressMbps;
 *   nodes with null egressMbps neither attract nor repel (their channels are
 *   invisible to the policy and they are never move targets);
 * - a channel is movable only when its active upstream is known, healthy, on
 *   a budgeted node, and its last switch is at least stickyMs old (a null
 *   lastSwitchAt means never switched — freely movable). An UNHEALTHY active
 *   upstream is the switcher's failover problem, not a rebalance;
 * - a move target must be a healthy upstream of the same channel on a
 *   DIFFERENT budgeted node;
 * - the winning move must reduce the spread by MORE than `hysteresis`;
 * - fully deterministic: channels are scanned in slug order and upstreams in
 *   (priority, placementId) order, and only a strictly better spread replaces
 *   the incumbent candidate — ties keep the earlier one.
 */
export function planRebalance(input: RebalanceInput): RebalanceMove[] {
  const stickyMs = input.stickyMs ?? DEFAULT_STICKY_MS;
  const hysteresis = input.hysteresis ?? DEFAULT_HYSTERESIS;

  const budget = new Map<string, number>();
  for (const n of input.nodes) {
    if (n.egressMbps != null && n.egressMbps > 0) {
      budget.set(nodeK(n.instanceId, n.nodeId), n.egressMbps);
    }
  }
  // a spread needs at least two budgeted nodes to exist
  if (budget.size < 2) return [];

  const load = new Map<string, number>([...budget.keys()].map((k) => [k, 0]));
  const actives: Array<{ ch: RebalanceChannelInput; active: RebalanceUpstream; activeKey: string }> = [];
  for (const ch of input.channels) {
    const active =
      ch.activePlacementId == null
        ? undefined
        : ch.upstreams.find((u) => u.placementId === ch.activePlacementId);
    if (!active) continue;
    const key = nodeK(active.instanceId, active.nodeId);
    if (!budget.has(key)) continue; // active on an unbudgeted node — invisible
    load.set(key, (load.get(key) ?? 0) + ch.expectedMbps);
    actives.push({ ch, active, activeKey: key });
  }

  const spreadOf = (l: Map<string, number>): number => {
    let min = Infinity;
    let max = -Infinity;
    for (const [key, egress] of budget) {
      const util = (l.get(key) ?? 0) / egress;
      if (util < min) min = util;
      if (util > max) max = util;
    }
    return max - min;
  };
  const currentSpread = spreadOf(load);

  const movable = actives
    .filter(({ ch, active }) => {
      if (!active.healthy) return false;
      if (ch.lastSwitchAt != null && input.now.getTime() - Date.parse(ch.lastSwitchAt) < stickyMs) {
        return false;
      }
      return true;
    })
    .sort(
      (a, b) => a.ch.slug.localeCompare(b.ch.slug) || a.ch.channelId.localeCompare(b.ch.channelId),
    );

  let best: { move: RebalanceMove; spread: number } | null = null;
  for (const { ch, activeKey } of movable) {
    const targets = ch.upstreams
      .filter((u) => u.healthy && u.placementId !== ch.activePlacementId)
      .sort((a, b) => a.priority - b.priority || a.placementId.localeCompare(b.placementId));
    for (const t of targets) {
      const targetKey = nodeK(t.instanceId, t.nodeId);
      if (targetKey === activeKey || !budget.has(targetKey)) continue;
      const sim = new Map(load);
      sim.set(activeKey, (sim.get(activeKey) ?? 0) - ch.expectedMbps);
      sim.set(targetKey, (sim.get(targetKey) ?? 0) + ch.expectedMbps);
      const spread = spreadOf(sim);
      // strictly better only — ties keep the earlier (slug/priority-ordered) candidate
      if (best === null || spread < best.spread) {
        best = {
          move: { slug: ch.slug, toPlacementId: t.placementId, reason: 'rebalance' },
          spread,
        };
      }
    }
  }

  if (!best) return [];
  if (currentSpread - best.spread <= hysteresis) return [];
  return [best.move];
}
