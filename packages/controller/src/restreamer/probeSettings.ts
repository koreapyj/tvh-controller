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
 * Per-node probe threshold settings: defaults + row↔DTO mapping for
 * `restream_node_probes` (absent row ⇒ defaults; must match the column
 * defaults in migration 013) and validation for the PUT endpoint.
 */

import type { NodeProbeSettings, NodeSettings, ProbeThresholds } from '@tvhc/shared';
import type { RestreamNodeProbesTable } from '../db/schema.js';
import { httpError } from '../util/httpError.js';

export const NODE_PROBE_DEFAULTS: NodeProbeSettings = {
  liveness: { timeoutSeconds: 5, periodSeconds: 10, successThreshold: 2, failureThreshold: 3 },
  underspeed: { timeoutSeconds: 20, periodSeconds: 45, successThreshold: 2, failureThreshold: 3 },
  lag: { timeoutSeconds: 30, periodSeconds: 10, successThreshold: 3, failureThreshold: 3 },
};

type ProbeRow = Omit<RestreamNodeProbesTable, 'updated_at'>;

export function rowToProbeSettings(r: ProbeRow): NodeProbeSettings {
  return {
    liveness: {
      timeoutSeconds: r.liveness_timeout_seconds,
      periodSeconds: r.liveness_period_seconds,
      successThreshold: r.liveness_success_threshold,
      failureThreshold: r.liveness_failure_threshold,
    },
    underspeed: {
      timeoutSeconds: r.underspeed_timeout_seconds,
      periodSeconds: r.underspeed_period_seconds,
      successThreshold: r.underspeed_success_threshold,
      failureThreshold: r.underspeed_failure_threshold,
    },
    lag: {
      timeoutSeconds: r.lag_timeout_seconds,
      periodSeconds: r.lag_period_seconds,
      successThreshold: r.lag_success_threshold,
      failureThreshold: r.lag_failure_threshold,
    },
  };
}

export function probeSettingsToRow(
  instanceId: string,
  nodeId: string,
  s: NodeProbeSettings,
): ProbeRow {
  return {
    instance_id: instanceId,
    node_id: nodeId,
    liveness_timeout_seconds: s.liveness.timeoutSeconds,
    liveness_period_seconds: s.liveness.periodSeconds,
    liveness_success_threshold: s.liveness.successThreshold,
    liveness_failure_threshold: s.liveness.failureThreshold,
    underspeed_timeout_seconds: s.underspeed.timeoutSeconds,
    underspeed_period_seconds: s.underspeed.periodSeconds,
    underspeed_success_threshold: s.underspeed.successThreshold,
    underspeed_failure_threshold: s.underspeed.failureThreshold,
    lag_timeout_seconds: s.lag.timeoutSeconds,
    lag_period_seconds: s.lag.periodSeconds,
    lag_success_threshold: s.lag.successThreshold,
    lag_failure_threshold: s.lag.failureThreshold,
  };
}

function assertNumber(
  value: unknown,
  label: string,
  opts: { integer: boolean; allowZero: boolean },
): number {
  const n = typeof value === 'number' ? value : Number.NaN;
  const min = opts.allowZero ? 0 : Number.MIN_VALUE;
  if (!Number.isFinite(n) || n < min || (opts.integer && !Number.isInteger(n))) {
    const kind = opts.integer ? 'integer' : 'number';
    throw httpError(
      400,
      `${label} must be a ${opts.allowZero ? `non-negative ${kind} (0 = disabled)` : `positive ${kind}`}`,
    );
  }
  return n;
}

/**
 * Validate an untrusted PUT body into a full NodeProbeSettings.
 *
 * Probes are OPTIONAL via zero values — no separate enable flag:
 * - periodSeconds 0    = probe fully off (no fetches, no state, no badges)
 * - failureThreshold 0 = probe measures (badges / lag discovery) but never
 *   reports failed, so it never triggers a failover
 * - successThreshold 0 = a tripped probe recovers on the first success
 * timeoutSeconds stays strictly positive — it parameterizes the measurement
 * itself, not whether it runs.
 */
export function parseProbeSettings(raw: unknown): NodeProbeSettings {
  if (typeof raw !== 'object' || raw === null) throw httpError(400, 'body must be an object');
  const body = raw as Record<string, unknown>;
  const thresholds = (key: 'liveness' | 'underspeed' | 'lag'): ProbeThresholds => {
    const g = body[key];
    if (typeof g !== 'object' || g === null) throw httpError(400, `${key} must be an object`);
    const o = g as Record<string, unknown>;
    return {
      timeoutSeconds: assertNumber(o.timeoutSeconds, `${key}.timeoutSeconds`, {
        integer: false,
        allowZero: false,
      }),
      periodSeconds: assertNumber(o.periodSeconds, `${key}.periodSeconds`, {
        integer: false,
        allowZero: true,
      }),
      successThreshold: assertNumber(o.successThreshold, `${key}.successThreshold`, {
        integer: true,
        allowZero: true,
      }),
      failureThreshold: assertNumber(o.failureThreshold, `${key}.failureThreshold`, {
        integer: true,
        allowZero: true,
      }),
    };
  };
  return {
    liveness: thresholds('liveness'),
    underspeed: thresholds('underspeed'),
    lag: thresholds('lag'),
  };
}

/** validate an untrusted PUT body into a full NodeSettings; missing key is invalid (null must be explicit) */
export function parseNodeSettings(raw: unknown): NodeSettings {
  if (typeof raw !== 'object' || raw === null) throw httpError(400, 'body must be an object');
  const { maxSessions, initialDelaySec } = raw as Record<string, unknown>;
  if (maxSessions !== null && (typeof maxSessions !== 'number' || !Number.isInteger(maxSessions) || maxSessions < 0)) {
    throw httpError(400, 'maxSessions must be null or a non-negative integer');
  }
  if (
    initialDelaySec !== null &&
    (typeof initialDelaySec !== 'number' || !Number.isInteger(initialDelaySec) || initialDelaySec < 1)
  ) {
    throw httpError(400, 'initialDelaySec must be null or a positive integer');
  }
  return { maxSessions, initialDelaySec };
}
