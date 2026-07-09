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

// Pure field layer for ProbeConfigModal (the profileFields/ruleFields
// pattern): one group per probe (liveness/underspeed/underrun/lag), each with
// its own threshold fields, and the string<->NodeProbeSettings conversions.
// No Svelte imports — everything here is node-testable.

import type { NodeProbeSettings, ProbeName } from '@tvhc/shared';

export interface ProbeGroupSpec {
  key: ProbeName;
  label: string;
  help: string;
}

/** display order + labels for the 4 probe groups (mirrors NodeProbeSettings) */
export const PROBE_GROUPS: ProbeGroupSpec[] = [
  { key: 'liveness', label: 'Liveness', help: 'delivery-path reachability' },
  { key: 'underspeed', label: 'Underspeed', help: 'segment download vs realtime' },
  { key: 'underrun', label: 'Underrun', help: 'ffmpeg encode speed' },
  { key: 'lag', label: 'Lag', help: 'playlist wall-clock lag' },
];

export interface ProbeFieldSpec {
  /** key within the group's threshold object (ProbeThresholds/UnderrunThresholds) */
  key: string;
  label: string;
  /** 'int' = integer only; 'float' = number (decimals ok) */
  kind: 'int' | 'float';
  /**
   * probes are OPTIONAL via zeros: period 0 = probe off, failure threshold
   * 0 = measure but never trigger, success threshold 0 = recover on first
   * success. timeout/minSpeed parameterize the measurement and stay positive.
   */
  allowZero?: boolean;
}

const COMMON_TAIL: ProbeFieldSpec[] = [
  { key: 'periodSeconds', label: 'Period (s, 0 = off)', kind: 'int', allowZero: true },
  { key: 'successThreshold', label: 'Success threshold', kind: 'int', allowZero: true },
  { key: 'failureThreshold', label: 'Failure threshold (0 = never trigger)', kind: 'int', allowZero: true },
];

/** per-group field specs — liveness/underspeed/lag share ProbeThresholds' shape */
export const PROBE_FIELDS: Record<ProbeName, ProbeFieldSpec[]> = {
  liveness: [{ key: 'timeoutSeconds', label: 'Timeout (s)', kind: 'float' }, ...COMMON_TAIL],
  underspeed: [{ key: 'timeoutSeconds', label: 'Timeout (s)', kind: 'float' }, ...COMMON_TAIL],
  lag: [{ key: 'timeoutSeconds', label: 'Timeout (s)', kind: 'float' }, ...COMMON_TAIL],
  underrun: [{ key: 'minSpeed', label: 'Min speed (×)', kind: 'float' }, ...COMMON_TAIL],
};

/** form value key for one group+field pair (group keys collide otherwise: periodSeconds etc.) */
function valKey(group: ProbeName, field: string): string {
  return `${group}.${field}`;
}

/** NodeProbeSettings -> one form string per group/field, keyed "group.field" */
export function probesToVals(cfg: NodeProbeSettings): Record<string, string> {
  const vals: Record<string, string> = {};
  for (const group of PROBE_GROUPS) {
    const thresholds = cfg[group.key] as unknown as Record<string, number>;
    for (const f of PROBE_FIELDS[group.key]) {
      vals[valKey(group.key, f.key)] = String(thresholds[f.key]);
    }
  }
  return vals;
}

export type BuildProbesResult = { ok: true; payload: NodeProbeSettings } | { ok: false; error: string };

/** '' or an out-of-range/non-matching-kind value -> undefined (error) */
function parseField(raw: string, kind: 'int' | 'float', allowZero: boolean): number | undefined {
  const t = raw.trim();
  if (t === '') return undefined;
  const n = Number(t);
  if (Number.isNaN(n) || (allowZero ? n < 0 : n <= 0)) return undefined;
  if (kind === 'int' && !Number.isInteger(n)) return undefined;
  return n;
}

/** form strings -> NodeProbeSettings; zero-allowing fields make probes optional */
export function buildProbesPayload(vals: Record<string, string>): BuildProbesResult {
  const out: Record<string, Record<string, number>> = {};
  for (const group of PROBE_GROUPS) {
    const obj: Record<string, number> = {};
    for (const f of PROBE_FIELDS[group.key]) {
      const raw = vals[valKey(group.key, f.key)] ?? '';
      const n = parseField(raw, f.kind, f.allowZero ?? false);
      if (n === undefined) {
        const kindLabel = f.kind === 'int' ? 'integer' : 'number';
        const rangeLabel = f.allowZero ? `a non-negative ${kindLabel} (0 = disabled)` : `a positive ${kindLabel}`;
        return { ok: false, error: `${group.label} ${f.label} must be ${rangeLabel}` };
      }
      obj[f.key] = n;
    }
    out[group.key] = obj;
  }
  return { ok: true, payload: out as unknown as NodeProbeSettings };
}
