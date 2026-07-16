/*
 * Switcher desired-doc + push tests: hermetic in-memory SQLite
 * (createTestDb), real InstanceCache/EventBus, hand-built topology snapshots,
 * fake restreamer nodes AND a fake switcher hub at the SwitcherHubLike
 * boundary. No network.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type { SseEvent, SwitcherChannelStatus } from '@tvhc/shared';
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
} from '../src/restreamer/service.js';
import { createTestDb } from './support/testDb.js';
import { fakeRestreamerNode } from './support/fakeRestreamerNode.js';
import { FakeSwitcherHub, seedReplicaStatus } from './support/fakeSwitcherHub.js';

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
    restreamer: { switcher: { publicUrl: 'https://tv.example' } },
    eventLogRetentionDays: 30,
    ...overrides,
  };
}

function profilePayload(extra: Record<string, unknown> = {}): unknown {
  return { template: 'arib-hls', templateVersion: 1, video: { mode: 'ivtc' }, audio: [{}], ...extra };
}

interface LoggedEvent {
  type: 'normal' | 'warning';
  service: string;
  source: string;
  message: string;
}

interface Harness {
  db: Kysely<Database>;
  destroy: () => Promise<void>;
  cache: InstanceCache;
  events: SseEvent[];
  service: RestreamerService;
  hub: FakeSwitcherHub;
  config: AppConfig;
  logs: LoggedEvent[];
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
  const hub = new FakeSwitcherHub();
  const logs: LoggedEvent[] = [];
  const service = new RestreamerService(db, cache, pollers, bus, config, clients, hub, {
    log: (e) => logs.push(e),
  });
  return { db, destroy, cache, events, service, hub, config, logs };
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
    force: true, // callers pass names that resolve nowhere — resolution is not under test here
  });
  const placements = (await h.service.listChannels()).find((c) => c.id === channel.id)!.placements;
  return { profile, channel, placements };
}

// ---------- computeSwitcherDoc ----------

describe('computeSwitcherDoc', () => {
  it('includes every enabled channel with ≥1 usable upstream, upstreams in priority order', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    // single placement — with a switcher configured it is fronted too, with a
    // one-entry upstreams array mirroring its one node
    const single = await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const { channel, placements } = await seedRedundant(h);

    const { doc, blocked } = await h.service.computeSwitcherDoc();
    expect(blocked).toEqual([]);
    expect(doc.apiVersion).toBe(1);
    expect(doc.channels.map((c) => c.slug)).toEqual(['at-x', 'bbb']);
    const singlePlacement = (await h.service.listChannels()).find((c) => c.id === single.id)!
      .placements[0]!;
    // upstream URL path segment is the placement id, not the channel slug
    expect(doc.channels[0]!.upstreams).toEqual([
      { id: singlePlacement.id, url: `http://hls.zone1-n1/${singlePlacement.id}`, priority: 1 },
    ]);
    const ch = doc.channels[1]!;
    expect(ch.segmentSeconds).toBe(5); // contract default
    expect(ch.upstreams).toEqual([
      { id: placements[0]!.id, url: `http://hls.zone1-n1/${placements[0]!.id}`, priority: 1 },
      { id: placements[1]!.id, url: `http://hls.zone2-n1/${placements[1]!.id}`, priority: 2 },
    ]);
    expect(doc.revision).toBe(sessionsHash(doc.channels));

    // disabling a channel removes it from the doc
    await h.service.updateChannel(channel.id, { enabled: false });
    const after = await h.service.computeSwitcherDoc();
    expect(after.doc.channels.map((c) => c.slug)).toEqual(['at-x']);
    await h.destroy();
  });

  it('skips serveUrl-less placements with a reason; 0 usable upstreams skips the channel', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    // placements on zone1/n1 (serveUrl) and zone1/n2 (NO serveUrl): one
    // usable upstream — channel stays in the doc, n2 blocked with a reason
    const chan = await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [
        { instanceId: 'zone1', nodeId: 'n1' },
        { instanceId: 'zone1', nodeId: 'n2' },
      ],
    });

    const n1PlacementId = (await h.service.listChannels()).find((c) => c.id === chan.id)!
      .placements.find((pl) => pl.nodeId === 'n1')!.id;
    const { doc, blocked } = await h.service.computeSwitcherDoc();
    expect(doc.channels.map((c) => c.slug)).toEqual(['at-x']);
    expect(doc.channels[0]!.upstreams).toEqual([
      { id: n1PlacementId, url: `http://hls.zone1-n1/${n1PlacementId}`, priority: 1 },
    ]);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.reason).toContain('has no serveUrl');
    expect(blocked[0]!.placementId).not.toBeNull();
    expect(blocked[0]!.channelId).toBe(chan.id);

    // a channel whose ONLY placement is unusable is skipped entirely
    const zero = await h.service.createChannel({
      channelName: 'ZeroUp',
      channelNumber: '99',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n2' }],
      force: true, // ZeroUp resolves nowhere — write-time availability would 409
    });
    const after = await h.service.computeSwitcherDoc();
    expect(after.doc.channels.map((c) => c.slug)).toEqual(['at-x']);
    const zeroBlocked = after.blocked.filter((b) => b.channelId === zero.id);
    expect(zeroBlocked).toHaveLength(2); // the n2 placement + the whole channel
    expect(zeroBlocked[1]).toMatchObject({ channelId: zero.id, slug: 'zeroup', placementId: null });
    expect(zeroBlocked[1]!.reason).toContain('no usable upstreams');
    await h.destroy();
  });

  it('the revision changes when a single-placement channel appears', async () => {
    const h = await setup();
    await seedRedundant(h);
    const before = await h.service.computeSwitcherDoc();

    const p = await h.service.createProfile('p-single', profilePayload());
    await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const after = await h.service.computeSwitcherDoc();
    expect(after.doc.channels).toHaveLength(2);
    expect(after.doc.revision).not.toBe(before.doc.revision);
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

  it('two placements on nodes sharing the same serveUrl (shared cache) still get distinct upstream URLs from the placement id', async () => {
    // n1 and n3 are configured with the IDENTICAL serveUrl (e.g. both fronted
    // by the same cache host) — under the old slug-keyed URL scheme this
    // collided (`${serveUrl}/${slug}` identical for both); placement ids fix it.
    const h = await setup({
      instances: [
        {
          id: 'zone1',
          name: 'zone1',
          url: 'http://zone1:9981',
          restreamer: {
            nodes: [
              { id: 'n1', url: 'http://zone1-n1:5580', serveUrl: 'http://hls.zone1-n1', egressMbps: 10 },
              { id: 'n3', url: 'http://zone1-n3:5580', serveUrl: 'http://hls.zone1-n1', egressMbps: 10 },
            ],
          },
        },
      ],
    });
    const p = await h.service.createProfile('p', profilePayload());
    const chan = await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [
        { instanceId: 'zone1', nodeId: 'n1' },
        { instanceId: 'zone1', nodeId: 'n3' },
      ],
    });
    const placements = (await h.service.listChannels()).find((c) => c.id === chan.id)!.placements;
    const n1Placement = placements.find((pl) => pl.nodeId === 'n1')!;
    const n3Placement = placements.find((pl) => pl.nodeId === 'n3')!;
    expect(n1Placement.id).not.toBe(n3Placement.id);

    const { doc } = await h.service.computeSwitcherDoc();
    const ch = doc.channels.find((c) => c.slug === 'at-x')!;
    const urls = ch.upstreams.map((u) => u.url);
    expect(new Set(urls).size).toBe(urls.length); // no collision despite identical serveUrl
    expect(ch.upstreams).toEqual([
      { id: n1Placement.id, url: `http://hls.zone1-n1/${n1Placement.id}`, priority: 1 },
      { id: n3Placement.id, url: `http://hls.zone1-n1/${n3Placement.id}`, priority: 2 },
    ]);
    await h.destroy();
  });
});

// ---------- failover state placements (cold-backup successor) ----------

describe('computeSwitcherDoc: failover state placements', () => {
  async function insertFailoverRow(
    h: Harness,
    fields: {
      channelId: string;
      fromPlacementId: string | null;
      toPlacementId: string;
      phase?: string;
      suppressFrom?: boolean;
    },
  ): Promise<void> {
    await h.db
      .insertInto('restream_failover_state')
      .values({
        channel_id: fields.channelId,
        from_placement_id: fields.fromPlacementId,
        to_placement_id: fields.toPlacementId,
        phase: fields.phase ?? 'complete',
        trigger_reason: 'manual',
        trigger_node_id: null,
        trigger_detail: null,
        suppress_from: fields.suppressFrom ? 1 : 0,
        drain_until: null,
        started_at: '2026-01-01 00:00:00',
        updated_at: '2026-01-01 00:00:00',
      })
      .execute();
  }

  it('excludes an enabled cold placement without a failover row; includes it at its priority once it is a to_placement', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    const chan = await h.service.createChannel({
      channelName: 'BBB',
      channelNumber: '10',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }], // hot, priority 1
    });
    const hotId = (await h.service.listChannels()).find((c) => c.id === chan.id)!.placements[0]!.id;
    const cold = await h.service.addPlacement(chan.id, {
      instanceId: 'zone2',
      nodeId: 'n1',
      mode: 'cold',
      priority: 2,
    });

    const before = await h.service.computeSwitcherDoc();
    const chBefore = before.doc.channels.find((c) => c.slug === 'bbb')!;
    expect(chBefore.upstreams.map((u) => u.id)).toEqual([hotId]);

    await insertFailoverRow(h, { channelId: chan.id, fromPlacementId: hotId, toPlacementId: cold.id });

    const after = await h.service.computeSwitcherDoc();
    const chAfter = after.doc.channels.find((c) => c.slug === 'bbb')!;
    // priority order: the hot placement (priority 1) first, the now-targeted cold one (priority 2) second
    expect(chAfter.upstreams.map((u) => u.id)).toEqual([hotId, cold.id]);
    await h.destroy();
  });

  it('a suppressed from_placement STAYS in the switcher doc for the whole row lifetime (deliberate divergence from node docs)', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    const chan = await h.service.createChannel({
      channelName: 'BBB',
      channelNumber: '10',
      profileId: p.id,
      placements: [
        { instanceId: 'zone1', nodeId: 'n1' }, // hot, priority 1 (the eventual "from")
        { instanceId: 'zone2', nodeId: 'n1' }, // hot, priority 2 (the eventual "to")
      ],
    });
    const placements = (await h.service.listChannels()).find((c) => c.id === chan.id)!.placements;
    const fromId = placements[0]!.id;
    const toId = placements[1]!.id;

    await insertFailoverRow(h, {
      channelId: chan.id,
      fromPlacementId: fromId,
      toPlacementId: toId,
      phase: 'complete',
      suppressFrom: true,
    });

    const { doc } = await h.service.computeSwitcherDoc();
    const ch = doc.channels.find((c) => c.slug === 'bbb')!;
    // node doc for `from`'s node would exclude it (suppress_from + complete); the
    // switcher doc keeps BOTH upstreams so retained seg/<from>/ URIs stay resolvable
    expect(ch.upstreams.map((u) => u.id).sort()).toEqual([fromId, toId].sort());
    await h.destroy();
  });

  it('an all-cold channel with no failover row is still included (idle on-demand): onDemandIdle=true, activeUpstreamId is the lowest-priority upstream', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    const chan = await h.service.createChannel({
      channelName: 'BBB',
      channelNumber: '10',
      profileId: p.id,
      placements: [
        { instanceId: 'zone1', nodeId: 'n1', mode: 'cold', priority: 1 },
        { instanceId: 'zone2', nodeId: 'n1', mode: 'cold', priority: 2 },
      ],
      force: true,
    });
    const placements = (await h.service.listChannels()).find((c) => c.id === chan.id)!.placements;
    const p1 = placements.find((pl) => pl.priority === 1)!;
    const p2 = placements.find((pl) => pl.priority === 2)!;

    const { doc, blocked } = await h.service.computeSwitcherDoc();
    expect(blocked).toEqual([]);
    const ch = doc.channels.find((c) => c.slug === 'bbb')!;
    expect(ch.upstreams.map((u) => u.id)).toEqual([p1.id, p2.id]);
    expect(ch.onDemandIdle).toBe(true);
    expect(ch.activeUpstreamId).toBe(p1.id);
    await h.destroy();
  });

  it('an all-cold channel with a complete failover row is included with no onDemandIdle, activeUpstreamId = the row target', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    const chan = await h.service.createChannel({
      channelName: 'BBB',
      channelNumber: '10',
      profileId: p.id,
      placements: [
        { instanceId: 'zone1', nodeId: 'n1', mode: 'cold', priority: 1 },
        { instanceId: 'zone2', nodeId: 'n1', mode: 'cold', priority: 2 },
      ],
      force: true,
    });
    const placements = (await h.service.listChannels()).find((c) => c.id === chan.id)!.placements;
    const p1 = placements.find((pl) => pl.priority === 1)!;
    const p2 = placements.find((pl) => pl.priority === 2)!;
    // activated onto the HIGHER-priority-number placement — the row wins over the priority default
    await insertFailoverRow(h, { channelId: chan.id, fromPlacementId: null, toPlacementId: p2.id });

    const { doc } = await h.service.computeSwitcherDoc();
    const ch = doc.channels.find((c) => c.slug === 'bbb')!;
    expect(ch.upstreams.map((u) => u.id)).toEqual([p1.id, p2.id]);
    expect(ch.onDemandIdle).toBeUndefined();
    expect(ch.activeUpstreamId).toBe(p2.id);
    await h.destroy();
  });

  it('a hot channel with no failover row: activeUpstreamId is the lowest-priority hot placement, no onDemandIdle', async () => {
    const h = await setup();
    const { placements } = await seedRedundant(h);
    const { doc } = await h.service.computeSwitcherDoc();
    const ch = doc.channels.find((c) => c.slug === 'bbb')!;
    expect(ch.activeUpstreamId).toBe(placements[0]!.id); // priority 1
    expect(ch.onDemandIdle).toBeUndefined();
    await h.destroy();
  });

  it('a hot channel with a failover row: activeUpstreamId is the row target even when it is not the lowest priority', async () => {
    const h = await setup();
    const { channel, placements } = await seedRedundant(h);
    await insertFailoverRow(h, {
      channelId: channel.id,
      fromPlacementId: placements[0]!.id,
      toPlacementId: placements[1]!.id, // priority 2 — NOT the lowest
    });
    const { doc } = await h.service.computeSwitcherDoc();
    const ch = doc.channels.find((c) => c.slug === 'bbb')!;
    expect(ch.activeUpstreamId).toBe(placements[1]!.id);
    await h.destroy();
  });

  it('the row target is skipped (no serveUrl): activeUpstreamId falls back to the preferred hot upstream', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    const chan = await h.service.createChannel({
      channelName: 'BBB',
      channelNumber: '10',
      profileId: p.id,
      placements: [
        { instanceId: 'zone1', nodeId: 'n1', mode: 'hot', priority: 1 }, // usable
        { instanceId: 'zone1', nodeId: 'n2', mode: 'cold', priority: 2 }, // no serveUrl
      ],
      force: true,
    });
    const placements = (await h.service.listChannels()).find((c) => c.id === chan.id)!.placements;
    const hotId = placements.find((pl) => pl.priority === 1)!.id;
    const coldId = placements.find((pl) => pl.priority === 2)!.id;
    await insertFailoverRow(h, { channelId: chan.id, fromPlacementId: hotId, toPlacementId: coldId });

    const { doc, blocked } = await h.service.computeSwitcherDoc();
    const ch = doc.channels.find((c) => c.slug === 'bbb')!;
    expect(ch.upstreams.map((u) => u.id)).toEqual([hotId]); // the cold target is blocked, not emitted
    expect(blocked.some((b) => b.placementId === coldId)).toBe(true);
    expect(ch.activeUpstreamId).toBe(hotId); // falls back past the (unemitted) row target to the preferred hot
    await h.destroy();
  });
});

// ---------- push (hub broadcast) ----------

describe('switcher push', () => {
  it('a mutation that creates a redundant channel broadcasts the switcher doc automatically', async () => {
    const h = await setup();
    await seedRedundant(h);
    expect(h.hub.docs).toHaveLength(1);
    expect(h.hub.lastDoc()!.channels.map((c) => c.slug)).toEqual(['bbb']);
    expect(h.service.switcherExpectedRevision()).toBe(h.hub.lastDoc()!.revision);
    await h.destroy();
  });

  it('revision-skip on unchanged doc; force bypasses; a real change re-broadcasts', async () => {
    const h = await setup();
    await seedRedundant(h);
    const firstRevision = h.hub.lastDoc()!.revision;

    const second = await h.service.pushAllSwitchers();
    expect(second.action).toBe('skipped');
    expect(h.hub.docs).toHaveLength(1);

    const forced = await h.service.pushAllSwitchers(true);
    expect(forced.action).toBe('pushed');
    expect(h.hub.docs).toHaveLength(2);
    expect(h.hub.lastDoc()!.revision).toBe(firstRevision);

    // a real change broadcasts a new revision
    const { channel } = { channel: (await h.service.listChannels())[0]! };
    await h.service.updateChannel(channel.id, { slug: 'bbb-renamed' });
    expect(h.hub.lastDoc()!.revision).not.toBe(firstRevision);
    expect(h.hub.lastDoc()!.channels[0]!.slug).toBe('bbb-renamed');
    expect(h.service.switcherExpectedRevision()).toBe(h.hub.lastDoc()!.revision);
    await h.destroy();
  });

  it('nothing broadcast yet + an empty doc is left alone', async () => {
    const h = await setup();
    const result = await h.service.pushAllSwitchers();
    expect(result).toEqual({ action: 'skipped', detail: 'nothing to manage', blocked: [] });
    expect(h.hub.docs).toHaveLength(0);
    expect(h.service.switcherExpectedRevision()).toBeNull();
    await h.destroy();
  });

  it('no switcher configured: pushAllSwitchers is a no-op skip', async () => {
    const h = await setup({ restreamer: undefined });
    await seedRedundant(h);
    const result = await h.service.pushAllSwitchers();
    expect(result.action).toBe('skipped');
    expect(h.hub.docs).toHaveLength(0);
    await h.destroy();
  });

  it('a single-placement channel is broadcast too; placements change the upstream list, not membership', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    const chan = await h.service.createChannel({
      channelName: 'BBB',
      channelNumber: '10',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    // single placement: with a switcher configured this IS its business now
    expect(h.hub.docs).toHaveLength(1);
    expect(h.hub.lastDoc()!.channels.map((c) => c.slug)).toEqual(['bbb']);
    expect(h.hub.lastDoc()!.channels[0]!.upstreams).toHaveLength(1);

    await h.service.addPlacement(chan.id, { instanceId: 'zone2', nodeId: 'n1' });
    expect(h.hub.docs).toHaveLength(2);
    expect(h.hub.lastDoc()!.channels[0]!.upstreams).toHaveLength(2);

    // removing it again shrinks the upstream list back to one — the channel
    // stays in the doc (its playback URL never changes)
    const placements = (await h.service.listChannels())[0]!.placements;
    await h.service.deletePlacement(placements[1]!.id);
    expect(h.hub.lastDoc()!.channels.map((c) => c.slug)).toEqual(['bbb']);
    expect(h.hub.lastDoc()!.channels[0]!.upstreams).toHaveLength(1);
    await h.destroy();
  });

  it('a doc-computation failure keeps the mutation successful; the sweep heals with the new doc', async () => {
    const { SwitcherSync } = await import('../src/restreamer/switcherSync.js');
    const h = await setup();
    await seedRedundant(h);
    const oldRevision = h.service.switcherExpectedRevision();

    const spy = vi
      .spyOn(SwitcherSync.prototype, 'computeDoc')
      .mockRejectedValueOnce(new Error('database gone'));
    const { channel } = { channel: (await h.service.listChannels())[0]! };
    await h.service.updateChannel(channel.id, { slug: 'bbb-x' }); // does not throw
    expect(h.service.switcherExpectedRevision()).toBe(oldRevision);
    spy.mockRestore();

    vi.useFakeTimers();
    h.service.startSweep();
    await vi.advanceTimersByTimeAsync(60_000);
    h.service.stopSweep();
    vi.useRealTimers();
    await h.service.pushAllSwitchers(); // join the op chain

    expect(h.service.switcherExpectedRevision()).not.toBe(oldRevision);
    expect(h.hub.lastDoc()!.channels[0]!.slug).toBe('bbb-x');
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

  /**
   * A move now enters the SAME serialized failover procedure as every other
   * trigger (reason 'rebalance') instead of calling switchChannel directly —
   * rebalanceTick() only enqueues; failoverTick() (or the 3s timer) actually
   * begins the procedure. Admission needs each candidate node's cached status
   * to be reachable.
   */
  function seedNodeReachable(h: Harness, instanceId: string, nodeId: string): void {
    h.cache.get(instanceId).restreamers.push({
      instanceId,
      nodeId,
      url: `http://${instanceId}-${nodeId}`,
      serveUrl: null,
      reachable: true,
      error: null,
      lastPollAt: null,
      version: '1.0.0',
      uptimeSec: 1,
      apiVersionSupported: true,
      desiredRevision: null,
      pendingPush: false,
      probes: null,
      sessions: [],
      sourcesHash: null,
      sources: null,
      capabilities: null,
      templates: null,
      maxSessions: null,
    });
  }

  it('routes the planned move through the failover procedure: a row appears only after failoverTick, never a direct switch', async () => {
    const h = await setup();
    seedNodeReachable(h, 'zone1', 'n1');
    seedNodeReachable(h, 'zone2', 'n1');
    // two redundant channels, both ACTIVE on zone1/n1 → clear imbalance
    const a = await seedRedundant(h, 'BBB', '10');
    const b = await seedRedundant(h, 'BBB', '10'); // slug uniquified to bbb-2
    const ids = (ps: typeof a.placements) => ps.map((p) => p.id);
    seedReplicaStatus(h.cache, {
      channels: [
        switcherChannel('bbb', a.placements[0]!.id, ids(a.placements), null),
        switcherChannel('bbb-2', b.placements[0]!.id, ids(b.placements), null),
      ],
    });

    await h.service.rebalanceTick(new Date());
    // enqueued only — no row yet, and definitely no direct switch
    expect(h.hub.switches).toHaveLength(0);
    expect(await h.db.selectFrom('restream_failover_state').selectAll().execute()).toHaveLength(0);

    await h.service.failoverTick();
    expect(h.hub.switches).toHaveLength(0); // still no direct switch — the procedure owns it
    const rows = await h.db.selectFrom('restream_failover_state').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channel_id: a.channel.id, // deterministic: lower slug first
      trigger_reason: 'rebalance',
      to_placement_id: a.placements[1]!.id, // the zone2 upstream
    });
    await h.destroy();
  });

  it('honors the sticky window: a recently switched channel is passed over', async () => {
    const h = await setup();
    seedNodeReachable(h, 'zone1', 'n1');
    seedNodeReachable(h, 'zone2', 'n1');
    const a = await seedRedundant(h, 'BBB', '10');
    const b = await seedRedundant(h, 'BBB', '10');
    const now = new Date();
    const recent = new Date(now.getTime() - 10 * 60_000).toISOString();
    const stale = new Date(now.getTime() - 2 * 3_600_000).toISOString();
    seedReplicaStatus(h.cache, {
      channels: [
        // bbb (the lower slug, otherwise preferred) switched 10 min ago — sticky
        switcherChannel('bbb', a.placements[0]!.id, a.placements.map((p) => p.id), recent),
        switcherChannel('bbb-2', b.placements[0]!.id, b.placements.map((p) => p.id), stale),
      ],
    });

    await h.service.rebalanceTick(now);
    await h.service.failoverTick();
    const rows = await h.db.selectFrom('restream_failover_state').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channel_id: b.channel.id,
      trigger_reason: 'rebalance',
      to_placement_id: b.placements[1]!.id,
    });
    await h.destroy();
  });

  it('never rebalances channels the switcher does not report yet — no row, no switch', async () => {
    const h = await setup();
    seedNodeReachable(h, 'zone1', 'n1');
    seedNodeReachable(h, 'zone2', 'n1');
    const a = await seedRedundant(h, 'BBB', '10');
    await seedRedundant(h, 'BBB', '10'); // bbb-2: NOT in the switcher status
    seedReplicaStatus(h.cache, {
      channels: [
        // only bbb is known: its own move buys nothing (same spread), and the
        // unreported bbb-2 must contribute neither load nor a move
        switcherChannel('bbb', a.placements[0]!.id, a.placements.map((p) => p.id), null),
      ],
    });

    await h.service.rebalanceTick(new Date());
    await h.service.failoverTick();
    expect(h.hub.switches).toHaveLength(0);
    expect(await h.db.selectFrom('restream_failover_state').selectAll().execute()).toHaveLength(0);
    await h.destroy();
  });

  it('logs a normal event-log entry when a rebalance move is queued', async () => {
    const h = await setup();
    seedNodeReachable(h, 'zone1', 'n1');
    seedNodeReachable(h, 'zone2', 'n1');
    const a = await seedRedundant(h, 'BBB', '10');
    const b = await seedRedundant(h, 'BBB', '10'); // slug uniquified to bbb-2
    const ids = (ps: typeof a.placements) => ps.map((p) => p.id);
    seedReplicaStatus(h.cache, {
      channels: [
        switcherChannel('bbb', a.placements[0]!.id, ids(a.placements), null),
        switcherChannel('bbb-2', b.placements[0]!.id, ids(b.placements), null),
      ],
    });

    await h.service.rebalanceTick(new Date());
    const moveLogs = h.logs.filter((l) => l.message.includes('rebalance queued'));
    expect(moveLogs).toHaveLength(1);
    expect(moveLogs[0]).toMatchObject({ type: 'normal', service: 'restreamer', source: 'switcher' });
    expect(moveLogs[0]!.message).toContain('bbb');
    await h.destroy();
  });
});

// ---------- event-log emission: switcher push failed/healed ----------

describe('SwitcherSync: switcher push failed/healed event-log emission', () => {
  it('logs a warning on the first doc-computation failure, nothing on a repeat, and a normal once it recovers', async () => {
    const { SwitcherSync } = await import('../src/restreamer/switcherSync.js');
    const h = await setup();
    await seedRedundant(h); // gives the switcher something to push

    const spy = vi
      .spyOn(SwitcherSync.prototype, 'computeDoc')
      .mockRejectedValue(new Error('database gone'));
    const failed = await h.service.pushAllSwitchers(true);
    expect(failed.action).toBe('error');
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({ type: 'warning', service: 'restreamer', source: 'switcher' });
    expect(h.logs[0]!.message).toContain('database gone');

    // still down (e.g. the 60s sweep retrying) must not spam
    const stillFailing = await h.service.pushAllSwitchers(true);
    expect(stillFailing.action).toBe('error');
    expect(h.logs).toHaveLength(1);

    spy.mockRestore();
    const healed = await h.service.pushAllSwitchers(true);
    expect(healed.action).toBe('pushed');
    expect(h.logs).toHaveLength(2);
    expect(h.logs[1]).toMatchObject({ type: 'normal', service: 'restreamer', source: 'switcher' });

    await h.destroy();
  });
});
