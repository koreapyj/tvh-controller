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

// Per-node session-capacity helpers (no Svelte imports): a node's configured
// hot load vs. its NodeSettings.maxSessions cap, plus the Capacity field's
// string<->value conversion.
//
// The cap gates AUTOMATIC admission only (failover/cutover clones); the
// controller pushes every enabled hot placement regardless, so these checks
// are a warn-only heuristic: configured steady-state load exceeding (or
// meeting) the benchmarked cap leaves no admission margin.

import type { RestreamChannelWithStatus } from '@tvhc/shared';

type PlacementLike = Pick<
  RestreamChannelWithStatus['placements'][number],
  'instanceId' | 'nodeId' | 'enabled' | 'mode' | 'transient'
>;
type ChannelLike = Pick<RestreamChannelWithStatus, 'enabled'> & { placements: PlacementLike[] };

/**
 * Configured steady-state hot load on one (instanceId, nodeId): enabled hot
 * placements belonging to enabled channels. Cutover-owned transient clones
 * are excluded — they're system-owned, admission-counted, and self-resolving,
 * so they must not inflate the operator-facing warning.
 */
export function configuredHotCount(channels: ChannelLike[], instanceId: string, nodeId: string): number {
  let n = 0;
  for (const c of channels) {
    if (!c.enabled) continue;
    for (const p of c.placements) {
      if (p.instanceId === instanceId && p.nodeId === nodeId && p.enabled && p.mode === 'hot' && !p.transient) {
        n++;
      }
    }
  }
  return n;
}

/** true when the configured hot load already exceeds the node's cap (null cap never warns) */
export function isOverCapacity(maxSessions: number | null, configured: number): boolean {
  return maxSessions != null && configured > maxSessions;
}

/** true when the configured hot load already meets/exceeds the cap — one more admission would tip it over */
export function isAtCapacity(maxSessions: number | null, configured: number): boolean {
  return maxSessions != null && configured >= maxSessions;
}

// ---------------------------------------------------------------------------
// NodeSettings.maxSessions form <-> value (ProbeConfigModal's Capacity field)
// ---------------------------------------------------------------------------

/** maxSessions -> form string ('' = uncapped) */
export function maxSessionsToInput(maxSessions: number | null): string {
  return maxSessions === null ? '' : String(maxSessions);
}

/** form string -> maxSessions; '' = null (uncapped); undefined = invalid (non-integer or negative) */
export function parseMaxSessionsInput(raw: string): number | null | undefined {
  const t = raw.trim();
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isInteger(n) || n < 0) return undefined;
  return n;
}

// ---------------------------------------------------------------------------
// NodeSettings.initialDelaySec form <-> value (ProbeConfigModal's Capacity field)
// ---------------------------------------------------------------------------

/** initialDelaySec -> form string ('' = default) */
export function initialDelayToInput(v: number | null): string {
  return v === null ? '' : String(v);
}

/** form string -> initialDelaySec; '' = null (default); undefined = invalid (non-integer or < 1) */
export function parseInitialDelayInput(raw: string): number | null | undefined {
  const t = raw.trim();
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isInteger(n) || n < 1) return undefined;
  return n;
}
