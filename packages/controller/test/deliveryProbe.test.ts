/*
 * DeliveryProbe tests: evaluateProbe as a pure classifier, then the class
 * driven directly via runOnce() with an injected fake fetch — no real
 * network, no timers. Response bodies are hand-built duck-typed objects (not
 * real undici Response instances) so the segment body's `arrayBuffer()` can
 * be delayed with a real (small) setTimeout to exercise the throughput
 * check deterministically.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DELIVERY_PROBE_DEFAULTS,
  DeliveryProbe,
  evaluateProbe,
  type DeliveryProbeConfig,
  type ProbeMeasurement,
  type ProbeTarget,
} from '../src/restreamer/deliveryProbe.js';

type FetchImpl = typeof fetch;

const CFG: DeliveryProbeConfig = { intervalSec: 45, ttfbMs: 3000, minSpeedFactor: 1.5 };

function measurement(overrides: Partial<ProbeMeasurement> = {}): ProbeMeasurement {
  return { ok: true, ttfbMs: 100, segmentSeconds: 4, downloadMs: 500, detail: '', ...overrides };
}

describe('DELIVERY_PROBE_DEFAULTS', () => {
  it('matches the documented defaults', () => {
    expect(DELIVERY_PROBE_DEFAULTS).toEqual({ intervalSec: 45, ttfbMs: 3000, minSpeedFactor: 1.5 });
  });
});

describe('evaluateProbe (pure)', () => {
  it('a fast probe is ok', () => {
    expect(evaluateProbe(measurement(), CFG)).toBe('ok');
  });

  it('slow by throughput boundary: just over the budget is slow, just under is ok', () => {
    // budget = 4s * 1000 / 1.5 = 2666.666...ms
    const budgetMs = (4 * 1000) / 1.5;
    expect(
      evaluateProbe(measurement({ segmentSeconds: 4, downloadMs: Math.ceil(budgetMs) + 1 }), CFG),
    ).toBe('slow');
    expect(
      evaluateProbe(measurement({ segmentSeconds: 4, downloadMs: Math.floor(budgetMs) }), CFG),
    ).toBe('ok');
  });

  it('slow by TTFB over the configured ceiling', () => {
    expect(evaluateProbe(measurement({ ttfbMs: CFG.ttfbMs + 1 }), CFG)).toBe('slow');
    expect(evaluateProbe(measurement({ ttfbMs: CFG.ttfbMs }), CFG)).toBe('ok');
  });

  it('ok:false is always slow regardless of otherwise-fine fields', () => {
    expect(
      evaluateProbe(measurement({ ok: false, ttfbMs: 1, segmentSeconds: 100, downloadMs: 1 }), CFG),
    ).toBe('slow');
  });

  it('nulls with ok:true and a fine TTFB are ok (an unmeasurable segment is not punished)', () => {
    expect(
      evaluateProbe(
        measurement({ ttfbMs: null, segmentSeconds: null, downloadMs: null }),
        CFG,
      ),
    ).toBe('ok');
  });
});

// ---------- fake fetch harness ----------

type Handler = () => Promise<Response> | Response;

/** routes exact URL strings to a registered handler; unregistered URLs throw */
function makeFetch(): { fetchImpl: FetchImpl; calls: string[]; set: (url: string, h: Handler) => void } {
  const calls: string[] = [];
  const handlers = new Map<string, Handler>();
  const fetchImpl = vi.fn(async (url: unknown) => {
    const u = String(url);
    calls.push(u);
    const h = handlers.get(u);
    if (!h) throw new Error(`unmocked fetch: ${u}`);
    return h();
  }) as unknown as FetchImpl;
  return {
    fetchImpl,
    calls,
    set: (url, h) => {
      handlers.set(url, h);
    },
  };
}

function playlistRes(text: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  } as unknown as Response;
}

/** segment body whose arrayBuffer() resolves after `delayMs` (real, small) */
function segmentRes(byteLength: number, delayMs = 0, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return new ArrayBuffer(byteLength);
    },
  } as unknown as Response;
}

/** media playlist with several segments; the LAST one is the one that must be probed */
function playlist(segments: Array<{ uri: string; durationSec: number }>): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:10'];
  for (const s of segments) {
    lines.push(`#EXTINF:${s.durationSec.toFixed(3)},`);
    lines.push(s.uri);
  }
  return lines.join('\n');
}

describe('DeliveryProbe', () => {
  it('happy path: healthyStreak increments across rounds, slowStreak stays 0', async () => {
    const { fetchImpl, set } = makeFetch();
    const playlistUrl = 'http://cache1/hls/ch1.m3u8';
    const segUrl = 'http://cache1/hls/seg3.ts';
    set(
      playlistUrl,
      () =>
        playlistRes(
          playlist([
            { uri: 'seg1.ts', durationSec: 6 },
            { uri: 'seg2.ts', durationSec: 6 },
            { uri: 'seg3.ts', durationSec: 6 },
          ]),
        ),
    );
    set(segUrl, () => segmentRes(1_000_000, 0));

    const targets: ProbeTarget[] = [{ origin: 'http://cache1', urls: [playlistUrl] }];
    const probe = new DeliveryProbe(CFG, () => targets, fetchImpl);

    await probe.runOnce();
    await probe.runOnce();
    await probe.runOnce();

    const health = probe.snapshot().get('http://cache1');
    expect(health).toMatchObject({ healthyStreak: 3, slowStreak: 0 });
    expect(health?.lastProbeAt).not.toBeNull();
  });

  it('a slow segment body (arrayBuffer delayed past the throughput budget) is classified slow', async () => {
    const { fetchImpl, set } = makeFetch();
    const playlistUrl = 'http://cache2/hls/ch1.m3u8';
    const segUrl = 'http://cache2/hls/seg1.ts';
    // 0.1s segment, minSpeedFactor 2 -> budget 50ms; a 200ms body blows it
    const slowCfg: DeliveryProbeConfig = { intervalSec: 45, ttfbMs: 3000, minSpeedFactor: 2 };
    set(playlistUrl, () => playlistRes(playlist([{ uri: 'seg1.ts', durationSec: 0.1 }])));
    set(segUrl, () => segmentRes(1000, 200));

    const targets: ProbeTarget[] = [{ origin: 'http://cache2', urls: [playlistUrl] }];
    const probe = new DeliveryProbe(slowCfg, () => targets, fetchImpl);
    await probe.runOnce();

    expect(probe.snapshot().get('http://cache2')).toMatchObject({ slowStreak: 1, healthyStreak: 0 });
  });

  it('streak accumulation and reset: slow, slow, ok -> slowStreak 2 then healthyStreak 1 / slowStreak 0', async () => {
    const { fetchImpl, set } = makeFetch();
    const playlistUrl = 'http://cache3/hls/ch1.m3u8';
    const segUrl = 'http://cache3/hls/seg1.ts';
    const slowCfg: DeliveryProbeConfig = { intervalSec: 45, ttfbMs: 3000, minSpeedFactor: 2 };
    set(playlistUrl, () => playlistRes(playlist([{ uri: 'seg1.ts', durationSec: 0.1 }])));
    set(segUrl, () => segmentRes(1000, 200)); // slow

    const targets: ProbeTarget[] = [{ origin: 'http://cache3', urls: [playlistUrl] }];
    const probe = new DeliveryProbe(slowCfg, () => targets, fetchImpl);

    await probe.runOnce();
    let health = probe.snapshot().get('http://cache3');
    expect(health).toMatchObject({ slowStreak: 1, healthyStreak: 0 });

    await probe.runOnce();
    health = probe.snapshot().get('http://cache3');
    expect(health).toMatchObject({ slowStreak: 2, healthyStreak: 0 });

    set(segUrl, () => segmentRes(1000, 0)); // now fast
    await probe.runOnce();
    health = probe.snapshot().get('http://cache3');
    expect(health).toMatchObject({ slowStreak: 0, healthyStreak: 1 });
  });

  it('playlist fetch HTTP 500 -> slow', async () => {
    const { fetchImpl, set } = makeFetch();
    const playlistUrl = 'http://cache4/hls/ch1.m3u8';
    set(playlistUrl, () => playlistRes('', 500));
    const targets: ProbeTarget[] = [{ origin: 'http://cache4', urls: [playlistUrl] }];
    const probe = new DeliveryProbe(CFG, () => targets, fetchImpl);
    await probe.runOnce();
    expect(probe.snapshot().get('http://cache4')).toMatchObject({ slowStreak: 1, healthyStreak: 0 });
  });

  it('playlist with no segments -> slow', async () => {
    const { fetchImpl, set } = makeFetch();
    const playlistUrl = 'http://cache5/hls/ch1.m3u8';
    set(playlistUrl, () => playlistRes('#EXTM3U\n#EXT-X-TARGETDURATION:6\n'));
    const targets: ProbeTarget[] = [{ origin: 'http://cache5', urls: [playlistUrl] }];
    const probe = new DeliveryProbe(CFG, () => targets, fetchImpl);
    await probe.runOnce();
    expect(probe.snapshot().get('http://cache5')).toMatchObject({ slowStreak: 1, healthyStreak: 0 });
  });

  it('segment fetch throws -> slow, and other targets are still probed (isolation)', async () => {
    // hostnames are lowercase throughout: new URL(...).toString() lowercases
    // the authority when resolving the (possibly relative) segment URI, so a
    // mixed-case host here would silently miss the registered handler below
    const { fetchImpl, set } = makeFetch();
    const badPlaylist = 'http://cachebad/hls/ch1.m3u8';
    const badSeg = 'http://cachebad/hls/seg1.ts';
    const goodPlaylist = 'http://cachegood/hls/ch1.m3u8';
    const goodSeg = 'http://cachegood/hls/seg1.ts';

    set(badPlaylist, () => playlistRes(playlist([{ uri: 'seg1.ts', durationSec: 6 }])));
    set(badSeg, () => {
      throw new Error('network fail');
    });
    set(goodPlaylist, () => playlistRes(playlist([{ uri: 'seg1.ts', durationSec: 6 }])));
    set(goodSeg, () => segmentRes(1000, 0));

    const targets: ProbeTarget[] = [
      { origin: 'http://cachebad', urls: [badPlaylist] },
      { origin: 'http://cachegood', urls: [goodPlaylist] },
    ];
    const probe = new DeliveryProbe(CFG, () => targets, fetchImpl);
    await probe.runOnce();

    expect(probe.snapshot().get('http://cachebad')).toMatchObject({ slowStreak: 1, healthyStreak: 0 });
    expect(probe.snapshot().get('http://cachegood')).toMatchObject({ slowStreak: 0, healthyStreak: 1 });
  });

  it('round-robin: two urls on one origin alternate across rounds', async () => {
    const { fetchImpl, set, calls } = makeFetch();
    const u1 = 'http://cacherr/a/ch1.m3u8';
    const u2 = 'http://cacherr/b/ch1.m3u8';
    const seg1 = 'http://cacherr/a/seg1.ts';
    const seg2 = 'http://cacherr/b/seg1.ts';
    set(u1, () => playlistRes(playlist([{ uri: 'seg1.ts', durationSec: 6 }])));
    set(u2, () => playlistRes(playlist([{ uri: 'seg1.ts', durationSec: 6 }])));
    set(seg1, () => segmentRes(1000, 0));
    set(seg2, () => segmentRes(1000, 0));

    const targets: ProbeTarget[] = [{ origin: 'http://cacherr', urls: [u1, u2] }];
    const probe = new DeliveryProbe(CFG, () => targets, fetchImpl);

    await probe.runOnce();
    await probe.runOnce();
    await probe.runOnce();

    expect(calls).toEqual([u1, seg1, u2, seg2, u1, seg1]);
  });

  it('pruning: an origin removed from getTargets() disappears from snapshot()', async () => {
    const { fetchImpl, set } = makeFetch();
    const urlA = 'http://cachea/hls/ch1.m3u8';
    const segA = 'http://cachea/hls/seg1.ts';
    const urlB = 'http://cacheb/hls/ch1.m3u8';
    const segB = 'http://cacheb/hls/seg1.ts';
    set(urlA, () => playlistRes(playlist([{ uri: 'seg1.ts', durationSec: 6 }])));
    set(segA, () => segmentRes(1000, 0));
    set(urlB, () => playlistRes(playlist([{ uri: 'seg1.ts', durationSec: 6 }])));
    set(segB, () => segmentRes(1000, 0));

    let targets: ProbeTarget[] = [
      { origin: 'http://cachea', urls: [urlA] },
      { origin: 'http://cacheb', urls: [urlB] },
    ];
    const probe = new DeliveryProbe(CFG, () => targets, fetchImpl);
    await probe.runOnce();
    expect([...probe.snapshot().keys()].sort()).toEqual(['http://cachea', 'http://cacheb']);

    targets = [{ origin: 'http://cachea', urls: [urlA] }];
    await probe.runOnce();
    expect([...probe.snapshot().keys()]).toEqual(['http://cachea']);
  });

  it('resolves a relative segment URI against the playlist URL', async () => {
    const { fetchImpl, set, calls } = makeFetch();
    const playlistUrl = 'http://cacherel/live/chan/index.m3u8';
    const expectedSegUrl = 'http://cacherel/live/chan/seg42.ts';
    set(playlistUrl, () => playlistRes(playlist([{ uri: 'seg42.ts', durationSec: 6 }])));
    set(expectedSegUrl, () => segmentRes(1000, 0));

    const targets: ProbeTarget[] = [{ origin: 'http://cacherel', urls: [playlistUrl] }];
    const probe = new DeliveryProbe(CFG, () => targets, fetchImpl);
    await probe.runOnce();

    expect(calls).toEqual([playlistUrl, expectedSegUrl]);
    expect(probe.snapshot().get('http://cacherel')).toMatchObject({ healthyStreak: 1, slowStreak: 0 });
  });
});
