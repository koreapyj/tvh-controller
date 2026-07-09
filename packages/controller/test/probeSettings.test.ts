/*
 * probeSettings.ts: NODE_PROBE_DEFAULTS / row<->DTO mapping (pure) and
 * parseProbeSettings validation for the PUT endpoint.
 */

import { describe, expect, it } from 'vitest';
import type { NodeProbeSettings } from '@tvhc/shared';
import {
  NODE_PROBE_DEFAULTS,
  parseProbeSettings,
  probeSettingsToRow,
  rowToProbeSettings,
} from '../src/restreamer/probeSettings.js';

const SETTINGS: NodeProbeSettings = {
  liveness: { timeoutSeconds: 5, periodSeconds: 10, successThreshold: 2, failureThreshold: 3 },
  underspeed: { timeoutSeconds: 20, periodSeconds: 45, successThreshold: 2, failureThreshold: 3 },
  lag: { timeoutSeconds: 30, periodSeconds: 10, successThreshold: 3, failureThreshold: 3 },
};

describe('row <-> NodeProbeSettings round-trip', () => {
  it('probeSettingsToRow then rowToProbeSettings reproduces the input', () => {
    const row = probeSettingsToRow('zone1', 'n1', SETTINGS);
    expect(row).toMatchObject({ instance_id: 'zone1', node_id: 'n1' });
    expect(rowToProbeSettings(row)).toEqual(SETTINGS);
  });

  it('round-trips a non-default value in every field group', () => {
    const custom: NodeProbeSettings = {
      liveness: { timeoutSeconds: 3, periodSeconds: 7, successThreshold: 1, failureThreshold: 5 },
      underspeed: { timeoutSeconds: 15, periodSeconds: 30, successThreshold: 4, failureThreshold: 2 },
      lag: { timeoutSeconds: 60, periodSeconds: 20, successThreshold: 2, failureThreshold: 4 },
    };
    const row = probeSettingsToRow('zone2', 'n2', custom);
    expect(rowToProbeSettings(row)).toEqual(custom);
  });
});

describe('NODE_PROBE_DEFAULTS', () => {
  // must match migration 013_probe_settings's column defaults exactly
  // (013 also added underrun_* columns, dropped by 015_drop_underrun)
  it('matches the 013_probe_settings column defaults', () => {
    expect(NODE_PROBE_DEFAULTS).toEqual({
      liveness: { timeoutSeconds: 5, periodSeconds: 10, successThreshold: 2, failureThreshold: 3 },
      underspeed: { timeoutSeconds: 20, periodSeconds: 45, successThreshold: 2, failureThreshold: 3 },
      lag: { timeoutSeconds: 30, periodSeconds: 10, successThreshold: 3, failureThreshold: 3 },
    });
  });
});

describe('parseProbeSettings', () => {
  it('accepts a well-formed body and returns the full NodeProbeSettings', () => {
    expect(parseProbeSettings(SETTINGS)).toEqual(SETTINGS);
  });

  it('rejects a non-object body', () => {
    expect(() => parseProbeSettings(null)).toThrow(/body must be an object/);
    expect(() => parseProbeSettings('nope')).toThrow(/body must be an object/);
  });

  it('rejects a missing/non-object threshold group, naming the field', () => {
    const bad = { ...SETTINGS, liveness: undefined };
    expect(() => parseProbeSettings(bad)).toThrow(/liveness must be an object/);
  });

  it('rejects a non-positive timeoutSeconds, naming the field', () => {
    const bad = { ...SETTINGS, liveness: { ...SETTINGS.liveness, timeoutSeconds: 0 } };
    expect(() => parseProbeSettings(bad)).toThrow(/liveness\.timeoutSeconds must be a positive number/);
  });

  it('rejects a negative periodSeconds, naming the field', () => {
    const bad = { ...SETTINGS, underspeed: { ...SETTINGS.underspeed, periodSeconds: -1 } };
    expect(() => parseProbeSettings(bad)).toThrow(/underspeed\.periodSeconds must be a non-negative number/);
  });

  it('rejects a non-integer successThreshold, naming the field', () => {
    const bad = { ...SETTINGS, lag: { ...SETTINGS.lag, successThreshold: 1.5 } };
    expect(() => parseProbeSettings(bad)).toThrow(/lag\.successThreshold must be a non-negative integer/);
  });

  it('probes are optional via zeros: period/thresholds 0 are accepted as disabled', () => {
    const disabled = {
      ...SETTINGS,
      liveness: { timeoutSeconds: 5, periodSeconds: 0, successThreshold: 0, failureThreshold: 0 },
    };
    expect(parseProbeSettings(disabled)).toEqual(disabled);
  });

  it('rejects a negative failureThreshold, naming the field', () => {
    const bad = { ...SETTINGS, liveness: { ...SETTINGS.liveness, failureThreshold: -1 } };
    expect(() => parseProbeSettings(bad)).toThrow(/liveness\.failureThreshold must be a non-negative integer/);
  });

  it('an underrun key in the body is ignored (no error)', () => {
    const withUnderrun = { ...SETTINGS, underrun: { minSpeed: 0.98, periodSeconds: 15, successThreshold: 2, failureThreshold: 3 } };
    expect(parseProbeSettings(withUnderrun)).toEqual(SETTINGS);
  });

  it('rejects NaN/non-numeric values the same as missing ones', () => {
    const bad = { ...SETTINGS, lag: { ...SETTINGS.lag, timeoutSeconds: 'soon' } };
    expect(() => parseProbeSettings(bad)).toThrow(/lag\.timeoutSeconds must be a positive number/);
  });
});
