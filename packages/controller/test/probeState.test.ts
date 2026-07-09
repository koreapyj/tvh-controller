/*
 * probeState.ts is PURE (no I/O, no clock — `now` is passed in): k8s-style
 * sticky failure/success counters shared by every probe kind.
 */

import { describe, expect, it } from 'vitest';
import { applyProbeResult, toProbeStatus, type ProbeCounterState } from '../src/restreamer/probeState.js';

const THRESH = { successThreshold: 2, failureThreshold: 3 };
const T0 = new Date('2026-01-01T00:00:00.000Z');

describe('applyProbeResult', () => {
  it('trips failed only once consecutive failures reach failureThreshold', () => {
    let s: ProbeCounterState | undefined;
    s = applyProbeResult(s, 'fail', THRESH, T0, 'd1');
    expect(s).toMatchObject({ consecutiveFailures: 1, failed: false });
    s = applyProbeResult(s, 'fail', THRESH, T0, 'd2');
    expect(s).toMatchObject({ consecutiveFailures: 2, failed: false });
    s = applyProbeResult(s, 'fail', THRESH, T0, 'd3');
    expect(s).toMatchObject({ consecutiveFailures: 3, failed: true });
  });

  it('stays failed through a below-threshold success streak (sticky)', () => {
    let s: ProbeCounterState | undefined;
    for (let i = 0; i < 3; i++) s = applyProbeResult(s, 'fail', THRESH, T0, 'fail');
    expect(s!.failed).toBe(true);
    // successThreshold is 2 — one success must not clear it yet
    s = applyProbeResult(s, 'ok', THRESH, T0, 'ok1');
    expect(s).toMatchObject({ failed: true, consecutiveSuccesses: 1, consecutiveFailures: 0 });
  });

  it('clears after successThreshold consecutive successes', () => {
    let s: ProbeCounterState | undefined;
    for (let i = 0; i < 3; i++) s = applyProbeResult(s, 'fail', THRESH, T0, 'fail');
    s = applyProbeResult(s, 'ok', THRESH, T0, 'ok1');
    expect(s!.failed).toBe(true);
    s = applyProbeResult(s, 'ok', THRESH, T0, 'ok2');
    expect(s).toMatchObject({ failed: false, consecutiveSuccesses: 2 });
  });

  it('counters reset on a result flip', () => {
    let s: ProbeCounterState | undefined;
    s = applyProbeResult(s, 'ok', THRESH, T0, 'ok');
    s = applyProbeResult(s, 'ok', THRESH, T0, 'ok');
    expect(s).toMatchObject({ consecutiveSuccesses: 2, consecutiveFailures: 0 });
    s = applyProbeResult(s, 'fail', THRESH, T0, 'fail');
    expect(s).toMatchObject({ consecutiveFailures: 1, consecutiveSuccesses: 0, failed: false });

    s = applyProbeResult(s, 'ok', THRESH, T0, 'ok');
    expect(s).toMatchObject({ consecutiveSuccesses: 1, consecutiveFailures: 0 });
  });

  it('a never-failed streak of successes never trips failed', () => {
    let s: ProbeCounterState | undefined;
    for (let i = 0; i < 5; i++) s = applyProbeResult(s, 'ok', THRESH, T0, 'ok');
    expect(s!.failed).toBe(false);
  });

  it('carries lastResult/lastCheckedAt/detail through', () => {
    const s = applyProbeResult(undefined, 'fail', THRESH, T0, 'boom');
    expect(s).toMatchObject({ lastResult: 'fail', lastCheckedAt: T0.toISOString(), detail: 'boom' });
  });

  it('failureThreshold 0 = trigger disabled: never trips, still counts failures', () => {
    const off = { successThreshold: 2, failureThreshold: 0 };
    let s: ProbeCounterState | undefined;
    for (let i = 0; i < 10; i++) s = applyProbeResult(s, 'fail', off, T0, 'down');
    expect(s!.failed).toBe(false); // never triggers a failover
    expect(s!.consecutiveFailures).toBe(10); // but the badge counter still runs
  });

  it('zeroing failureThreshold unsticks an already-tripped state on the next result', () => {
    let s: ProbeCounterState | undefined;
    for (let i = 0; i < 3; i++) s = applyProbeResult(s, 'fail', THRESH, T0, 'down');
    expect(s!.failed).toBe(true);
    const off = { successThreshold: 2, failureThreshold: 0 };
    s = applyProbeResult(s, 'fail', off, T0, 'down');
    expect(s!.failed).toBe(false);
  });

  it('successThreshold 0 clears a tripped state on the first success', () => {
    const fast = { successThreshold: 0, failureThreshold: 3 };
    let s: ProbeCounterState | undefined;
    for (let i = 0; i < 3; i++) s = applyProbeResult(s, 'fail', fast, T0, 'down');
    expect(s!.failed).toBe(true);
    s = applyProbeResult(s, 'ok', fast, T0, 'up');
    expect(s!.failed).toBe(false);
  });
});

describe('toProbeStatus', () => {
  it('undefined state maps to the all-clear wire shape', () => {
    expect(toProbeStatus(undefined)).toEqual({
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      failed: false,
      lastResult: null,
      lastCheckedAt: null,
      detail: null,
    });
  });

  it('an existing state maps its fields through verbatim', () => {
    const s = applyProbeResult(undefined, 'fail', THRESH, T0, 'boom');
    expect(toProbeStatus(s)).toEqual({
      consecutiveFailures: 1,
      consecutiveSuccesses: 0,
      failed: false,
      lastResult: 'fail',
      lastCheckedAt: T0.toISOString(),
      detail: 'boom',
    });
  });
});
