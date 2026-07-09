/*
 * failoverPolicy.ts is PURE (no I/O, no clock) — selectTarget, the
 * planFailoverStep phase machine, placementIndicators, pastCommitPoint and
 * midProcedure.
 */

import { describe, expect, it } from 'vitest';
import {
  midProcedure,
  pastCommitPoint,
  placementIndicators,
  planFailoverStep,
  rejectionSummary,
  selectTarget,
  type FailoverCandidate,
  type FailoverStepInput,
} from '../src/restreamer/failoverPolicy.js';

function input(overrides: Partial<FailoverStepInput> = {}): FailoverStepInput {
  return {
    phase: 'bringing-up',
    suppressFrom: true,
    lagDiscovered: false,
    lagTimedOut: false,
    switchConfirmed: false,
    oldSessionGone: false,
    stopConfirmTimedOut: false,
    drainElapsed: false,
    ...overrides,
  };
}

describe('planFailoverStep — one case per transition row', () => {
  it('bringing-up -> advance awaiting-lag', () => {
    expect(planFailoverStep(input({ phase: 'bringing-up' }))).toEqual({
      action: 'advance',
      toPhase: 'awaiting-lag',
    });
  });

  it('awaiting-lag + lagDiscovered -> advance switch-ordered', () => {
    expect(planFailoverStep(input({ phase: 'awaiting-lag', lagDiscovered: true }))).toEqual({
      action: 'advance',
      toPhase: 'switch-ordered',
    });
  });

  it('awaiting-lag + lagTimedOut (not discovered) -> retarget', () => {
    expect(
      planFailoverStep(input({ phase: 'awaiting-lag', lagDiscovered: false, lagTimedOut: true })),
    ).toEqual({ action: 'retarget' });
  });

  it('awaiting-lag, neither discovered nor timed out -> wait', () => {
    expect(planFailoverStep(input({ phase: 'awaiting-lag' }))).toEqual({ action: 'wait' });
  });

  it('switch-ordered -> issue-switch', () => {
    expect(planFailoverStep(input({ phase: 'switch-ordered' }))).toEqual({ action: 'issue-switch' });
  });

  it('awaiting-switch-confirm + confirmed + suppressFrom -> advance stopping-old', () => {
    expect(
      planFailoverStep(
        input({ phase: 'awaiting-switch-confirm', switchConfirmed: true, suppressFrom: true }),
      ),
    ).toEqual({ action: 'advance', toPhase: 'stopping-old' });
  });

  it('awaiting-switch-confirm + confirmed + !suppressFrom -> advance complete', () => {
    expect(
      planFailoverStep(
        input({ phase: 'awaiting-switch-confirm', switchConfirmed: true, suppressFrom: false }),
      ),
    ).toEqual({ action: 'advance', toPhase: 'complete' });
  });

  it('awaiting-switch-confirm, not yet confirmed -> wait', () => {
    expect(
      planFailoverStep(input({ phase: 'awaiting-switch-confirm', switchConfirmed: false })),
    ).toEqual({ action: 'wait' });
  });

  it('stopping-old -> advance awaiting-stop-confirm', () => {
    expect(planFailoverStep(input({ phase: 'stopping-old' }))).toEqual({
      action: 'advance',
      toPhase: 'awaiting-stop-confirm',
    });
  });

  it('awaiting-stop-confirm + oldSessionGone -> advance complete', () => {
    expect(
      planFailoverStep(input({ phase: 'awaiting-stop-confirm', oldSessionGone: true })),
    ).toEqual({ action: 'advance', toPhase: 'complete' });
  });

  it('awaiting-stop-confirm + stopConfirmTimedOut (session not gone) -> advance complete', () => {
    expect(
      planFailoverStep(
        input({ phase: 'awaiting-stop-confirm', oldSessionGone: false, stopConfirmTimedOut: true }),
      ),
    ).toEqual({ action: 'advance', toPhase: 'complete' });
  });

  it('awaiting-stop-confirm, neither gone nor timed out -> wait', () => {
    expect(
      planFailoverStep(
        input({ phase: 'awaiting-stop-confirm', oldSessionGone: false, stopConfirmTimedOut: false }),
      ),
    ).toEqual({ action: 'wait' });
  });

  it('complete -> wait', () => {
    expect(planFailoverStep(input({ phase: 'complete' }))).toEqual({ action: 'wait' });
  });

  it('draining + drainElapsed -> delete-row', () => {
    expect(planFailoverStep(input({ phase: 'draining', drainElapsed: true }))).toEqual({
      action: 'delete-row',
    });
  });

  it('draining, not yet elapsed -> wait', () => {
    expect(planFailoverStep(input({ phase: 'draining', drainElapsed: false }))).toEqual({
      action: 'wait',
    });
  });
});

describe('selectTarget', () => {
  function cand(id: string, priority: number, ok = true, detail = 'nope'): FailoverCandidate {
    return { placementId: id, priority, mode: 'hot', admission: ok ? { ok: true } : { ok: false, detail } };
  }

  it('picks the lowest (priority, id) admissible candidate', () => {
    const candidates = [cand('b', 2), cand('a', 1), cand('c', 1)];
    expect(selectTarget(candidates, new Set())?.placementId).toBe('a');
  });

  it('breaks priority ties by placementId ascending', () => {
    const candidates = [cand('z', 1), cand('a', 1)];
    expect(selectTarget(candidates, new Set())?.placementId).toBe('a');
  });

  it('skips excluded placements', () => {
    const candidates = [cand('a', 1), cand('b', 2)];
    expect(selectTarget(candidates, new Set(['a']))?.placementId).toBe('b');
  });

  it('skips admission-refused candidates', () => {
    const candidates = [cand('a', 1, false), cand('b', 2, true)];
    expect(selectTarget(candidates, new Set())?.placementId).toBe('b');
  });

  it('returns null when nothing qualifies', () => {
    const candidates = [cand('a', 1, false)];
    expect(selectTarget(candidates, new Set())).toBeNull();
  });

  it('rejectionSummary: empty candidate list', () => {
    expect(rejectionSummary([], new Set())).toBe('no other placements to fail over to');
  });

  it('rejectionSummary: labels each candidate already-tried / eligible / refused', () => {
    const candidates = [cand('a', 1, false, 'node down'), cand('b', 2, true)];
    const summary = rejectionSummary(candidates, new Set(['b']));
    expect(summary).toContain('a: node down');
    expect(summary).toContain('b: already tried');
  });
});

describe('pastCommitPoint / midProcedure', () => {
  it('pastCommitPoint is true from switch-ordered through awaiting-stop-confirm', () => {
    expect(pastCommitPoint('bringing-up')).toBe(false);
    expect(pastCommitPoint('awaiting-lag')).toBe(false);
    expect(pastCommitPoint('switch-ordered')).toBe(true);
    expect(pastCommitPoint('awaiting-switch-confirm')).toBe(true);
    expect(pastCommitPoint('stopping-old')).toBe(true);
    expect(pastCommitPoint('awaiting-stop-confirm')).toBe(true);
    expect(pastCommitPoint('complete')).toBe(false);
    expect(pastCommitPoint('draining')).toBe(false);
  });

  it('midProcedure is true for every phase except complete and draining', () => {
    expect(midProcedure('bringing-up')).toBe(true);
    expect(midProcedure('awaiting-lag')).toBe(true);
    expect(midProcedure('switch-ordered')).toBe(true);
    expect(midProcedure('awaiting-switch-confirm')).toBe(true);
    expect(midProcedure('stopping-old')).toBe(true);
    expect(midProcedure('awaiting-stop-confirm')).toBe(true);
    expect(midProcedure('complete')).toBe(false);
    expect(midProcedure('draining')).toBe(false);
  });
});

describe('placementIndicators', () => {
  const TO = 'to-1';
  const FROM = 'from-1';

  function row(phase: Parameters<typeof placementIndicators>[0]['phase'], suppressFrom = true) {
    return { phase, fromPlacementId: FROM, toPlacementId: TO, suppressFrom };
  }

  it('bringing-up: to starting, from switching', () => {
    const m = placementIndicators(row('bringing-up'));
    expect(m.get(TO)).toBe('starting');
    expect(m.get(FROM)).toBe('switching');
  });

  it('awaiting-lag: to awaiting-lag, from switching', () => {
    const m = placementIndicators(row('awaiting-lag'));
    expect(m.get(TO)).toBe('awaiting-lag');
    expect(m.get(FROM)).toBe('switching');
  });

  it('switch-ordered and awaiting-switch-confirm: both switching', () => {
    for (const phase of ['switch-ordered', 'awaiting-switch-confirm'] as const) {
      const m = placementIndicators(row(phase));
      expect(m.get(TO)).toBe('switching');
      expect(m.get(FROM)).toBe('switching');
    }
  });

  it('stopping-old and awaiting-stop-confirm: to active, from stopping', () => {
    for (const phase of ['stopping-old', 'awaiting-stop-confirm'] as const) {
      const m = placementIndicators(row(phase));
      expect(m.get(TO)).toBe('active');
      expect(m.get(FROM)).toBe('stopping');
    }
  });

  it('complete + suppressFrom -> to active, from stopped', () => {
    const m = placementIndicators(row('complete', true));
    expect(m.get(TO)).toBe('active');
    expect(m.get(FROM)).toBe('stopped');
  });

  it('complete + !suppressFrom -> to active, from idle', () => {
    const m = placementIndicators(row('complete', false));
    expect(m.get(TO)).toBe('active');
    expect(m.get(FROM)).toBe('idle');
  });

  it('draining: to active, from stopped', () => {
    const m = placementIndicators(row('draining'));
    expect(m.get(TO)).toBe('active');
    expect(m.get(FROM)).toBe('stopped');
  });

  it('a null fromPlacementId never sets a from entry', () => {
    const m = placementIndicators({ phase: 'complete', fromPlacementId: null, toPlacementId: TO, suppressFrom: true });
    expect(m.has(FROM)).toBe(false);
    expect(m.get(TO)).toBe('active');
    expect(m.size).toBe(1);
  });

  it('placements not named in the map are absent (idle is a UI fallback, not a map entry)', () => {
    const m = placementIndicators(row('complete'));
    expect(m.has('some-other-placement')).toBe(false);
  });
});
