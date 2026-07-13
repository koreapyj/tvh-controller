/*
 * RestreamerPoller / SwitcherPoller tests: fake client + real InstanceCache +
 * real EventBus. Tick-level behavior is driven via pollOnce(); the scheduling
 * loop (start/stop) is exercised with fake timers.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  LagProbeStatus,
  NodeProbeStatus,
  SessionStatus,
  SourcesResponse,
  SseEvent,
  StatusResponse,
  SwitcherStatus,
} from '@tvhc/shared';
import { EventBus } from '../src/state/events.js';
import { InstanceCache } from '../src/state/instanceCache.js';
import { RestreamerPoller, SwitcherPoller } from '../src/restreamer/poller.js';

const NODE = { id: 'n1', url: 'http://node1:5580', serveUrl: 'http://node1' };
const SWITCHER = { id: 'sw1', url: 'http://switcher:5581', publicUrl: 'https://tv.example' };

function nodeStatus(overrides: Partial<StatusResponse> = {}): StatusResponse {
  return {
    apiVersion: 1,
    daemonVersion: '1.0.0',
    startedAt: '2026-07-06T00:00:00Z',
    uptimeSec: 42,
    capabilities: ['qsv'],
    templates: [{ id: 'arib-hls', version: 1 }],
    desiredRevision: 'rev-1',
    sessions: [],
    ...overrides,
  };
}

function switcherStatus(overrides: Partial<SwitcherStatus> = {}): SwitcherStatus {
  return {
    apiVersion: 1,
    switcherVersion: '2.0.0',
    startedAt: '2026-07-06T00:00:00Z',
    uptimeSec: 7,
    desiredRevision: 'rev-9',
    channels: [],
    ...overrides,
  };
}

function catalog(hash: string, entries: SourcesResponse['entries'] = []): SourcesResponse {
  return { apiVersion: 1, catalogHash: hash, updatedAt: '2026-07-06T00:00:00Z', entries };
}

interface LoggedEvent {
  type: 'normal' | 'warning';
  service: string;
  source: string;
  message: string;
}

function setup(hooks = {}) {
  const cache = new InstanceCache();
  cache.init('i1', 'Instance 1', 'http://tvh1');
  const bus = new EventBus();
  const events: SseEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const status = vi.fn<() => Promise<StatusResponse>>();
  const sources = vi.fn<() => Promise<SourcesResponse>>();
  const logs: LoggedEvent[] = [];
  const poller = new RestreamerPoller('i1', NODE, { status, sources }, cache, bus, 15_000, hooks, {
    log: (e) => logs.push(e),
  });
  return { cache, bus, events, status, sources, poller, logs };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('RestreamerPoller', () => {
  it('successful tick fills the snapshot entry and publishes one restreamer event', async () => {
    const { cache, events, status, poller } = setup();
    status.mockResolvedValue(nodeStatus());

    await poller.pollOnce();

    const snap = cache.get('i1');
    expect(snap.restreamers).toHaveLength(1);
    expect(snap.restreamers[0]).toMatchObject({
      instanceId: 'i1',
      nodeId: 'n1',
      url: 'http://node1:5580',
      serveUrl: 'http://node1',
      reachable: true,
      error: null,
      version: '1.0.0',
      uptimeSec: 42,
      apiVersionSupported: true,
      desiredRevision: 'rev-1',
      pendingPush: false,
      sessions: [],
    });
    expect(snap.restreamers[0]?.lastPollAt).not.toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('restreamer');
  });

  it('an identical second tick does not re-publish (lastPollAt churn excluded)', async () => {
    const { events, status, poller } = setup();
    status.mockResolvedValue(nodeStatus());

    await poller.pollOnce();
    await poller.pollOnce();

    expect(status).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(1);
  });

  it('replaces the existing entry keyed by nodeId instead of appending', async () => {
    const { cache, status, poller } = setup();
    status.mockResolvedValue(nodeStatus());
    await poller.pollOnce();
    status.mockResolvedValue(nodeStatus({ uptimeSec: 99 }));
    await poller.pollOnce();

    const snap = cache.get('i1');
    expect(snap.restreamers).toHaveLength(1);
    expect(snap.restreamers[0]?.uptimeSec).toBe(99);
  });

  it('error tick -> reachable false with the error message, sessions cleared, published', async () => {
    const { cache, events, status, poller } = setup();
    status.mockResolvedValue(
      nodeStatus({ sessions: [{ name: 'at-x', state: 'running', enabled: true, configHash: 'h', restarts: 0, consecutiveFailures: 0 }] }),
    );
    await poller.pollOnce();
    status.mockRejectedValue(new Error('ECONNREFUSED'));
    await poller.pollOnce();

    const entry = cache.get('i1').restreamers[0];
    expect(entry).toMatchObject({
      reachable: false,
      error: 'ECONNREFUSED',
      version: null,
      uptimeSec: null,
      desiredRevision: null,
      apiVersionSupported: true,
      sessions: [],
    });
    expect(events).toHaveLength(2);
  });

  it('recovery after an error publishes again', async () => {
    const { events, status, poller } = setup();
    status.mockResolvedValue(nodeStatus());
    await poller.pollOnce();
    status.mockRejectedValue(new Error('down'));
    await poller.pollOnce();
    status.mockResolvedValue(nodeStatus());
    await poller.pollOnce();

    expect(events.map((e) => e.type)).toEqual(['restreamer', 'restreamer', 'restreamer']);
    expect((events[2]?.data as { reachable: boolean }).reachable).toBe(true);
  });

  it('flags apiVersionSupported=false when the node reports an unknown apiVersion', async () => {
    const { cache, status, poller } = setup();
    status.mockResolvedValue(nodeStatus({ apiVersion: 2 as unknown as 1 }));
    await poller.pollOnce();
    expect(cache.get('i1').restreamers[0]?.apiVersionSupported).toBe(false);
  });

  it('surfaces pendingPush from the hook', async () => {
    const { cache, status, poller } = setup({ getPendingPush: () => true });
    status.mockResolvedValue(nodeStatus());
    await poller.pollOnce();
    expect(cache.get('i1').restreamers[0]?.pendingPush).toBe(true);
  });

  describe('revision-mismatch trigger', () => {
    it('fires when expected differs from the reported revision', async () => {
      const onRevisionMismatch = vi.fn();
      const { status, poller } = setup({
        getExpectedRevision: () => 'rev-2',
        onRevisionMismatch,
      });
      status.mockResolvedValue(nodeStatus({ desiredRevision: 'rev-1' }));
      await poller.pollOnce();
      expect(onRevisionMismatch).toHaveBeenCalledTimes(1);
      expect(onRevisionMismatch).toHaveBeenCalledWith('i1', 'n1', 'rev-1');
    });

    it('fires when the node lost its state (reports null)', async () => {
      const onRevisionMismatch = vi.fn();
      const { status, poller } = setup({
        getExpectedRevision: () => 'rev-2',
        onRevisionMismatch,
      });
      status.mockResolvedValue(nodeStatus({ desiredRevision: null }));
      await poller.pollOnce();
      expect(onRevisionMismatch).toHaveBeenCalledWith('i1', 'n1', null);
    });

    it('does not fire when revisions match', async () => {
      const onRevisionMismatch = vi.fn();
      const { status, poller } = setup({
        getExpectedRevision: () => 'rev-1',
        onRevisionMismatch,
      });
      status.mockResolvedValue(nodeStatus({ desiredRevision: 'rev-1' }));
      await poller.pollOnce();
      expect(onRevisionMismatch).not.toHaveBeenCalled();
    });

    it('does not fire when there is no expectation (expected null)', async () => {
      const onRevisionMismatch = vi.fn();
      const { status, poller } = setup({
        getExpectedRevision: () => null,
        onRevisionMismatch,
      });
      status.mockResolvedValue(nodeStatus({ desiredRevision: 'rev-1' }));
      await poller.pollOnce();
      expect(onRevisionMismatch).not.toHaveBeenCalled();
    });

    it('does not fire on an unreachable tick, and a rejecting hook is swallowed', async () => {
      const onRevisionMismatch = vi.fn(() => Promise.reject(new Error('push failed')));
      const { status, poller } = setup({
        getExpectedRevision: () => 'rev-2',
        onRevisionMismatch,
      });
      status.mockRejectedValue(new Error('down'));
      await poller.pollOnce();
      expect(onRevisionMismatch).not.toHaveBeenCalled();

      status.mockResolvedValue(nodeStatus({ desiredRevision: 'rev-1' }));
      await expect(poller.pollOnce()).resolves.toBeUndefined();
      expect(onRevisionMismatch).toHaveBeenCalledTimes(1);
    });
  });

  describe('sources catalog', () => {
    const ENTRY = { id: 'louise-1', name: 'Louise', url: 'https://louise.example/stream?id=1', chno: '1' };

    it('absent sourcesHash (old daemon) -> known-empty catalog, no sources fetch', async () => {
      const { cache, status, sources, poller } = setup();
      status.mockResolvedValue(nodeStatus()); // no sourcesHash field at all
      await poller.pollOnce();
      expect(sources).not.toHaveBeenCalled();
      expect(cache.get('i1').restreamers[0]).toMatchObject({ sourcesHash: null, sources: [] });
    });

    it('null sourcesHash (no sourcesM3u configured) -> known-empty catalog, no fetch', async () => {
      const { cache, status, sources, poller } = setup();
      status.mockResolvedValue(nodeStatus({ sourcesHash: null }));
      await poller.pollOnce();
      expect(sources).not.toHaveBeenCalled();
      expect(cache.get('i1').restreamers[0]).toMatchObject({ sourcesHash: null, sources: [] });
    });

    it('a string hash triggers ONE sources fetch; an unchanged hash does not re-fetch', async () => {
      const { cache, status, sources, poller } = setup();
      status.mockResolvedValue(nodeStatus({ sourcesHash: 'h1' }));
      sources.mockResolvedValue(catalog('h1', [ENTRY]));

      await poller.pollOnce();
      await poller.pollOnce();

      expect(sources).toHaveBeenCalledTimes(1);
      expect(cache.get('i1').restreamers[0]).toMatchObject({
        sourcesHash: 'h1',
        sources: [ENTRY],
      });
    });

    it('a changed hash re-fetches and replaces the catalog', async () => {
      const { cache, status, sources, poller } = setup();
      status.mockResolvedValue(nodeStatus({ sourcesHash: 'h1' }));
      sources.mockResolvedValue(catalog('h1', [ENTRY]));
      await poller.pollOnce();

      const entry2 = { id: 'nhk-g', name: 'NHK G', url: 'https://other.example/s2', chno: '9.1' };
      status.mockResolvedValue(nodeStatus({ sourcesHash: 'h2' }));
      sources.mockResolvedValue(catalog('h2', [entry2]));
      await poller.pollOnce();

      expect(sources).toHaveBeenCalledTimes(2);
      expect(cache.get('i1').restreamers[0]).toMatchObject({
        sourcesHash: 'h2',
        sources: [entry2],
      });
    });

    it('a failed sources fetch keeps the last-known catalog and retries next tick', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { cache, status, sources, poller } = setup();
      status.mockResolvedValue(nodeStatus({ sourcesHash: 'h1' }));
      sources.mockResolvedValue(catalog('h1', [ENTRY]));
      await poller.pollOnce();

      status.mockResolvedValue(nodeStatus({ sourcesHash: 'h2' }));
      sources.mockRejectedValue(new Error('sources down'));
      await poller.pollOnce();
      // last-known kept, hash NOT advanced (so the next tick retries)
      expect(cache.get('i1').restreamers[0]).toMatchObject({
        reachable: true,
        sourcesHash: 'h1',
        sources: [ENTRY],
      });
      expect(err).toHaveBeenCalled();

      sources.mockResolvedValue(catalog('h2', []));
      await poller.pollOnce();
      expect(sources).toHaveBeenCalledTimes(3);
      expect(cache.get('i1').restreamers[0]).toMatchObject({ sourcesHash: 'h2', sources: [] });
      err.mockRestore();
    });

    it('a first-ever fetch failure leaves sources null (never fetched)', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { cache, status, sources, poller } = setup();
      status.mockResolvedValue(nodeStatus({ sourcesHash: 'h1' }));
      sources.mockRejectedValue(new Error('sources down'));
      await poller.pollOnce();
      expect(cache.get('i1').restreamers[0]).toMatchObject({ sourcesHash: null, sources: null });
      err.mockRestore();
    });

    it('an unreachable tick carries the last-known catalog forward', async () => {
      const { cache, status, sources, poller } = setup();
      status.mockResolvedValue(nodeStatus({ sourcesHash: 'h1' }));
      sources.mockResolvedValue(catalog('h1', [ENTRY]));
      await poller.pollOnce();

      status.mockRejectedValue(new Error('ECONNREFUSED'));
      await poller.pollOnce();
      expect(cache.get('i1').restreamers[0]).toMatchObject({
        reachable: false,
        sourcesHash: 'h1',
        sources: [ENTRY],
      });
    });

    it('a catalog change publishes an SSE event; an unchanged catalog does not', async () => {
      const { events, status, sources, poller } = setup();
      status.mockResolvedValue(nodeStatus({ sourcesHash: 'h1' }));
      sources.mockResolvedValue(catalog('h1', [ENTRY]));
      await poller.pollOnce();
      await poller.pollOnce();
      expect(events).toHaveLength(1);

      status.mockResolvedValue(nodeStatus({ sourcesHash: 'h2' }));
      sources.mockResolvedValue(catalog('h2', []));
      await poller.pollOnce();
      expect(events).toHaveLength(2);
    });

    it('onSourcesChanged fires only when the hash actually changed, and a rejecting hook is swallowed', async () => {
      const onSourcesChanged = vi.fn(() => Promise.reject(new Error('push failed')));
      const { status, sources, poller } = setup({ onSourcesChanged });

      status.mockResolvedValue(nodeStatus({ sourcesHash: 'h1' }));
      sources.mockResolvedValue(catalog('h1', [ENTRY]));
      await poller.pollOnce();
      expect(onSourcesChanged).toHaveBeenCalledTimes(1);
      expect(onSourcesChanged).toHaveBeenCalledWith('i1', 'n1');

      await poller.pollOnce(); // unchanged hash
      expect(onSourcesChanged).toHaveBeenCalledTimes(1);

      status.mockResolvedValue(nodeStatus({ sourcesHash: 'h2' }));
      sources.mockResolvedValue(catalog('h2', []));
      await poller.pollOnce();
      expect(onSourcesChanged).toHaveBeenCalledTimes(2);

      // catalog removed (hash string -> null) is also a change
      status.mockResolvedValue(nodeStatus({ sourcesHash: null }));
      await poller.pollOnce();
      expect(onSourcesChanged).toHaveBeenCalledTimes(3);
      await poller.pollOnce();
      expect(onSourcesChanged).toHaveBeenCalledTimes(3);
    });

    it('does not fire onSourcesChanged when the fetch failed (hash not advanced)', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const onSourcesChanged = vi.fn();
      const { status, sources, poller } = setup({ onSourcesChanged });
      status.mockResolvedValue(nodeStatus({ sourcesHash: 'h1' }));
      sources.mockRejectedValue(new Error('sources down'));
      await poller.pollOnce();
      expect(onSourcesChanged).not.toHaveBeenCalled();
      err.mockRestore();
    });
  });

  describe('probe state and session enrichment', () => {
    function probeStatus(overrides: Partial<NodeProbeStatus['liveness']> = {}): NodeProbeStatus {
      return {
        liveness: {
          consecutiveFailures: 0,
          consecutiveSuccesses: 2,
          failed: false,
          lastResult: 'ok',
          lastCheckedAt: '2026-01-01T00:00:00.000Z',
          detail: 'playlist HTTP 200',
          ...overrides,
        },
        underspeed: {
          consecutiveFailures: 0,
          consecutiveSuccesses: 2,
          failed: false,
          lastResult: 'ok',
          lastCheckedAt: '2026-01-01T00:00:00.000Z',
          detail: 'segment 1.0KB in 10ms (5s segment)',
          lastSpeedRatio: 500,
        },
      };
    }

    it('getProbes lands in status.probes and survives an unrelated later poll (no wipe)', async () => {
      const probes = probeStatus();
      const { cache, status, poller } = setup({ getProbes: () => probes });
      status.mockResolvedValue(nodeStatus());
      await poller.pollOnce();
      expect(cache.get('i1').restreamers[0]?.probes).toEqual(probes);

      status.mockResolvedValue(nodeStatus({ uptimeSec: 99 }));
      await poller.pollOnce();
      expect(cache.get('i1').restreamers[0]?.uptimeSec).toBe(99);
      expect(cache.get('i1').restreamers[0]?.probes).toEqual(probes);
    });

    it('getProbes returning null (nothing probeable) leaves status.probes null', async () => {
      const { cache, status, poller } = setup({ getProbes: () => null });
      status.mockResolvedValue(nodeStatus());
      await poller.pollOnce();
      expect(cache.get('i1').restreamers[0]?.probes).toBeNull();
    });

    it('enrichSessions folds channel-level probe state into the polled sessions', async () => {
      const lagProbe: LagProbeStatus = {
        consecutiveFailures: 0,
        consecutiveSuccesses: 1,
        failed: false,
        lastResult: 'ok',
        lastCheckedAt: '2026-01-01T00:00:00.000Z',
        detail: 'lag 1.0s (threshold 30s)',
        lastLagSec: 1,
        firstMeasuredAt: '2026-01-01T00:00:00.000Z',
      };
      const enrichSessions = vi.fn(async (_i: string, _n: string, sessions: SessionStatus[]) =>
        sessions.map((s) => ({ ...s, lagProbe })),
      );
      const { cache, status, poller } = setup({ enrichSessions });
      status.mockResolvedValue(
        nodeStatus({
          sessions: [{ name: 'at-x', state: 'running', enabled: true, configHash: 'h', restarts: 0, consecutiveFailures: 0 }],
        }),
      );
      await poller.pollOnce();
      expect(enrichSessions).toHaveBeenCalledWith('i1', 'n1', expect.any(Array));
      expect(cache.get('i1').restreamers[0]?.sessions[0]).toMatchObject({ name: 'at-x', lagProbe });
    });

    it('a throwing enrichSessions hook is swallowed — the plain sessions pass through', async () => {
      const enrichSessions = vi.fn(() => {
        throw new Error('boom');
      });
      const { cache, status, poller } = setup({ enrichSessions });
      status.mockResolvedValue(
        nodeStatus({
          sessions: [{ name: 'at-x', state: 'running', enabled: true, configHash: 'h', restarts: 0, consecutiveFailures: 0 }],
        }),
      );
      await expect(poller.pollOnce()).resolves.toBeUndefined();
      expect(cache.get('i1').restreamers[0]?.sessions[0]).toMatchObject({ name: 'at-x' });
    });

    it('statusKey ignores lastCheckedAt anywhere in the status, not just at the top level', async () => {
      let n = 0;
      const { events, status, poller } = setup({
        getProbes: () => probeStatus({ lastCheckedAt: new Date(2026, 0, 1, 0, 0, n++).toISOString() }),
      });
      status.mockResolvedValue(nodeStatus());
      await poller.pollOnce();
      await poller.pollOnce(); // only the nested probes.liveness.lastCheckedAt changed
      expect(events).toHaveLength(1);
    });
  });

  it('start() polls on the interval and stop() halts rescheduling', async () => {
    vi.useFakeTimers();
    const { status, poller } = setup();
    status.mockResolvedValue(nodeStatus());

    poller.start();
    await vi.advanceTimersByTimeAsync(2000); // past the max initial jitter
    expect(status).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(status).toHaveBeenCalledTimes(2);

    poller.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(status).toHaveBeenCalledTimes(2);
  });

  describe('event-log emission: node up/down (site #6)', () => {
    it('logs nothing on the very first poll (no prior state), then a normal/warning on each transition only', async () => {
      const { logs, status, poller } = setup();
      status.mockRejectedValue(new Error('down'));
      await poller.pollOnce(); // first-ever entry — nothing to transition from
      expect(logs).toHaveLength(0);

      status.mockResolvedValue(nodeStatus());
      await poller.pollOnce(); // false -> true
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ type: 'normal', service: 'restreamer', source: 'node.i1.n1' });
      expect(logs[0]!.message).toContain('node.i1.n1');

      await poller.pollOnce(); // still reachable — no repeat
      expect(logs).toHaveLength(1);

      status.mockRejectedValue(new Error('ECONNRESET'));
      await poller.pollOnce(); // true -> false
      expect(logs).toHaveLength(2);
      expect(logs[1]).toMatchObject({ type: 'warning', service: 'restreamer', source: 'node.i1.n1' });
      expect(logs[1]!.message).toContain('ECONNRESET');
    });

    it('a pre-seeded placeholder entry (lastPollAt: null, as main.ts seeds before any poller runs) does not log "came online" on the first real poll', async () => {
      const { cache, logs, status, poller } = setup();
      // mimic main.ts: a reachable:false placeholder exists in the cache
      // BEFORE this poller's first tick — a naive idx !== -1 check would read
      // its reachable:false as a real prior observation
      cache.get('i1').restreamers = [
        {
          instanceId: 'i1',
          nodeId: 'n1',
          url: NODE.url,
          serveUrl: NODE.serveUrl,
          reachable: false,
          error: null,
          lastPollAt: null,
          version: null,
          uptimeSec: null,
          apiVersionSupported: true,
          desiredRevision: null,
          pendingPush: false,
          probes: null,
          sessions: [],
          sourcesHash: null,
          sources: null,
        },
      ];

      status.mockResolvedValue(nodeStatus());
      await poller.pollOnce(); // first REAL poll — must not log despite the placeholder's reachable:false
      expect(logs).toHaveLength(0);

      status.mockRejectedValue(new Error('ECONNRESET'));
      await poller.pollOnce(); // first genuine transition: true -> false
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ type: 'warning', service: 'restreamer', source: 'node.i1.n1' });

      status.mockResolvedValue(nodeStatus());
      await poller.pollOnce(); // false -> true
      expect(logs).toHaveLength(2);
      expect(logs[1]).toMatchObject({ type: 'normal', service: 'restreamer', source: 'node.i1.n1' });
    });
  });

  describe('event-log emission: ffmpeg session restarts (site #8)', () => {
    function sess(name: string, over: Partial<SessionStatus> = {}): SessionStatus {
      return { name, state: 'running', enabled: true, configHash: 'h', restarts: 0, consecutiveFailures: 0, ...over };
    }

    it('warns only on an increase, never on the first-poll baseline or a repeat of the same count', async () => {
      const { logs, status, poller } = setup();
      status.mockResolvedValue(nodeStatus({ sessions: [sess('at-x', { restarts: 2 })] }));
      await poller.pollOnce(); // baseline — pre-existing restarts=2 must not log
      expect(logs).toHaveLength(0);

      status.mockResolvedValue(nodeStatus({ sessions: [sess('at-x', { restarts: 2 })] }));
      await poller.pollOnce(); // unchanged
      expect(logs).toHaveLength(0);

      status.mockResolvedValue(
        nodeStatus({
          sessions: [sess('at-x', { restarts: 3, lastExit: { code: 1, signal: null, at: '2026-01-01T00:00:00Z', class: 'crash' } })],
        }),
      );
      await poller.pollOnce(); // restarts increased
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ type: 'warning', service: 'restreamer', source: 'node.i1.n1' });
      expect(logs[0]!.message).toContain('at-x');
      expect(logs[0]!.message).toContain('restarts=3');
      expect(logs[0]!.message).toContain('crash');
    });

    it('a session that disappears and reappears at a lower count is rebaselined without logging a spurious event', async () => {
      const { logs, status, poller } = setup();
      status.mockResolvedValue(nodeStatus({ sessions: [sess('at-x', { restarts: 5 })] }));
      await poller.pollOnce(); // baseline
      expect(logs).toHaveLength(0);

      status.mockResolvedValue(nodeStatus({ sessions: [] })); // session gone (e.g. placement removed)
      await poller.pollOnce();
      expect(logs).toHaveLength(0);

      status.mockResolvedValue(nodeStatus({ sessions: [sess('at-x', { restarts: 0 })] })); // reappears fresh
      await poller.pollOnce();
      expect(logs).toHaveLength(0); // 0 < the old count, but it's a fresh session, not a restart

      status.mockResolvedValue(nodeStatus({ sessions: [sess('at-x', { restarts: 1 })] }));
      await poller.pollOnce(); // now a genuine increase from the rebaselined count
      expect(logs).toHaveLength(1);
      expect(logs[0]!.message).toContain('restarts=1');
    });
  });
});

describe('SwitcherPoller', () => {
  function setupSwitcher(hooks = {}) {
    const cache = new InstanceCache();
    const bus = new EventBus();
    const events: SseEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const status = vi.fn<() => Promise<SwitcherStatus>>();
    const logs: LoggedEvent[] = [];
    const poller = new SwitcherPoller(SWITCHER, { status }, cache, bus, 15_000, hooks, {
      log: (e) => logs.push(e),
    });
    return { cache, events, status, poller, logs };
  }

  it('successful tick stores the status in cache.switchers and publishes once', async () => {
    const { cache, events, status, poller } = setupSwitcher();
    status.mockResolvedValue(switcherStatus());

    await poller.pollOnce();
    await poller.pollOnce(); // identical -> no re-publish

    expect(cache.switchers.get('sw1')).toMatchObject({
      switcherId: 'sw1',
      url: 'http://switcher:5581',
      publicUrl: 'https://tv.example',
      reachable: true,
      error: null,
      version: '2.0.0',
      pendingPush: false,
      channels: [],
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('restreamer-switcher');
  });

  it('error tick -> reachable false, then recovery publishes again', async () => {
    const { cache, events, status, poller } = setupSwitcher();
    status.mockResolvedValue(switcherStatus());
    await poller.pollOnce();
    status.mockRejectedValue(new Error('gone'));
    await poller.pollOnce();

    expect(cache.switchers.get('sw1')).toMatchObject({
      reachable: false,
      error: 'gone',
      version: null,
      channels: [],
    });

    status.mockResolvedValue(switcherStatus());
    await poller.pollOnce();
    expect(events.map((e) => e.type)).toEqual([
      'restreamer-switcher',
      'restreamer-switcher',
      'restreamer-switcher',
    ]);
  });

  it('revision-mismatch trigger fires with the switcher id (e.g. after PVC loss)', async () => {
    const onRevisionMismatch = vi.fn();
    const { status, poller } = setupSwitcher({
      getExpectedRevision: () => 'rev-9',
      onRevisionMismatch,
    });
    status.mockResolvedValue(switcherStatus({ desiredRevision: null }));
    await poller.pollOnce();
    expect(onRevisionMismatch).toHaveBeenCalledWith('sw1', null);

    onRevisionMismatch.mockClear();
    status.mockResolvedValue(switcherStatus({ desiredRevision: 'rev-9' }));
    await poller.pollOnce();
    expect(onRevisionMismatch).not.toHaveBeenCalled();
  });

  it('stop() halts rescheduling', async () => {
    vi.useFakeTimers();
    const { status, poller } = setupSwitcher();
    status.mockResolvedValue(switcherStatus());

    poller.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(status).toHaveBeenCalledTimes(1);
    poller.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(status).toHaveBeenCalledTimes(1);
  });

  describe('event-log emission: switcher up/down (site #6)', () => {
    it('logs nothing on the first poll, then a normal/warning only on transitions', async () => {
      const { logs, status, poller } = setupSwitcher();
      status.mockRejectedValue(new Error('down'));
      await poller.pollOnce(); // first-ever entry
      expect(logs).toHaveLength(0);

      status.mockResolvedValue(switcherStatus());
      await poller.pollOnce(); // false -> true
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ type: 'normal', service: 'restreamer', source: 'switcher.sw1' });

      await poller.pollOnce(); // unchanged
      expect(logs).toHaveLength(1);

      status.mockRejectedValue(new Error('gone'));
      await poller.pollOnce(); // true -> false
      expect(logs).toHaveLength(2);
      expect(logs[1]).toMatchObject({ type: 'warning', service: 'restreamer', source: 'switcher.sw1' });
      expect(logs[1]!.message).toContain('gone');
    });
  });
});
