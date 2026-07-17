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

// Pure mapping from a placement's failover PlacementIndicator to the badge
// class the Restreamer page paints it with, plus the small derived bits
// (active checkmark, "does this channel have a live failover procedure")
// the channels table needs. No Svelte imports.

import type { ChannelFailoverStatus, PlacementIndicator, SessionState } from '@tvhc/shared';
import { sessionStateBadge } from './restreamFields.js';

/** placement fallback info used when the indicator itself is 'idle'/absent */
export interface PlacementFallback {
  enabled: boolean;
  sessionState: SessionState | null;
}

/**
 * Badge class for one placement: yellow while the failover procedure is
 * transitioning it (starting/awaiting-lag/switching/stopping), green once
 * 'active', gray once 'stopped'. 'idle' (not involved in any procedure) and
 * missing indicator (pre-upgrade payload) fall back to the session-state
 * coloring used before failover indicators existed: disabled placements are
 * neutral, a null session state is neutral, otherwise sessionStateBadge.
 */
export function placementBadgeClass(
  indicator: PlacementIndicator | undefined,
  fallback: PlacementFallback,
): string {
  if (
    indicator === 'starting' ||
    indicator === 'awaiting-lag' ||
    indicator === 'switching' ||
    indicator === 'stopping'
  ) {
    return 'warn';
  }
  if (indicator === 'active') return 'ok';
  if (indicator === 'stopped') return 'neutral';
  // indicator === 'idle' || indicator === undefined
  if (!fallback.enabled) return 'neutral';
  return fallback.sessionState === null ? 'neutral' : sessionStateBadge(fallback.sessionState);
}

/**
 * Whether to render the "this is the one viewers currently get" checkmark.
 * The failover procedure's own 'active' indicator is authoritative; when no
 * procedure has ever touched this placement (indicator absent/'idle') fall
 * back to the plain activePlacementId match, same as before indicators
 * existed — but only on a redundant channel (single-placement channels never
 * showed a checkmark, there's nothing to distinguish).
 */
export function showActiveCheck(
  indicator: PlacementIndicator | undefined,
  isActivePlacement: boolean,
  redundant: boolean,
): boolean {
  return (
    indicator === 'active' ||
    ((indicator === undefined || indicator === 'idle') && isActivePlacement && redundant)
  );
}

/**
 * Whether the Reset button renders at all. Hidden with no persisted failover
 * procedure/result (nothing to reset), and hidden during the terminal
 * 'draining' grace — the fail-back already finished, 'draining' is just
 * bookkeeping for the switcher's retained window, not a live procedure.
 */
export function resetButtonVisible(failover: ChannelFailoverStatus | null | undefined): boolean {
  if (failover == null) return false;
  if (failover.phase === 'draining') return false;
  return true;
}

/**
 * Reset button disable reason/tooltip: disabled while a reset procedure
 * itself is still running (nothing to reset — one is already in flight).
 * null everywhere else the button renders (enabled); the caller's own
 * in-flight-HTTP `busy` disabling is separate from this.
 */
export function resetDisabledReason(
  failover: ChannelFailoverStatus | null | undefined,
): string | null {
  if (failover?.triggerReason === 'reset' && failover.phase !== 'draining') {
    return 'reset in progress';
  }
  return null;
}
