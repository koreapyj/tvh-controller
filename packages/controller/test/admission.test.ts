/*
 * Pure admission-policy tests: canAdmitSession / nodeHealthy / recordSnapshot
 * over hand-built RestreamerNodeStatus snapshots — capacity boundary, health
 * gate (speed streak, playlist lag, overload backoff), source-http
 * exclusion, ring-buffer FIFO eviction and purity. No I/O.
 */

import { describe, expect, it } from 'vitest';
import type { ExitClass, RestreamerNodeStatus, SessionState, SessionStatus } from '@tvhc/shared';
import {
  type AdmissionHistory,
  HEALTH_HISTORY_SIZE,
  MAX_HEALTHY_PLAYLIST_LAG_SEC,
  MAX_OVERLOAD_BACKOFF_SESSIONS,
  MIN_HEALTHY_SPEED,
  SPEED_DEGRADED_STREAK,
  canAdmitSession,
  emptyHistory,
  nodeHealthy,
  recordSnapshot,
} from '../src/restreamer/admission.js';

/** one SessionStatus fixture; `running` unless overridden */
function sess(
  name: string,
  opts: Partial<SessionStatus> & {
    speed?: number;
    playlistLagSec?: number;
    exitClass?: ExitClass;
    state?: SessionState;
  } = {},
): SessionStatus {
  const { speed, playlistLagSec, exitClass, state, ...rest } = opts;
  const status: SessionStatus = {
    name,
    state: state ?? 'running',
    enabled: true,
    configHash: 'hash',
    restarts: 0,
    consecutiveFailures: 0,
    ...rest,
  };
  if (speed !== undefined) {
    status.progress = { bitrateKbps: 4000, speed, outTimeMs: 1000, updatedAt: '2026-07-06T12:00:00Z' };
  }
  if (playlistLagSec !== undefined) {
    status.playlistLagSec = playlistLagSec;
  }
  if (exitClass !== undefined) {
    status.lastExit = { code: 1, signal: null, at: '2026-07-06T11:59:00Z', class: exitClass };
  }
  return status;
}

/** one RestreamerNodeStatus fixture; reachable unless overridden */
function status(
  sessions: SessionStatus[],
  opts: Partial<RestreamerNodeStatus> = {},
): RestreamerNodeStatus {
  return {
    instanceId: 'zone1',
    nodeId: 'node-a',
    url: 'http://node-a:8080',
    serveUrl: 'http://node-a:8080/hls',
    reachable: true,
    error: null,
    lastPollAt: '2026-07-06T12:00:00Z',
    version: '1.0.0',
    uptimeSec: 3600,
    apiVersionSupported: true,
    desiredRevision: 'rev1',
    pendingPush: false,
    sourcesHash: null,
    sources: null,
    sessions,
    ...opts,
  };
}

/** feed `count` identical snapshots into a fresh history, returning the final history */
function historyAfter(snapshots: RestreamerNodeStatus[]): AdmissionHistory {
  let h = emptyHistory();
  for (const s of snapshots) h = recordSnapshot(h, s);
  return h;
}

describe('capacity gate', () => {
  it('count === max is ok', () => {
    const st = status([]);
    const result = canAdmitSession({
      status: st,
      history: emptyHistory(),
      desiredSessionCount: 6,
      maxSessions: 6,
    });
    expect(result).toEqual({ ok: true });
  });

  it('count === max+1 is at-capacity', () => {
    const st = status([]);
    const result = canAdmitSession({
      status: st,
      history: emptyHistory(),
      desiredSessionCount: 7,
      maxSessions: 6,
    });
    expect(result).toEqual({
      ok: false,
      reason: 'at-capacity',
      detail: '7 sessions desired > maxSessions 6',
    });
  });

  it('uncapped (maxSessions undefined) always passes capacity', () => {
    const st = status([]);
    const result = canAdmitSession({
      status: st,
      history: emptyHistory(),
      desiredSessionCount: 999,
      maxSessions: undefined,
    });
    expect(result).toEqual({ ok: true });
  });
});

describe('nodeHealthy: speed degradation', () => {
  it('under-cap but 2 running sessions sustained-slow speed → node-unhealthy', () => {
    const snap = status([
      sess('news1', { speed: 0.5 }),
      sess('news2', { speed: 0.5 }),
    ]);
    const history = historyAfter([snap, snap]); // 2 consecutive slow samples = SPEED_DEGRADED_STREAK
    const result = nodeHealthy(history, snap);
    expect(result.healthy).toBe(false);
  });

  it('flapping speed: one slow sample then recovery never reaches the streak → ok', () => {
    const slow = status([sess('news1', { speed: 0.5 }), sess('news2', { speed: 0.5 })]);
    const recovered = status([sess('news1', { speed: 1.0 }), sess('news2', { speed: 1.0 })]);
    const history = historyAfter([slow, recovered]);
    const result = nodeHealthy(history, recovered);
    expect(result.healthy).toBe(true);
  });

  it('exactly SPEED_DEGRADED_STREAK consecutive slow samples (2nd session also degraded) → unhealthy', () => {
    expect(SPEED_DEGRADED_STREAK).toBe(2);
    const snap = status([sess('news1', { speed: 0.9 }), sess('news2', { speed: 0.9 })]);
    const history = historyAfter([snap, snap]);
    const result = nodeHealthy(history, snap);
    expect(result.healthy).toBe(false);
  });

  it('a single degraded session alone is still ok (>=2 rule)', () => {
    const snap = status([sess('news1', { speed: 0.5 }), sess('news2', { speed: 1.0 })]);
    const history = historyAfter([snap, snap]);
    const result = nodeHealthy(history, snap);
    expect(result.healthy).toBe(true);
  });

  it('MIN_HEALTHY_SPEED boundary is 0.98', () => {
    expect(MIN_HEALTHY_SPEED).toBe(0.98);
  });
});

describe('nodeHealthy: source-http exclusion', () => {
  it('lone source-http backoff session, everything else fine → ok', () => {
    const snap = status([
      sess('deadsrc', { state: 'backoff', exitClass: 'source-http' }),
      sess('news1', { speed: 1.0 }),
    ]);
    const history = historyAfter([snap]);
    expect(nodeHealthy(history, snap)).toEqual({ healthy: true });
  });

  it('source-http sessions never count toward the degraded-speed branch either', () => {
    // running w/ slow speed but classified source-http on lastExit shouldn't happen in practice
    // (source-http implies not running) — still exercise the guard directly via 2 slow + 1 source-http
    const snap = status([
      sess('news1', { speed: 0.5 }),
      sess('news2', { speed: 0.5 }),
      sess('deadsrc', { state: 'backoff', exitClass: 'source-http' }),
    ]);
    const history = historyAfter([snap, snap]);
    // the two speed-degraded sessions alone already trip unhealthy; deadsrc must not add a 3rd
    const result = nodeHealthy(history, snap);
    expect(result.healthy).toBe(false);
    if (!result.healthy) {
      expect(result.reason).not.toContain('deadsrc');
    }
  });
});

describe('nodeHealthy: playlist lag', () => {
  it('lag on the latest sample alone marks a session degraded (no streak needed)', () => {
    const snap = status([
      sess('news1', { playlistLagSec: MAX_HEALTHY_PLAYLIST_LAG_SEC + 1 }),
      sess('news2', { playlistLagSec: MAX_HEALTHY_PLAYLIST_LAG_SEC + 1 }),
    ]);
    const history = historyAfter([snap]); // single sample, no streak
    const result = nodeHealthy(history, snap);
    expect(result.healthy).toBe(false);
  });

  it('one lag-degraded session alone → still ok (>=2 rule)', () => {
    const snap = status([
      sess('news1', { playlistLagSec: MAX_HEALTHY_PLAYLIST_LAG_SEC + 1 }),
      sess('news2', { speed: 1.0 }),
    ]);
    const history = historyAfter([snap]);
    expect(nodeHealthy(history, snap)).toEqual({ healthy: true });
  });

  it('lag-degraded + speed-degraded pair → unhealthy', () => {
    const snap = status([
      sess('news1', { playlistLagSec: MAX_HEALTHY_PLAYLIST_LAG_SEC + 1 }),
      sess('news2', { speed: 0.5 }),
    ]);
    const history = historyAfter([snap, snap]); // news2 needs the streak
    const result = nodeHealthy(history, snap);
    expect(result.healthy).toBe(false);
  });

  it('MAX_HEALTHY_PLAYLIST_LAG_SEC is 12', () => {
    expect(MAX_HEALTHY_PLAYLIST_LAG_SEC).toBe(12);
  });
});

describe('nodeHealthy: overload backoff', () => {
  it('2 backoff sessions with class stall → unhealthy even with zero degraded running sessions', () => {
    const snap = status([
      sess('a', { state: 'backoff', exitClass: 'stall' }),
      sess('b', { state: 'backoff', exitClass: 'stall' }),
      sess('c', { speed: 1.0 }),
    ]);
    const history = historyAfter([snap]);
    const result = nodeHealthy(history, snap);
    expect(result.healthy).toBe(false);
  });

  it('exactly MAX_OVERLOAD_BACKOFF_SESSIONS (1) backoff session is tolerated', () => {
    expect(MAX_OVERLOAD_BACKOFF_SESSIONS).toBe(1);
    const snap = status([
      sess('a', { state: 'backoff', exitClass: 'crash' }),
      sess('b', { speed: 1.0 }),
    ]);
    const history = historyAfter([snap]);
    expect(nodeHealthy(history, snap)).toEqual({ healthy: true });
  });

  it('oom-guard also counts as overload-shaped', () => {
    const snap = status([
      sess('a', { state: 'backoff', exitClass: 'oom-guard' }),
      sess('b', { state: 'backoff', exitClass: 'oom-guard' }),
    ]);
    const history = historyAfter([snap]);
    expect(nodeHealthy(history, snap).healthy).toBe(false);
  });
});

describe('nodeHealthy: empty node', () => {
  it('empty node (no sessions) → ok', () => {
    const snap = status([]);
    const history = historyAfter([snap]);
    expect(nodeHealthy(history, snap)).toEqual({ healthy: true });
  });
});

describe('canAdmitSession: check order', () => {
  it('unreachable short-circuits before capacity/health', () => {
    const snap = status(
      [sess('a', { speed: 0.5 }), sess('b', { speed: 0.5 })],
      { reachable: false, error: 'ECONNREFUSED' },
    );
    const history = historyAfter([snap, snap]);
    const result = canAdmitSession({
      status: snap,
      history,
      desiredSessionCount: 999, // would also fail capacity
      maxSessions: 1,
    });
    expect(result).toEqual({
      ok: false,
      reason: 'node-unreachable',
      detail: 'ECONNREFUSED',
    });
  });

  it('capacity is checked before health', () => {
    const snap = status([sess('a', { speed: 0.5 }), sess('b', { speed: 0.5 })]);
    const history = historyAfter([snap, snap]); // would also fail health
    const result = canAdmitSession({
      status: snap,
      history,
      desiredSessionCount: 5,
      maxSessions: 2,
    });
    expect(result).toEqual({
      ok: false,
      reason: 'at-capacity',
      detail: '5 sessions desired > maxSessions 2',
    });
  });

  it('healthy, under-cap, reachable → ok', () => {
    const snap = status([sess('a', { speed: 1.0 })]);
    const history = historyAfter([snap]);
    const result = canAdmitSession({
      status: snap,
      history,
      desiredSessionCount: 2,
      maxSessions: 6,
    });
    expect(result).toEqual({ ok: true });
  });
});

describe('recordSnapshot: ring buffer and pruning', () => {
  it('caps at HEALTH_HISTORY_SIZE and evicts old bad samples so the verdict flips back to healthy', () => {
    expect(HEALTH_HISTORY_SIZE).toBe(4);
    let h = emptyHistory();
    const bad = status([sess('a', { speed: 0.5 }), sess('b', { speed: 0.5 })]);
    const good = status([sess('a', { speed: 1.0 }), sess('b', { speed: 1.0 })]);

    // 2 bad samples trip the streak
    h = recordSnapshot(h, bad);
    h = recordSnapshot(h, bad);
    expect(nodeHealthy(h, bad).healthy).toBe(false);
    expect(h.perSession.get('a')?.length).toBe(2);

    // push HEALTH_HISTORY_SIZE + 3 more good samples total; buffer length stays capped
    for (let i = 0; i < HEALTH_HISTORY_SIZE + 3; i++) {
      h = recordSnapshot(h, good);
    }
    expect(h.perSession.get('a')?.length).toBe(HEALTH_HISTORY_SIZE);
    expect(h.perSession.get('b')?.length).toBe(HEALTH_HISTORY_SIZE);
    // the bad samples have aged out of the ring buffer — verdict is healthy again
    expect(nodeHealthy(h, good)).toEqual({ healthy: true });
  });

  it('vanished-session pruning: a status missing a previously-tracked name drops its entry', () => {
    let h = emptyHistory();
    h = recordSnapshot(h, status([sess('a', { speed: 1.0 }), sess('b', { speed: 1.0 })]));
    expect(h.perSession.has('a')).toBe(true);
    expect(h.perSession.has('b')).toBe(true);

    h = recordSnapshot(h, status([sess('b', { speed: 1.0 })]));
    expect(h.perSession.has('a')).toBe(false);
    expect(h.perSession.has('b')).toBe(true);
  });

  it('is pure: does not mutate the input history object', () => {
    const h0 = recordSnapshot(emptyHistory(), status([sess('a', { speed: 1.0 })]));
    const snapshotBefore = JSON.stringify([...h0.perSession.entries()]);
    const h1 = recordSnapshot(h0, status([sess('a', { speed: 0.5 })]));
    const snapshotAfter = JSON.stringify([...h0.perSession.entries()]);
    expect(snapshotAfter).toBe(snapshotBefore);
    expect(h1).not.toBe(h0);
    expect(h1.perSession.get('a')?.length).toBe(2);
    expect(h0.perSession.get('a')?.length).toBe(1);
  });
});
