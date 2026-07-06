/*
 * Switcher desired-doc + push tests (B5): hermetic in-memory SQLite
 * (createTestDb), real InstanceCache/EventBus, hand-built topology snapshots,
 * fake restreamer nodes AND fake switchers at the client boundary. No network.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type { SseEvent, SwitcherChannelStatus, SwitcherNodeStatus } from '@tvhc/shared';
import type { Database } from '../src/db/schema.js';
import type { AppConfig } from '../src/config.js';
import type { InstancePoller } from '../src/tvh/poller.js';
import { EventBus } from '../src/state/events.js';
import { InstanceCache, type TopologySnapshot } from '../src/state/instanceCache.js';
import {
  RestreamerService,
  nodeKey,
  sessionsHash,
  type RestreamerNodeClient,
  type SwitcherNodeClient,
} from '../src/restreamer/service.js';
import { createTestDb } from './support/testDb.js';
import { fakeRestreamerNode } from './support/fakeRestreamerNode.js';
import { fakeSwitcher, type FakeSwitcher } from './support/fakeSwitcher.js';

// ---------- fixtures ----------

/** both zones carry BBB 10 (redundant channel base) and their own extras */
function zone1Topology(): TopologySnapshot {
  return {
    channels: [
      { uuid: 'ch-atx', name: 'AT-X', number: '9.1', services: ['svc-atx'] },
      { uuid: 'ch-bbb', name: 'BBB', number: '10', services: ['svc-bbb'] },
    ],
    tags: [],
    dvrConfigs: [],
    muxes: [],
    services: [
      { uuid: 'svc-atx', sid: 101 },
      { uuid: 'svc-bbb', sid: 102 },
    ],
    networks: [],
    hardware: [],
    frontendNetworks: new Map(),
    fetchedAt: Date.now(),
  };
}

function zone2Topology(): TopologySnapshot {
  return {
    channels: [{ uuid: 'ch2-bbb', name: 'BBB', number: '10', services: ['svc2-bbb'] }],
    tags: [],
    dvrConfigs: [],
    muxes: [],
    services: [{ uuid: 'svc2-bbb', sid: 202 }],
    networks: [],
    hardware: [],
    frontendNetworks: new Map(),
    fetchedAt: Date.now(),
  };
}

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    instances: [
      {
        id: 'zone1',
        name: 'zone1',
        url: 'http://zone1:9981',
        restreamer: {
          nodes: [
            // small egress budgets so a couple of ~3.4 Mbps channels create a
            // spread comfortably beyond the 0.15 hysteresis
            { id: 'n1', url: 'http://zone1-n1:5580', serveUrl: 'http://hls.zone1-n1', egressMbps: 10 },
            { id: 'n2', url: 'http://zone1-n2:5580' }, // no serveUrl
          ],
        },
      },
      {
        id: 'zone2',
        name: 'zone2',
        url: 'http://zone2:9981',
        restreamer: {
          nodes: [
            { id: 'n1', url: 'http://zone2-n1:5580', serveUrl: 'http://hls.zone2-n1', egressMbps: 10 },
          ],
        },
      },
    ],
    rclone: { remote: '' },
    databaseUrl: null,
    port: 0,
    pollIntervals: { dvr: 15_000, autorec: 60_000, topology: 600_000, epg: 600_000, restreamer: 15_000 },
    overlapThreshold: 0.7,
    autoUpload: { enabled: false, graceSeconds: 120 },
    restreamer: { switchers: [{ id: 'sw1', url: 'http://sw1:5581', publicUrl: 'https://tv.example' }] },
    ...overrides,
  };
}

function profilePayload(extra: Record<string, unknown> = {}): unknown {
  return { template: 'arib-hls', templateVersion: 1, video: { mode: 'ivtc' }, audio: [{}], ...extra };
}

interface Harness {
  db: Kysely<Database>;
  destroy: () => Promise<void>;
  cache: InstanceCache;
  events: SseEvent[];
  service: RestreamerService;
  switcher: FakeSwitcher;
  config: AppConfig;
}

async function setup(configOverrides: Partial<AppConfig> = {}): Promise<Harness> {
  const { db, destroy } = await createTestDb();
  const cache = new InstanceCache();
  const bus = new EventBus();
  const events: SseEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const config = makeConfig(configOverrides);
  const pollers = new Map<string, InstancePoller>();
  const clients = new Map<string, RestreamerNodeClient>();
  for (const inst of config.instances) {
    cache.init(inst.id, inst.name, inst.url);
    cache.get(inst.id).topology = inst.id === 'zone1' ? zone1Topology() : zone2Topology();
    pollers.set(inst.id, { pollTopology: vi.fn(async () => {}) } as unknown as InstancePoller);
    for (const n of inst.restreamer?.nodes ?? []) {
      clients.set(nodeKey(inst.id, n.id), fakeRestreamerNode());
    }
  }
  const switcher = fakeSwitcher();
  const switcherClients = new Map<string, SwitcherNodeClient>();
  for (const sw of config.restreamer?.switchers ?? []) switcherClients.set(sw.id, switcher);
  const service = new RestreamerService(db, cache, pollers, bus, config, clients, switcherClients);
  return { db, destroy, cache, events, service, switcher, config };
}

function switcherStateRow(db: Kysely<Database>, switcherId: string) {
  return db
    .selectFrom('restream_switcher_state')
    .selectAll()
    .where('switcher_id', '=', switcherId)
    .executeTakeFirst();
}

function seedSwitcherStatus(
  cache: InstanceCache,
  switcherId: string,
  channels: SwitcherChannelStatus[] = [],
): void {
  const status: SwitcherNodeStatus = {
    switcherId,
    url: `http://${switcherId}:5581`,
    publicUrl: 'https://tv.example',
    reachable: true,
    error: null,
    lastPollAt: null,
    version: '1.0.0',
    pendingPush: false,
    channels,
  };
  cache.switchers.set(switcherId, status);
}

let profileSeq = 0;

/** create a profile + a redundant channel across zone1/n1 and zone2/n1 */
async function seedRedundant(h: Harness, name = 'BBB', number = '10') {
  const profile = await h.service.createProfile(`p-${name}-${++profileSeq}`, profilePayload());
  const channel = await h.service.createChannel({
    channelName: name,
    channelNumber: number,
    profileId: profile.id,
    placements: [
      { instanceId: 'zone1', nodeId: 'n1' },
      { instanceId: 'zone2', nodeId: 'n1' },
    ],
  });
  const placements = (await h.service.listChannels()).find((c) => c.id === channel.id)!.placements;
  return { profile, channel, placements };
}

// ---------- computeSwitcherDoc ----------

describe('computeSwitcherDoc', () => {
  it('includes only enabled channels with ≥2 enabled placements, upstreams in priority order', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    // single placement — not redundant, not the switcher's business
    await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const { channel, placements } = await seedRedundant(h);

    const { doc, blocked } = await h.service.computeSwitcherDoc();
    expect(blocked).toEqual([]);
    expect(doc.apiVersion).toBe(1);
    expect(doc.channels).toHaveLength(1);
    const ch = doc.channels[0]!;
    expect(ch.slug).toBe('bbb');
    expect(ch.segmentSeconds).toBe(5); // contract default
    expect(ch.upstreams).toEqual([
      { id: placements[0]!.id, url: 'http://hls.zone1-n1/bbb', priority: 1 },
      { id: placements[1]!.id, url: 'http://hls.zone2-n1/bbb', priority: 2 },
    ]);
    expect(doc.revision).toBe(sessionsHash(doc.channels));

    // disabling the channel removes it from the doc
    await h.service.updateChannel(channel.id, { enabled: false });
    const after = await h.service.computeSwitcherDoc();
    expect(after.doc.channels).toHaveLength(0);
    await h.destroy();
  });

  it('skips serveUrl-less placements with a reason; <2 usable upstreams skips the channel', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    // placements on zone1/n1 (serveUrl) and zone1/n2 (NO serveUrl): redundant
    // by placement count but only one usable upstream — channel skipped
    const chan = await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [
        { instanceId: 'zone1', nodeId: 'n1' },
        { instanceId: 'zone1', nodeId: 'n2' },
      ],
    });

    const { doc, blocked } = await h.service.computeSwitcherDoc();
    expect(doc.channels).toHaveLength(0);
    expect(blocked).toHaveLength(2);
    expect(blocked[0]!.reason).toContain('has no serveUrl');
    expect(blocked[0]!.placementId).not.toBeNull();
    expect(blocked[1]).toMatchObject({ channelId: chan.id, slug: 'at-x', placementId: null });
    expect(blocked[1]!.reason).toContain('fewer than 2 usable upstreams');

    // a third, usable placement fixes it: channel included, n2 still blocked
    await h.service.addPlacement(chan.id, { instanceId: 'zone2', nodeId: 'n1' });
    const after = await h.service.computeSwitcherDoc();
    expect(after.doc.channels.map((c) => c.slug)).toEqual(['at-x']);
    expect(after.doc.channels[0]!.upstreams).toHaveLength(2);
    expect(after.blocked).toHaveLength(1);
    await h.destroy();
  });

  it('sorts channels by slug and produces a stable revision', async () => {
    const h = await setup();
    await seedRedundant(h, 'ZZ Chan', '10');
    await seedRedundant(h, 'AA Chan', '10');
    const a = await h.service.computeSwitcherDoc();
    const b = await h.service.computeSwitcherDoc();
    expect(a.doc.channels.map((c) => c.slug)).toEqual(['aa-chan', 'zz-chan']);
    expect(a.doc.revision).toBe(b.doc.revision);
    await h.destroy();
  });

  it('takes segmentSeconds from the profile payload (hls.segmentSeconds)', async () => {
    const h = await setup();
    const profile = await h.service.createProfile(
      'seg6',
      profilePayload({ hls: { segmentSeconds: 6 } }),
    );
    await h.service.createChannel({
      channelName: 'BBB',
      channelNumber: '10',
      profileId: profile.id,
      placements: [
        { instanceId: 'zone1', nodeId: 'n1' },
        { instanceId: 'zone2', nodeId: 'n1' },
      ],
    });
    const { doc } = await h.service.computeSwitcherDoc();
    expect(doc.channels[0]!.segmentSeconds).toBe(6);
    await h.destroy();
  });
});

// ---------- push ----------

describe('switcher push', () => {
  it('a mutation that creates a redundant channel pushes the switcher doc automatically', async () => {
    const h = await setup();
    await seedRedundant(h);
    expect(h.switcher.puts()).toHaveLength(1);
    expect(h.switcher.desired!.channels.map((c) => c.slug)).toEqual(['bbb']);
    const state = await switcherStateRow(h.db, 'sw1');
    expect(state!.pushed_hash).toBe(h.switcher.desired!.revision);
    await h.destroy();
  });

  it('hash-skip on unchanged doc; force bypasses; upsert roundtrip', async () => {
    const h = await setup();
    await seedRedundant(h);
    const firstHash = (await switcherStateRow(h.db, 'sw1'))!.pushed_hash;

    const second = await h.service.pushSwitcher('sw1');
    expect(second.action).toBe('skipped');
    expect(h.switcher.puts()).toHaveLength(1);

    const forced = await h.service.pushSwitcher('sw1', true);
    expect(forced.action).toBe('pushed');
    expect(h.switcher.puts()).toHaveLength(2);
    expect((await switcherStateRow(h.db, 'sw1'))!.pushed_hash).toBe(firstHash);

    // a real change updates the stored hash (upsert, not insert-only)
    const { channel } = { channel: (await h.service.listChannels())[0]! };
    await h.service.updateChannel(channel.id, { slug: 'bbb-renamed' });
    const after = await switcherStateRow(h.db, 'sw1');
    expect(after!.pushed_hash).not.toBe(firstHash);
    expect(h.switcher.desired!.channels[0]!.slug).toBe('bbb-renamed');
    await h.destroy();
  });

  it('a never-pushed switcher with an empty doc is left alone', async () => {
    const h = await setup();
    const results = await h.service.pushAllSwitchers();
    expect(results).toEqual([
      { switcherId: 'sw1', action: 'skipped', detail: 'nothing to manage', blocked: [] },
    ]);
    expect(h.switcher.puts()).toHaveLength(0);
    expect(await switcherStateRow(h.db, 'sw1')).toBeUndefined();
    await h.destroy();
  });

  it('adding a second placement makes the switcher doc gain the channel', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    const chan = await h.service.createChannel({
      channelName: 'BBB',
      channelNumber: '10',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    expect(h.switcher.puts()).toHaveLength(0); // single placement: nothing to manage

    await h.service.addPlacement(chan.id, { instanceId: 'zone2', nodeId: 'n1' });
    expect(h.switcher.puts()).toHaveLength(1);
    expect(h.switcher.desired!.channels.map((c) => c.slug)).toEqual(['bbb']);

    // removing it again empties the pushed doc (state exists → push happens)
    const placements = (await h.service.listChannels())[0]!.placements;
    await h.service.deletePlacement(placements[1]!.id);
    expect(h.switcher.desired!.channels).toHaveLength(0);
    await h.destroy();
  });

  it('a push failure keeps the mutation successful and the old state; the sweep heals', async () => {
    const h = await setup();
    await seedRedundant(h);
    const oldHash = (await switcherStateRow(h.db, 'sw1'))!.pushed_hash;

    h.switcher.failNextPut();
    const { channel } = { channel: (await h.service.listChannels())[0]! };
    await h.service.updateChannel(channel.id, { slug: 'bbb-x' }); // does not throw
    expect((await switcherStateRow(h.db, 'sw1'))!.pushed_hash).toBe(oldHash);

    vi.useFakeTimers();
    h.service.startSweep();
    await vi.advanceTimersByTimeAsync(60_000);
    h.service.stopSweep();
    vi.useRealTimers();
    await h.service.pushAllSwitchers(); // join the op chain

    expect((await switcherStateRow(h.db, 'sw1'))!.pushed_hash).not.toBe(oldHash);
    expect(h.switcher.desired!.channels[0]!.slug).toBe('bbb-x');
    await h.destroy();
  });

  it('push outcomes patch the cached switcher status and publish SSE', async () => {
    const h = await setup();
    seedSwitcherStatus(h.cache, 'sw1');
    h.switcher.failNextPut(new Error('boom'));
    await seedRedundant(h);
    let entry = h.cache.switchers.get('sw1')!;
    expect(entry.pendingPush).toBe(true);
    expect(entry.error).toBe('boom');
    expect(h.events.some((e) => e.type === 'restreamer-switcher')).toBe(true);

    await h.service.pushSwitcher('sw1');
    entry = h.cache.switchers.get('sw1')!;
    expect(entry.pendingPush).toBe(false);
    await h.destroy();
  });
});

// ---------- poller hooks ----------

describe('switcher poller hooks', () => {
  it('getExpectedRevision is the stored pushed hash, null before any push', async () => {
    const h = await setup();
    const hooks = h.service.switcherPollerHooks();
    expect(await hooks.getExpectedRevision!('sw1')).toBeNull();
    await seedRedundant(h);
    expect(await hooks.getExpectedRevision!('sw1')).toBe(h.switcher.desired!.revision);
    await h.destroy();
  });

  it('getPendingPush reflects computed-vs-pushed drift', async () => {
    const h = await setup();
    const hooks = h.service.switcherPollerHooks();
    expect(await hooks.getPendingPush!('sw1')).toBe(false); // empty doc, nothing pushed
    await seedRedundant(h);
    expect(await hooks.getPendingPush!('sw1')).toBe(false); // pushed by the mutation

    h.switcher.failNextPut();
    const chan = (await h.service.listChannels())[0]!;
    await h.service.updateChannel(chan.id, { slug: 'bbb-y' });
    expect(await hooks.getPendingPush!('sw1')).toBe(true);
    await h.destroy();
  });

  it('onRevisionMismatch force-pushes (switcher lost its PVC/state file)', async () => {
    const h = await setup();
    await seedRedundant(h);
    expect(h.switcher.puts()).toHaveLength(1);
    h.switcher.desired = null; // simulate state loss

    const hooks = h.service.switcherPollerHooks();
    hooks.onRevisionMismatch!('sw1', null);
    await h.service.pushAllSwitchers(); // join the serialized op chain
    expect(h.switcher.puts().length).toBeGreaterThanOrEqual(2);
    expect(h.switcher.desired!.channels.map((c) => c.slug)).toEqual(['bbb']);
    await h.destroy();
  });
});

// ---------- rebalance driver ----------

describe('rebalanceTick', () => {
  function switcherChannel(
    slug: string,
    active: string,
    upstreamIds: string[],
    lastSwitchAt: string | null,
  ): SwitcherChannelStatus {
    return {
      slug,
      activeUpstreamId: active,
      upstreams: upstreamIds.map((id) => ({ id, healthy: true })),
      lastSwitch: lastSwitchAt
        ? { at: lastSwitchAt, from: null, to: active, reason: 'failover' }
        : null,
    };
  }

  it('issues the planned switch through the switcher client', async () => {
    const h = await setup();
    // two redundant channels, both ACTIVE on zone1/n1 → clear imbalance
    const a = await seedRedundant(h, 'BBB', '10');
    const b = await seedRedundant(h, 'BBB', '10'); // slug uniquified to bbb-2
    const ids = (ps: typeof a.placements) => ps.map((p) => p.id);
    seedSwitcherStatus(h.cache, 'sw1', [
      switcherChannel('bbb', a.placements[0]!.id, ids(a.placements), null),
      switcherChannel('bbb-2', b.placements[0]!.id, ids(b.placements), null),
    ]);

    await h.service.rebalanceTick(new Date());
    expect(h.switcher.switches()).toHaveLength(1);
    const sw = h.switcher.switches()[0]!;
    expect(sw.slug).toBe('bbb'); // deterministic: lower slug first
    expect(sw.upstreamId).toBe(a.placements[1]!.id); // the zone2 upstream
    await h.destroy();
  });

  it('honors the sticky window: a recently switched channel is passed over', async () => {
    const h = await setup();
    const a = await seedRedundant(h, 'BBB', '10');
    const b = await seedRedundant(h, 'BBB', '10');
    const now = new Date();
    const recent = new Date(now.getTime() - 10 * 60_000).toISOString();
    const stale = new Date(now.getTime() - 2 * 3_600_000).toISOString();
    seedSwitcherStatus(h.cache, 'sw1', [
      // bbb (the lower slug, otherwise preferred) switched 10 min ago — sticky
      switcherChannel('bbb', a.placements[0]!.id, a.placements.map((p) => p.id), recent),
      switcherChannel('bbb-2', b.placements[0]!.id, b.placements.map((p) => p.id), stale),
    ]);

    await h.service.rebalanceTick(now);
    expect(h.switcher.switches()).toHaveLength(1);
    expect(h.switcher.switches()[0]).toMatchObject({
      slug: 'bbb-2',
      upstreamId: b.placements[1]!.id,
    });
    await h.destroy();
  });

  it('never rebalances channels the switcher does not report yet', async () => {
    const h = await setup();
    const a = await seedRedundant(h, 'BBB', '10');
    await seedRedundant(h, 'BBB', '10'); // bbb-2: NOT in the switcher status
    seedSwitcherStatus(h.cache, 'sw1', [
      // only bbb is known: its own move buys nothing (same spread), and the
      // unreported bbb-2 must contribute neither load nor a move
      switcherChannel('bbb', a.placements[0]!.id, a.placements.map((p) => p.id), null),
    ]);

    await h.service.rebalanceTick(new Date());
    expect(h.switcher.switches()).toHaveLength(0);
    await h.destroy();
  });

  it('tolerates a failing switch command', async () => {
    const h = await setup();
    const a = await seedRedundant(h, 'BBB', '10');
    const b = await seedRedundant(h, 'BBB', '10');
    seedSwitcherStatus(h.cache, 'sw1', [
      switcherChannel('bbb', a.placements[0]!.id, a.placements.map((p) => p.id), null),
      switcherChannel('bbb-2', b.placements[0]!.id, b.placements.map((p) => p.id), null),
    ]);
    h.switcher.failNextSwitch();
    await expect(h.service.rebalanceTick(new Date())).resolves.toBeUndefined();
    await h.destroy();
  });
});
