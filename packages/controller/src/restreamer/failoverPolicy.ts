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
 * Failover procedure policy (PURE — no I/O, no clock; successor to
 * coldFailoverPolicy.ts).
 *
 * One channel's failover is a persisted 7-phase procedure
 * (restream_failover_state.phase):
 *
 *   bringing-up → awaiting-lag → switch-ordered → awaiting-switch-confirm
 *     → stopping-old → awaiting-stop-confirm → complete [→ draining]
 *
 * The COMMIT POINT is issuing the switch: before it a procedure may retarget
 * or abort loss-free (viewers were never moved); after it, only forward.
 * The impure sync layer (failoverSync.ts) computes the per-tick inputs and
 * applies one step's side effects, looping while steps keep advancing so a
 * hot, lag-known target crosses several phases in a single tick.
 *
 * Procedures are strictly serialized GLOBALLY (one at a time): ffmpeg
 * bring-up causes transient CPU/GPU spikes that can destabilize other
 * sessions on a node, so at most one bring-up may ever be in flight.
 */

import type { FailoverPhase, PlacementIndicator } from '@tvhc/shared';

/** re-evaluation cadence of the failover orchestrator */
export const FAILOVER_TICK_MS = 3_000;
/** awaiting-lag budget per target; then retarget (loss-free — nothing switched yet) */
export const LAG_DISCOVERY_TIMEOUT_MS = 90_000;
/** awaiting-stop-confirm budget; then warn + complete (the doc already excludes the session) */
export const STOP_CONFIRM_TIMEOUT_MS = 120_000;
/** re-issue a not-yet-confirmed switch command after this long */
export const SWITCH_REISSUE_MS = 15_000;
/** re-trigger backoff when no eligible target exists while the trigger persists */
export const RETRIGGER_BACKOFF_MIN_MS = 30_000;
export const RETRIGGER_BACKOFF_MAX_MS = 600_000;

export interface FailoverCandidate {
  placementId: string;
  priority: number;
  mode: 'hot' | 'cold';
  admission: { ok: true } | { ok: false; detail: string };
}

/**
 * Next failover target: first candidate in (priority, id) order that passes
 * admission and is not excluded (already tried / currently active / the
 * failed placement).
 */
export function selectTarget(
  candidates: FailoverCandidate[],
  exclude: ReadonlySet<string>,
): FailoverCandidate | null {
  const sorted = [...candidates].sort(
    (a, b) => a.priority - b.priority || a.placementId.localeCompare(b.placementId),
  );
  return sorted.find((c) => !exclude.has(c.placementId) && c.admission.ok) ?? null;
}

/** aggregate human-readable reason when no candidate was eligible */
export function rejectionSummary(
  candidates: FailoverCandidate[],
  exclude: ReadonlySet<string>,
): string {
  if (!candidates.length) return 'no other placements to fail over to';
  const parts = candidates.map((c) => {
    if (exclude.has(c.placementId)) return `${c.placementId}: already tried`;
    return c.admission.ok ? `${c.placementId}: eligible` : `${c.placementId}: ${c.admission.detail}`;
  });
  return parts.join('; ');
}

export interface FailoverStepInput {
  phase: FailoverPhase;
  /** the outgoing placement's encode is to be stopped once the switch confirmed */
  suppressFrom: boolean;
  /** target's lag probe has a measurement at/below the lag threshold */
  lagDiscovered: boolean;
  /** awaiting-lag exceeded LAG_DISCOVERY_TIMEOUT_MS (anchored at phase entry) */
  lagTimedOut: boolean;
  /** switcher status reports activeUpstreamId === to_placement_id */
  switchConfirmed: boolean;
  /** from placement's node no longer reports a session under this slug */
  oldSessionGone: boolean;
  /** awaiting-stop-confirm exceeded STOP_CONFIRM_TIMEOUT_MS */
  stopConfirmTimedOut: boolean;
  /** draining row's drain_until has passed */
  drainElapsed: boolean;
}

export type FailoverStep =
  /** persist toPhase and keep stepping */
  | { action: 'advance'; toPhase: FailoverPhase }
  /** order the switcher switch now; on success advance to awaiting-switch-confirm */
  | { action: 'issue-switch' }
  /** awaiting-lag gave up on this target — pick the next candidate or abort */
  | { action: 'retarget' }
  /** terminal draining grace elapsed — delete the row */
  | { action: 'delete-row' }
  /** nothing to do this tick */
  | { action: 'wait' };

/** one pure state-machine step for the ACTIVE procedure (see module doc) */
export function planFailoverStep(input: FailoverStepInput): FailoverStep {
  switch (input.phase) {
    case 'bringing-up':
      // the sync layer advances here only after its bring-up push succeeded;
      // a failed push retargets directly (a push error is already conclusive)
      return { action: 'advance', toPhase: 'awaiting-lag' };
    case 'awaiting-lag':
      if (input.lagDiscovered) return { action: 'advance', toPhase: 'switch-ordered' };
      if (input.lagTimedOut) return { action: 'retarget' };
      return { action: 'wait' };
    case 'switch-ordered':
      return { action: 'issue-switch' };
    case 'awaiting-switch-confirm':
      if (input.switchConfirmed) {
        return input.suppressFrom
          ? { action: 'advance', toPhase: 'stopping-old' }
          : { action: 'advance', toPhase: 'complete' };
      }
      return { action: 'wait' };
    case 'stopping-old':
      // entering this phase re-pushed the from node (doc now excludes it)
      return { action: 'advance', toPhase: 'awaiting-stop-confirm' };
    case 'awaiting-stop-confirm':
      if (input.oldSessionGone || input.stopConfirmTimedOut) {
        return { action: 'advance', toPhase: 'complete' };
      }
      return { action: 'wait' };
    case 'complete':
      return { action: 'wait' };
    case 'draining':
      return input.drainElapsed ? { action: 'delete-row' } : { action: 'wait' };
  }
}

/** phases at/after the commit point — a reset must reject instead of revert */
export function pastCommitPoint(phase: FailoverPhase): boolean {
  return (
    phase === 'switch-ordered' ||
    phase === 'awaiting-switch-confirm' ||
    phase === 'stopping-old' ||
    phase === 'awaiting-stop-confirm'
  );
}

/** phases where the procedure is still in flight (an orchestrator must own it) */
export function midProcedure(phase: FailoverPhase): boolean {
  return phase !== 'complete' && phase !== 'draining';
}

/**
 * Per-placement UI indicator for one failover row (the plan's mapping table).
 * Placements not named here are 'idle' — session-state fallback in the UI.
 */
export function placementIndicators(row: {
  phase: FailoverPhase;
  fromPlacementId: string | null;
  toPlacementId: string;
  suppressFrom: boolean;
}): Map<string, PlacementIndicator> {
  const out = new Map<string, PlacementIndicator>();
  const setFrom = (v: PlacementIndicator): void => {
    if (row.fromPlacementId) out.set(row.fromPlacementId, v);
  };
  switch (row.phase) {
    case 'bringing-up':
      out.set(row.toPlacementId, 'starting');
      setFrom('switching');
      break;
    case 'awaiting-lag':
      out.set(row.toPlacementId, 'awaiting-lag');
      setFrom('switching');
      break;
    case 'switch-ordered':
    case 'awaiting-switch-confirm':
      out.set(row.toPlacementId, 'switching');
      setFrom('switching');
      break;
    case 'stopping-old':
    case 'awaiting-stop-confirm':
      out.set(row.toPlacementId, 'active');
      setFrom('stopping');
      break;
    case 'complete':
      out.set(row.toPlacementId, 'active');
      setFrom(row.suppressFrom ? 'stopped' : 'idle');
      break;
    case 'draining':
      out.set(row.toPlacementId, 'active');
      setFrom('stopped');
      break;
  }
  return out;
}
