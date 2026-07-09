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
 * PURE probe counter semantics (k8s-style, sticky): `failed` trips once
 * failureThreshold CONSECUTIVE failures accumulate and clears only after
 * successThreshold CONSECUTIVE successes. The raw counters are exposed so the
 * UI can show warning badges below the threshold.
 */

import type { ProbeStatus } from '@tvhc/shared';

export interface ProbeCounterState {
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  failed: boolean;
  lastResult: 'ok' | 'fail';
  /** ISO 8601 */
  lastCheckedAt: string;
  detail: string;
}

export function applyProbeResult(
  prev: ProbeCounterState | undefined,
  result: 'ok' | 'fail',
  thresholds: { successThreshold: number; failureThreshold: number },
  now: Date,
  detail: string,
): ProbeCounterState {
  // failureThreshold 0 = trigger disabled: the probe still measures (badges,
  // lag discovery) but NEVER reports failed — including a previously-stuck
  // failed state, which unsticks the moment the threshold is zeroed
  const trips = thresholds.failureThreshold > 0;
  if (result === 'fail') {
    const consecutiveFailures = (prev?.lastResult === 'fail' ? prev.consecutiveFailures : 0) + 1;
    return {
      consecutiveFailures,
      consecutiveSuccesses: 0,
      failed: trips && ((prev?.failed ?? false) || consecutiveFailures >= thresholds.failureThreshold),
      lastResult: 'fail',
      lastCheckedAt: now.toISOString(),
      detail,
    };
  }
  const consecutiveSuccesses = (prev?.lastResult === 'ok' ? prev.consecutiveSuccesses : 0) + 1;
  return {
    consecutiveFailures: 0,
    consecutiveSuccesses,
    // sticky: once tripped, only a full success streak clears it
    // (successThreshold 0 clears on the first success)
    failed: trips && (prev?.failed ?? false) && consecutiveSuccesses < thresholds.successThreshold,
    lastResult: 'ok',
    lastCheckedAt: now.toISOString(),
    detail,
  };
}

/** wire shape for a state that may not exist yet */
export function toProbeStatus(s: ProbeCounterState | undefined): ProbeStatus {
  return {
    consecutiveFailures: s?.consecutiveFailures ?? 0,
    consecutiveSuccesses: s?.consecutiveSuccesses ?? 0,
    failed: s?.failed ?? false,
    lastResult: s?.lastResult ?? null,
    lastCheckedAt: s?.lastCheckedAt ?? null,
    detail: s?.detail ?? null,
  };
}
