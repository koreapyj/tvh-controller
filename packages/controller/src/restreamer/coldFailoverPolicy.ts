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
 * Cold-failover policy for redundant channels (PURE — no I/O, no clock, no
 * Date.now).
 *
 * Placements are encoding sessions on restreamer nodes. `mode:'hot'`
 * placements always encode; `mode:'cold'` placements are standbys. A control
 * loop ticks every `COLD_FAILOVER_TICK_MS` and, when a channel's PREFERRED
 * placement (the lowest-(priority,id) enabled hot placement) becomes
 * not-ready, activates one cold placement (inserting an activation); when the
 * preferred recovers, the deactivation is make-before-break. A separate HLS
 * "switcher" fronts viewers and picks the active upstream (upstream id =
 * placement id).
 *
 * This module is the pure decision function only: an impure sync layer
 * elsewhere computes the input snapshot (streak counters, admission results,
 * source keys) every tick and applies the resulting actions.
 */

/** control-loop tick interval. */
export const COLD_FAILOVER_TICK_MS = 20_000;
/** consecutive ticks the preferred placement's node must be unreachable before it counts (~60s). */
export const NODE_UNREACHABLE_DEBOUNCE_TICKS = 3;
/** consecutive ticks the preferred placement's session must be unhealthy before it counts. */
export const SESSION_UNHEALTHY_DEBOUNCE_TICKS = 3;
/** consecutive ticks the delivery probe must report the preferred's serve origin as slow before it counts. */
export const DELIVERY_SLOW_DEBOUNCE_TICKS = 3;
/** consecutive ticks the recovery condition must hold before deactivation/switch-back is considered. */
export const RECOVERY_DEBOUNCE_TICKS = 3;
/** consecutive backoff failures on the preferred session before it is considered "unhealthy". */
export const SESSION_CONSECUTIVE_FAILURES_THRESHOLD = 3;
/** playlist lag (seconds) on the preferred session above which it is considered "unhealthy". */
export const PLAYLIST_LAG_ACTIVATE_SEC = 30;
/** playlist lag (seconds) the preferred session must fall back under to be considered recovered (hysteresis). */
export const PLAYLIST_LAG_RECOVER_SEC = 10;

/** identity of the ENCODE input source of a placement. */
export type SourceKey =
  | { kind: 'tvh'; instanceId: string }
  | { kind: 'catalog'; url: string }
  | { kind: 'unresolved' };

/**
 * Structural equality of two source identities. `'unresolved'` NEVER equals
 * anything — not even another `'unresolved'` — so an unresolved source is
 * conservatively treated as distinct everywhere it is compared.
 */
export function sameSource(a: SourceKey, b: SourceKey): boolean {
  if (a.kind === 'unresolved' || b.kind === 'unresolved') return false;
  switch (a.kind) {
    case 'tvh':
      return b.kind === 'tvh' && a.instanceId === b.instanceId;
    case 'catalog':
      return b.kind === 'catalog' && a.url === b.url;
  }
}

export type ColdTriggerReason = 'node-unreachable' | 'session-unhealthy' | 'delivery-slow';

/**
 * Per-tick raw health snapshot of the preferred placement's node+session, as
 * evaluated by {@link evalPreferredHealth}.
 */
export interface PreferredSnapshot {
  reachable: boolean;
  /** null = the node did not report a session for this placement. */
  session: { state: string; consecutiveFailures: number; playlistLagSec: number | null } | null;
}

/**
 * Pure per-tick classification the sync layer uses to update its streak
 * counters. `sessionUnhealthy` and `sessionHealthy` are mutually exclusive;
 * a lag between {@link PLAYLIST_LAG_RECOVER_SEC} and
 * {@link PLAYLIST_LAG_ACTIVATE_SEC} yields neither (hysteresis band).
 */
export function evalPreferredHealth(s: PreferredSnapshot): {
  nodeUnreachable: boolean;
  sessionUnhealthy: boolean;
  sessionHealthy: boolean;
} {
  if (!s.reachable) {
    return { nodeUnreachable: true, sessionUnhealthy: false, sessionHealthy: false };
  }
  if (s.session === null) {
    return { nodeUnreachable: false, sessionUnhealthy: true, sessionHealthy: false };
  }
  const { state, consecutiveFailures, playlistLagSec } = s.session;
  const sessionUnhealthy =
    (state === 'backoff' && consecutiveFailures >= SESSION_CONSECUTIVE_FAILURES_THRESHOLD) ||
    (playlistLagSec != null && playlistLagSec > PLAYLIST_LAG_ACTIVATE_SEC);
  const sessionHealthy =
    state === 'running' && (playlistLagSec == null || playlistLagSec <= PLAYLIST_LAG_RECOVER_SEC);
  return { nodeUnreachable: false, sessionUnhealthy, sessionHealthy };
}

export interface PreferredInput {
  placementId: string;
  sourceKey: SourceKey;
  /** origin (scheme+host+port) of the node's serveUrl (HLS delivery path, may be a cache server); null if the node has no serveUrl. */
  serveOrigin: string | null;
  nodeUnreachableStreak: number;
  sessionUnhealthyStreak: number;
  /** from the delivery probe, per serveOrigin. */
  deliverySlowStreak: number;
  /** consecutive ticks the recovery condition held (for the delivery-slow reason the sync layer only counts ticks where the probe was ALSO healthy). */
  sessionHealthyStreak: number;
}

export interface ColdCandidateInput {
  placementId: string;
  priority: number;
  sourceKey: SourceKey;
  serveOrigin: string | null;
  /** pre-computed by the sync layer. */
  admission: { ok: true } | { ok: false; detail: string };
}

export interface ColdChannelInput {
  channelId: string;
  slug: string;
  /** switcher currently reports this slug. */
  switcherReported: boolean;
  /** upstream ids are placement ids. */
  switcherActiveUpstreamId: string | null;
  /** null = channel has no enabled hot placement. */
  preferred: PreferredInput | null;
  /** some OTHER enabled hot placement is currently healthy. */
  otherHotHealthy: boolean;
  /** enabled cold placements, any order. */
  candidates: ColdCandidateInput[];
  currentActivation: { placementId: string; reason: ColdTriggerReason } | null;
  /** cold session running AND its switcher upstream healthy (needed before force-switch). */
  activeColdReady: boolean;
}

export type ColdFailoverAction =
  | {
      type: 'activate';
      channelId: string;
      placementId: string;
      reason: ColdTriggerReason;
      preferredPlacementId: string;
      forceSwitch: boolean;
    }
  // manual switcher cutover (delivery-slow only)
  | { type: 'switch'; channelId: string; slug: string; toPlacementId: string }
  // manual switch back to preferred (delivery-slow only)
  | { type: 'switch-back'; channelId: string; slug: string; toPlacementId: string }
  | { type: 'deactivate'; channelId: string; placementId: string };

export interface ColdFailoverBlocked {
  channelId: string;
  slug: string;
  reason: string;
}

const TRIGGER_ORDER: ColdTriggerReason[] = ['node-unreachable', 'session-unhealthy', 'delivery-slow'];

function streakFor(pref: PreferredInput, reason: ColdTriggerReason): number {
  switch (reason) {
    case 'node-unreachable':
      return pref.nodeUnreachableStreak;
    case 'session-unhealthy':
      return pref.sessionUnhealthyStreak;
    case 'delivery-slow':
      return pref.deliverySlowStreak;
  }
}

function debounceFor(reason: ColdTriggerReason): number {
  switch (reason) {
    case 'node-unreachable':
      return NODE_UNREACHABLE_DEBOUNCE_TICKS;
    case 'session-unhealthy':
      return SESSION_UNHEALTHY_DEBOUNCE_TICKS;
    case 'delivery-slow':
      return DELIVERY_SLOW_DEBOUNCE_TICKS;
  }
}

/** whether a cold candidate is eligible for the given trigger reason (admission + reason-specific gate). */
function passesGate(c: ColdCandidateInput, reason: ColdTriggerReason, pref: PreferredInput): boolean {
  if (!c.admission.ok) return false;
  if (reason === 'session-unhealthy') return !sameSource(c.sourceKey, pref.sourceKey);
  if (reason === 'delivery-slow') return c.serveOrigin !== null && c.serveOrigin !== pref.serveOrigin;
  return true; // node-unreachable: no gate
}

/** human-readable reason a single candidate was rejected, for the aggregate blocked message. */
function rejectionReason(c: ColdCandidateInput, reason: ColdTriggerReason): string {
  if (!c.admission.ok) return `${c.placementId}: ${c.admission.detail}`;
  if (reason === 'session-unhealthy') return `${c.placementId}: same source as preferred`;
  if (reason === 'delivery-slow') {
    return c.serveOrigin === null
      ? `${c.placementId}: no serve origin`
      : `${c.placementId}: same serve origin as preferred`;
  }
  return `${c.placementId}: ineligible`;
}

/**
 * Decide, per channel, whether to activate/deactivate a cold placement or
 * force a manual switcher cutover. Pure: same input array → same output;
 * inputs are never mutated.
 *
 * See the module doc for the overall model. Per channel:
 * - `!switcherReported` or `preferred === null` → skipped entirely (no
 *   action, no blocked entry).
 * - no `currentActivation`: the firing trigger is chosen by precedence
 *   node-unreachable > session-unhealthy > delivery-slow among triggers whose
 *   streak has reached its debounce constant, and only when `!otherHotHealthy`.
 *   If one fires, the first eligible candidate (by (priority, placementId))
 *   is activated; otherwise a single aggregate `blocked` entry is produced.
 * - `currentActivation` exists: for `delivery-slow` while the switcher hasn't
 *   moved to the cold placement yet, a `switch` is force-emitted once the
 *   cold session is ready (the switcher cannot see segment slowness on its
 *   own). Once the recovery streak is reached AND the switcher has moved
 *   off the cold placement, `deactivate` is emitted (make-before-break);
 *   while the switcher is still on the cold placement, `delivery-slow`
 *   force-emits `switch-back`, other reasons wait for the switcher to move
 *   back on its own. No re-activation churn: while an activation exists, no
 *   second `activate` is ever emitted for that channel.
 */
export function planColdFailover(channels: ColdChannelInput[]): {
  actions: ColdFailoverAction[];
  blocked: ColdFailoverBlocked[];
} {
  const actions: ColdFailoverAction[] = [];
  const blocked: ColdFailoverBlocked[] = [];

  for (const ch of channels) {
    if (!ch.switcherReported || ch.preferred === null) continue;
    const pref = ch.preferred;

    if (ch.currentActivation) {
      const activation = ch.currentActivation;
      const recoveryReached = pref.sessionHealthyStreak >= RECOVERY_DEBOUNCE_TICKS;
      const switcherOnCold = ch.switcherActiveUpstreamId === activation.placementId;

      if (activation.reason === 'delivery-slow' && !switcherOnCold && !recoveryReached) {
        if (ch.activeColdReady) {
          actions.push({
            type: 'switch',
            channelId: ch.channelId,
            slug: ch.slug,
            toPlacementId: activation.placementId,
          });
        }
        // else: cold not ready yet — wait
      } else if (recoveryReached) {
        if (switcherOnCold) {
          if (activation.reason === 'delivery-slow') {
            actions.push({
              type: 'switch-back',
              channelId: ch.channelId,
              slug: ch.slug,
              toPlacementId: pref.placementId,
            });
          }
          // else: wait for the switcher to move back autonomously
        } else {
          actions.push({ type: 'deactivate', channelId: ch.channelId, placementId: activation.placementId });
        }
      }
      continue;
    }

    // No currentActivation: determine whether a trigger fires, by precedence.
    const firingReason = TRIGGER_ORDER.find((r) => streakFor(pref, r) >= debounceFor(r));
    if (!firingReason || ch.otherHotHealthy) continue;

    const sortedCandidates = [...ch.candidates].sort(
      (a, b) => a.priority - b.priority || a.placementId.localeCompare(b.placementId),
    );
    const chosen = sortedCandidates.find((c) => passesGate(c, firingReason, pref));

    if (chosen) {
      actions.push({
        type: 'activate',
        channelId: ch.channelId,
        placementId: chosen.placementId,
        reason: firingReason,
        preferredPlacementId: pref.placementId,
        forceSwitch: firingReason === 'delivery-slow',
      });
    } else {
      const reason =
        sortedCandidates.length > 0
          ? sortedCandidates.map((c) => rejectionReason(c, firingReason)).join('; ')
          : 'no cold candidates available';
      blocked.push({ channelId: ch.channelId, slug: ch.slug, reason });
    }
  }

  return { actions, blocked };
}
