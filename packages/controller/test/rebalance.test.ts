/*
 * Pure rebalance-policy tests: planRebalance over a fake clock — sticky
 * window, hysteresis, greedy single-move selection, health/budget rules and
 * deterministic tie-breaking. No I/O.
 */

import { describe, expect, it } from 'vitest';
import type { PipelineParams } from '@tvhc/shared';
import {
  DEFAULT_HYSTERESIS,
  DEFAULT_STICKY_MS,
  expectedChannelMbps,
  parseBitrateMbps,
  planRebalance,
  type RebalanceChannelInput,
  type RebalanceNodeInput,
  type RebalanceUpstream,
} from '../src/restreamer/rebalance.js';

const NOW = new Date('2026-07-06T12:00:00Z');
/** ISO timestamp `minutes` before NOW */
function ago(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

function up(
  placementId: string,
  nodeId: string,
  opts: Partial<RebalanceUpstream> = {},
): RebalanceUpstream {
  return {
    placementId,
    instanceId: 'zone1',
    nodeId,
    healthy: true,
    priority: 1,
    ...opts,
  };
}

/** channel active on its first upstream unless said otherwise */
function chan(
  slug: string,
  mbps: number,
  upstreams: RebalanceUpstream[],
  opts: Partial<RebalanceChannelInput> = {},
): RebalanceChannelInput {
  return {
    slug,
    channelId: `id-${slug}`,
    expectedMbps: mbps,
    activePlacementId: upstreams[0]?.placementId ?? null,
    lastSwitchAt: null,
    upstreams,
    ...opts,
  };
}

function node(nodeId: string, egressMbps: number | null): RebalanceNodeInput {
  return { instanceId: 'zone1', nodeId, egressMbps };
}

const AB: RebalanceNodeInput[] = [node('a', 100), node('b', 100)];

describe('parseBitrateMbps / expectedChannelMbps', () => {
  it('parses M/k suffixes and plain bits per second', () => {
    expect(parseBitrateMbps('3M', 0)).toBe(3);
    expect(parseBitrateMbps('128k', 0)).toBe(0.128);
    expect(parseBitrateMbps('1500000', 0)).toBe(1.5);
    expect(parseBitrateMbps('2.5M', 0)).toBe(2.5);
    expect(parseBitrateMbps(undefined, 3)).toBe(3);
    expect(parseBitrateMbps('garbage', 7)).toBe(7);
  });

  it('sums video + per-index audio defaults with 10% overhead', () => {
    const payload = {
      template: 'arib-hls',
      templateVersion: 1,
      video: { mode: 'ivtc' },
      audio: [{}, {}],
    } as unknown as PipelineParams;
    // (3 + 0.128 + 0.064) * 1.1
    expect(expectedChannelMbps(payload)).toBeCloseTo(3.5112, 6);

    const explicit = {
      template: 'arib-hls',
      templateVersion: 1,
      video: { mode: 'ivtc', bitrate: '4M' },
      audio: [{ bitrate: '192k' }],
    } as unknown as PipelineParams;
    expect(expectedChannelMbps(explicit)).toBeCloseTo((4 + 0.192) * 1.1, 6);
  });
});

describe('planRebalance', () => {
  it('proposes the single move that best reduces the utilization spread', () => {
    // node a carries 30+20+10 = 60 Mbps (util 0.6), node b is empty:
    // moving the 30 Mbps channel equalizes at 0.3/0.3 (spread 0) — best
    const channels = [
      chan('big', 30, [up('big-a', 'a'), up('big-b', 'b', { priority: 2 })]),
      chan('mid', 20, [up('mid-a', 'a'), up('mid-b', 'b', { priority: 2 })]),
      chan('sml', 10, [up('sml-a', 'a'), up('sml-b', 'b', { priority: 2 })]),
    ];
    const moves = planRebalance({ channels, nodes: AB, now: NOW });
    expect(moves).toEqual([{ slug: 'big', toPlacementId: 'big-b', reason: 'rebalance' }]);
  });

  it('sticky window: a channel switched less than stickyMs ago is not movable', () => {
    // immovable ballast keeps node a loaded so moving `big` genuinely helps
    const withSwitchAt = (lastSwitchAt: string) => [
      chan('ballast', 60, [up('bal-a', 'a')], { lastSwitchAt: ago(1) }),
      chan('big', 30, [up('big-a', 'a'), up('big-b', 'b')], { lastSwitchAt }),
    ];
    expect(planRebalance({ channels: withSwitchAt(ago(30)), nodes: AB, now: NOW })).toEqual([]);
    // 1h + ε ago: movable again
    expect(planRebalance({ channels: withSwitchAt(ago(61)), nodes: AB, now: NOW })).toEqual([
      { slug: 'big', toPlacementId: 'big-b', reason: 'rebalance' },
    ]);
    // custom stickyMs is honored
    expect(
      planRebalance({ channels: withSwitchAt(ago(30)), nodes: AB, now: NOW, stickyMs: 15 * 60_000 }),
    ).toHaveLength(1);
    expect(DEFAULT_STICKY_MS).toBe(3_600_000);
  });

  it('hysteresis: a marginal improvement never triggers a move', () => {
    // moving 3.5 Mbps from a (util 0.5) to b (util 0.45) shrinks the spread by
    // only 0.03 — far below the 0.15 threshold
    const channels = [
      chan('x', 3.5, [up('x-a', 'a'), up('x-b', 'b')]),
      chan('rest-a', 46.5, [up('ra-a', 'a')], { lastSwitchAt: ago(1) }),
      chan('rest-b', 45, [up('rb-b', 'b')], { lastSwitchAt: ago(1) }),
    ];
    expect(planRebalance({ channels, nodes: AB, now: NOW })).toEqual([]);
    // a tighter threshold lets the same move through
    expect(planRebalance({ channels, nodes: AB, now: NOW, hysteresis: 0.01 })).toEqual([
      { slug: 'x', toPlacementId: 'x-b', reason: 'rebalance' },
    ]);
    expect(DEFAULT_HYSTERESIS).toBe(0.15);
  });

  /** immovable 60 Mbps on node a — makes moving the 30 Mbps channel worthwhile */
  const BALLAST = chan('ballast', 60, [up('bal-a', 'a')], { lastSwitchAt: ago(1) });

  it('never moves to an unhealthy upstream', () => {
    // identical to the aged sticky case that DOES move — except target health
    const channels = [
      BALLAST,
      chan('big', 30, [up('big-a', 'a'), up('big-b', 'b', { healthy: false })]),
    ];
    expect(planRebalance({ channels, nodes: AB, now: NOW })).toEqual([]);
  });

  it('a channel whose ACTIVE upstream is unhealthy is not movable (failover is the switcher’s job)', () => {
    const channels = [
      BALLAST,
      chan('big', 30, [up('big-a', 'a', { healthy: false }), up('big-b', 'b')]),
    ];
    expect(planRebalance({ channels, nodes: AB, now: NOW })).toEqual([]);
  });

  it('nodes with null egressMbps neither attract nor repel', () => {
    // only alternative is unbudgeted node c: no move
    const channels = [BALLAST, chan('big', 30, [up('big-a', 'a'), up('big-c', 'c')])];
    expect(planRebalance({ channels, nodes: [...AB, node('c', null)], now: NOW })).toEqual([]);

    // a channel ACTIVE on the unbudgeted node contributes no load anywhere and
    // is never proposed as a move either
    const onC = [chan('idle', 60, [up('idle-c', 'c'), up('idle-b', 'b')])];
    expect(planRebalance({ channels: onC, nodes: [...AB, node('c', null)], now: NOW })).toEqual([]);
  });

  it('returns nothing with fewer than two budgeted nodes', () => {
    const channels = [chan('big', 60, [up('big-a', 'a'), up('big-c', 'c')])];
    expect(planRebalance({ channels, nodes: [node('a', 100), node('c', null)], now: NOW })).toEqual(
      [],
    );
  });

  it('deterministic tie-break: equal candidates resolve by slug order, then priority', () => {
    // two identical channels on a; moving either gives the same spread — the
    // lexically lower slug wins because only a STRICTLY better spread replaces
    const channels = [
      chan('zzz', 30, [up('z-a', 'a'), up('z-b', 'b')]),
      chan('aaa', 30, [up('a-a', 'a'), up('a-b', 'b')]),
    ];
    expect(planRebalance({ channels, nodes: AB, now: NOW })).toEqual([
      { slug: 'aaa', toPlacementId: 'a-b', reason: 'rebalance' },
    ]);

    // within one channel two equal-spread targets resolve by priority:
    // ballast pins node a at 0.6 either way, so moving to b or c both land at
    // spread 0.6 — the lower-priority-number upstream (o-b) wins
    const nodes3 = [node('a', 100), node('b', 100), node('c', 100)];
    const multi = [
      chan('ballast', 60, [up('bal-a', 'a')], { lastSwitchAt: ago(1) }),
      chan('only', 30, [
        up('o-a', 'a'),
        up('o-c', 'c', { priority: 3 }),
        up('o-b', 'b', { priority: 2 }),
      ]),
    ];
    expect(planRebalance({ channels: multi, nodes: nodes3, now: NOW })).toEqual([
      { slug: 'only', toPlacementId: 'o-b', reason: 'rebalance' },
    ]);
  });

  it('one move per pass, even when several channels are out of place', () => {
    const channels = [
      chan('c1', 30, [up('c1-a', 'a'), up('c1-b', 'b')]),
      chan('c2', 30, [up('c2-a', 'a'), up('c2-b', 'b')]),
      chan('c3', 30, [up('c3-a', 'a'), up('c3-b', 'b')]),
    ];
    expect(planRebalance({ channels, nodes: AB, now: NOW })).toHaveLength(1);
  });

  it('is a pure function: same input, same output', () => {
    const channels = [
      chan('big', 30, [up('big-a', 'a'), up('big-b', 'b')]),
      chan('sml', 10, [up('sml-a', 'a'), up('sml-b', 'b')]),
    ];
    const a = planRebalance({ channels, nodes: AB, now: NOW });
    const b = planRebalance({ channels, nodes: AB, now: NOW });
    expect(a).toEqual(b);
  });
});
