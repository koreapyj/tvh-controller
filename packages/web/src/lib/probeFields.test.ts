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

import { describe, expect, it } from 'vitest';
import type { NodeProbeSettings } from '@tvhc/shared';
import { buildProbesPayload, PROBE_FIELDS, PROBE_GROUPS, probesToVals } from './probeFields.js';

function settings(): NodeProbeSettings {
  return {
    liveness: { timeoutSeconds: 5, periodSeconds: 10, successThreshold: 2, failureThreshold: 3 },
    underspeed: { timeoutSeconds: 8, periodSeconds: 15, successThreshold: 2, failureThreshold: 3 },
    lag: { timeoutSeconds: 4.5, periodSeconds: 20, successThreshold: 2, failureThreshold: 5 },
    underrun: { minSpeed: 0.9, periodSeconds: 10, successThreshold: 2, failureThreshold: 3 },
  };
}

describe('PROBE_GROUPS / PROBE_FIELDS', () => {
  it('has one group per NodeProbeSettings key, in a stable display order', () => {
    expect(PROBE_GROUPS.map((g) => g.key)).toEqual(['liveness', 'underspeed', 'underrun', 'lag']);
  });

  it('liveness/underspeed/lag share the same field shape (timeout/period/success/failure)', () => {
    for (const key of ['liveness', 'underspeed', 'lag'] as const) {
      expect(PROBE_FIELDS[key].map((f) => f.key)).toEqual([
        'timeoutSeconds',
        'periodSeconds',
        'successThreshold',
        'failureThreshold',
      ]);
    }
  });

  it('underrun swaps timeout for minSpeed', () => {
    expect(PROBE_FIELDS.underrun.map((f) => f.key)).toEqual([
      'minSpeed',
      'periodSeconds',
      'successThreshold',
      'failureThreshold',
    ]);
  });
});

describe('probesToVals / buildProbesPayload round trip', () => {
  it('round-trips a full settings object exactly', () => {
    const cfg = settings();
    const built = buildProbesPayload(probesToVals(cfg));
    expect(built).toEqual({ ok: true, payload: cfg });
  });

  it('every field is stringified', () => {
    const vals = probesToVals(settings());
    expect(vals['liveness.timeoutSeconds']).toBe('5');
    expect(vals['underrun.minSpeed']).toBe('0.9');
    expect(vals['lag.failureThreshold']).toBe('5');
  });
});

describe('buildProbesPayload validation', () => {
  it('rejects a blank field, naming the group and field', () => {
    const vals = probesToVals(settings());
    vals['liveness.timeoutSeconds'] = '';
    expect(buildProbesPayload(vals)).toEqual({
      ok: false,
      error: 'Liveness Timeout (s) must be a positive number',
    });
  });

  it('probes are optional via zeros: period/thresholds accept 0 as disabled', () => {
    const vals = probesToVals(settings());
    vals['underspeed.periodSeconds'] = '0';
    vals['lag.failureThreshold'] = '0';
    vals['liveness.successThreshold'] = '0';
    const built = buildProbesPayload(vals);
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.payload.underspeed.periodSeconds).toBe(0);
      expect(built.payload.lag.failureThreshold).toBe(0);
      expect(built.payload.liveness.successThreshold).toBe(0);
    }
  });

  it('still rejects negative values and zero for timeout/minSpeed', () => {
    const vals = probesToVals(settings());
    vals['underspeed.periodSeconds'] = '-5';
    expect(buildProbesPayload(vals).ok).toBe(false);
    const vals2 = probesToVals(settings());
    vals2['liveness.timeoutSeconds'] = '0';
    expect(buildProbesPayload(vals2).ok).toBe(false);
    const vals3 = probesToVals(settings());
    vals3['underrun.minSpeed'] = '0';
    expect(buildProbesPayload(vals3).ok).toBe(false);
  });

  it('rejects a non-integer for int-kind fields', () => {
    const vals = probesToVals(settings());
    vals['lag.successThreshold'] = '2.5';
    expect(buildProbesPayload(vals)).toEqual({
      ok: false,
      error: 'Lag Success threshold must be a non-negative integer (0 = disabled)',
    });
  });

  it('allows a decimal for float-kind fields (timeout, minSpeed)', () => {
    const vals = probesToVals(settings());
    vals['underrun.minSpeed'] = '1.25';
    const built = buildProbesPayload(vals);
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.payload.underrun.minSpeed).toBe(1.25);
  });

  it('rejects a non-numeric value', () => {
    const vals = probesToVals(settings());
    vals['underrun.minSpeed'] = 'fast';
    expect(buildProbesPayload(vals).ok).toBe(false);
  });
});
