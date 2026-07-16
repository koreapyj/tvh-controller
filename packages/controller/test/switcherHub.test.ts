/*
 * SwitcherHub tests: a bare node:http server on port 0 with hub.attach(),
 * real `ws` clients dialing /ws/switcher. Hermetic — everything in-process.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { SseEvent, SwitcherDesiredState } from '@tvhc/shared';
import { WS_CLOSE_UNSUPPORTED_VERSION } from '@tvhc/shared';
import { EventBus } from '../src/state/events.js';
import { InstanceCache } from '../src/state/instanceCache.js';
import { SwitcherHub, SWITCHER_WS_PATH } from '../src/restreamer/switcherHub.js';
import { SWITCHER_CACHE_KEY, type DemandEvent } from '../src/restreamer/switcherHubTypes.js';

interface LoggedEvent {
  type: 'normal' | 'warning';
  service: string;
  source: string;
  message: string;
}

function doc(revision = 'rev-1'): SwitcherDesiredState {
  return { apiVersion: 1, revision, channels: [] };
}

interface Harness {
  hub: SwitcherHub;
  server: Server;
  port: number;
  cache: InstanceCache;
  events: SseEvent[];
  logs: LoggedEvent[];
  demands: DemandEvent[][];
  getDoc: ReturnType<typeof vi.fn>;
  setExpectedRevision: (rev: string | null) => void;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(): Promise<Harness> {
  const cache = new InstanceCache();
  const bus = new EventBus();
  const events: SseEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const logs: LoggedEvent[] = [];
  const demands: DemandEvent[][] = [];
  let expectedRevision: string | null = null;
  const getDoc = vi.fn(async () => doc());
  const hub = new SwitcherHub({
    cache,
    bus,
    events: { log: (e) => logs.push(e) },
    getDoc,
    onDemand: (e) => demands.push(e),
    getExpectedRevision: () => expectedRevision,
    publicUrl: 'https://tv.example',
    serverVersion: '9.9.9-test',
  });
  const server = createServer();
  hub.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  cleanups.push(async () => {
    hub.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    hub,
    server,
    port,
    cache,
    events,
    logs,
    demands,
    getDoc,
    setExpectedRevision: (rev) => {
      expectedRevision = rev;
    },
  };
}

interface Client {
  ws: WebSocket;
  frames: Array<Record<string, unknown>>;
  /** resolves once at least n frames have arrived */
  waitFrames: (n: number) => Promise<void>;
  send: (frame: unknown) => void;
  close: () => Promise<void>;
  closed: Promise<{ code: number }>;
}

async function connect(h: Harness, path = SWITCHER_WS_PATH): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${h.port}${path}`);
  const frames: Array<Record<string, unknown>> = [];
  const waiters: Array<{ n: number; resolve: () => void }> = [];
  ws.on('message', (data) => {
    frames.push(JSON.parse(String(data)) as Record<string, unknown>);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (frames.length >= waiters[i]!.n) {
        waiters[i]!.resolve();
        waiters.splice(i, 1);
      }
    }
  });
  const closed = new Promise<{ code: number }>((resolve) => {
    ws.on('close', (code) => resolve({ code }));
  });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  const client: Client = {
    ws,
    frames,
    waitFrames: (n) =>
      frames.length >= n
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiters.push({ n, resolve })),
    send: (frame) => ws.send(JSON.stringify(frame)),
    close: async () => {
      ws.close();
      await closed;
    },
    closed,
  };
  cleanups.push(() => {
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.terminate();
  });
  return client;
}

/** the hub processes incoming frames on the next tick — settle the loop */
function settle(ms = 30): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function aggregate(h: Harness) {
  return h.cache.switchers.get(SWITCHER_CACHE_KEY)!;
}

function status(
  channels: unknown[],
  desiredRevision: string | null = null,
): Record<string, unknown> {
  return { v: 1, type: 'status', desiredRevision, channels };
}

function chan(
  slug: string,
  activeUpstreamId: string | null,
  upstreams: Array<{ id: string; healthy: boolean; playlistLagSec?: number }>,
  lastSwitch: { at: string; from: string | null; to: string; reason: string } | null = null,
): Record<string, unknown> {
  return { slug, activeUpstreamId, upstreams, lastSwitch };
}

describe('SwitcherHub: connection lifecycle', () => {
  it('a connecting replica receives hello (serverVersion) then the current doc', async () => {
    const h = await setup();
    const c = await connect(h);
    await c.waitFrames(2);
    expect(c.frames[0]).toMatchObject({ v: 1, type: 'hello', serverVersion: '9.9.9-test' });
    expect(c.frames[1]).toMatchObject({ v: 1, type: 'doc', doc: { revision: 'rev-1' } });
    expect(h.getDoc).toHaveBeenCalledTimes(1);
    expect(h.hub.connectedCount()).toBe(1);
  });

  it('a failing getDoc sends hello only (no doc frame), and the socket stays open', async () => {
    const h = await setup();
    h.getDoc.mockRejectedValueOnce(new Error('db down'));
    const c = await connect(h);
    await c.waitFrames(1);
    await settle();
    expect(c.frames).toHaveLength(1);
    expect(c.frames[0]).toMatchObject({ type: 'hello' });
    expect(h.hub.connectedCount()).toBe(1);
  });

  it('an upgrade on any other path is destroyed, not upgraded', async () => {
    const h = await setup();
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws/other`);
    const err = await new Promise<Error>((resolve) => ws.on('error', resolve));
    expect(err).toBeInstanceOf(Error);
    expect(h.hub.connectedCount()).toBe(0);
  });

  it('a frame with an unsupported v closes the socket with 4400', async () => {
    const h = await setup();
    const c = await connect(h);
    c.send({ v: 2, type: 'status', desiredRevision: null, channels: [] });
    const { code } = await c.closed;
    expect(code).toBe(WS_CLOSE_UNSUPPORTED_VERSION);
    await settle();
    expect(h.hub.connectedCount()).toBe(0);
  });

  it('unknown frame types and non-JSON frames are ignored', async () => {
    const h = await setup();
    const c = await connect(h);
    c.send({ v: 1, type: 'future-thing', whatever: true });
    c.ws.send('not json');
    await settle();
    expect(h.hub.connectedCount()).toBe(1);
  });

  it('event-logs only the 0->N and N->0 transitions', async () => {
    const h = await setup();
    const c1 = await connect(h);
    expect(h.logs).toEqual([
      expect.objectContaining({ type: 'normal', service: 'restreamer', source: 'switcher' }),
    ]);
    const c2 = await connect(h); // second replica: no new log
    expect(h.logs).toHaveLength(1);

    await c1.close();
    await settle();
    expect(h.logs).toHaveLength(1); // one replica still connected
    await c2.close();
    await settle();
    expect(h.logs).toHaveLength(2);
    expect(h.logs[1]).toMatchObject({ type: 'warning', source: 'switcher' });
    expect(h.logs[1]!.message).toContain('disconnected');
  });
});

describe('SwitcherHub: broadcast', () => {
  it('broadcastDoc reaches every connected replica', async () => {
    const h = await setup();
    const c1 = await connect(h);
    const c2 = await connect(h);
    await c1.waitFrames(2);
    await c2.waitFrames(2);

    h.hub.broadcastDoc(doc('rev-2'));
    await c1.waitFrames(3);
    await c2.waitFrames(3);
    expect(c1.frames[2]).toMatchObject({ type: 'doc', doc: { revision: 'rev-2' } });
    expect(c2.frames[2]).toMatchObject({ type: 'doc', doc: { revision: 'rev-2' } });
  });

  it('broadcastSwitch reaches every replica and returns the count sent', async () => {
    const h = await setup();
    const c1 = await connect(h);
    const c2 = await connect(h);
    await c1.waitFrames(2);
    await c2.waitFrames(2);

    const sent = h.hub.broadcastSwitch('bbb', 'plc-2');
    expect(sent).toBe(2);
    await c1.waitFrames(3);
    await c2.waitFrames(3);
    expect(c1.frames[2]).toEqual({ v: 1, type: 'switch', slug: 'bbb', upstreamId: 'plc-2' });

    await c1.close();
    await c2.close();
    await settle();
    expect(h.hub.broadcastSwitch('bbb', 'plc-2')).toBe(0);
  });
});

describe('SwitcherHub: aggregate status merge', () => {
  it('a status frame builds the aggregate cache entry (reachable, version from hello, channels)', async () => {
    const h = await setup();
    const c = await connect(h);
    await c.waitFrames(2);
    c.send({ v: 1, type: 'hello', switcherVersion: '3.1.4', startedAt: '2026-07-01T00:00:00Z' });
    c.send(status([chan('bbb', 'plc-1', [{ id: 'plc-1', healthy: true }])], 'rev-1'));
    await settle();

    const agg = aggregate(h);
    expect(agg).toMatchObject({
      switcherId: SWITCHER_CACHE_KEY,
      url: 'ws',
      publicUrl: 'https://tv.example',
      reachable: true,
      error: null,
      version: '3.1.4',
      replicaCount: 1,
      channels: [
        {
          slug: 'bbb',
          activeUpstreamId: 'plc-1',
          upstreams: [{ id: 'plc-1', healthy: true }],
        },
      ],
    });
    expect(agg.lastPollAt).not.toBeNull();
  });

  it('activeUpstreamId: consensus value when all replicas agree, null when they disagree', async () => {
    const h = await setup();
    const c1 = await connect(h);
    const c2 = await connect(h);
    await c1.waitFrames(2);
    await c2.waitFrames(2);

    c1.send(status([chan('bbb', 'plc-1', [{ id: 'plc-1', healthy: true }])]));
    c2.send(status([chan('bbb', 'plc-1', [{ id: 'plc-1', healthy: true }])]));
    await settle();
    expect(aggregate(h).channels[0]!.activeUpstreamId).toBe('plc-1');

    c2.send(status([chan('bbb', 'plc-2', [{ id: 'plc-2', healthy: true }])]));
    await settle();
    // mid-propagation disagreement must not look like a confirmed switch
    expect(aggregate(h).channels[0]!.activeUpstreamId).toBeNull();
  });

  it('healthy AND-merges, playlistLagSec MAX-merges, upstream ids union', async () => {
    const h = await setup();
    const c1 = await connect(h);
    const c2 = await connect(h);
    await c1.waitFrames(2);
    await c2.waitFrames(2);

    c1.send(
      status([
        chan('bbb', 'plc-1', [
          { id: 'plc-1', healthy: true, playlistLagSec: 3 },
          { id: 'plc-2', healthy: true },
        ]),
      ]),
    );
    c2.send(
      status([
        chan('bbb', 'plc-1', [
          { id: 'plc-1', healthy: false, playlistLagSec: 9 },
          { id: 'plc-3', healthy: true, playlistLagSec: 1 },
        ]),
      ]),
    );
    await settle();

    const ups = aggregate(h).channels[0]!.upstreams;
    expect(ups).toContainEqual({ id: 'plc-1', healthy: false, playlistLagSec: 9 });
    expect(ups).toContainEqual({ id: 'plc-2', healthy: true });
    expect(ups).toContainEqual({ id: 'plc-3', healthy: true, playlistLagSec: 1 });
  });

  it('lastSwitch: newest by timestamp wins', async () => {
    const h = await setup();
    const c1 = await connect(h);
    const c2 = await connect(h);
    await c1.waitFrames(2);
    await c2.waitFrames(2);

    const older = { at: '2026-07-01T00:00:00Z', from: null, to: 'plc-1', reason: 'push' };
    const newer = { at: '2026-07-02T00:00:00Z', from: 'plc-1', to: 'plc-2', reason: 'failover' };
    c1.send(status([chan('bbb', null, [{ id: 'plc-1', healthy: true }], older)]));
    c2.send(status([chan('bbb', null, [{ id: 'plc-1', healthy: true }], newer)]));
    await settle();
    expect(aggregate(h).channels[0]!.lastSwitch).toEqual(newer);
  });

  it('pendingPush: false with no expectation; true when a replica reports a stale revision or 0 replicas with an expectation', async () => {
    const h = await setup();
    const c = await connect(h);
    await c.waitFrames(2);
    c.send(status([], 'rev-1'));
    await settle();
    expect(aggregate(h).pendingPush).toBe(false); // no expected revision yet

    h.setExpectedRevision('rev-2');
    c.send(status([], 'rev-1')); // stale
    await settle();
    expect(aggregate(h).pendingPush).toBe(true);

    c.send(status([], 'rev-2')); // caught up
    await settle();
    expect(aggregate(h).pendingPush).toBe(false);

    await c.close();
    await settle();
    expect(aggregate(h).pendingPush).toBe(true); // 0 replicas + an expectation
  });

  it('replica disconnect: replicaCount drops; at 0 the entry stays with reachable:false', async () => {
    const h = await setup();
    const c1 = await connect(h);
    const c2 = await connect(h);
    await c1.waitFrames(2);
    await c2.waitFrames(2);
    c1.send(status([chan('bbb', 'plc-1', [{ id: 'plc-1', healthy: true }])]));
    await settle();
    expect(aggregate(h).replicaCount).toBe(2);

    await c1.close();
    await settle();
    expect(aggregate(h)).toMatchObject({ reachable: true, replicaCount: 1 });

    await c2.close();
    await settle();
    expect(aggregate(h)).toMatchObject({
      reachable: false,
      replicaCount: 0,
      error: 'no switcher replicas connected',
      channels: [],
    });
  });

  it('publishes restreamer-switcher SSE only on meaningful change', async () => {
    const h = await setup();
    const c = await connect(h);
    await c.waitFrames(2);
    const countSse = () => h.events.filter((e) => e.type === 'restreamer-switcher').length;
    const afterConnect = countSse();

    c.send(status([chan('bbb', 'plc-1', [{ id: 'plc-1', healthy: true }])]));
    await settle();
    const afterFirstStatus = countSse();
    expect(afterFirstStatus).toBeGreaterThan(afterConnect);

    // identical status (only lastPollAt moves) — no re-publish
    c.send(status([chan('bbb', 'plc-1', [{ id: 'plc-1', healthy: true }])]));
    await settle();
    expect(countSse()).toBe(afterFirstStatus);

    // meaningful change — re-publish
    c.send(status([chan('bbb', 'plc-1', [{ id: 'plc-1', healthy: false }])]));
    await settle();
    expect(countSse()).toBe(afterFirstStatus + 1);
  });
});

describe('SwitcherHub: demand forwarding', () => {
  it('valid demand events reach onDemand; malformed entries are dropped', async () => {
    const h = await setup();
    const c = await connect(h);
    await c.waitFrames(2);

    c.send({
      v: 1,
      type: 'demand',
      events: [
        { slug: 'bbb', kind: 'master', at: '2026-07-15T00:00:00Z' },
        { slug: 'bbb', kind: 'media', at: '2026-07-15T00:00:01Z' },
        { slug: 'bad', kind: 'other', at: '2026-07-15T00:00:02Z' }, // invalid kind
        { kind: 'master', at: '2026-07-15T00:00:03Z' }, // missing slug
      ],
    });
    await settle();
    expect(h.demands).toHaveLength(1);
    expect(h.demands[0]).toEqual([
      { slug: 'bbb', kind: 'master', at: '2026-07-15T00:00:00Z' },
      { slug: 'bbb', kind: 'media', at: '2026-07-15T00:00:01Z' },
    ]);

    // an all-invalid batch never invokes the callback
    c.send({ v: 1, type: 'demand', events: [{ slug: 1, kind: 'master', at: 'x' }] });
    await settle();
    expect(h.demands).toHaveLength(1);
  });
});
