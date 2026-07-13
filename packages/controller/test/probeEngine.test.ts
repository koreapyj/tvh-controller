/*
 * ProbeEngine tests: constructed directly with stub getTargets/getSettings
 * and an injectable fetchImpl (real Response/ReadableStream objects, no real
 * network — same style as the retired deliveryProbe.test.ts). Settings use a
 * tiny periodSeconds (0.001) and threshold 1 throughout, and the harness
 * tick() auto-advances the injected clock 10s after each round so every
 * probe is due on every tick — periodSeconds 0 now means DISABLED (see the
 * dedicated test). Streak semantics live in probeState.test.ts — this file
 * is about the engine's I/O and target plumbing.
 */

import { describe, expect, it } from 'vitest';
import type { NodeProbeSettings } from '@tvhc/shared';
import {
  ProbeEngine,
  type NodeProbeTarget,
  type PlacementProbeTarget,
  type ProbeTargets,
} from '../src/restreamer/probeEngine.js';

type FetchImpl = typeof fetch;
type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function nk(instanceId: string, nodeId: string): string {
  return `${instanceId}/${nodeId}`;
}

function makeFetch(): { fetchImpl: FetchImpl; calls: string[]; set: (url: string, h: Handler) => void } {
  const calls: string[] = [];
  const handlers = new Map<string, Handler>();
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    const h = handlers.get(u);
    if (!h) throw new Error(`unmocked fetch: ${u}`);
    return h(u, init);
  }) as unknown as FetchImpl;
  return {
    fetchImpl,
    calls,
    set: (url, h) => {
      handlers.set(url, h);
    },
  };
}

function cfg(overrides: Partial<NodeProbeSettings> = {}): NodeProbeSettings {
  return {
    liveness: { timeoutSeconds: 5, periodSeconds: 0.001, successThreshold: 1, failureThreshold: 1 },
    underspeed: { timeoutSeconds: 5, periodSeconds: 0.001, successThreshold: 1, failureThreshold: 1 },
    lag: { timeoutSeconds: 30, periodSeconds: 0.001, successThreshold: 1, failureThreshold: 1 },
    ...overrides,
  };
}

function nodeTarget(
  instanceId: string,
  nodeId: string,
  serveUrl: string | null,
  slugs: string[],
): NodeProbeTarget {
  return { instanceId, nodeId, serveUrl, slugs };
}

function placementTarget(
  channelId: string,
  placementId: string,
  instanceId: string,
  nodeId: string,
  slug: string,
  playlistUrl: string | null,
): PlacementProbeTarget {
  return { channelId, placementId, instanceId, nodeId, slug, playlistUrl };
}

/** media playlist; segments optionally carrying a PDT tag (lag tests) */
function mediaPlaylist(
  segs: Array<{ uri: string; durationSec: number; pdtIso?: string }>,
  targetDuration = 6,
): string {
  const lines = ['#EXTM3U', `#EXT-X-TARGETDURATION:${targetDuration}`];
  for (const s of segs) {
    if (s.pdtIso) lines.push(`#EXT-X-PROGRAM-DATE-TIME:${s.pdtIso}`);
    lines.push(`#EXTINF:${s.durationSec},`);
    lines.push(s.uri);
  }
  return `${lines.join('\n')}\n`;
}

/** segment body: real Response over a ReadableStream so getReader() behaves like a real fetch */
function segmentResponse(opts: { bytes?: number; delayMs?: number; status?: number; hang?: boolean } = {}): Response {
  const status = opts.status ?? 200;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      if (opts.hang) {
        controller.error(new Error('connection reset mid-body'));
        return;
      }
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      controller.enqueue(new Uint8Array(opts.bytes ?? 0));
      controller.close();
    },
  });
  return new Response(body, { status });
}

interface LoggedEvent {
  type: 'normal' | 'warning';
  service: string;
  source: string;
  message: string;
}

interface Setup {
  engine: ProbeEngine;
  calls: string[];
  set: (url: string, h: Handler) => void;
  setTargets: (t: ProbeTargets) => void;
  setSettings: (m: Map<string, NodeProbeSettings>) => void;
  setNow: (d: Date) => void;
  /** one engine round, then advance the injected clock 10s so the next round is due */
  tick: () => Promise<void>;
  changes: string[];
  logs: LoggedEvent[];
}

function setup(): Setup {
  const { fetchImpl, calls, set } = makeFetch();
  let targets: ProbeTargets = { nodes: [], placements: [] };
  let settings = new Map<string, NodeProbeSettings>();
  let now = new Date('2026-01-01T00:00:00.000Z');
  const changes: string[] = [];
  const logs: LoggedEvent[] = [];
  const engine = new ProbeEngine(
    async () => targets,
    async () => settings,
    (channelId) => changes.push(channelId),
    fetchImpl,
    () => now,
    { log: (e) => logs.push(e) },
  );
  return {
    engine,
    calls,
    set,
    setTargets: (t) => {
      targets = t;
    },
    setSettings: (m) => {
      settings = m;
    },
    setNow: (d) => {
      now = d;
    },
    tick: async () => {
      await engine.tick();
      now = new Date(now.getTime() + 10_000);
    },
    changes,
    logs,
  };
}

const PLAYLIST_URL = 'http://node1/ch1/playlist.m3u8';
const SEG_URL = 'http://node1/ch1/seg1.ts';

// ---------- liveness ----------

describe('ProbeEngine: liveness', () => {
  it('a 2xx playlist response is ok', async () => {
    const s = setup();
    s.setTargets({ nodes: [nodeTarget('z1', 'n1', 'http://node1', ['ch1'])], placements: [] });
    s.setSettings(new Map([[nk('z1', 'n1'), cfg()]]));
    s.set(PLAYLIST_URL, () => new Response('#EXTM3U\n', { status: 200 }));
    await s.tick();
    const status = s.engine.nodeProbeStatus('z1', 'n1')!;
    expect(status.liveness).toMatchObject({ failed: false, lastResult: 'ok' });
  });

  it('a 4xx response fails', async () => {
    const s = setup();
    s.setTargets({ nodes: [nodeTarget('z1', 'n1', 'http://node1', ['ch1'])], placements: [] });
    s.setSettings(new Map([[nk('z1', 'n1'), cfg()]]));
    s.set(PLAYLIST_URL, () => new Response('nope', { status: 404 }));
    await s.tick();
    expect(s.engine.nodeProbeStatus('z1', 'n1')!.liveness).toMatchObject({
      failed: true,
      lastResult: 'fail',
    });
  });

  it('a 5xx response fails', async () => {
    const s = setup();
    s.setTargets({ nodes: [nodeTarget('z1', 'n1', 'http://node1', ['ch1'])], placements: [] });
    s.setSettings(new Map([[nk('z1', 'n1'), cfg()]]));
    s.set(PLAYLIST_URL, () => new Response('boom', { status: 500 }));
    await s.tick();
    expect(s.engine.nodeProbeStatus('z1', 'n1')!.liveness).toMatchObject({
      failed: true,
      lastResult: 'fail',
    });
  });

  it('a network error fails with the error message in detail', async () => {
    const s = setup();
    s.setTargets({ nodes: [nodeTarget('z1', 'n1', 'http://node1', ['ch1'])], placements: [] });
    s.setSettings(new Map([[nk('z1', 'n1'), cfg()]]));
    s.set(PLAYLIST_URL, () => {
      throw new Error('ECONNREFUSED');
    });
    await s.tick();
    const live = s.engine.nodeProbeStatus('z1', 'n1')!.liveness;
    expect(live.failed).toBe(true);
    expect(live.detail).toMatch(/fetch error: ECONNREFUSED/);
  });

  it('an AbortSignal.timeout-shaped rejection fails with a "no response within" detail', async () => {
    const s = setup();
    s.setTargets({ nodes: [nodeTarget('z1', 'n1', 'http://node1', ['ch1'])], placements: [] });
    s.setSettings(new Map([[nk('z1', 'n1'), cfg({ liveness: { timeoutSeconds: 5, periodSeconds: 0.001, successThreshold: 1, failureThreshold: 1 } })]]));
    s.set(PLAYLIST_URL, () => {
      const err = new Error('The operation was aborted');
      err.name = 'TimeoutError';
      throw err;
    });
    await s.tick();
    const live = s.engine.nodeProbeStatus('z1', 'n1')!.liveness;
    expect(live.failed).toBe(true);
    expect(live.detail).toBe('no response within 5s');
  });

  it('a zero-slug node has its probe state deleted (nodeProbeStatus null)', async () => {
    const s = setup();
    s.setTargets({ nodes: [nodeTarget('z1', 'n1', 'http://node1', ['ch1'])], placements: [] });
    s.setSettings(new Map([[nk('z1', 'n1'), cfg()]]));
    s.set(PLAYLIST_URL, () => new Response('#EXTM3U\n', { status: 200 }));
    await s.tick();
    expect(s.engine.nodeProbeStatus('z1', 'n1')).not.toBeNull();

    s.setTargets({ nodes: [nodeTarget('z1', 'n1', 'http://node1', [])], placements: [] });
    await s.tick();
    expect(s.engine.nodeProbeStatus('z1', 'n1')).toBeNull();
  });
});

// ---------- underspeed ----------

describe('ProbeEngine: underspeed', () => {
  it('a fast segment is ok and records lastSpeedRatio', async () => {
    const s = setup();
    s.setTargets({ nodes: [nodeTarget('z1', 'n1', 'http://node1', ['ch1'])], placements: [] });
    s.setSettings(new Map([[nk('z1', 'n1'), cfg()]]));
    s.set(PLAYLIST_URL, () => new Response(mediaPlaylist([{ uri: 'seg1.ts', durationSec: 5 }])));
    s.set(SEG_URL, () => segmentResponse({ bytes: 1000, delayMs: 5 }));
    await s.tick();
    const speed = s.engine.nodeProbeStatus('z1', 'n1')!.underspeed;
    expect(speed.failed).toBe(false);
    expect(speed.lastResult).toBe('ok');
    expect(speed.lastSpeedRatio).not.toBeNull();
    expect(speed.lastSpeedRatio!).toBeGreaterThan(1);
  });

  it('a segment slower than realtime fails', async () => {
    const s = setup();
    s.setTargets({ nodes: [nodeTarget('z1', 'n1', 'http://node1', ['ch1'])], placements: [] });
    s.setSettings(new Map([[nk('z1', 'n1'), cfg()]]));
    // a 0.01s segment with a 50ms body is unambiguously slower than realtime
    s.set(PLAYLIST_URL, () => new Response(mediaPlaylist([{ uri: 'seg1.ts', durationSec: 0.01 }])));
    s.set(SEG_URL, () => segmentResponse({ bytes: 1000, delayMs: 50 }));
    await s.tick();
    const speed = s.engine.nodeProbeStatus('z1', 'n1')!.underspeed;
    expect(speed.failed).toBe(true);
    expect(speed.detail).toMatch(/slower than realtime/);
  });

  it('a body reader that throws mid-download is a hung failure', async () => {
    const s = setup();
    s.setTargets({ nodes: [nodeTarget('z1', 'n1', 'http://node1', ['ch1'])], placements: [] });
    s.setSettings(new Map([[nk('z1', 'n1'), cfg()]]));
    s.set(PLAYLIST_URL, () => new Response(mediaPlaylist([{ uri: 'seg1.ts', durationSec: 5 }])));
    s.set(SEG_URL, () => segmentResponse({ hang: true }));
    await s.tick();
    const speed = s.engine.nodeProbeStatus('z1', 'n1')!.underspeed;
    expect(speed.failed).toBe(true);
    expect(speed.detail).toMatch(/hung/);
  });

  it('connection-refused, playlist HTTP error, and a segment-less playlist all defer to liveness as ok', async () => {
    const s = setup();
    s.setTargets({ nodes: [nodeTarget('z1', 'n1', 'http://node1', ['ch1'])], placements: [] });
    s.setSettings(new Map([[nk('z1', 'n1'), cfg()]]));

    s.set(PLAYLIST_URL, () => {
      throw new Error('ECONNREFUSED');
    });
    await s.tick();
    expect(s.engine.nodeProbeStatus('z1', 'n1')!.underspeed).toMatchObject({
      failed: false,
      lastResult: 'ok',
    });

    s.set(PLAYLIST_URL, () => new Response('boom', { status: 500 }));
    await s.tick();
    expect(s.engine.nodeProbeStatus('z1', 'n1')!.underspeed).toMatchObject({
      failed: false,
      lastResult: 'ok',
    });

    s.set(PLAYLIST_URL, () => new Response('#EXTM3U\n#EXT-X-TARGETDURATION:6\n'));
    await s.tick();
    expect(s.engine.nodeProbeStatus('z1', 'n1')!.underspeed).toMatchObject({
      failed: false,
      lastResult: 'ok',
    });
  });
});

// ---------- lag ----------

describe('ProbeEngine: lag', () => {
  function seedPlacement(s: Setup, lagTimeoutSeconds = 30): void {
    s.setTargets({
      nodes: [],
      placements: [placementTarget('chan1', 'plc1', 'z1', 'n1', 'ch1', PLAYLIST_URL)],
    });
    s.setSettings(
      new Map([
        [
          nk('z1', 'n1'),
          cfg({
            lag: { timeoutSeconds: lagTimeoutSeconds, periodSeconds: 0.001, successThreshold: 1, failureThreshold: 1 },
          }),
        ],
      ]),
    );
  }

  it('lag under the threshold is ok', async () => {
    const s = setup();
    seedPlacement(s, 30);
    const now = new Date('2026-01-01T00:00:10.000Z');
    s.setNow(now);
    const pdtIso = new Date(now.getTime() - 5000).toISOString(); // 5s lag
    s.set(PLAYLIST_URL, () => new Response(mediaPlaylist([{ uri: 'seg1.ts', durationSec: 0, pdtIso }])));
    await s.tick();
    const lag = s.engine.lagStatus('plc1')!;
    expect(lag.failed).toBe(false);
    expect(lag.lastLagSec).toBeCloseTo(5, 1);
  });

  it('lag over the threshold fails', async () => {
    const s = setup();
    seedPlacement(s, 3); // 3s threshold
    const now = new Date('2026-01-01T00:00:10.000Z');
    s.setNow(now);
    const pdtIso = new Date(now.getTime() - 5000).toISOString(); // 5s lag > 3s threshold
    s.set(PLAYLIST_URL, () => new Response(mediaPlaylist([{ uri: 'seg1.ts', durationSec: 0, pdtIso }])));
    await s.tick();
    const lag = s.engine.lagStatus('plc1')!;
    expect(lag.failed).toBe(true);
  });

  it('a fetch error is a SKIP — no state change at all', async () => {
    const s = setup();
    seedPlacement(s, 30);
    const now = new Date('2026-01-01T00:00:10.000Z');
    s.setNow(now);
    const pdtIso = new Date(now.getTime() - 2000).toISOString();
    s.set(PLAYLIST_URL, () => new Response(mediaPlaylist([{ uri: 'seg1.ts', durationSec: 0, pdtIso }])));
    await s.tick();
    const before = s.engine.lagStatus('plc1');

    s.set(PLAYLIST_URL, () => {
      throw new Error('down');
    });
    await s.tick();
    const after = s.engine.lagStatus('plc1');
    expect(after).toEqual(before);
  });

  it('firstMeasuredAt is set once and never advances on later measurements', async () => {
    const s = setup();
    seedPlacement(s, 30);
    const t1 = new Date('2026-01-01T00:00:10.000Z');
    s.setNow(t1);
    s.set(PLAYLIST_URL, () =>
      new Response(mediaPlaylist([{ uri: 'seg1.ts', durationSec: 0, pdtIso: new Date(t1.getTime() - 1000).toISOString() }])),
    );
    await s.tick();
    const first = s.engine.lagStatus('plc1')!.firstMeasuredAt;
    expect(first).not.toBeNull();

    const t2 = new Date('2026-01-01T00:05:00.000Z');
    s.setNow(t2);
    s.set(PLAYLIST_URL, () =>
      new Response(mediaPlaylist([{ uri: 'seg1.ts', durationSec: 0, pdtIso: new Date(t2.getTime() - 2000).toISOString() }])),
    );
    await s.tick();
    expect(s.engine.lagStatus('plc1')!.firstMeasuredAt).toBe(first);
  });
});

// ---------- period gating / pruning ----------

describe('ProbeEngine: per-target period gating and pruning', () => {
  it('gates re-probing by periodSeconds via the injected clock', async () => {
    const s = setup();
    s.setTargets({ nodes: [nodeTarget('z1', 'n1', 'http://node1', ['ch1'])], placements: [] });
    s.setSettings(
      new Map([
        [
          nk('z1', 'n1'),
          cfg({
            liveness: { timeoutSeconds: 5, periodSeconds: 10, successThreshold: 1, failureThreshold: 1 },
            // huge period so underspeed only ever fires on the very first tick
            underspeed: { timeoutSeconds: 5, periodSeconds: 100_000, successThreshold: 1, failureThreshold: 1 },
          }),
        ],
      ]),
    );
    let hits = 0;
    s.set(PLAYLIST_URL, () => {
      hits++;
      return new Response('#EXTM3U\n', { status: 200 });
    });

    const t0 = new Date('2026-01-01T00:00:00.000Z');
    s.setNow(t0);
    await s.tick();
    const afterFirst = hits; // liveness + underspeed both probed once

    s.setNow(new Date(t0.getTime() + 5_000));
    await s.tick();
    expect(hits).toBe(afterFirst); // neither is due yet

    s.setNow(new Date(t0.getTime() + 11_000));
    await s.tick();
    expect(hits).toBe(afterFirst + 1); // liveness due again, underspeed still not
  });

  it('periodSeconds 0 disables a probe: never fetched, prior state dropped', async () => {
    const s = setup();
    s.setTargets({
      nodes: [nodeTarget('z1', 'n1', 'http://node1', ['ch1'])],
      placements: [placementTarget('chan1', 'plc1', 'z1', 'n1', 'ch1', PLAYLIST_URL)],
    });
    s.setSettings(new Map([[nk('z1', 'n1'), cfg()]]));
    s.set(PLAYLIST_URL, () => new Response(mediaPlaylist([{ uri: 'seg1.ts', durationSec: 0, pdtIso: '2026-01-01T00:00:00.000Z' }])));
    s.set(SEG_URL, () => segmentResponse({ bytes: 10 }));
    await s.tick();
    expect(s.engine.nodeProbeStatus('z1', 'n1')).not.toBeNull();
    expect(s.engine.lagStatus('plc1')).not.toBeNull();

    // disable everything via periodSeconds 0 — state drops, no more fetches
    s.setSettings(
      new Map([
        [
          nk('z1', 'n1'),
          {
            liveness: { timeoutSeconds: 5, periodSeconds: 0, successThreshold: 1, failureThreshold: 1 },
            underspeed: { timeoutSeconds: 5, periodSeconds: 0, successThreshold: 1, failureThreshold: 1 },
            lag: { timeoutSeconds: 30, periodSeconds: 0, successThreshold: 1, failureThreshold: 1 },
          },
        ],
      ]),
    );
    const callsBefore = s.calls.length;
    await s.tick();
    expect(s.engine.nodeProbeStatus('z1', 'n1')).toBeNull();
    expect(s.engine.lagStatus('plc1')).toBeNull();
    expect(s.calls.length).toBe(callsBefore); // no fetch left the building
  });

  it('prunes node and placement state when the target disappears from getTargets()', async () => {
    const s = setup();
    s.setTargets({
      nodes: [nodeTarget('z1', 'n1', 'http://node1', ['ch1'])],
      placements: [placementTarget('chan1', 'plc1', 'z1', 'n1', 'ch1', PLAYLIST_URL)],
    });
    s.setSettings(new Map([[nk('z1', 'n1'), cfg()]]));
    s.set(PLAYLIST_URL, () => new Response(mediaPlaylist([{ uri: 'seg1.ts', durationSec: 0, pdtIso: '2026-01-01T00:00:00.000Z' }])));

    await s.tick();
    expect(s.engine.nodeProbeStatus('z1', 'n1')).not.toBeNull();
    expect(s.engine.lagStatus('plc1')).not.toBeNull();

    s.setTargets({ nodes: [], placements: [] });
    await s.tick();
    expect(s.engine.nodeProbeStatus('z1', 'n1')).toBeNull();
    expect(s.engine.lagStatus('plc1')).toBeNull();
  });
});

// ---------- event-log emission (site #5) ----------

describe('ProbeEngine: event-log emission (site #5)', () => {
  it('liveness: warns on trip, stays silent on repeated still-failing ticks, normal on clear', async () => {
    const s = setup();
    s.setTargets({ nodes: [nodeTarget('z1', 'n1', 'http://node1', ['ch1'])], placements: [] });
    s.setSettings(new Map([[nk('z1', 'n1'), cfg()]]));

    s.set(PLAYLIST_URL, () => new Response('boom', { status: 500 }));
    await s.tick(); // trip
    expect(s.logs).toHaveLength(1);
    expect(s.logs[0]).toMatchObject({ type: 'warning', service: 'restreamer', source: 'node.z1.n1' });
    expect(s.logs[0]!.message).toMatch(/liveness probe tripped/);

    await s.tick(); // still failing — must not repeat the warning
    expect(s.logs).toHaveLength(1);

    s.set(PLAYLIST_URL, () => new Response('#EXTM3U\n', { status: 200 }));
    await s.tick(); // clear
    expect(s.logs).toHaveLength(2);
    expect(s.logs[1]).toMatchObject({ type: 'normal', service: 'restreamer', source: 'node.z1.n1' });
    expect(s.logs[1]!.message).toMatch(/liveness probe cleared/);
  });

  it('lag: trip/clear messages include the channel slug (channel-level probe)', async () => {
    const s = setup();
    s.setTargets({
      nodes: [],
      placements: [placementTarget('chan1', 'plc1', 'z1', 'n1', 'ch1', PLAYLIST_URL)],
    });
    s.setSettings(
      new Map([
        [
          nk('z1', 'n1'),
          cfg({ lag: { timeoutSeconds: 3, periodSeconds: 0.001, successThreshold: 1, failureThreshold: 1 } }),
        ],
      ]),
    );

    const t0 = new Date('2026-01-01T00:00:10.000Z');
    s.setNow(t0);
    const failPdt = new Date(t0.getTime() - 5000).toISOString(); // 5s lag > 3s threshold
    s.set(PLAYLIST_URL, () => new Response(mediaPlaylist([{ uri: 'seg1.ts', durationSec: 0, pdtIso: failPdt }])));
    await s.tick(); // trip
    expect(s.logs).toHaveLength(1);
    expect(s.logs[0]).toMatchObject({ type: 'warning', service: 'restreamer', source: 'node.z1.n1' });
    expect(s.logs[0]!.message).toContain('"ch1"');

    const t1 = new Date(t0.getTime() + 20_000);
    s.setNow(t1);
    const clearPdt = new Date(t1.getTime() - 1000).toISOString(); // 1s lag < 3s threshold
    s.set(PLAYLIST_URL, () => new Response(mediaPlaylist([{ uri: 'seg1.ts', durationSec: 0, pdtIso: clearPdt }])));
    await s.tick(); // clear
    expect(s.logs).toHaveLength(2);
    expect(s.logs[1]).toMatchObject({ type: 'normal', service: 'restreamer', source: 'node.z1.n1' });
    expect(s.logs[1]!.message).toContain('"ch1"');
  });
});
