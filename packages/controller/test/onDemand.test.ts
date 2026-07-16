/*
 * OnDemandEngine unit tests: pure in-memory engine, deps fully faked
 * (requestFailover/releaseOnDemand/events as vi.fn()s), an injected clock —
 * no DB, no service, no switcher hub.
 */

import { describe, expect, it, vi } from 'vitest';
import { ON_DEMAND_INITIAL_DELAY_DEFAULT_SEC } from '@tvhc/shared';
import { OnDemandEngine, type OnDemandChannelTick } from '../src/restreamer/onDemand.js';
import type { DemandEvent } from '../src/restreamer/switcherHubTypes.js';

interface LoggedEvent {
  type: 'normal' | 'warning';
  service: string;
  source: string;
  message: string;
}

function makeHarness() {
  let ms = Date.parse('2026-01-01T00:00:00.000Z');
  const logs: LoggedEvent[] = [];
  const requestFailover = vi.fn(
    async (_channelId: string, _opts: { reason: 'on-demand'; detail: string }) =>
      ({ ok: true }) as const,
  );
  const releaseOnDemand = vi.fn(async (_channelId: string) => {});
  const engine = new OnDemandEngine({
    requestFailover,
    releaseOnDemand,
    events: { log: (e) => logs.push(e) },
    now: () => ms,
  });
  return {
    engine,
    requestFailover,
    releaseOnDemand,
    logs,
    get nowMs() {
      return ms;
    },
    advance(deltaMs: number) {
      ms += deltaMs;
    },
    set(atMs: number) {
      ms = atMs;
    },
    iso(atMs: number): string {
      return new Date(atMs).toISOString();
    },
    demand(slug: string, kind: DemandEvent['kind'], atMs: number): DemandEvent {
      return { slug, kind, at: new Date(atMs).toISOString() };
    },
  };
}

function ch(overrides: Partial<OnDemandChannelTick> = {}): OnDemandChannelTick {
  return {
    channelId: 'c1',
    slug: 'bbb',
    allCold: true,
    hasRow: false,
    rowPhase: null,
    segmentSeconds: 5,
    initialDelaySec: 30,
    ...overrides,
  };
}

describe('OnDemandEngine: start', () => {
  it('requests a failover (reason on-demand) once recent demand is within the initial-delay window', async () => {
    const h = makeHarness();
    h.engine.noteDemand([h.demand('bbb', 'master', h.nowMs)]);
    await h.engine.tick([ch({ hasRow: false })]);
    expect(h.requestFailover).toHaveBeenCalledTimes(1);
    expect(h.requestFailover).toHaveBeenCalledWith('c1', { reason: 'on-demand', detail: 'viewer demand' });
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({ type: 'normal', service: 'restreamer', source: 'controller' });
    expect(h.logs[0]!.message).toContain('bbb');
  });

  it('dedups a start request across ticks while no row has landed yet (start guard)', async () => {
    const h = makeHarness();
    h.engine.noteDemand([h.demand('bbb', 'master', h.nowMs)]);
    await h.engine.tick([ch({ hasRow: false })]);
    await h.engine.tick([ch({ hasRow: false })]);
    await h.engine.tick([ch({ hasRow: false })]);
    expect(h.requestFailover).toHaveBeenCalledTimes(1);
  });

  it('never requests a start with no demand recorded — deadline stays unreachable', async () => {
    const h = makeHarness();
    await h.engine.tick([ch({ hasRow: false })]);
    expect(h.requestFailover).not.toHaveBeenCalled();
  });

  it('ignores unparseable demand timestamps', async () => {
    const h = makeHarness();
    h.engine.noteDemand([{ slug: 'bbb', kind: 'master', at: 'not-a-date' }]);
    await h.engine.tick([ch({ hasRow: false })]);
    expect(h.requestFailover).not.toHaveBeenCalled();
  });

  it('max-merges repeated demand per slug/kind — an out-of-order older event never regresses the deadline', async () => {
    const h = makeHarness();
    const t0 = h.nowMs;
    h.engine.noteDemand([h.demand('bbb', 'master', t0 + 10_000)]);
    h.engine.noteDemand([h.demand('bbb', 'master', t0)]); // older, arrives second — must not win
    h.set(t0 + 10_000 + ON_DEMAND_INITIAL_DELAY_DEFAULT_SEC * 1000 - 1);
    await h.engine.tick([ch({ hasRow: false, initialDelaySec: null })]);
    expect(h.requestFailover).toHaveBeenCalledTimes(1);
  });

  it('ignores a channel with allCold=false entirely — never starts, never stops', async () => {
    const h = makeHarness();
    h.engine.noteDemand([h.demand('bbb', 'master', h.nowMs)]);
    await h.engine.tick([ch({ allCold: false, hasRow: false })]);
    expect(h.requestFailover).not.toHaveBeenCalled();
    h.advance(60_000);
    await h.engine.tick([ch({ allCold: false, hasRow: true, rowPhase: 'complete' })]);
    expect(h.releaseOnDemand).not.toHaveBeenCalled();
  });

  it('defaults initialDelaySec to ON_DEMAND_INITIAL_DELAY_DEFAULT_SEC when null', async () => {
    const h = makeHarness();
    const t0 = h.nowMs;
    h.engine.noteDemand([h.demand('bbb', 'master', t0)]);
    h.set(t0 + ON_DEMAND_INITIAL_DELAY_DEFAULT_SEC * 1000 - 1_000);
    await h.engine.tick([ch({ hasRow: false, initialDelaySec: null })]);
    expect(h.requestFailover).toHaveBeenCalledTimes(1);
  });

  it('does not start once the default 30s window has elapsed with no further demand', async () => {
    const h = makeHarness();
    const t0 = h.nowMs;
    h.engine.noteDemand([h.demand('bbb', 'master', t0)]);
    h.set(t0 + ON_DEMAND_INITIAL_DELAY_DEFAULT_SEC * 1000 + 1_000);
    await h.engine.tick([ch({ hasRow: false, initialDelaySec: null })]);
    expect(h.requestFailover).not.toHaveBeenCalled();
  });

  it('clears the start guard on a failed requestFailover so the next tick retries, and logs a warning', async () => {
    const h = makeHarness();
    h.requestFailover.mockRejectedValueOnce(new Error('boom'));
    h.engine.noteDemand([h.demand('bbb', 'master', h.nowMs)]);
    await h.engine.tick([ch({ hasRow: false })]);
    expect(h.requestFailover).toHaveBeenCalledTimes(1);
    expect(h.logs.some((l) => l.type === 'warning' && l.message.includes('boom'))).toBe(true);

    await h.engine.tick([ch({ hasRow: false })]);
    expect(h.requestFailover).toHaveBeenCalledTimes(2);
  });

  it('clears the start guard once hasRow is observed, allowing a later re-request', async () => {
    const h = makeHarness();
    h.engine.noteDemand([h.demand('bbb', 'master', h.nowMs)]);
    await h.engine.tick([ch({ hasRow: false })]);
    expect(h.requestFailover).toHaveBeenCalledTimes(1);
    await h.engine.tick([ch({ hasRow: false })]); // still no row — guard still set
    expect(h.requestFailover).toHaveBeenCalledTimes(1);

    await h.engine.tick([ch({ hasRow: true, rowPhase: 'bringing-up' })]); // row landed — guard cleared
    await h.engine.tick([ch({ hasRow: false })]); // row gone again, demand still live — allowed to retry
    expect(h.requestFailover).toHaveBeenCalledTimes(2);
  });
});

describe('OnDemandEngine: stop', () => {
  it('releases and logs once the deadline passes on a complete row', async () => {
    const h = makeHarness();
    h.engine.noteDemand([h.demand('bbb', 'master', h.nowMs)]);
    h.advance(30_001);
    await h.engine.tick([ch({ hasRow: true, rowPhase: 'complete' })]);
    expect(h.releaseOnDemand).toHaveBeenCalledWith('c1');
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({ type: 'normal', service: 'restreamer', source: 'controller' });
    expect(h.logs[0]!.message).toContain('bbb');
  });

  it('does not release before the deadline', async () => {
    const h = makeHarness();
    h.engine.noteDemand([h.demand('bbb', 'master', h.nowMs)]);
    h.advance(29_000);
    await h.engine.tick([ch({ hasRow: true, rowPhase: 'complete' })]);
    expect(h.releaseOnDemand).not.toHaveBeenCalled();
  });

  it('a recent media fetch extends the keep-alive deadline past what the master fetch alone would allow', async () => {
    const h = makeHarness();
    const t0 = h.nowMs;
    h.engine.noteDemand([h.demand('bbb', 'master', t0)]);
    h.advance(3_000);
    h.engine.noteDemand([h.demand('bbb', 'media', h.nowMs)]);

    // master alone (initialDelaySec=5s) would have expired by t0+5000
    h.set(t0 + 6_000);
    await h.engine.tick([ch({ hasRow: true, rowPhase: 'complete', initialDelaySec: 5, segmentSeconds: 5 })]);
    expect(h.releaseOnDemand).not.toHaveBeenCalled();

    // media deadline = (t0+3000) + 2*5000 = t0+13000
    h.set(t0 + 13_001);
    await h.engine.tick([ch({ hasRow: true, rowPhase: 'complete', initialDelaySec: 5, segmentSeconds: 5 })]);
    expect(h.releaseOnDemand).toHaveBeenCalledTimes(1);
  });

  it('never releases a mid-procedure row, however stale the demand', async () => {
    const h = makeHarness();
    h.engine.noteDemand([h.demand('bbb', 'master', h.nowMs)]);
    h.advance(60_000);
    for (const rowPhase of ['bringing-up', 'switch-ordered', 'awaiting-stop-confirm', 'stopping-old', 'draining']) {
      await h.engine.tick([ch({ hasRow: true, rowPhase })]);
    }
    expect(h.releaseOnDemand).not.toHaveBeenCalled();
  });

  it('seedActive arms the grace window so a just-restarted active channel is not released before any demand replays', async () => {
    const h = makeHarness();
    h.engine.seedActive(['bbb']);
    await h.engine.tick([ch({ hasRow: true, rowPhase: 'complete', initialDelaySec: 30 })]);
    expect(h.releaseOnDemand).not.toHaveBeenCalled();

    h.advance(30_001);
    await h.engine.tick([ch({ hasRow: true, rowPhase: 'complete', initialDelaySec: 30 })]);
    expect(h.releaseOnDemand).toHaveBeenCalledTimes(1);
  });
});

describe('OnDemandEngine: stopDeadlineMs', () => {
  it('returns null for a channel never seen with a row', async () => {
    const h = makeHarness();
    expect(h.engine.stopDeadlineMs('c1')).toBeNull();
    await h.engine.tick([ch({ hasRow: false })]);
    expect(h.engine.stopDeadlineMs('c1')).toBeNull();
  });

  it('returns the tick-computed deadline for an active all-cold channel with a row, extends on newer demand + re-tick', async () => {
    const h = makeHarness();
    const t0 = h.nowMs;
    h.engine.noteDemand([h.demand('bbb', 'master', t0)]);
    await h.engine.tick([ch({ hasRow: true, rowPhase: 'bringing-up', initialDelaySec: 30 })]);
    expect(h.engine.stopDeadlineMs('c1')).toBe(t0 + 30_000);

    h.advance(5_000);
    h.engine.noteDemand([h.demand('bbb', 'master', h.nowMs)]);
    await h.engine.tick([ch({ hasRow: true, rowPhase: 'bringing-up', initialDelaySec: 30 })]);
    expect(h.engine.stopDeadlineMs('c1')).toBe(t0 + 5_000 + 30_000);
  });

  it('clears once the row disappears', async () => {
    const h = makeHarness();
    h.engine.noteDemand([h.demand('bbb', 'master', h.nowMs)]);
    await h.engine.tick([ch({ hasRow: true, rowPhase: 'complete', initialDelaySec: 30 })]);
    expect(h.engine.stopDeadlineMs('c1')).not.toBeNull();

    h.advance(30_001); // past the deadline — no spurious restart once the row vanishes
    await h.engine.tick([ch({ hasRow: false })]);
    expect(h.engine.stopDeadlineMs('c1')).toBeNull();
    expect(h.requestFailover).not.toHaveBeenCalled();
  });
});
